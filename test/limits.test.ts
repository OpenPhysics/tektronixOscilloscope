/**
 * Ladder snapping and clamping.
 *
 * The instrument rounds an out-of-ladder scale to a rung of its own choosing and
 * says nothing. Snapping here means the page shows the setting that is really in
 * force; getting the snap wrong means the display and the hardware disagree by a
 * factor of two or five, with no error anywhere to show for it.
 */

import { describe, expect, it } from 'vitest';

import {
  HORIZONTAL_SCALES_S, VERTICAL_SCALES_V, clampAverages, clampHorizontalScale,
  clampPositionDiv, clampProbeAttenuation, clampTriggerLevel, clampVerticalScale,
  snapToLadder,
} from '../src/device/limits.ts';

describe('snapToLadder', () => {
  it('leaves a value that is already a rung alone', () => {
    for (const rung of VERTICAL_SCALES_V) {
      expect(snapToLadder(rung, VERTICAL_SCALES_V)).toBe(rung);
    }
  });

  it('compares logarithmically, not linearly', () => {
    // 3 mV is 1.5x of 2 mV but only 0.6x of 5 mV, so it belongs to 2 mV - even
    // though linear distance would put it nearer 5 mV. This is how the knob
    // behaves, and the reason the comparison is done in log space.
    expect(snapToLadder(3e-3, VERTICAL_SCALES_V)).toBe(2e-3);
    expect(snapToLadder(3.5e-3, VERTICAL_SCALES_V)).toBe(5e-3);
  });

  it('pins a value below the ladder to the smallest rung', () => {
    expect(snapToLadder(1e-9, VERTICAL_SCALES_V)).toBe(2e-3);
  });

  it('pins a value above the ladder to the largest rung', () => {
    expect(snapToLadder(1000, VERTICAL_SCALES_V)).toBe(5);
    expect(snapToLadder(1e6, HORIZONTAL_SCALES_S)).toBe(50);
  });

  it('falls back to the first rung for nonsense rather than returning NaN', () => {
    expect(snapToLadder(NaN, VERTICAL_SCALES_V)).toBe(2e-3);
    expect(snapToLadder(-1, VERTICAL_SCALES_V)).toBe(2e-3);
    expect(snapToLadder(0, VERTICAL_SCALES_V)).toBe(2e-3);
  });
});

describe('vertical scale and probe attenuation', () => {
  it('snaps to the bare ladder with a 1X probe', () => {
    expect(clampVerticalScale(0.6, 1)).toBe(0.5);
  });

  it('shifts the whole ladder by the attenuation with a 10X probe', () => {
    // CH<x>:SCALe is read at the probe tip, so a 10X probe runs 20 mV to 50 V.
    // Getting this wrong is the classic oscilloscope factor-of-ten error.
    expect(clampVerticalScale(6, 10)).toBe(5);
    expect(clampVerticalScale(50, 10)).toBe(50);
    expect(clampVerticalScale(0.02, 10)).toBeCloseTo(0.02, 12);
  });

  it('refuses an attenuation the instrument does not offer', () => {
    expect(clampProbeAttenuation(7)).toBe(10);
    expect(clampProbeAttenuation(100)).toBe(100);
  });
});

describe('horizontal scale', () => {
  it('snaps onto the 1-2.5-5 ladder', () => {
    expect(clampHorizontalScale(3e-6)).toBe(2.5e-6);
    expect(clampHorizontalScale(400e-9)).toBe(500e-9);
  });

  it('covers the full 5 ns to 50 s range', () => {
    expect(clampHorizontalScale(1e-12)).toBe(5e-9);
    expect(clampHorizontalScale(1e6)).toBe(50);
  });
});

describe('positions and levels', () => {
  it('keeps the vertical position on screen', () => {
    expect(clampPositionDiv(10)).toBe(4);
    expect(clampPositionDiv(-10)).toBe(-4);
    expect(clampPositionDiv(1.5)).toBe(1.5);
  });

  it('keeps the trigger level inside the source channel window', () => {
    // At 1 V/div with the trace centred, the screen spans -4 V to +4 V, so a
    // level of 10 V could never be crossed and the scope would never trigger.
    expect(clampTriggerLevel(10, 1, 0)).toBe(4);
    expect(clampTriggerLevel(-10, 1, 0)).toBe(-4);
    expect(clampTriggerLevel(2, 1, 0)).toBe(2);
  });

  it('follows the window when the trace is moved off centre', () => {
    // Position +2 div pushes the trace up, so the visible voltages drop by 2 V.
    expect(clampTriggerLevel(10, 1, 2)).toBe(2);
    expect(clampTriggerLevel(-10, 1, 2)).toBe(-6);
  });

  it('follows the window when the volts per division change', () => {
    expect(clampTriggerLevel(10, 5, 0)).toBe(10);
    expect(clampTriggerLevel(10, 0.1, 0)).toBeCloseTo(0.4, 12);
  });
});

describe('averaging', () => {
  it('accepts only the four counts the instrument offers', () => {
    expect(clampAverages(4)).toBe(4);
    expect(clampAverages(128)).toBe(128);
    expect(clampAverages(20)).toBe(16);
    expect(clampAverages(1000)).toBe(128);
  });
});
