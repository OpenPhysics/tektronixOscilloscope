/**
 * What the TBS1072B-EDU can actually do. No I/O, no DOM.
 *
 * The instrument does not accept arbitrary scales: turning the VOLTS/DIV knob
 * steps through a 1-2-5 ladder, and sending `CH1:SCALE 0.37` makes it silently
 * pick the nearest rung instead. Snapping here means the page shows what the
 * scope is really set to rather than what we asked for.
 *
 * Figures marked "verified" were read back from the instrument with
 * tools/probe.py; the rest come from the TBS1000B series manual and are clamps
 * chosen to stay inside the real limits rather than to sit exactly on them.
 */

/** Screen geometry. Verified: 2500-point records over 10 horizontal divisions. */
export const RECORD_LENGTH = 2500;
export const HORIZONTAL_DIVISIONS = 10;
export const VERTICAL_DIVISIONS = 8;

/** Volts per division at 1X probe attenuation. A 1-2-5 ladder, 2 mV to 5 V. */
export const VERTICAL_SCALES_V = [
  2e-3, 5e-3, 10e-3, 20e-3, 50e-3, 100e-3, 200e-3, 500e-3, 1, 2, 5,
] as const;

/** Seconds per division. A 1-2.5-5 ladder, 5 ns to 50 s. */
export const HORIZONTAL_SCALES_S = [
  5e-9, 10e-9, 25e-9, 50e-9, 100e-9, 250e-9, 500e-9,
  1e-6, 2.5e-6, 5e-6, 10e-6, 25e-6, 50e-6, 100e-6, 250e-6, 500e-6,
  1e-3, 2.5e-3, 5e-3, 10e-3, 25e-3, 50e-3, 100e-3, 250e-3, 500e-3,
  1, 2.5, 5, 10, 25, 50,
] as const;

export const PROBE_ATTENUATIONS = [1, 10, 100, 1000] as const;

/** ACQuire:NUMAVg accepts only these four values. */
export const AVERAGE_COUNTS = [4, 16, 64, 128] as const;

/**
 * Pick the ladder rung nearest `value`, comparing logarithmically.
 *
 * Linear comparison would put 3 mV closer to 5 mV than to 2 mV, which is wrong
 * for a knob that thinks in decades: 3 mV is 1.5x of 2 mV but only 0.6x of 5 mV.
 */
export function snapToLadder(value: number, ladder: readonly number[]): number {
  const first = ladder[0];
  if (first === undefined) throw new Error('empty ladder');
  if (!Number.isFinite(value) || value <= 0) return first;

  let best = first;
  let bestDistance = Infinity;
  for (const rung of ladder) {
    const distance = Math.abs(Math.log(value / rung));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = rung;
    }
  }
  return best;
}

/**
 * Clamp a vertical scale to the ladder, scaled by probe attenuation.
 *
 * CH<x>:SCALe is expressed at the probe tip, so a 10X probe shifts the whole
 * range to 20 mV/div - 50 V/div. Getting this wrong makes every reading off by
 * a factor of ten, which is the classic oscilloscope mistake.
 */
export function clampVerticalScale(value: number, probeAttenuation: number): number {
  const factor = PROBE_ATTENUATIONS.includes(probeAttenuation as 1) ? probeAttenuation : 1;
  return snapToLadder(value / factor, VERTICAL_SCALES_V) * factor;
}

export function clampHorizontalScale(value: number): number {
  return snapToLadder(value, HORIZONTAL_SCALES_S);
}

export function clampProbeAttenuation(value: number): number {
  return PROBE_ATTENUATIONS.includes(value as 1) ? value : 10;
}

export function clampAverages(value: number): number {
  return snapToLadder(value, AVERAGE_COUNTS);
}

/** Vertical position, in divisions. The knob runs out at the screen edge either way. */
export function clampPositionDiv(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const limit = VERTICAL_DIVISIONS / 2;
  return Math.max(-limit, Math.min(limit, value));
}

/**
 * Trigger level, in volts.
 *
 * A level outside the source channel's visible window can never be crossed, so
 * the scope would sit untriggered forever. Clamping to the screen keeps the
 * control honest - it is bounded by what you can see.
 */
export function clampTriggerLevel(
  value: number,
  sourceScaleVPerDiv: number,
  sourcePositionDiv: number,
): number {
  if (!Number.isFinite(value)) return 0;
  const halfScreen = (VERTICAL_DIVISIONS / 2) * sourceScaleVPerDiv;
  const centre = -sourcePositionDiv * sourceScaleVPerDiv;
  return Math.max(centre - halfScreen, Math.min(centre + halfScreen, value));
}

/**
 * Horizontal position, in seconds from the trigger point.
 *
 * Unverified: the manual gives the pre-trigger window as a fraction of the
 * record and the post-trigger delay as a much larger range. Ten screens either
 * way is comfortably inside both.
 */
export function clampHorizontalPosition(value: number, scaleSPerDiv: number): number {
  if (!Number.isFinite(value)) return 0;
  const limit = HORIZONTAL_DIVISIONS * scaleSPerDiv * 10;
  return Math.max(-limit, Math.min(limit, value));
}
