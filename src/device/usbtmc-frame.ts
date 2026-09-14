/**
 * USBTMC bulk-transfer framing. Pure byte manipulation - no WebUSB, no DOM.
 *
 * USBTMC (USB Test & Measurement Class, USB-IF specification 1.00) wraps every
 * message in a 12-byte header on the bulk endpoints. Keeping that arithmetic in
 * its own module is what lets test/usbtmc.test.ts prove the framing is right
 * without an instrument attached - which matters, because a one-byte error here
 * produces a device that stalls rather than a readable error message.
 *
 * Header layout, little-endian throughout:
 *
 *   offset 0   MsgID
 *   offset 1   bTag
 *   offset 2   bTagInverse, i.e. ~bTag
 *   offset 3   reserved, must be 0
 *   offset 4   TransferSize, u32
 *   offset 8   bmTransferAttributes
 *   offset 9   TermChar
 *   offset 10  reserved, must be 0
 *
 * The whole transfer is then padded with zeros to a multiple of 4 bytes.
 */

export const HEADER_BYTES = 12;

export const MsgId = {
  /** Host -> device: here is a command. */
  devDepMsgOut: 1,
  /** Host -> device: send me a reply. */
  requestDevDepMsgIn: 2,
} as const;

/** bmTransferAttributes bits. */
const ATTR_EOM = 0x01;
const ATTR_TERMCHAR = 0x02;

export interface BulkInHeader {
  msgId: number;
  bTag: number;
  /** Bytes of payload that follow the header in this transfer. */
  transferSize: number;
  /** End of message: the reply is complete and no further transfer is needed. */
  eom: boolean;
}

/**
 * The next bTag in the cycle.
 *
 * The spec reserves 0, and firmware that receives it may stall the endpoint
 * rather than answer, so the sequence is 1..255 and wraps back to 1.
 */
export function nextBTag(previous: number): number {
  return (previous % 255) + 1;
}

/** Length rounded up to the 4-byte boundary every USBTMC transfer must end on. */
export function paddedLength(length: number): number {
  return length + ((-length % 4) + 4) % 4;
}

function writeHeader(
  view: DataView,
  msgId: number,
  bTag: number,
  transferSize: number,
  attributes: number,
  termChar: number,
): void {
  view.setUint8(0, msgId);
  view.setUint8(1, bTag);
  view.setUint8(2, ~bTag & 0xff);
  view.setUint8(3, 0);
  view.setUint32(4, transferSize, true);
  view.setUint8(8, attributes);
  view.setUint8(9, termChar);
  view.setUint8(10, 0);
  view.setUint8(11, 0);
}

/**
 * Frame a command for the bulk-OUT endpoint.
 *
 * `eom` is false only when a message is deliberately split across transfers,
 * which this driver never does - every SCPI command fits in one.
 */
export function packDevDepMsgOut(
  bTag: number,
  payload: Uint8Array,
  eom = true,
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(paddedLength(HEADER_BYTES + payload.length));
  writeHeader(
    new DataView(frame.buffer),
    MsgId.devDepMsgOut,
    bTag,
    payload.length,
    eom ? ATTR_EOM : 0,
    0,
  );
  frame.set(payload, HEADER_BYTES);
  return frame;
}

/**
 * Frame a request for the device's reply.
 *
 * `termChar` is left off by default: USBTMC replies are length-delimited, so
 * unlike a serial instrument there is no need to hunt for a newline. Passing a
 * terminator is only useful when probing firmware that gets the length wrong.
 */
export function packRequestDevDepMsgIn(
  bTag: number,
  transferSize: number,
  termChar?: number,
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(HEADER_BYTES);
  writeHeader(
    new DataView(frame.buffer),
    MsgId.requestDevDepMsgIn,
    bTag,
    transferSize,
    termChar === undefined ? 0 : ATTR_TERMCHAR,
    termChar ?? 0,
  );
  return frame;
}

/**
 * Read the 12-byte header off a bulk-IN transfer.
 *
 * Throws rather than returning a partial result: a header that fails these
 * checks means the endpoint is out of sync, and the only recovery is a USBTMC
 * clear. Guessing at the contents would turn that into corrupt samples.
 */
export function parseBulkInHeader(bytes: Uint8Array): BulkInHeader {
  if (bytes.length < HEADER_BYTES) {
    throw new Error(`truncated USBTMC header: ${bytes.length} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bTag = view.getUint8(1);
  const bTagInverse = view.getUint8(2);
  if ((~bTag & 0xff) !== bTagInverse) {
    throw new Error(`USBTMC header bTag mismatch: ${bTag} vs ${bTagInverse}`);
  }
  return {
    msgId: view.getUint8(0),
    bTag,
    transferSize: view.getUint32(4, true),
    eom: (view.getUint8(8) & ATTR_EOM) !== 0,
  };
}

/** The payload of a bulk-IN transfer, bounded by both the header and what arrived. */
export function bulkInPayload(bytes: Uint8Array, header: BulkInHeader): Uint8Array {
  const end = Math.min(bytes.length, HEADER_BYTES + header.transferSize);
  return bytes.subarray(HEADER_BYTES, end);
}
