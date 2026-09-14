/**
 * USBTMC framing.
 *
 * This is the layer with no forgiving failure mode: a device that receives a
 * malformed header stalls its endpoint rather than complaining, so an error here
 * shows up in the browser as an instrument that simply stops answering. These
 * tests assert the byte layout against the USBTMC 1.00 specification directly.
 */

import { describe, expect, it } from 'vitest';

import {
  HEADER_BYTES, MsgId, bulkInPayload, nextBTag, packDevDepMsgOut,
  packRequestDevDepMsgIn, paddedLength, parseBulkInHeader,
} from '../src/device/usbtmc-frame.ts';

describe('bTag sequencing', () => {
  it('never yields 0, which the specification reserves', () => {
    let tag = 0;
    for (let step = 0; step < 1000; step += 1) {
      tag = nextBTag(tag);
      expect(tag).toBeGreaterThanOrEqual(1);
      expect(tag).toBeLessThanOrEqual(255);
    }
  });

  it('wraps from 255 back to 1 rather than to 0', () => {
    expect(nextBTag(254)).toBe(255);
    expect(nextBTag(255)).toBe(1);
  });
});

describe('4-byte padding', () => {
  it('leaves an aligned length alone', () => {
    expect(paddedLength(0)).toBe(0);
    expect(paddedLength(12)).toBe(12);
    expect(paddedLength(2512)).toBe(2512);
  });

  it('rounds an unaligned length up', () => {
    expect(paddedLength(13)).toBe(16);
    expect(paddedLength(14)).toBe(16);
    expect(paddedLength(15)).toBe(16);
  });
});

describe('DEV_DEP_MSG_OUT', () => {
  const payload = new TextEncoder().encode('*IDN?\n');
  const frame = packDevDepMsgOut(0x42, payload);

  it('writes the documented header layout', () => {
    expect(frame[0]).toBe(MsgId.devDepMsgOut);
    expect(frame[1]).toBe(0x42);
    expect(frame[2]).toBe(0xbd); // ~0x42
    expect(frame[3]).toBe(0);
    // TransferSize is the payload length, little-endian, and excludes the header.
    const view = new DataView(frame.buffer);
    expect(view.getUint32(4, true)).toBe(payload.length);
    expect(frame[8]).toBe(0x01); // EOM
    expect(frame[10]).toBe(0);
    expect(frame[11]).toBe(0);
  });

  it('places the payload straight after the header', () => {
    const carried = frame.subarray(HEADER_BYTES, HEADER_BYTES + payload.length);
    expect(new TextDecoder().decode(carried)).toBe('*IDN?\n');
  });

  it('pads the whole transfer to a multiple of 4', () => {
    // 12 + 6 = 18, so the frame is 20 bytes with two zeros of padding.
    expect(frame.length).toBe(20);
    expect(frame[18]).toBe(0);
    expect(frame[19]).toBe(0);
  });

  it('clears the EOM bit when a message is deliberately split', () => {
    expect(packDevDepMsgOut(1, payload, false)[8]).toBe(0x00);
  });
});

describe('REQUEST_DEV_DEP_MSG_IN', () => {
  it('is a bare header asking for a given number of bytes', () => {
    const frame = packRequestDevDepMsgIn(7, 4096);
    expect(frame.length).toBe(HEADER_BYTES);
    expect(frame[0]).toBe(MsgId.requestDevDepMsgIn);
    expect(frame[1]).toBe(7);
    expect(frame[2]).toBe(0xf8);
    expect(new DataView(frame.buffer).getUint32(4, true)).toBe(4096);
  });

  it('leaves TermChar disabled unless one is asked for', () => {
    expect(packRequestDevDepMsgIn(1, 64)[8]).toBe(0x00);
    const terminated = packRequestDevDepMsgIn(1, 64, 0x0a);
    expect(terminated[8]).toBe(0x02);
    expect(terminated[9]).toBe(0x0a);
  });
});

describe('bulk-in headers', () => {
  function reply(bTag: number, size: number, eom: boolean, body: string): Uint8Array {
    const payload = new TextEncoder().encode(body);
    const bytes = new Uint8Array(HEADER_BYTES + payload.length);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, MsgId.requestDevDepMsgIn);
    view.setUint8(1, bTag);
    view.setUint8(2, ~bTag & 0xff);
    view.setUint32(4, size, true);
    view.setUint8(8, eom ? 0x01 : 0x00);
    bytes.set(payload, HEADER_BYTES);
    return bytes;
  }

  it('reads the tag, size and EOM flag back', () => {
    const header = parseBulkInHeader(reply(9, 5, true, 'HELLO'));
    expect(header.bTag).toBe(9);
    expect(header.transferSize).toBe(5);
    expect(header.eom).toBe(true);
  });

  it('reports a continuation when EOM is clear', () => {
    expect(parseBulkInHeader(reply(9, 5, false, 'HELLO')).eom).toBe(false);
  });

  it('rejects a header whose inverse tag disagrees', () => {
    // A mismatch means the endpoint is out of sync; guessing would corrupt data.
    const bytes = reply(9, 5, true, 'HELLO');
    bytes[2] = 0x00;
    expect(() => parseBulkInHeader(bytes)).toThrow(/bTag mismatch/);
  });

  it('rejects a transfer too short to hold a header', () => {
    expect(() => parseBulkInHeader(new Uint8Array(8))).toThrow(/truncated/);
  });

  it('extracts the payload named by the header', () => {
    const bytes = reply(3, 5, true, 'HELLO');
    const payload = bulkInPayload(bytes, parseBulkInHeader(bytes));
    expect(new TextDecoder().decode(payload)).toBe('HELLO');
  });

  it('never reads past what actually arrived, whatever the header claims', () => {
    // Firmware that overstates the length must not make the driver read rubbish
    // out of the rest of the buffer.
    const bytes = reply(3, 9999, true, 'HELLO');
    const payload = bulkInPayload(bytes, parseBulkInHeader(bytes));
    expect(payload.length).toBe(5);
  });
});
