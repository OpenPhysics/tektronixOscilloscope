/**
 * WebUSB transport for the TBS1072B-EDU. The only module that touches hardware.
 *
 * Why WebUSB and not Web Serial: the scope has no UART bridge inside it. It is a
 * native USBTMC device with raw bulk endpoints, so Windows never creates a COM
 * port for it and `navigator.serial` would show an empty picker. See
 * docs/SETUP.md, which also covers the one-time WinUSB bind that WebUSB needs.
 *
 * Two behaviours worth knowing before reading this file:
 *
 *   1. Settings are never acknowledged. Nothing may wait for a reply after a
 *      write, or the UI deadlocks. Ask `EVMSG?` if you need to know whether the
 *      instrument liked a command.
 *   2. Replies are length-delimited by the USBTMC header, so - unlike a serial
 *      instrument - there is no terminator hunting and no idle-gap heuristic.
 *      A reply arrives in full or the transfer times out.
 */

import { commandKey } from './scpi.ts';
import {
  bulkInPayload, HEADER_BYTES, nextBTag, packDevDepMsgOut, packRequestDevDepMsgIn,
  parseBulkInHeader,
} from './usbtmc-frame.ts';

export const USB_VENDOR_ID = 0x0699; // Tektronix
export const USB_PRODUCT_ID = 0x0368; // TBS 1072B-EDU

/** Interface descriptor values that identify a USBTMC interface. */
const USBTMC_INTERFACE_CLASS = 0xfe; // application specific
const USBTMC_INTERFACE_SUBCLASS = 0x03; // test & measurement

/** USBTMC class requests, sent as control transfers to the interface. */
const INITIATE_CLEAR = 5;
const CHECK_CLEAR_STATUS = 6;
const GET_CAPABILITIES = 7;
const CLEAR_STATUS_PENDING = 0x02;

/**
 * A CURVe? on this scope is 2500 bytes, and a hardcopy image is a few hundred
 * kilobytes. One megabyte is generous for both and small enough that a firmware
 * bug in the length field cannot make the page allocate unboundedly.
 */
const MAX_REPLY_BYTES = 1024 * 1024;

/** Ceiling on a single bulk-IN request, so a long reply arrives in steps. */
const MAX_TRANSFER_BYTES = 64 * 1024;

/**
 * WebUSB transfers never time out on their own - a device that stops answering
 * leaves the promise pending forever, which reads to the user as a frozen page.
 * Everything therefore races a timer. Image transfers get longer than commands
 * because the scope renders the bitmap before it starts sending.
 */
const COMMAND_TIMEOUT_MS = 5000;
const IMAGE_TIMEOUT_MS = 30000;

/** Settings are spaced out; the scope drops commands sent back-to-back at full tilt. */
const COMMAND_INTERVAL_MS = 20;

export type ConnectionStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected';

export interface TransportHandlers {
  onStatus?(status: ConnectionStatus, detail?: string): void;
  /** Every command actually put on the wire. Drives the on-screen log. */
  onSent?(command: string): void;
  /** Reply text, for the log. Binary replies are reported as a byte count. */
  onReceived?(text: string): void;
  onError?(message: string): void;
}

interface QueueEntry {
  key: string;
  command: string;
}

export function isWebUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class UsbTmcTransport {
  private device: USBDevice | null = null;
  private interfaceNumber = 0;
  private endpointIn = 0;
  private endpointOut = 0;
  private packetSizeIn = 64;
  private bTag = 0;

  private status: ConnectionStatus = 'disconnected';
  private queue: QueueEntry[] = [];
  private draining = false;
  /** Promise chain used as a mutex; see `serialise`. */
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private handlers: TransportHandlers = {}) {
    if (isWebUsbSupported()) {
      navigator.usb.addEventListener('disconnect', this.handleUnplug);
    } else {
      this.status = 'unsupported';
    }
  }

  get isConnected(): boolean {
    return this.status === 'connected';
  }

  /* ------------------------------------------------------------ connect --- */

  /**
   * MUST be called synchronously from a user gesture - `requestDevice` throws if
   * the browser no longer considers the call user-initiated, so never put an
   * `await` between the click and this call.
   */
  async connect(): Promise<void> {
    if (!isWebUsbSupported()) {
      this.setStatus('unsupported');
      throw new Error('This browser has no WebUSB API. Use Chrome or Edge on desktop.');
    }
    this.setStatus('connecting');
    try {
      const device = await navigator.usb.requestDevice({
        filters: [{ vendorId: USB_VENDOR_ID, productId: USB_PRODUCT_ID }],
      });
      await this.openDevice(device);
    } catch (error) {
      this.setStatus('disconnected');
      throw asError(error);
    }
  }

  /**
   * Reopen a device the user has already granted, without prompting.
   *
   * Called at startup so that refreshing the page mid-experiment does not put a
   * permission dialog between the student and their measurement.
   */
  async tryReconnect(): Promise<boolean> {
    if (!isWebUsbSupported()) return false;
    try {
      const devices = await navigator.usb.getDevices();
      const match = devices.find(
        (device) =>
          device.vendorId === USB_VENDOR_ID && device.productId === USB_PRODUCT_ID,
      );
      if (!match) return false;
      await this.openDevice(match);
      return true;
    } catch {
      // A device that is remembered but no longer plugged in lands here. That is
      // the ordinary case on a fresh page load, not an error worth reporting.
      return false;
    }
  }

  private async openDevice(device: USBDevice): Promise<void> {
    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }

    const target = this.findUsbTmcInterface(device);
    await device.claimInterface(target.interfaceNumber);

    this.device = device;
    this.interfaceNumber = target.interfaceNumber;
    this.endpointIn = target.endpointIn;
    this.endpointOut = target.endpointOut;
    this.packetSizeIn = target.packetSizeIn;
    this.bTag = 0;

    // Whatever the last session left in the endpoint buffers is not ours.
    await this.clear().catch(() => undefined);

    this.setStatus('connected');
  }

  /**
   * Locate the USBTMC interface and its bulk endpoint pair.
   *
   * Searched rather than hard-coded to index 0: firmware revisions have been
   * known to reorder interfaces, and a wrong claim fails in a way that looks
   * like a dead instrument.
   */
  private findUsbTmcInterface(device: USBDevice): {
    interfaceNumber: number;
    endpointIn: number;
    endpointOut: number;
    packetSizeIn: number;
  } {
    const configuration = device.configuration ?? device.configurations[0];
    if (!configuration) throw new Error('device exposes no USB configuration');

    for (const candidate of configuration.interfaces) {
      const alternate = candidate.alternates[0];
      if (!alternate) continue;
      if (
        alternate.interfaceClass !== USBTMC_INTERFACE_CLASS ||
        alternate.interfaceSubclass !== USBTMC_INTERFACE_SUBCLASS
      ) {
        continue;
      }
      const bulkIn = alternate.endpoints.find(
        (endpoint) => endpoint.direction === 'in' && endpoint.type === 'bulk',
      );
      const bulkOut = alternate.endpoints.find(
        (endpoint) => endpoint.direction === 'out' && endpoint.type === 'bulk',
      );
      if (!bulkIn || !bulkOut) continue;

      return {
        interfaceNumber: candidate.interfaceNumber,
        endpointIn: bulkIn.endpointNumber,
        endpointOut: bulkOut.endpointNumber,
        packetSizeIn: bulkIn.packetSize,
      };
    }

    throw new Error(
      'no USBTMC interface found. Check the front panel: ' +
        'Utility > Options > USB Device Port must be set to Computer.',
    );
  }

  /* --------------------------------------------------------------- i/o --- */

  /** Send one command and do not wait for anything. */
  async write(command: string): Promise<void> {
    return this.serialise(() => this.writeRaw(command));
  }

  /** Send a query and return its reply as text. */
  async query(command: string): Promise<string> {
    const bytes = await this.queryBinary(command, COMMAND_TIMEOUT_MS);
    const text = new TextDecoder().decode(bytes).trim();
    this.handlers.onReceived?.(text);
    return text;
  }

  /**
   * Send a query and return its raw reply.
   *
   * `CURVe?` and `HARDCopy STARt` answer with binary that is not valid UTF-8, so
   * they must not go through `query`, which would mangle it into replacement
   * characters.
   */
  async queryBinary(command: string, timeoutMs = IMAGE_TIMEOUT_MS): Promise<Uint8Array> {
    return this.serialise(async () => {
      await this.writeRaw(command);
      const bytes = await this.readReply(timeoutMs);
      return bytes;
    });
  }

  private async writeRaw(command: string): Promise<void> {
    const device = this.device;
    if (!device) throw new Error('not connected');
    const payload = new TextEncoder().encode(`${command}\n`);
    this.bTag = nextBTag(this.bTag);
    const frame = packDevDepMsgOut(this.bTag, payload);
    await this.withTimeout(
      device.transferOut(this.endpointOut, frame),
      COMMAND_TIMEOUT_MS,
      command,
    );
    this.handlers.onSent?.(command);
  }

  /**
   * Reassemble a reply across as many bulk-IN transfers as it takes.
   *
   * Each round trip is an explicit REQUEST_DEV_DEP_MSG_IN followed by a read;
   * the device sets the EOM bit on the transfer that completes the message. A
   * 2500-byte curve usually arrives in one, an image in many.
   */
  private async readReply(timeoutMs: number): Promise<Uint8Array> {
    const device = this.device;
    if (!device) throw new Error('not connected');

    const chunks: Uint8Array[] = [];
    let total = 0;

    while (total < MAX_REPLY_BYTES) {
      const want = Math.min(MAX_REPLY_BYTES - total, MAX_TRANSFER_BYTES);
      this.bTag = nextBTag(this.bTag);
      const request = packRequestDevDepMsgIn(this.bTag, want);
      await this.withTimeout(
        device.transferOut(this.endpointOut, request),
        timeoutMs,
        'bulk-in request',
      );

      // Read whole packets: a bulk transfer ends when the device returns a short
      // packet, so asking for a non-multiple would truncate a full-length reply.
      const readLength =
        Math.ceil((want + HEADER_BYTES) / this.packetSizeIn) * this.packetSizeIn;
      const result = await this.withTimeout(
        device.transferIn(this.endpointIn, readLength),
        timeoutMs,
        'bulk-in transfer',
      );

      if (result.status === 'stall') {
        await device.clearHalt('in', this.endpointIn);
        throw new Error('the instrument stalled the bulk-in endpoint');
      }
      if (!result.data) throw new Error('empty bulk-in transfer');

      const bytes = new Uint8Array(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength,
      );
      const header = parseBulkInHeader(bytes);
      const payload = bulkInPayload(bytes, header);
      chunks.push(payload.slice());
      total += payload.length;

      if (header.eom) break;
    }

    const reply = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      reply.set(chunk, offset);
      offset += chunk.length;
    }
    return reply;
  }

  /**
   * Race a transfer against a deadline and clean up if the deadline wins.
   *
   * A timed-out transfer leaves the endpoints half-way through a message, so the
   * next read would return the tail of the abandoned one. The USBTMC clear is
   * what resynchronises them.
   */
  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what}: no response after ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([operation, expiry]);
    } catch (error) {
      await this.clear().catch(() => undefined);
      throw asError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------- queue --- */

  /**
   * Queue a command, replacing any queued command for the same parameter.
   *
   * This coalescing is what makes sliders usable: a drag produces dozens of
   * values, but only the one the user landed on needs to reach the instrument.
   * Superseded values are dropped rather than transmitted and overwritten.
   */
  enqueue(command: string): void {
    const key = commandKey(command);
    const existing = this.queue.findIndex((entry) => entry.key === key);
    if (existing >= 0) this.queue[existing] = { key, command };
    else this.queue.push({ key, command });
    void this.drain();
  }

  enqueueAll(commands: readonly string[]): void {
    for (const command of commands) this.enqueue(command);
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.isConnected) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && this.isConnected) {
        const entry = this.queue.shift();
        if (!entry) break;
        try {
          await this.write(entry.command);
        } catch (error) {
          this.handlers.onError?.(asError(error).message);
        }
        await delay(COMMAND_INTERVAL_MS);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Run `fn` with exclusive access to the endpoints. */
  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    // Swallow rejections on the chain itself so one failure cannot poison it.
    this.busy = run.catch(() => undefined);
    return run;
  }

  /* ----------------------------------------------------------- control --- */

  /** GET_CAPABILITIES: 24 bytes describing what the device supports. */
  async capabilities(): Promise<Uint8Array> {
    const device = this.device;
    if (!device) throw new Error('not connected');
    const result = await device.controlTransferIn(
      {
        requestType: 'class',
        recipient: 'interface',
        request: GET_CAPABILITIES,
        value: 0,
        index: this.interfaceNumber,
      },
      24,
    );
    if (!result.data) throw new Error('GET_CAPABILITIES returned no data');
    return new Uint8Array(result.data.buffer);
  }

  /**
   * Abort whatever is in flight and flush both endpoint buffers.
   *
   * The spec requires polling CHECK_CLEAR_STATUS until it stops reporting
   * PENDING, then clearing the halt on bulk-OUT. Skipping the second step leaves
   * the endpoint halted and every later write fails.
   */
  async clear(): Promise<void> {
    const device = this.device;
    if (!device) return;

    await device.controlTransferIn(
      {
        requestType: 'class',
        recipient: 'interface',
        request: INITIATE_CLEAR,
        value: 0,
        index: this.interfaceNumber,
      },
      1,
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await device.controlTransferIn(
        {
          requestType: 'class',
          recipient: 'interface',
          request: CHECK_CLEAR_STATUS,
          value: 0,
          index: this.interfaceNumber,
        },
        2,
      );
      if (status.data?.getUint8(0) !== CLEAR_STATUS_PENDING) break;
      await delay(50);
    }

    await device.clearHalt('out', this.endpointOut);
  }

  /* -------------------------------------------------------- disconnect --- */

  async disconnect(): Promise<void> {
    await this.teardown();
  }

  private handleUnplug = (event: USBConnectionEvent): void => {
    // Only care if it was OUR device that vanished.
    if (this.device && event.device === this.device) {
      void this.teardown('the instrument was unplugged');
    }
  };

  private async teardown(detail?: string): Promise<void> {
    this.queue = [];
    const device = this.device;
    this.device = null;
    if (device) {
      try {
        await device.releaseInterface(this.interfaceNumber);
      } catch {
        // Already gone if this is an unplug; nothing to release.
      }
      try {
        await device.close();
      } catch {
        // Same: closing a device that has left the bus throws, harmlessly.
      }
    }
    this.setStatus('disconnected', detail);
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    this.handlers.onStatus?.(status, detail);
  }
}
