/**
 * Shared vocabulary for the TBS1072B-EDU. No I/O, no DOM.
 *
 * Values are stored in SI units with the unit in the field name - `scaleVPerDiv`,
 * `levelV`, `scaleSPerDiv` - because the SCPI layer sends SI and the UI displays
 * engineering notation. Converting in exactly one place (ui/format.ts) keeps
 * unit-conversion bugs out of the protocol.
 */

export const CHANNELS = [1, 2] as const;
export type ChannelId = (typeof CHANNELS)[number];

/** Key into InstrumentState for a channel, so callers never build 'ch1' by hand. */
export function channelKey(id: ChannelId): 'ch1' | 'ch2' {
  return id === 1 ? 'ch1' : 'ch2';
}

export const Coupling = {
  dc: 'DC',
  ac: 'AC',
  ground: 'GND',
} as const;
export type CouplingCode = (typeof Coupling)[keyof typeof Coupling];

export const TriggerSlope = {
  rising: 'RISE',
  falling: 'FALL',
} as const;
export type TriggerSlopeCode = (typeof TriggerSlope)[keyof typeof TriggerSlope];

export const TriggerMode = {
  auto: 'AUTO',
  normal: 'NORMAL',
} as const;
export type TriggerModeCode = (typeof TriggerMode)[keyof typeof TriggerMode];

export const TriggerSource = {
  ch1: 'CH1',
  ch2: 'CH2',
  ext: 'EXT',
  ext5: 'EXT5',
  line: 'LINE',
} as const;
export type TriggerSourceCode = (typeof TriggerSource)[keyof typeof TriggerSource];

export const AcquireMode = {
  sample: 'SAMPLE',
  peakDetect: 'PEAKDETECT',
  average: 'AVERAGE',
} as const;
export type AcquireModeCode = (typeof AcquireMode)[keyof typeof AcquireMode];

/**
 * Measurement types offered by MEASUrement:IMMed:TYPe.
 *
 * The instrument supports more than these; this is the subset that is
 * meaningful on every signal a teaching lab is likely to put on the screen.
 */
export const MEASUREMENT_TYPES = [
  { code: 'FREQUENCY', label: 'Frequency', unit: 'Hz' },
  { code: 'PERIOD', label: 'Period', unit: 's' },
  { code: 'PK2PK', label: 'Peak-to-peak', unit: 'V' },
  { code: 'CRMS', label: 'RMS (cycle)', unit: 'V' },
  { code: 'MEAN', label: 'Mean', unit: 'V' },
  { code: 'MINIMUM', label: 'Minimum', unit: 'V' },
  { code: 'MAXIMUM', label: 'Maximum', unit: 'V' },
  { code: 'RISE', label: 'Rise time', unit: 's' },
  { code: 'FALL', label: 'Fall time', unit: 's' },
] as const;
export type MeasurementTypeCode = (typeof MEASUREMENT_TYPES)[number]['code'];

export interface ChannelState {
  enabled: boolean;
  scaleVPerDiv: number;
  positionDiv: number;
  coupling: CouplingCode;
  /** Probe attenuation as a ratio: 1, 10, 100 or 1000. */
  probeAttenuation: number;
  bandwidthLimited: boolean;
}

export interface HorizontalState {
  scaleSPerDiv: number;
  /** Trigger point offset from the centre of the screen, in seconds. */
  positionS: number;
}

export interface TriggerState {
  source: TriggerSourceCode;
  slope: TriggerSlopeCode;
  levelV: number;
  mode: TriggerModeCode;
}

export interface AcquisitionState {
  mode: AcquireModeCode;
  /** Only meaningful when mode is AVERAGE. The instrument accepts 4, 16, 64 or 128. */
  averages: number;
  running: boolean;
}

export interface InstrumentState {
  ch1: ChannelState;
  ch2: ChannelState;
  horizontal: HorizontalState;
  trigger: TriggerState;
  acquisition: AcquisitionState;
}

function defaultChannelState(): ChannelState {
  return {
    enabled: true,
    scaleVPerDiv: 1,
    positionDiv: 0,
    coupling: Coupling.dc,
    probeAttenuation: 10,
    bandwidthLimited: false,
  };
}

/**
 * A safe starting point, not a read of the instrument.
 *
 * The page pushes these on connect so that what is on screen and what is in the
 * scope agree; "Read from instrument" goes the other way when you have been
 * using the front panel.
 */
export function defaultInstrumentState(): InstrumentState {
  return {
    ch1: defaultChannelState(),
    ch2: { ...defaultChannelState(), enabled: false },
    horizontal: { scaleSPerDiv: 500e-6, positionS: 0 },
    trigger: {
      source: TriggerSource.ch1,
      slope: TriggerSlope.rising,
      levelV: 0,
      mode: TriggerMode.auto,
    },
    acquisition: {
      mode: AcquireMode.sample,
      averages: 16,
      running: true,
    },
  };
}
