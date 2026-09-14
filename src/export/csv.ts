/**
 * Turning a capture into a CSV a student can open. Pure string building, no DOM.
 *
 * The format follows what Tektronix's own software writes: a block of `key,value`
 * metadata, a blank line, then the samples under a two-column header. Excel,
 * LoggerPro, Origin and pandas all cope with that shape, and the metadata means
 * a file found six months later can still be interpreted.
 */

import { type Capture, summarise } from '../device/waveform.ts';
import { type InstrumentState } from '../device/types.ts';

/** RFC 4180: a field containing a comma, quote or newline is quoted, quotes doubled. */
function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function row(key: string, value: string | number): string {
  return `${escapeField(key)},${escapeField(String(value))}`;
}

/**
 * Serialise one capture.
 *
 * Sample values are written with `toPrecision(8)`, comfortably more than the
 * instrument's 8-bit resolution justifies. Writing fewer digits would quantise
 * the record a second time, on top of the quantisation the ADC already applied.
 */
export function captureToCsv(capture: Capture, instrument: InstrumentState): string {
  const stats = summarise(capture);
  const channel = capture.channel === 1 ? instrument.ch1 : instrument.ch2;

  const lines: string[] = [
    row('Source', `CH${capture.channel}`),
    row('Model', 'Tektronix TBS1072B-EDU'),
    row('Captured', new Date(capture.capturedAt).toISOString()),
    row('Record length', capture.volts.length),
    row('Sample interval (s)', capture.preamble.xIncr.toPrecision(8)),
    row('Sample rate (Hz)', stats.sampleRateHz.toPrecision(8)),
    row('Trigger point (samples)', capture.preamble.ptOff),
    row('Vertical scale (V/div)', channel.scaleVPerDiv),
    row('Vertical position (div)', channel.positionDiv),
    row('Coupling', channel.coupling),
    row('Probe attenuation', channel.probeAttenuation),
    row('Horizontal scale (s/div)', instrument.horizontal.scaleSPerDiv),
    row('Trigger source', instrument.trigger.source),
    row('Trigger slope', instrument.trigger.slope),
    row('Trigger level (V)', instrument.trigger.levelV),
    row('Acquisition mode', instrument.acquisition.mode),
    row('Minimum (V)', stats.min.toPrecision(8)),
    row('Maximum (V)', stats.max.toPrecision(8)),
    row('Peak-to-peak (V)', stats.peakToPeak.toPrecision(8)),
    row('Mean (V)', stats.mean.toPrecision(8)),
    row('RMS (V)', stats.rms.toPrecision(8)),
    '',
    'time_s,voltage_v',
  ];

  for (let index = 0; index < capture.volts.length; index += 1) {
    const time = capture.times[index] ?? 0;
    const volt = capture.volts[index] ?? 0;
    lines.push(`${time.toPrecision(8)},${volt.toPrecision(8)}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Serialise several captures side by side, sharing one time column.
 *
 * Only valid when the captures were taken with the same timebase, which is the
 * case when CH1 and CH2 are read from a single acquisition. The caller checks;
 * this function assumes.
 */
export function capturesToCsv(
  captures: readonly Capture[],
  instrument: InstrumentState,
): string {
  const first = captures[0];
  if (!first) return '';
  if (captures.length === 1) return captureToCsv(first, instrument);

  const header = ['time_s', ...captures.map((capture) => `ch${capture.channel}_voltage_v`)];
  const lines: string[] = [
    row('Model', 'Tektronix TBS1072B-EDU'),
    row('Captured', new Date(first.capturedAt).toISOString()),
    row('Record length', first.volts.length),
    row('Sample interval (s)', first.preamble.xIncr.toPrecision(8)),
    row('Horizontal scale (s/div)', instrument.horizontal.scaleSPerDiv),
    '',
    header.join(','),
  ];

  for (let index = 0; index < first.volts.length; index += 1) {
    const cells = [(first.times[index] ?? 0).toPrecision(8)];
    for (const capture of captures) {
      cells.push((capture.volts[index] ?? 0).toPrecision(8));
    }
    lines.push(cells.join(','));
  }

  return `${lines.join('\n')}\n`;
}
