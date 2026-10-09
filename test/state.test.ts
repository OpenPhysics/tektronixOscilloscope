/**
 * What this browser is allowed to remember.
 *
 * The front panel belongs to the scope. A saved probe or volts/div would be
 * shown before connect and, on "Push all settings", written back over the
 * bench. These tests pin that the page choices survive a reload and the
 * instrument block does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultInstrumentState } from '../src/device/types.ts';
import { Store } from '../src/state.ts';

const STORAGE_KEY = 'tbs1072b.preferences.v2';
const LEGACY_STORAGE_KEY = 'tbs1072b.settings.v1';

function installMemoryStorage(): Map<string, string> {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  });
  return memory;
}

describe('store persistence', () => {
  let memory: Map<string, string>;

  beforeEach(() => {
    memory = installMemoryStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('remembers page choices and forgets the front panel', () => {
    const store = new Store();
    store.update((draft) => {
      draft.activeChannel = 2;
      draft.liveMeasurements = true;
      draft.measurements = ['FREQUENCY'];
      draft.instrument.ch1.probeAttenuation = 1;
      draft.instrument.ch1.scaleVPerDiv = 0.2;
    });

    const saved = JSON.parse(memory.get(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(saved).toEqual({
      activeChannel: 2,
      measurements: ['FREQUENCY'],
      liveMeasurements: true,
    });

    const reloaded = new Store();
    expect(reloaded.get().activeChannel).toBe(2);
    expect(reloaded.get().liveMeasurements).toBe(true);
    expect(reloaded.get().measurements).toEqual(['FREQUENCY']);
    expect(reloaded.get().instrument).toEqual(defaultInstrumentState());
  });

  it('drops a legacy front panel instead of restoring it', () => {
    memory.set(LEGACY_STORAGE_KEY, JSON.stringify({
      activeChannel: 2,
      measurements: ['PK2PK'],
      liveMeasurements: false,
      instrument: {
        ch1: { probeAttenuation: 1, scaleVPerDiv: 5 },
        ch2: { probeAttenuation: 1, scaleVPerDiv: 2 },
      },
    }));

    const store = new Store();
    expect(store.get().activeChannel).toBe(2);
    expect(store.get().measurements).toEqual(['PK2PK']);
    expect(store.get().liveMeasurements).toBe(false);
    expect(store.get().instrument).toEqual(defaultInstrumentState());
    expect(memory.has(LEGACY_STORAGE_KEY)).toBe(false);

    const saved = JSON.parse(memory.get(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(saved).not.toHaveProperty('instrument');
    expect(saved['activeChannel']).toBe(2);
  });

  it('keeps the default measurements when a saved list contains an unknown code', () => {
    memory.set(STORAGE_KEY, JSON.stringify({
      activeChannel: 1,
      measurements: ['FREQUENCY', 'NOT_A_TYPE'],
      liveMeasurements: true,
    }));

    const store = new Store();
    expect(store.get().measurements).toEqual(['FREQUENCY', 'PK2PK', 'CRMS', 'MEAN']);
    expect(store.get().liveMeasurements).toBe(true);
  });
});
