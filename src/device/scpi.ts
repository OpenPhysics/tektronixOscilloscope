/**
 * The TBS1072B-EDU command language: pure string building, no I/O.
 *
 * Keeping this module free of `navigator.usb` is what makes the whole command
 * set testable in CI with no instrument attached - which is most of the risk in
 * a project like this, because a misspelt SCPI keyword is accepted silently and
 * simply does nothing.
 *
 * Spellings here were chosen against the TBS1000B series programmer manual and
 * are meant to be checked with `python3 tools/probe.py try-spellings` before
 * being trusted; see docs/PROTOCOL.md for what has actually been verified.
 */

import { RECORD_LENGTH } from './limits.ts';
import {
  channelKey,
  type AcquisitionState, type ChannelId, type ChannelState, type HorizontalState,
  type InstrumentState, type MeasurementTypeCode, type TriggerState,
} from './types.ts';

/**
 * Commands sent once, immediately after the link comes up.
 *
 * HEADER OFF is the critical one. With headers on, `CH1:SCALE?` answers
 * ':CH1:SCALE 5.0E-1' rather than '5.0E-1', and every parser below breaks. LOCK
 * NONE matters for a teaching lab: without it the front panel goes dead as soon
 * as the page connects, which is baffling if you are standing at the bench.
 */
export const SESSION_SETUP: readonly string[] = [
  '*CLS',
  'HEADER OFF',
  'VERBOSE OFF',
  'LOCK NONE',
];

/**
 * Render a number the way the instrument's parser likes it.
 *
 * Scales span 5e-9 to 50, so plain decimal notation would either lose precision
 * on the small end or produce absurd strings on the large. Exponential covers
 * both and is what the scope itself replies with.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value === 0) return '0';
  return value.toExponential(6).toUpperCase();
}

/**
 * The parameter a command addresses, used to coalesce a slider drag.
 *
 * 'CH1:SCALE 5.0E-1' and 'CH1:SCALE 1.0E0' share the key 'CH1:SCALE', so the
 * queue keeps only the newest. A command with no argument is its own key.
 */
export function commandKey(command: string): string {
  const space = command.indexOf(' ');
  return (space < 0 ? command : command.slice(0, space)).toUpperCase();
}

/**
 * A screen for hand-typed input in the raw console.
 *
 * Deliberately permissive - it rejects obvious nonsense and control characters,
 * not unusual commands, because the console exists precisely for trying things
 * this file does not know about.
 */
export function isPlausibleCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return /^[*:A-Za-z]/.test(trimmed);
}

/* --------------------------------------------------------------- encode --- */

export function encodeChannel(id: ChannelId, channel: ChannelState): string[] {
  return [
    `SELECT:CH${id} ${channel.enabled ? 'ON' : 'OFF'}`,
    `CH${id}:PROBE ${formatNumber(channel.probeAttenuation)}`,
    `CH${id}:SCALE ${formatNumber(channel.scaleVPerDiv)}`,
    `CH${id}:POSITION ${formatNumber(channel.positionDiv)}`,
    `CH${id}:COUPLING ${channel.coupling}`,
    `CH${id}:BANDWIDTH ${channel.bandwidthLimited ? 'TWENTY' : 'FULL'}`,
  ];
}

export function encodeHorizontal(horizontal: HorizontalState): string[] {
  return [
    `HORIZONTAL:SCALE ${formatNumber(horizontal.scaleSPerDiv)}`,
    `HORIZONTAL:POSITION ${formatNumber(horizontal.positionS)}`,
  ];
}

export function encodeTrigger(trigger: TriggerState): string[] {
  return [
    `TRIGGER:MAIN:EDGE:SOURCE ${trigger.source}`,
    `TRIGGER:MAIN:EDGE:SLOPE ${trigger.slope}`,
    `TRIGGER:MAIN:MODE ${trigger.mode}`,
    `TRIGGER:MAIN:LEVEL ${formatNumber(trigger.levelV)}`,
  ];
}

/**
 * ACQuire:STOPAfter and ACQuire:STATE together decide run/stop.
 *
 * RUNSTOP means free-running; SEQUENCE plus STATE RUN is the single-shot the
 * SINGLE button gives you. They are sent as a pair because setting STATE alone
 * leaves the previous stop-after mode in force.
 */
export function encodeAcquisition(acquisition: AcquisitionState): string[] {
  return [
    `ACQUIRE:MODE ${acquisition.mode}`,
    `ACQUIRE:NUMAVG ${Math.round(acquisition.averages)}`,
    'ACQUIRE:STOPAFTER RUNSTOP',
    `ACQUIRE:STATE ${acquisition.running ? 'RUN' : 'STOP'}`,
  ];
}

/** Arm a single acquisition and stop. */
export const SINGLE_SHOT: readonly string[] = [
  'ACQUIRE:STOPAFTER SEQUENCE',
  'ACQUIRE:STATE RUN',
];

/** Every setting, for the initial push and for "Push all settings". */
export function encodeAll(state: InstrumentState): string[] {
  return [
    ...encodeChannel(1, state.ch1),
    ...encodeChannel(2, state.ch2),
    ...encodeHorizontal(state.horizontal),
    ...encodeTrigger(state.trigger),
    ...encodeAcquisition(state.acquisition),
  ];
}

/* ----------------------------------------------------------------- diff --- */

/**
 * Keep only the commands whose value changed.
 *
 * Both sides are encoded in full and compared by key, rather than each field
 * being compared by hand. That way adding a parameter to `encodeChannel` cannot
 * leave a stale hand-written diff behind.
 */
function diffCommands(before: readonly string[], after: readonly string[]): string[] {
  const previous = new Map(before.map((command) => [commandKey(command), command]));
  return after.filter((command) => previous.get(commandKey(command)) !== command);
}

export function diffChannel(id: ChannelId, before: ChannelState, after: ChannelState): string[] {
  return diffCommands(encodeChannel(id, before), encodeChannel(id, after));
}

export function diffAll(before: InstrumentState, after: InstrumentState): string[] {
  return diffCommands(encodeAll(before), encodeAll(after));
}

/* -------------------------------------------------------------- queries --- */

/**
 * Prepare a waveform transfer.
 *
 * RIBINARY at WIDTH 1 is signed 8-bit, which is the instrument's native
 * resolution - asking for WIDTH 2 gets the same information padded, at twice the
 * transfer size. START/STOP are set explicitly because they persist across
 * sessions and a previous user may have left a partial range in place.
 */
export function waveformSetup(source: ChannelId, points: number = RECORD_LENGTH): string[] {
  return [
    `DATA:SOURCE CH${source}`,
    'DATA:ENCDG RIBINARY',
    'DATA:WIDTH 1',
    'DATA:START 1',
    `DATA:STOP ${Math.round(points)}`,
  ];
}

export const CURVE_QUERY = 'CURVE?';

/**
 * Preamble fields needed to turn raw codes into volts and seconds.
 *
 * Queried one at a time rather than with a bare `WFMPRE?`, whose comma-separated
 * field order differs between firmware revisions. A handful of short queries is
 * slower but cannot silently misassign a scale factor.
 */
export const PREAMBLE_FIELDS = [
  'NR_PT', 'XINCR', 'XZERO', 'PT_OFF', 'XUNIT',
  'YMULT', 'YZERO', 'YOFF', 'YUNIT',
] as const;
export type PreambleField = (typeof PREAMBLE_FIELDS)[number];

export function preambleQuery(field: PreambleField): string {
  return `WFMPRE:${field}?`;
}

export function measurementSetup(source: ChannelId, type: MeasurementTypeCode): string[] {
  return [`MEASUREMENT:IMMED:SOURCE CH${source}`, `MEASUREMENT:IMMED:TYPE ${type}`];
}

export const MEASUREMENT_VALUE_QUERY = 'MEASUREMENT:IMMED:VALUE?';

/**
 * Ask for the scope's own screen.
 *
 * Which formats this firmware accepts is unverified - see docs/PROTOCOL.md. The
 * caller tries the list in order and keeps the first that answers.
 */
export function screenshotSetup(format: string): string[] {
  return [`SAVE:IMAGE:FILEFORMAT ${format}`];
}

export const SCREENSHOT_QUERY = 'HARDCOPY START';

export const IDENTITY_QUERY = '*IDN?';
export const ERROR_QUERY = 'EVMSG?';

/**
 * Image formats to try for a screen capture, best first.
 *
 * PNG is listed first because browsers render it without help and it is what a
 * lab report wants; BMP is the fallback because browsers decode that natively
 * too. PCX and TIFF appear in the manual but neither displays in a browser, so
 * they are not offered. Which of these the firmware actually accepts is
 * unverified - see docs/PROTOCOL.md.
 */
export const SCREENSHOT_FORMATS: readonly string[] = ['PNG', 'BMP'];

/**
 * One front-panel value read back from the instrument.
 *
 * Each entry carries its own `apply`, so the query and the assignment cannot
 * drift apart the way two parallel lists would. `apply` is pure, which is what
 * lets test/scpi.test.ts check the whole readback path without a scope.
 */
export interface Readback {
  command: string;
  apply(state: InstrumentState, reply: string): void;
}

/**
 * Read the whole front panel back.
 *
 * Used after someone has turned the physical knobs: the page's idea of the
 * instrument is otherwise write-only, and would quietly overwrite their changes
 * on the next update.
 */
export function readbackPlan(): Readback[] {
  const plan: Readback[] = [];

  for (const id of [1, 2] as const) {
    const key = channelKey(id);
    plan.push(
      {
        command: `SELECT:CH${id}?`,
        apply: (state, reply) => {
          state[key].enabled = parseBoolean(reply);
        },
      },
      {
        command: `CH${id}:PROBE?`,
        apply: (state, reply) => {
          const value = parseNumber(reply);
          if (Number.isFinite(value)) state[key].probeAttenuation = value;
        },
      },
      {
        command: `CH${id}:SCALE?`,
        apply: (state, reply) => {
          const value = parseNumber(reply);
          if (Number.isFinite(value)) state[key].scaleVPerDiv = value;
        },
      },
      {
        command: `CH${id}:POSITION?`,
        apply: (state, reply) => {
          const value = parseNumber(reply);
          if (Number.isFinite(value)) state[key].positionDiv = value;
        },
      },
      {
        command: `CH${id}:COUPLING?`,
        apply: (state, reply) => {
          const value = matchEnum(reply, ['DC', 'AC', 'GND'] as const);
          if (value) state[key].coupling = value;
        },
      },
      {
        command: `CH${id}:BANDWIDTH?`,
        apply: (state, reply) => {
          const value = matchEnum(reply, ['FULL', 'TWENTY'] as const);
          if (value) state[key].bandwidthLimited = value === 'TWENTY';
        },
      },
    );
  }

  plan.push(
    {
      command: 'HORIZONTAL:SCALE?',
      apply: (state, reply) => {
        const value = parseNumber(reply);
        if (Number.isFinite(value)) state.horizontal.scaleSPerDiv = value;
      },
    },
    {
      command: 'HORIZONTAL:POSITION?',
      apply: (state, reply) => {
        const value = parseNumber(reply);
        if (Number.isFinite(value)) state.horizontal.positionS = value;
      },
    },
    {
      command: 'TRIGGER:MAIN:EDGE:SOURCE?',
      apply: (state, reply) => {
        const value = matchEnum(reply, ['CH1', 'CH2', 'EXT', 'EXT5', 'LINE'] as const);
        if (value) state.trigger.source = value;
      },
    },
    {
      command: 'TRIGGER:MAIN:EDGE:SLOPE?',
      apply: (state, reply) => {
        const value = matchEnum(reply, ['RISE', 'FALL'] as const);
        if (value) state.trigger.slope = value;
      },
    },
    {
      command: 'TRIGGER:MAIN:MODE?',
      apply: (state, reply) => {
        const value = matchEnum(reply, ['AUTO', 'NORMAL'] as const);
        if (value) state.trigger.mode = value;
      },
    },
    {
      command: 'TRIGGER:MAIN:LEVEL?',
      apply: (state, reply) => {
        const value = parseNumber(reply);
        if (Number.isFinite(value)) state.trigger.levelV = value;
      },
    },
    {
      command: 'ACQUIRE:MODE?',
      apply: (state, reply) => {
        const value = matchEnum(reply, ['SAMPLE', 'PEAKDETECT', 'AVERAGE'] as const);
        if (value) state.acquisition.mode = value;
      },
    },
    {
      command: 'ACQUIRE:NUMAVG?',
      apply: (state, reply) => {
        const value = parseNumber(reply);
        if (Number.isFinite(value)) state.acquisition.averages = value;
      },
    },
    {
      command: 'ACQUIRE:STATE?',
      apply: (state, reply) => {
        state.acquisition.running = parseBoolean(reply);
      },
    },
  );

  return plan;
}

/* -------------------------------------------------------------- parsing --- */

/**
 * Read a number out of a reply.
 *
 * Returns NaN rather than throwing: a single unparseable readback should leave
 * that one control alone, not abandon the whole sync.
 */
export function parseNumber(reply: string): number {
  const match = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(reply.trim());
  return match ? Number(match[0]) : NaN;
}

/** The scope answers boolean queries with 1/0, and sometimes ON/OFF. */
export function parseBoolean(reply: string): boolean {
  const text = reply.trim().toUpperCase();
  return text === '1' || text === 'ON' || text === 'RUN' || text === 'TRUE';
}

/**
 * Match an enumerated reply, allowing the abbreviated form.
 *
 * Verified 2026-09-14: under `VERBOSE OFF` this instrument answers enumerations
 * with the minimum-length keyword - `ACQUIRE:MODE?` returns `SAM`, not `SAMPLE`.
 * Comparing against the full word therefore rejects every valid reply, and
 * because a rejected readback is silently skipped, the failure looks like the
 * control simply refusing to update.
 *
 * Exact matches win before prefixes, which is what keeps `EXT` from being
 * ambiguous with `EXT5`. An abbreviation matching more than one value returns
 * null rather than guessing.
 */
export function matchEnum<T extends string>(reply: string, allowed: readonly T[]): T | null {
  const text = reply.trim().toUpperCase();
  if (text.length === 0) return null;

  const exact = allowed.find((value) => value === text);
  if (exact !== undefined) return exact;

  const candidates = allowed.filter((value) => value.startsWith(text));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export interface Identity {
  vendor: string;
  model: string;
  serial: string;
  firmware: string;
}

/** `*IDN?` answers 'TEKTRONIX,TBS 1072B-EDU,C011239,CF:91.1CT FV:v24.31'. */
export function parseIdentity(reply: string): Identity {
  const [vendor = '', model = '', serial = '', firmware = ''] = reply
    .trim()
    .split(',')
    .map((field) => field.trim());
  return { vendor, model, serial, firmware };
}
