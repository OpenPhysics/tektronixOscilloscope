/**
 * The single source of truth for what the instrument has been told.
 *
 * Every change flows through `update`, which hands subscribers both the old and
 * new state. That is what lets main.ts diff them and transmit only the commands
 * that actually changed, instead of resending the whole front panel on every
 * drag of a slider.
 *
 * Captures deliberately do not live here. A single 2500-point record is 40 kB of
 * Float64Array, and localStorage would be full after a handful of them; main.ts
 * keeps them in memory for the life of the page instead.
 */

import {
  clampAverages, clampHorizontalPosition, clampHorizontalScale, clampPositionDiv,
  clampProbeAttenuation, clampTriggerLevel, clampVerticalScale,
} from './device/limits.ts';
import {
  channelKey, defaultInstrumentState,
  type ChannelId, type ChannelState, type InstrumentState, type MeasurementTypeCode,
} from './device/types.ts';

export interface AppState {
  instrument: InstrumentState;
  /** Which channel the capture and measurement panels act on. */
  activeChannel: ChannelId;
  /** Measurement types shown in the readout panel, in display order. */
  measurements: MeasurementTypeCode[];
  /** Poll measurements continuously rather than on demand. */
  liveMeasurements: boolean;
}

export type Listener = (next: AppState, prev: AppState) => void;

const STORAGE_KEY = 'tbs1072b.settings.v1';

function initialState(): AppState {
  return {
    instrument: defaultInstrumentState(),
    activeChannel: 1,
    measurements: ['FREQUENCY', 'PK2PK', 'CRMS', 'MEAN'],
    liveMeasurements: false,
  };
}

export class Store {
  private state: AppState = initialState();
  private listeners = new Set<Listener>();

  constructor() {
    this.restore();
  }

  get(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply a mutation to a draft, then notify with both versions. */
  update(mutate: (draft: AppState) => void): void {
    const prev = this.state;
    const draft = structuredClone(prev);
    mutate(draft);
    this.normalise(draft);
    this.state = draft;
    this.persist();
    for (const listener of this.listeners) listener(draft, prev);
  }

  /** Convenience for the common case of editing one channel. */
  updateChannel(id: ChannelId, mutate: (channel: ChannelState) => void): void {
    this.update((draft) => {
      mutate(draft.instrument[channelKey(id)]);
    });
  }

  /**
   * Replace the instrument state wholesale, as after reading the front panel back.
   *
   * Goes through `update` so the same clamping and the same notification happen
   * as for any other change - a readback is not exempt from being a legal state.
   */
  replaceInstrument(instrument: InstrumentState): void {
    this.update((draft) => {
      draft.instrument = instrument;
    });
  }

  /**
   * Force every value into something the instrument can actually do.
   *
   * This runs on every update rather than at the input layer, so a value that
   * became illegal indirectly - a trigger level that fell off screen because the
   * VOLTS/DIV changed under it - is corrected too.
   */
  private normalise(draft: AppState): void {
    const instrument = draft.instrument;

    for (const key of ['ch1', 'ch2'] as const) {
      const channel = instrument[key];
      channel.probeAttenuation = clampProbeAttenuation(channel.probeAttenuation);
      channel.scaleVPerDiv = clampVerticalScale(
        channel.scaleVPerDiv,
        channel.probeAttenuation,
      );
      channel.positionDiv = clampPositionDiv(channel.positionDiv);
    }

    instrument.horizontal.scaleSPerDiv = clampHorizontalScale(
      instrument.horizontal.scaleSPerDiv,
    );
    instrument.horizontal.positionS = clampHorizontalPosition(
      instrument.horizontal.positionS,
      instrument.horizontal.scaleSPerDiv,
    );

    // The trigger level is bounded by the window of whichever channel triggers,
    // so it has to be clamped after the vertical settings have settled.
    const source = instrument.trigger.source === 'CH2' ? instrument.ch2 : instrument.ch1;
    instrument.trigger.levelV = clampTriggerLevel(
      instrument.trigger.levelV,
      source.scaleVPerDiv,
      source.positionDiv,
    );

    instrument.acquisition.averages = clampAverages(instrument.acquisition.averages);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Private windows and blocked site data both throw here. Losing the
      // remembered settings is not worth breaking the page over.
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<AppState>;
      const merged: AppState = { ...initialState(), ...saved };
      // Guard against a stale or hand-edited payload.
      if (!merged.instrument?.ch1 || !merged.instrument?.ch2) return;
      if (!merged.instrument.horizontal || !merged.instrument.trigger) return;
      this.normalise(merged);
      this.state = merged;
    } catch {
      // Corrupt payload: fall back to defaults rather than failing to start.
    }
  }
}
