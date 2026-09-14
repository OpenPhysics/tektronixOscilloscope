/**
 * Block parsing and the scaling maths.
 *
 * The scaling is the step where a mistake is invisible: wrong numbers still plot
 * as a plausible-looking waveform, just with the wrong axis. The expected values
 * below were worked out by hand from the transformation in the TBS1000B
 * programmer manual, not from running this code.
 */

import { describe, expect, it } from 'vitest';

import {
  buildCapture, decodeCurve, emptyPreamble, parseDefiniteLengthBlock, scaleSamples,
  summarise, type Preamble,
} from '../src/device/waveform.ts';

/** Wrap a payload the way CURVe? does: #<digits><length><payload>. */
function block(payload: Uint8Array): Uint8Array {
  const length = String(payload.length);
  const header = new TextEncoder().encode(`#${length.length}${length}`);
  const bytes = new Uint8Array(header.length + payload.length);
  bytes.set(header);
  bytes.set(payload, header.length);
  return bytes;
}

describe('IEEE 488.2 definite-length blocks', () => {
  it('unwraps a full 2500-point record', () => {
    const payload = new Uint8Array(2500).fill(7);
    const parsed = parseDefiniteLengthBlock(block(payload));
    expect(parsed.length).toBe(2500);
    expect(parsed[0]).toBe(7);
  });

  it('reads the single-digit form', () => {
    const parsed = parseDefiniteLengthBlock(new TextEncoder().encode('#14ABCD'));
    expect(new TextDecoder().decode(parsed)).toBe('ABCD');
  });

  it('ignores whatever trails the block, such as the terminating newline', () => {
    const parsed = parseDefiniteLengthBlock(new TextEncoder().encode('#14ABCD\n'));
    expect(parsed.length).toBe(4);
  });

  it('rejects a reply that is not a block at all', () => {
    const plain = new TextEncoder().encode('2.0E-1');
    expect(() => parseDefiniteLengthBlock(plain)).toThrow(/definite-length block/);
  });

  it('rejects an indefinite-length block rather than guessing its extent', () => {
    expect(() => parseDefiniteLengthBlock(new TextEncoder().encode('#0ABCD')))
      .toThrow(/unsupported block length prefix/);
  });

  it('refuses a truncated transfer instead of returning short data', () => {
    // Declares 2500 bytes, carries 10. Silently returning 10 would look like a
    // successful capture of a mangled waveform.
    const truncated = new TextEncoder().encode('#42500' + 'x'.repeat(10));
    expect(() => parseDefiniteLengthBlock(truncated)).toThrow(/only 10 arrived/);
  });
});

describe('RIBINARY decoding', () => {
  it('reads the codes as signed bytes', () => {
    // 0xFF is -1 signed, not 255; getting this wrong flips the bottom half of
    // the screen to the top.
    const codes = decodeCurve(new Uint8Array([0x00, 0x7f, 0xff, 0x80]));
    expect(Array.from(codes)).toEqual([0, 127, -1, -128]);
  });
});

describe('scaling', () => {
  function preamble(): Preamble {
    const value = emptyPreamble();
    // A plausible 1 V/div, 500 us/div setting: 25 codes per division vertically,
    // 250 samples per division horizontally.
    value.points = 2500;
    value.xIncr = 2e-6;
    value.xZero = -2.5e-3;
    value.ptOff = 1250;
    value.yMult = 0.04;
    value.yZero = 0;
    value.yOff = 0;
    return value;
  }

  it('turns codes into volts by yZero + yMult * (code - yOff)', () => {
    const { volts } = scaleSamples(new Int8Array([0, 25, -25, 100]), preamble());
    expect(volts[0]).toBeCloseTo(0, 12);
    expect(volts[1]).toBeCloseTo(1, 12);
    expect(volts[2]).toBeCloseTo(-1, 12);
    expect(volts[3]).toBeCloseTo(4, 12);
  });

  it('applies yOff before yMult, not after', () => {
    // With yOff = 25 and yZero = 0, a code of 25 is the zero-volt level.
    const shifted = preamble();
    shifted.yOff = 25;
    const { volts } = scaleSamples(new Int8Array([25, 50]), shifted);
    expect(volts[0]).toBeCloseTo(0, 12);
    expect(volts[1]).toBeCloseTo(1, 12);
  });

  it('adds yZero after scaling, as a voltage offset', () => {
    const offset = preamble();
    offset.yZero = 2;
    const { volts } = scaleSamples(new Int8Array([0, 25]), offset);
    expect(volts[0]).toBeCloseTo(2, 12);
    expect(volts[1]).toBeCloseTo(3, 12);
  });

  it('puts the trigger point at t = xZero + xIncr * (ptOff - ptOff)', () => {
    const { times } = scaleSamples(new Int8Array(2500), preamble());
    // Sample 1250 is the trigger, so it sits at xZero + 0 offset from itself.
    expect(times[1250]).toBeCloseTo(-2.5e-3, 12);
    // One sample later is one xIncr later.
    expect((times[1251] ?? 0) - (times[1250] ?? 0)).toBeCloseTo(2e-6, 15);
  });

  it('spans the full record at the stated sample interval', () => {
    const { times } = scaleSamples(new Int8Array(2500), preamble());
    const span = (times[2499] ?? 0) - (times[0] ?? 0);
    expect(span).toBeCloseTo(2499 * 2e-6, 12);
  });
});

describe('buildCapture', () => {
  it('runs block, decode and scale together', () => {
    const value = emptyPreamble();
    value.yMult = 0.04;
    const capture = buildCapture(1, block(new Uint8Array([0, 25, 50])), value, 1000);
    expect(capture.channel).toBe(1);
    expect(capture.capturedAt).toBe(1000);
    expect(capture.volts.length).toBe(3);
    expect(capture.volts[2]).toBeCloseTo(2, 12);
  });
});

describe('summarise', () => {
  it('describes a square wave the way the front panel would', () => {
    // Probe-comp shaped: 5 Vpp square, half the samples high, half low.
    const value = emptyPreamble();
    value.yMult = 1;
    value.xIncr = 1e-6;
    const codes = new Int8Array(1000);
    codes.fill(5, 0, 500);
    codes.fill(0, 500);

    const stats = summarise({
      channel: 1,
      preamble: value,
      ...scaleSamples(codes, value),
      capturedAt: 0,
    });

    expect(stats.min).toBeCloseTo(0, 12);
    expect(stats.max).toBeCloseTo(5, 12);
    expect(stats.peakToPeak).toBeCloseTo(5, 12);
    expect(stats.mean).toBeCloseTo(2.5, 12);
    // RMS of a 50% duty square between 0 and 5 is 5/sqrt(2), not the mean.
    expect(stats.rms).toBeCloseTo(5 / Math.SQRT2, 10);
    expect(stats.sampleRateHz).toBeCloseTo(1e6, 6);
  });

  it('reports zeros for an empty capture rather than NaN', () => {
    const stats = summarise({
      channel: 1,
      preamble: emptyPreamble(),
      times: new Float64Array(0),
      volts: new Float64Array(0),
      capturedAt: 0,
    });
    expect(stats.peakToPeak).toBe(0);
    expect(stats.rms).toBe(0);
  });
});
