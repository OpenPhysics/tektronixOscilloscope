/**
 * The command language.
 *
 * A misspelt SCPI keyword is accepted silently by the instrument and simply does
 * nothing, so these tests pin the exact strings that go on the wire. They cannot
 * prove the instrument understands them - only tools/probe.py can do that - but
 * they do prevent a refactor from quietly changing one.
 */

import { describe, expect, it } from 'vitest';

import {
  SESSION_SETUP, commandKey, diffAll, encodeAcquisition, encodeAll, encodeChannel,
  encodeHorizontal, encodeTrigger, formatNumber, isPlausibleCommand, matchEnum,
  parseBoolean, parseIdentity, parseNumber, readbackPlan, waveformSetup,
} from '../src/device/scpi.ts';
import { defaultInstrumentState } from '../src/device/types.ts';

describe('session setup', () => {
  it('turns headers off, without which every query reply is unparseable', () => {
    expect(SESSION_SETUP).toContain('HEADER OFF');
  });

  it('leaves the front panel unlocked so the bench stays usable', () => {
    expect(SESSION_SETUP).toContain('LOCK NONE');
  });
});

describe('number formatting', () => {
  it('uses exponential notation, which spans 5 ns to 50 s without losing digits', () => {
    expect(formatNumber(0.5)).toBe('5.000000E-1');
    expect(formatNumber(5e-9)).toBe('5.000000E-9');
    expect(formatNumber(50)).toBe('5.000000E+1');
  });

  it('writes a plain zero rather than 0.000000E+0', () => {
    expect(formatNumber(0)).toBe('0');
  });

  it('degrades to zero instead of emitting NaN at the instrument', () => {
    expect(formatNumber(NaN)).toBe('0');
    expect(formatNumber(Infinity)).toBe('0');
  });
});

describe('command keys', () => {
  it('collapses every value of one parameter onto a single key', () => {
    expect(commandKey('CH1:SCALE 5.0E-1')).toBe('CH1:SCALE');
    expect(commandKey('CH1:SCALE 1.0E0')).toBe('CH1:SCALE');
  });

  it('distinguishes the two channels', () => {
    expect(commandKey('CH1:SCALE 1')).not.toBe(commandKey('CH2:SCALE 1'));
  });

  it('treats an argument-less command as its own key', () => {
    expect(commandKey('*CLS')).toBe('*CLS');
    expect(commandKey('CURVE?')).toBe('CURVE?');
  });
});

describe('channel encoding', () => {
  const state = defaultInstrumentState();

  it('sends display, probe, scale, position, coupling and bandwidth', () => {
    const commands = encodeChannel(1, state.ch1);
    expect(commands).toEqual([
      'SELECT:CH1 ON',
      'CH1:PROBE 1.000000E+1',
      'CH1:SCALE 1.000000E+0',
      'CH1:POSITION 0',
      'CH1:COUPLING DC',
      'CH1:BANDWIDTH FULL',
    ]);
  });

  it('sets the probe before the scale, since the scale is read at the probe tip', () => {
    const commands = encodeChannel(1, state.ch1);
    expect(commands.findIndex((c) => c.startsWith('CH1:PROBE')))
      .toBeLessThan(commands.findIndex((c) => c.startsWith('CH1:SCALE')));
  });

  it('spells the 20 MHz limit TWENTY, not ON', () => {
    const limited = { ...state.ch1, bandwidthLimited: true };
    expect(encodeChannel(2, limited)).toContain('CH2:BANDWIDTH TWENTY');
  });
});

describe('horizontal and trigger encoding', () => {
  const state = defaultInstrumentState();

  it('uses the unprefixed HORIZONTAL spelling', () => {
    expect(encodeHorizontal(state.horizontal)[0]).toMatch(/^HORIZONTAL:SCALE /);
  });

  it('sets the trigger source before the level it is bounded by', () => {
    const commands = encodeTrigger(state.trigger);
    expect(commands.findIndex((c) => c.includes('EDGE:SOURCE')))
      .toBeLessThan(commands.findIndex((c) => c.includes(':LEVEL')));
  });
});

describe('acquisition encoding', () => {
  it('pairs STOPAFTER with STATE, since STATE alone inherits the old mode', () => {
    const commands = encodeAcquisition(defaultInstrumentState().acquisition);
    expect(commands).toContain('ACQUIRE:STOPAFTER RUNSTOP');
    expect(commands).toContain('ACQUIRE:STATE RUN');
  });

  it('stops when asked to', () => {
    const stopped = { ...defaultInstrumentState().acquisition, running: false };
    expect(encodeAcquisition(stopped)).toContain('ACQUIRE:STATE STOP');
  });

  it('rounds the averaging count, which must be an integer', () => {
    const averaged = { ...defaultInstrumentState().acquisition, averages: 15.7 };
    expect(encodeAcquisition(averaged)).toContain('ACQUIRE:NUMAVG 16');
  });
});

describe('diffing', () => {
  it('sends nothing when nothing changed', () => {
    const state = defaultInstrumentState();
    expect(diffAll(state, structuredClone(state))).toEqual([]);
  });

  it('sends only the parameter that moved', () => {
    const before = defaultInstrumentState();
    const after = structuredClone(before);
    after.ch1.scaleVPerDiv = 0.5;
    expect(diffAll(before, after)).toEqual(['CH1:SCALE 5.000000E-1']);
  });

  it('does not leak a change on one channel into the other', () => {
    const before = defaultInstrumentState();
    const after = structuredClone(before);
    after.ch2.coupling = 'AC';
    expect(diffAll(before, after)).toEqual(['CH2:COUPLING AC']);
  });

  it('covers every parameter, so adding one cannot be forgotten', () => {
    // Encoding the default state from scratch must produce exactly as many
    // commands as diffing against a state where everything differs.
    const before = defaultInstrumentState();
    const after = structuredClone(before);
    after.ch1.enabled = false;
    after.ch1.scaleVPerDiv = 0.5;
    after.ch1.positionDiv = 1;
    after.ch1.coupling = 'AC';
    after.ch1.probeAttenuation = 1;
    after.ch1.bandwidthLimited = true;
    expect(diffAll(before, after)).toHaveLength(encodeChannel(1, after.ch1).length);
  });
});

describe('waveform setup', () => {
  const commands = waveformSetup(1);

  it('selects the source, encoding, width and range', () => {
    expect(commands).toEqual([
      'DATA:SOURCE CH1',
      'DATA:ENCDG RIBINARY',
      'DATA:WIDTH 1',
      'DATA:START 1',
      'DATA:STOP 2500',
    ]);
  });

  it('sets START and STOP explicitly, because they persist between sessions', () => {
    expect(commands).toContain('DATA:START 1');
  });

  it('honours a shorter record when one is asked for', () => {
    expect(waveformSetup(2, 1000)).toContain('DATA:STOP 1000');
  });
});

describe('reply parsing', () => {
  it('reads the exponential form the instrument answers with', () => {
    expect(parseNumber('5.0E-1')).toBeCloseTo(0.5, 12);
    expect(parseNumber('-2.5000E+1')).toBeCloseTo(-25, 12);
  });

  it('survives a stray header if HEADER OFF was somehow missed', () => {
    expect(parseNumber(':CH1:SCALE 5.0E-1')).toBeCloseTo(1, 12);
  });

  it('returns NaN rather than throwing on a reply it cannot read', () => {
    expect(parseNumber('')).toBeNaN();
    expect(parseNumber('ERROR')).toBeNaN();
  });

  it('accepts every truthy spelling the instrument uses', () => {
    expect(parseBoolean('1')).toBe(true);
    expect(parseBoolean('ON')).toBe(true);
    expect(parseBoolean('RUN')).toBe(true);
    expect(parseBoolean('0')).toBe(false);
    expect(parseBoolean('OFF')).toBe(false);
    expect(parseBoolean('STOP')).toBe(false);
  });

  it('splits an identity string into its four fields', () => {
    // The exact string this instrument returned on 2026-09-14.
    const identity = parseIdentity('TEKTRONIX,TBS 1072B-EDU,C011239,CF:91.1CT FV:v2.52');
    expect(identity.vendor).toBe('TEKTRONIX');
    expect(identity.model).toBe('TBS 1072B-EDU');
    expect(identity.serial).toBe('C011239');
    expect(identity.firmware).toBe('CF:91.1CT FV:v2.52');
  });
});

describe('readback', () => {
  it('asks about every parameter the page can set', () => {
    const commands = readbackPlan().map((item) => item.command);
    expect(commands).toContain('CH1:SCALE?');
    expect(commands).toContain('CH2:COUPLING?');
    expect(commands).toContain('HORIZONTAL:SCALE?');
    expect(commands).toContain('TRIGGER:MAIN:LEVEL?');
    expect(commands).toContain('ACQUIRE:STATE?');
  });

  it('applies replies into the right fields', () => {
    const state = defaultInstrumentState();
    const plan = readbackPlan();
    const apply = (command: string, reply: string): void => {
      plan.find((item) => item.command === command)?.apply(state, reply);
    };

    apply('CH1:SCALE?', '5.0E-1');
    apply('CH2:COUPLING?', 'AC');
    apply('HORIZONTAL:SCALE?', '1.0E-3');
    apply('TRIGGER:MAIN:EDGE:SLOPE?', 'FALL');
    apply('ACQUIRE:STATE?', '0');

    expect(state.ch1.scaleVPerDiv).toBeCloseTo(0.5, 12);
    expect(state.ch2.coupling).toBe('AC');
    expect(state.horizontal.scaleSPerDiv).toBeCloseTo(1e-3, 12);
    expect(state.trigger.slope).toBe('FALL');
    expect(state.acquisition.running).toBe(false);
  });

  it('leaves a field alone when the reply is unreadable', () => {
    // One bad reply should cost one control, not abandon the whole sync.
    const state = defaultInstrumentState();
    const before = state.ch1.scaleVPerDiv;
    readbackPlan().find((item) => item.command === 'CH1:SCALE?')?.apply(state, 'ERROR');
    expect(state.ch1.scaleVPerDiv).toBe(before);
  });

  it('ignores an out-of-vocabulary enumeration rather than storing it', () => {
    const state = defaultInstrumentState();
    readbackPlan().find((item) => item.command === 'CH1:COUPLING?')?.apply(state, 'XYZ');
    expect(state.ch1.coupling).toBe('DC');
  });

  it('accepts the abbreviated keywords the instrument actually sends', () => {
    // Verified 2026-09-14 on a TBS1072B-EDU, firmware FV:v2.52: under VERBOSE
    // OFF, `ACQUIRE:MODE?` answers `SAM`, not `SAMPLE`. Comparing against the
    // full word rejected every valid reply, and a rejected readback is skipped
    // silently - so the control just never updated.
    const state = defaultInstrumentState();
    const plan = readbackPlan();
    const apply = (command: string, reply: string): void => {
      plan.find((item) => item.command === command)?.apply(state, reply);
    };

    apply('ACQUIRE:MODE?', 'SAM');
    expect(state.acquisition.mode).toBe('SAMPLE');

    apply('ACQUIRE:MODE?', 'PEAK');
    expect(state.acquisition.mode).toBe('PEAKDETECT');

    apply('ACQUIRE:MODE?', 'AVE');
    expect(state.acquisition.mode).toBe('AVERAGE');

    apply('TRIGGER:MAIN:EDGE:SLOPE?', 'RIS');
    expect(state.trigger.slope).toBe('RISE');

    apply('TRIGGER:MAIN:MODE?', 'NORM');
    expect(state.trigger.mode).toBe('NORMAL');

    apply('CH1:BANDWIDTH?', 'TWE');
    expect(state.ch1.bandwidthLimited).toBe(true);
  });

  it('reads back the bandwidth limit, which it also sets', () => {
    // Every parameter encodeChannel sends should be readable, or the page can
    // show a bandwidth the instrument is not using.
    const commands = readbackPlan().map((item) => item.command);
    expect(commands).toContain('CH1:BANDWIDTH?');
    expect(commands).toContain('CH2:BANDWIDTH?');
  });
});

describe('matchEnum', () => {
  it('takes an exact match in preference to a prefix', () => {
    // EXT is a prefix of EXT5, so without exact-first the scope saying "EXT"
    // would be ambiguous and silently dropped.
    expect(matchEnum('EXT', ['CH1', 'CH2', 'EXT', 'EXT5', 'LINE'])).toBe('EXT');
    expect(matchEnum('EXT5', ['CH1', 'CH2', 'EXT', 'EXT5', 'LINE'])).toBe('EXT5');
  });

  it('resolves an unambiguous abbreviation', () => {
    expect(matchEnum('SAM', ['SAMPLE', 'PEAKDETECT', 'AVERAGE'])).toBe('SAMPLE');
  });

  it('refuses an ambiguous abbreviation rather than guessing', () => {
    expect(matchEnum('A', ['AUTO', 'AVERAGE'])).toBeNull();
  });

  it('is case and whitespace insensitive', () => {
    expect(matchEnum('  sam \n', ['SAMPLE'])).toBe('SAMPLE');
  });

  it('returns null for an empty or unknown reply', () => {
    expect(matchEnum('', ['SAMPLE'])).toBeNull();
    expect(matchEnum('XYZ', ['SAMPLE'])).toBeNull();
  });
});

describe('raw console screening', () => {
  it('accepts ordinary commands and queries', () => {
    expect(isPlausibleCommand('*IDN?')).toBe(true);
    expect(isPlausibleCommand('CH1:SCALE 0.5')).toBe(true);
    expect(isPlausibleCommand(':MEASUREMENT:IMMED:VALUE?')).toBe(true);
  });

  it('rejects empty input and control characters', () => {
    expect(isPlausibleCommand('   ')).toBe(false);
    expect(isPlausibleCommand('CH1:SCALE 1')).toBe(false);
  });

  it('rejects something that plainly is not a command', () => {
    expect(isPlausibleCommand('123')).toBe(false);
  });
});

describe('the whole front panel', () => {
  it('encodes without producing a duplicate key', () => {
    const commands = encodeAll(defaultInstrumentState());
    const keys = commands.map(commandKey);
    // A duplicate key would mean the queue silently drops one of the two.
    expect(new Set(keys).size).toBe(keys.length);
  });
});
