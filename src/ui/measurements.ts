/**
 * The instrument's own automatic measurements.
 *
 * These come from MEASUrement:IMMed, which runs over the full acquisition rather
 * than over the 2500 points that were transferred. That makes them more accurate
 * than anything computed from a captured record, and also means they will not
 * agree with the capture statistics to the last digit. Both panels are shown
 * precisely so that difference is visible rather than hidden.
 *
 * A value of 9.9e37 is the instrument's way of saying "I cannot measure that" -
 * an unstable signal, or a frequency on a flat line - and is displayed as such.
 */

import { MEASUREMENT_TYPES, type MeasurementTypeCode } from '../device/types.ts';
import { type Store } from '../state.ts';
import { formatEngineering } from './format.ts';

/** IEEE 488.2 "not a number" as Tektronix reports it. */
const INSTRUMENT_NAN = 9.9e37;

export function isMeasurable(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) < INSTRUMENT_NAN / 10;
}

export class MeasurementPanel {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly chooser: HTMLElement;
  private readonly cells = new Map<MeasurementTypeCode, HTMLElement>();

  constructor(root: HTMLElement, private readonly store: Store) {
    this.root = root;

    this.list = document.createElement('div');
    this.list.className = 'measurement-grid';
    this.list.setAttribute('role', 'status');
    this.list.setAttribute('aria-live', 'polite');

    this.chooser = document.createElement('fieldset');
    this.chooser.className = 'measurement-chooser';
    const legend = document.createElement('legend');
    legend.textContent = 'Show';
    this.chooser.append(legend);

    for (const type of MEASUREMENT_TYPES) {
      const id = `measure-${type.code.toLowerCase()}`;
      const wrapper = document.createElement('div');
      wrapper.className = 'measurement-choice';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.value = type.code;
      input.addEventListener('change', () => {
        this.store.update((draft) => {
          const selected = new Set(draft.measurements);
          if (input.checked) selected.add(type.code);
          else selected.delete(type.code);
          // Keep the canonical order rather than click order, so the readout
          // does not rearrange itself as boxes are ticked.
          draft.measurements = MEASUREMENT_TYPES
            .map((entry) => entry.code)
            .filter((code) => selected.has(code));
        });
      });

      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = type.label;

      wrapper.append(input, label);
      this.chooser.append(wrapper);
    }

    root.append(this.list, this.chooser);
    this.refresh();
  }

  /** Rebuild the readout tiles to match the current selection. */
  refresh(): void {
    const selected = this.store.get().measurements;

    for (const input of this.chooser.querySelectorAll('input[type=checkbox]')) {
      const checkbox = input as HTMLInputElement;
      checkbox.checked = selected.includes(checkbox.value as MeasurementTypeCode);
    }

    const wanted = selected.join('|');
    if (this.list.dataset['selection'] === wanted) return;
    this.list.dataset['selection'] = wanted;

    this.list.replaceChildren();
    this.cells.clear();

    if (selected.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'section-note';
      empty.textContent = 'Nothing selected.';
      this.list.append(empty);
      return;
    }

    for (const code of selected) {
      const type = MEASUREMENT_TYPES.find((entry) => entry.code === code);
      if (!type) continue;

      const tile = document.createElement('div');
      tile.className = 'measurement-tile';

      const label = document.createElement('span');
      label.className = 'measurement-label';
      label.textContent = type.label;

      const value = document.createElement('span');
      value.className = 'measurement-value';
      value.textContent = '-';

      tile.append(label, value);
      this.list.append(tile);
      this.cells.set(code, value);
    }
  }

  /** Update the readouts from a fresh poll. Codes not present are left alone. */
  setValues(values: ReadonlyMap<MeasurementTypeCode, number>): void {
    for (const [code, cell] of this.cells) {
      const value = values.get(code);
      if (value === undefined) continue;
      const type = MEASUREMENT_TYPES.find((entry) => entry.code === code);
      cell.textContent = isMeasurable(value)
        ? formatEngineering(value, type?.unit ?? '', 4)
        : 'unstable';
    }
  }

  clearValues(): void {
    for (const cell of this.cells.values()) cell.textContent = '-';
  }
}
