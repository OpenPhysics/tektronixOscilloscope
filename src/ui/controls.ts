/**
 * The front-panel controls: channels, timebase, trigger, acquisition.
 *
 * Every panel is a plain class that builds its own nodes, exposes `root`, and
 * has a `refresh()` that pulls current values out of the store. Nothing here
 * talks to the instrument - panels mutate the store, main.ts notices and sends
 * the difference. That indirection is what lets the page stay usable, and stay
 * honest about what it has sent, while disconnected.
 *
 * Scales are `<select>` elements rather than sliders because the instrument
 * only accepts ladder values; offering a continuous control would invite values
 * it silently rounds away.
 */

import {
  AVERAGE_COUNTS, HORIZONTAL_SCALES_S, PROBE_ATTENUATIONS, VERTICAL_DIVISIONS,
  VERTICAL_SCALES_V,
} from '../device/limits.ts';
import {
  AcquireMode, CHANNELS, Coupling, TriggerMode, TriggerSlope, TriggerSource,
  channelKey, type AcquireModeCode, type ChannelId, type CouplingCode,
  type TriggerModeCode, type TriggerSlopeCode, type TriggerSourceCode,
} from '../device/types.ts';
import { type Store } from '../state.ts';
import { formatEngineering } from './format.ts';

let uniqueId = 0;
function nextId(prefix: string): string {
  uniqueId += 1;
  return `${prefix}-${uniqueId}`;
}

interface Option<T> {
  value: T;
  label: string;
}

/* ------------------------------------------------------------- widgets --- */

function panel(title: string, accent?: string): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel';
  if (accent) section.dataset['accent'] = accent;
  const heading = document.createElement('h3');
  heading.className = 'panel-title';
  heading.textContent = title;
  section.append(heading);
  return section;
}

function selectRow<T extends string | number>(
  label: string,
  options: readonly Option<T>[],
  onChange: (value: T) => void,
): {
  row: HTMLElement;
  select: HTMLSelectElement;
  setOptions: (next: readonly Option<T>[]) => void;
} {
  const id = nextId('select');
  const row = document.createElement('div');
  row.className = 'control-row';

  const labelElement = document.createElement('label');
  labelElement.className = 'control-label';
  labelElement.htmlFor = id;
  labelElement.textContent = label;

  const select = document.createElement('select');
  select.id = id;
  select.className = 'control-select';

  // A `<select>` only ever hands back a string, so the typed value has to be
  // recovered from this list. It is rebuilt alongside the DOM options rather
  // than captured once: the V/div ladder is filled in after construction, and a
  // stale list here means `change` finds no match and the control silently does
  // nothing.
  let current: readonly Option<T>[] = [];

  const setOptions = (next: readonly Option<T>[]): void => {
    current = next;
    select.replaceChildren();
    for (const option of next) {
      const element = document.createElement('option');
      element.value = String(option.value);
      element.textContent = option.label;
      select.append(element);
    }
  };
  setOptions(options);

  select.addEventListener('change', () => {
    const raw = select.value;
    const match = current.find((option) => String(option.value) === raw);
    if (match) onChange(match.value);
  });

  row.append(labelElement, select);
  return { row, select, setOptions };
}

function sliderRow(
  label: string,
  config: { min: number; max: number; step: number },
  format: (value: number) => string,
  onInput: (value: number) => void,
): { row: HTMLElement; input: HTMLInputElement; value: HTMLElement; refreshBounds: (c: { min: number; max: number; step: number }) => void } {
  const id = nextId('slider');
  const row = document.createElement('div');
  row.className = 'control-row control-row-slider';

  const labelElement = document.createElement('label');
  labelElement.className = 'control-label';
  labelElement.htmlFor = id;
  labelElement.textContent = label;

  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  input.className = 'control-slider';
  input.min = String(config.min);
  input.max = String(config.max);
  input.step = String(config.step);

  const value = document.createElement('output');
  value.className = 'control-value';
  value.htmlFor = id;

  input.addEventListener('input', () => {
    const parsed = Number(input.value);
    value.textContent = format(parsed);
    onInput(parsed);
  });

  row.append(labelElement, input, value);
  return {
    row,
    input,
    value,
    refreshBounds: (bounds) => {
      input.min = String(bounds.min);
      input.max = String(bounds.max);
      input.step = String(bounds.step);
    },
  };
}

function toggleRow(
  label: string,
  onChange: (checked: boolean) => void,
): { row: HTMLElement; input: HTMLInputElement } {
  const id = nextId('toggle');
  const row = document.createElement('div');
  row.className = 'control-row control-row-toggle';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.className = 'control-toggle';
  input.addEventListener('change', () => onChange(input.checked));

  const labelElement = document.createElement('label');
  labelElement.className = 'control-label';
  labelElement.htmlFor = id;
  labelElement.textContent = label;

  row.append(input, labelElement);
  return { row, input };
}

function verticalScaleOptions(attenuation: number): Option<number>[] {
  return VERTICAL_SCALES_V.map((scale) => ({
    value: scale * attenuation,
    label: `${formatEngineering(scale * attenuation, 'V')}/div`,
  }));
}

/* -------------------------------------------------------------- panels --- */

export class ChannelPanel {
  readonly root: HTMLElement;
  private readonly enabled: HTMLInputElement;
  private readonly scale: HTMLSelectElement;
  private readonly setScaleOptions: (options: readonly Option<number>[]) => void;
  private readonly position: HTMLInputElement;
  private readonly positionValue: HTMLElement;
  private readonly coupling: HTMLSelectElement;
  private readonly probe: HTMLSelectElement;
  private readonly bandwidth: HTMLInputElement;

  constructor(private readonly store: Store, private readonly id: ChannelId) {
    this.root = panel(`Channel ${id}`, `ch${id}`);

    const enabled = toggleRow('Display this channel', (checked) => {
      this.store.updateChannel(this.id, (channel) => {
        channel.enabled = checked;
      });
    });
    this.enabled = enabled.input;

    const scale = selectRow<number>('Volts / division', [], (value) => {
      this.store.updateChannel(this.id, (channel) => {
        channel.scaleVPerDiv = value;
      });
    });
    this.scale = scale.select;
    this.setScaleOptions = scale.setOptions;

    const limit = VERTICAL_DIVISIONS / 2;
    const position = sliderRow(
      'Vertical position',
      { min: -limit, max: limit, step: 0.02 },
      (value) => `${value.toFixed(2)} div`,
      (value) => {
        this.store.updateChannel(this.id, (channel) => {
          channel.positionDiv = value;
        });
      },
    );
    this.position = position.input;
    this.positionValue = position.value;

    const coupling = selectRow<CouplingCode>(
      'Coupling',
      [
        { value: Coupling.dc, label: 'DC' },
        { value: Coupling.ac, label: 'AC' },
        { value: Coupling.ground, label: 'Ground' },
      ],
      (value) => {
        this.store.updateChannel(this.id, (channel) => {
          channel.coupling = value;
        });
      },
    );
    this.coupling = coupling.select;

    const probe = selectRow<number>(
      'Probe attenuation',
      PROBE_ATTENUATIONS.map((factor) => ({ value: factor, label: `${factor}X` })),
      (value) => {
        this.store.updateChannel(this.id, (channel) => {
          channel.probeAttenuation = value;
        });
      },
    );
    this.probe = probe.select;

    const bandwidth = toggleRow('Limit bandwidth to 20 MHz', (checked) => {
      this.store.updateChannel(this.id, (channel) => {
        channel.bandwidthLimited = checked;
      });
    });
    this.bandwidth = bandwidth.input;

    this.root.append(
      enabled.row, scale.row, position.row, coupling.row, probe.row, bandwidth.row,
    );
    this.refresh();
  }

  refresh(): void {
    const channel = this.store.get().instrument[channelKey(this.id)];

    // The V/div ladder shifts with the probe, so the options are rebuilt rather
    // than merely reselected whenever the attenuation changes.
    const options = verticalScaleOptions(channel.probeAttenuation);
    const wanted = options.map((option) => String(option.value)).join('|');
    if (this.scale.dataset['ladder'] !== wanted) {
      this.setScaleOptions(options);
      this.scale.dataset['ladder'] = wanted;
    }

    this.enabled.checked = channel.enabled;
    this.scale.value = String(channel.scaleVPerDiv);
    this.position.value = String(channel.positionDiv);
    this.positionValue.textContent = `${channel.positionDiv.toFixed(2)} div`;
    this.coupling.value = channel.coupling;
    this.probe.value = String(channel.probeAttenuation);
    this.bandwidth.checked = channel.bandwidthLimited;
  }
}

export class HorizontalPanel {
  readonly root: HTMLElement;
  private readonly scale: HTMLSelectElement;
  private readonly position: HTMLInputElement;
  private readonly positionValue: HTMLElement;
  private readonly refreshBounds: (config: { min: number; max: number; step: number }) => void;

  constructor(private readonly store: Store) {
    this.root = panel('Horizontal');

    const scale = selectRow<number>(
      'Seconds / division',
      HORIZONTAL_SCALES_S.map((seconds) => ({
        value: seconds,
        label: `${formatEngineering(seconds, 's')}/div`,
      })),
      (value) => {
        this.store.update((draft) => {
          draft.instrument.horizontal.scaleSPerDiv = value;
        });
      },
    );
    this.scale = scale.select;

    const position = sliderRow(
      'Horizontal position',
      { min: -1, max: 1, step: 0.001 },
      (value) => formatEngineering(value, 's'),
      (value) => {
        this.store.update((draft) => {
          draft.instrument.horizontal.positionS = value;
        });
      },
    );
    this.position = position.input;
    this.positionValue = position.value;
    this.refreshBounds = position.refreshBounds;

    this.root.append(scale.row, position.row);
    this.refresh();
  }

  refresh(): void {
    const horizontal = this.store.get().instrument.horizontal;
    this.scale.value = String(horizontal.scaleSPerDiv);

    // The position slider is expressed in seconds, so its range has to follow
    // the timebase - five screens either way, in steps of a hundredth of a
    // division. A fixed range would be unusable at 5 ns/div and at 50 s/div both.
    const limit = horizontal.scaleSPerDiv * 50;
    this.refreshBounds({ min: -limit, max: limit, step: horizontal.scaleSPerDiv / 100 });
    this.position.value = String(horizontal.positionS);
    this.positionValue.textContent = formatEngineering(horizontal.positionS, 's');
  }
}

export class TriggerPanel {
  readonly root: HTMLElement;
  private readonly source: HTMLSelectElement;
  private readonly slope: HTMLSelectElement;
  private readonly mode: HTMLSelectElement;
  private readonly level: HTMLInputElement;
  private readonly levelValue: HTMLElement;
  private readonly refreshBounds: (config: { min: number; max: number; step: number }) => void;

  constructor(private readonly store: Store) {
    this.root = panel('Trigger');

    const source = selectRow<TriggerSourceCode>(
      'Source',
      [
        { value: TriggerSource.ch1, label: 'Channel 1' },
        { value: TriggerSource.ch2, label: 'Channel 2' },
        { value: TriggerSource.ext, label: 'External' },
        { value: TriggerSource.ext5, label: 'External / 5' },
        { value: TriggerSource.line, label: 'Mains line' },
      ],
      (value) => {
        this.store.update((draft) => {
          draft.instrument.trigger.source = value;
        });
      },
    );
    this.source = source.select;

    const slope = selectRow<TriggerSlopeCode>(
      'Slope',
      [
        { value: TriggerSlope.rising, label: 'Rising' },
        { value: TriggerSlope.falling, label: 'Falling' },
      ],
      (value) => {
        this.store.update((draft) => {
          draft.instrument.trigger.slope = value;
        });
      },
    );
    this.slope = slope.select;

    const mode = selectRow<TriggerModeCode>(
      'Mode',
      [
        { value: TriggerMode.auto, label: 'Auto' },
        { value: TriggerMode.normal, label: 'Normal' },
      ],
      (value) => {
        this.store.update((draft) => {
          draft.instrument.trigger.mode = value;
        });
      },
    );
    this.mode = mode.select;

    const level = sliderRow(
      'Level',
      { min: -1, max: 1, step: 0.001 },
      (value) => formatEngineering(value, 'V'),
      (value) => {
        this.store.update((draft) => {
          draft.instrument.trigger.levelV = value;
        });
      },
    );
    this.level = level.input;
    this.levelValue = level.value;
    this.refreshBounds = level.refreshBounds;

    this.root.append(source.row, slope.row, mode.row, level.row);
    this.refresh();
  }

  refresh(): void {
    const instrument = this.store.get().instrument;
    const trigger = instrument.trigger;
    this.source.value = trigger.source;
    this.slope.value = trigger.slope;
    this.mode.value = trigger.mode;

    // Bound the level by the source channel's visible window; a level off screen
    // can never be crossed, so the scope would sit untriggered forever.
    const channel = trigger.source === 'CH2' ? instrument.ch2 : instrument.ch1;
    const half = (VERTICAL_DIVISIONS / 2) * channel.scaleVPerDiv;
    const centre = -channel.positionDiv * channel.scaleVPerDiv;
    this.refreshBounds({
      min: centre - half,
      max: centre + half,
      step: channel.scaleVPerDiv / 100,
    });
    this.level.value = String(trigger.levelV);
    this.levelValue.textContent = formatEngineering(trigger.levelV, 'V');
  }
}

export class AcquisitionPanel {
  readonly root: HTMLElement;
  private readonly mode: HTMLSelectElement;
  private readonly averages: HTMLSelectElement;
  private readonly averagesRow: HTMLElement;
  private readonly running: HTMLInputElement;

  constructor(private readonly store: Store) {
    this.root = panel('Acquisition');

    const mode = selectRow<AcquireModeCode>(
      'Mode',
      [
        { value: AcquireMode.sample, label: 'Sample' },
        { value: AcquireMode.peakDetect, label: 'Peak detect' },
        { value: AcquireMode.average, label: 'Average' },
      ],
      (value) => {
        this.store.update((draft) => {
          draft.instrument.acquisition.mode = value;
        });
      },
    );
    this.mode = mode.select;

    const averages = selectRow<number>(
      'Averages',
      AVERAGE_COUNTS.map((count) => ({ value: count, label: String(count) })),
      (value) => {
        this.store.update((draft) => {
          draft.instrument.acquisition.averages = value;
        });
      },
    );
    this.averages = averages.select;
    this.averagesRow = averages.row;

    const running = toggleRow('Running', (checked) => {
      this.store.update((draft) => {
        draft.instrument.acquisition.running = checked;
      });
    });
    this.running = running.input;

    this.root.append(mode.row, averages.row, running.row);
    this.refresh();
  }

  refresh(): void {
    const acquisition = this.store.get().instrument.acquisition;
    this.mode.value = acquisition.mode;
    this.averages.value = String(acquisition.averages);
    // The averaging count means nothing in sample or peak-detect mode.
    this.averagesRow.hidden = acquisition.mode !== AcquireMode.average;
    this.running.checked = acquisition.running;
  }
}

/** Build every panel and return them for `main.ts` to mount and refresh. */
export function buildPanels(store: Store): {
  root: HTMLElement;
  refresh(): void;
}[] {
  return [
    ...CHANNELS.map((id) => new ChannelPanel(store, id)),
    new HorizontalPanel(store),
    new TriggerPanel(store),
    new AcquisitionPanel(store),
  ];
}
