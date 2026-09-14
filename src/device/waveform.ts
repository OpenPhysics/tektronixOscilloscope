/**
 * Turning a CURVe? reply into volts against seconds. Pure functions, no I/O, no DOM.
 *
 * The instrument sends 8-bit codes, not voltages. What those codes mean depends
 * entirely on the preamble captured at the same moment - change the VOLTS/DIV
 * knob between the preamble and the curve and every sample is wrong by a
 * constant factor, with nothing in the data to reveal it. That is why
 * `captureWaveform` in main.ts reads both inside one acquisition.
 */

import { type ChannelId } from './types.ts';

/**
 * The scaling information that accompanies a record.
 *
 * Field names mirror the WFMPRE keywords so that a reading of docs/PROTOCOL.md
 * and a reading of this interface line up.
 */
export interface Preamble {
  /** NR_PT: how many points the record holds. */
  points: number;
  /** XINCR: seconds between successive samples. */
  xIncr: number;
  /** XZERO: time of the first point, relative to the trigger. */
  xZero: number;
  /** PT_OFF: index of the trigger point within the record. */
  ptOff: number;
  xUnit: string;
  /** YMULT: volts per code. */
  yMult: number;
  /** YZERO: voltage offset applied after scaling. */
  yZero: number;
  /** YOFF: code value that corresponds to yZero. */
  yOff: number;
  yUnit: string;
}

export interface Capture {
  channel: ChannelId;
  preamble: Preamble;
  /** Seconds relative to the trigger point. */
  times: Float64Array;
  volts: Float64Array;
  /** Milliseconds since the epoch, so a capture can be labelled and sorted. */
  capturedAt: number;
}

export function emptyPreamble(): Preamble {
  return {
    points: 0,
    xIncr: 1,
    xZero: 0,
    ptOff: 0,
    xUnit: 's',
    yMult: 1,
    yZero: 0,
    yOff: 0,
    yUnit: 'V',
  };
}

/**
 * Unwrap an IEEE 488.2 definite-length block: `#<n><length, n digits><payload>`.
 *
 * `#42500` means "four digits of length follow, and they say 2500". Both
 * CURVe? and HARDCopy answer in this form. Indefinite-length blocks (`#0`,
 * terminated by EOI) are rejected rather than guessed at - this instrument does
 * not send them, and accepting one would mean trusting the transfer length
 * instead of the declared length.
 */
export function parseDefiniteLengthBlock(data: Uint8Array): Uint8Array {
  if (data.length < 2 || data[0] !== 0x23 /* '#' */) {
    throw new Error('reply is not an IEEE 488.2 definite-length block');
  }
  const digitCount = (data[1] ?? 0) - 0x30;
  if (digitCount < 1 || digitCount > 9) {
    throw new Error(`unsupported block length prefix: #${String.fromCharCode(data[1] ?? 0)}`);
  }

  let length = 0;
  for (let index = 0; index < digitCount; index += 1) {
    const digit = (data[2 + index] ?? 0) - 0x30;
    if (digit < 0 || digit > 9) throw new Error('block length is not numeric');
    length = length * 10 + digit;
  }

  const start = 2 + digitCount;
  if (start + length > data.length) {
    throw new Error(
      `block declares ${length} bytes but only ${data.length - start} arrived`,
    );
  }
  return data.subarray(start, start + length);
}

/** Reinterpret the payload as the signed bytes that DATA:ENCDG RIBINARY sends. */
export function decodeCurve(payload: Uint8Array): Int8Array {
  return new Int8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

/**
 * Apply the preamble, giving seconds and volts.
 *
 *   volts   = YZERO + YMULT * (code - YOFF)
 *   seconds = XZERO + XINCR * (index - PT_OFF)
 *
 * This is the transformation printed in the TBS1000B programmer manual, and the
 * reason the numbers here can be compared against the scope's own screen.
 */
export function scaleSamples(
  codes: Int8Array,
  preamble: Preamble,
): { times: Float64Array; volts: Float64Array } {
  const times = new Float64Array(codes.length);
  const volts = new Float64Array(codes.length);
  for (let index = 0; index < codes.length; index += 1) {
    times[index] = preamble.xZero + preamble.xIncr * (index - preamble.ptOff);
    volts[index] = preamble.yZero + preamble.yMult * ((codes[index] ?? 0) - preamble.yOff);
  }
  return { times, volts };
}

/** The whole pipeline: raw USBTMC reply in, scaled capture out. */
export function buildCapture(
  channel: ChannelId,
  reply: Uint8Array,
  preamble: Preamble,
  capturedAt: number,
): Capture {
  const codes = decodeCurve(parseDefiniteLengthBlock(reply));
  const { times, volts } = scaleSamples(codes, preamble);
  return { channel, preamble, times, volts, capturedAt };
}

export interface Summary {
  min: number;
  max: number;
  peakToPeak: number;
  mean: number;
  rms: number;
  durationS: number;
  sampleRateHz: number;
}

/**
 * Descriptive statistics over a capture.
 *
 * These are computed from the transferred record, so they are not the same
 * numbers as the instrument's own MEASUREMENT readings, which run over the full
 * acquisition. Small disagreements between the two panels are expected.
 */
export function summarise(capture: Capture): Summary {
  const { volts, preamble } = capture;
  if (volts.length === 0) {
    return {
      min: 0, max: 0, peakToPeak: 0, mean: 0, rms: 0, durationS: 0, sampleRateHz: 0,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSquares = 0;
  for (const value of volts) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    sumSquares += value * value;
  }

  return {
    min,
    max,
    peakToPeak: max - min,
    mean: sum / volts.length,
    rms: Math.sqrt(sumSquares / volts.length),
    durationS: preamble.xIncr * volts.length,
    sampleRateHz: preamble.xIncr > 0 ? 1 / preamble.xIncr : 0,
  };
}
