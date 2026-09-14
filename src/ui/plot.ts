/**
 * Canvas display of captured waveforms.
 *
 * Laid out like the instrument's own screen - ten horizontal divisions by eight
 * vertical - so that what the page shows and what the bench shows can be
 * compared at a glance. Traces are drawn in the channel colours Tektronix uses
 * on the front panel, for the same reason.
 *
 * This is a measurement, unlike the preview in the sibling function-generator
 * project: every point here came off the instrument.
 */

import {
  HORIZONTAL_DIVISIONS, VERTICAL_DIVISIONS,
} from '../device/limits.ts';
import { type Capture } from '../device/waveform.ts';
import { type ChannelId, type InstrumentState } from '../device/types.ts';
import { formatEngineering } from './format.ts';

const CHANNEL_COLOURS: Record<ChannelId, string> = {
  1: '#f2c744',
  2: '#4fd0e7',
};

const GRID_COLOUR = 'rgba(148, 163, 184, 0.22)';
const AXIS_COLOUR = 'rgba(148, 163, 184, 0.55)';
const BACKGROUND = '#0b1220';

/** Space for the axis labels outside the graticule. */
const PADDING = { top: 16, right: 16, bottom: 30, left: 62 };

interface Pointer {
  x: number;
  y: number;
}

export class Plot {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly readout: HTMLElement;

  private captures: readonly Capture[] = [];
  private instrument: InstrumentState | null = null;
  private pointer: Pointer | null = null;

  constructor(canvas: HTMLCanvasElement, readout: HTMLElement) {
    this.canvas = canvas;
    this.readout = readout;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas 2d context unavailable');
    this.context = context;

    this.root = canvas.parentElement ?? canvas;

    // Redraw on resize as well as on new data: the canvas backing store has to
    // track both the element size and the device pixel ratio, or the trace is
    // blurry on exactly the high-DPI laptops students bring.
    new ResizeObserver(() => this.draw()).observe(canvas);

    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);
  }

  /** The canvas itself, for PNG export. */
  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  show(captures: readonly Capture[], instrument: InstrumentState): void {
    this.captures = captures;
    this.instrument = instrument;
    this.draw();
  }

  clear(): void {
    this.captures = [];
    this.draw();
  }

  /* ------------------------------------------------------------ pointer --- */

  private handlePointerMove = (event: PointerEvent): void => {
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    this.draw();
  };

  private handlePointerLeave = (): void => {
    this.pointer = null;
    this.readout.textContent = '';
    this.draw();
  };

  /* --------------------------------------------------------------- draw --- */

  private draw(): void {
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;

    if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }

    const context = this.context;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, width, height);

    const plot = {
      left: PADDING.left,
      top: PADDING.top,
      width: width - PADDING.left - PADDING.right,
      height: height - PADDING.top - PADDING.bottom,
    };
    if (plot.width <= 0 || plot.height <= 0) return;

    this.drawGrid(plot);

    if (this.captures.length === 0 || !this.instrument) {
      this.drawPlaceholder(plot);
      return;
    }

    const window_ = this.viewport();
    this.drawAxisLabels(plot, window_);
    for (const capture of this.captures) {
      this.drawTrace(plot, window_, capture);
    }
    this.drawCursor(plot, window_);
  }

  /**
   * The time and voltage span the graticule covers.
   *
   * Taken from the instrument's own scale settings rather than from the data, so
   * the display matches the scope's screen - including a flat trace sitting off
   * to one side, which is information the student needs to see.
   */
  private viewport(): { tSpan: number; tCentre: number; vSpan: number; vCentre: number } {
    const instrument = this.instrument;
    const first = this.captures[0];
    if (!instrument || !first) {
      return { tSpan: 1, tCentre: 0, vSpan: 1, vCentre: 0 };
    }

    const channel = first.channel === 1 ? instrument.ch1 : instrument.ch2;
    return {
      tSpan: instrument.horizontal.scaleSPerDiv * HORIZONTAL_DIVISIONS,
      tCentre: instrument.horizontal.positionS,
      vSpan: channel.scaleVPerDiv * VERTICAL_DIVISIONS,
      vCentre: -channel.positionDiv * channel.scaleVPerDiv,
    };
  }

  private drawGrid(plot: { left: number; top: number; width: number; height: number }): void {
    const context = this.context;
    context.save();
    context.strokeStyle = GRID_COLOUR;
    context.lineWidth = 1;

    for (let column = 0; column <= HORIZONTAL_DIVISIONS; column += 1) {
      const x = plot.left + (plot.width * column) / HORIZONTAL_DIVISIONS;
      context.beginPath();
      // Half-pixel offset keeps a 1px line crisp instead of straddling two pixels.
      context.moveTo(Math.round(x) + 0.5, plot.top);
      context.lineTo(Math.round(x) + 0.5, plot.top + plot.height);
      context.stroke();
    }
    for (let row = 0; row <= VERTICAL_DIVISIONS; row += 1) {
      const y = plot.top + (plot.height * row) / VERTICAL_DIVISIONS;
      context.beginPath();
      context.moveTo(plot.left, Math.round(y) + 0.5);
      context.lineTo(plot.left + plot.width, Math.round(y) + 0.5);
      context.stroke();
    }

    // Centre lines, where the trigger point and zero volts sit.
    context.strokeStyle = AXIS_COLOUR;
    const midX = Math.round(plot.left + plot.width / 2) + 0.5;
    const midY = Math.round(plot.top + plot.height / 2) + 0.5;
    context.beginPath();
    context.moveTo(midX, plot.top);
    context.lineTo(midX, plot.top + plot.height);
    context.moveTo(plot.left, midY);
    context.lineTo(plot.left + plot.width, midY);
    context.stroke();
    context.restore();
  }

  private drawPlaceholder(plot: {
    left: number; top: number; width: number; height: number;
  }): void {
    const context = this.context;
    context.save();
    context.fillStyle = 'rgba(148, 163, 184, 0.75)';
    context.font = '14px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(
      'No capture yet - connect the scope and press Capture',
      plot.left + plot.width / 2,
      plot.top + plot.height / 2,
    );
    context.restore();
  }

  private drawAxisLabels(
    plot: { left: number; top: number; width: number; height: number },
    viewport: { tSpan: number; tCentre: number; vSpan: number; vCentre: number },
  ): void {
    const context = this.context;
    context.save();
    context.fillStyle = 'rgba(203, 213, 225, 0.85)';
    context.font = '11px ui-monospace, monospace';

    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (let row = 0; row <= VERTICAL_DIVISIONS; row += 1) {
      const fraction = 0.5 - row / VERTICAL_DIVISIONS;
      const volts = viewport.vCentre + fraction * viewport.vSpan;
      const y = plot.top + (plot.height * row) / VERTICAL_DIVISIONS;
      context.fillText(formatEngineering(volts, 'V', 3), plot.left - 8, y);
    }

    context.textAlign = 'center';
    context.textBaseline = 'top';
    for (let column = 0; column <= HORIZONTAL_DIVISIONS; column += 2) {
      const fraction = column / HORIZONTAL_DIVISIONS - 0.5;
      const seconds = viewport.tCentre + fraction * viewport.tSpan;
      const x = plot.left + (plot.width * column) / HORIZONTAL_DIVISIONS;
      context.fillText(formatEngineering(seconds, 's', 3), x, plot.top + plot.height + 8);
    }
    context.restore();
  }

  /**
   * Draw one record.
   *
   * A 2500-point record on a ~900px canvas means several samples per pixel, so
   * the trace is decimated into per-pixel min/max columns rather than drawn
   * point by point. Plain subsampling would drop the extremes and make a noisy
   * or fast signal look cleaner than it is - the one thing a measurement display
   * must never do.
   */
  private drawTrace(
    plot: { left: number; top: number; width: number; height: number },
    viewport: { tSpan: number; tCentre: number; vSpan: number; vCentre: number },
    capture: Capture,
  ): void {
    const { times, volts } = capture;
    if (volts.length === 0) return;

    const context = this.context;
    const tMin = viewport.tCentre - viewport.tSpan / 2;
    const vMax = viewport.vCentre + viewport.vSpan / 2;

    const toX = (t: number): number => plot.left + ((t - tMin) / viewport.tSpan) * plot.width;
    const toY = (v: number): number => plot.top + ((vMax - v) / viewport.vSpan) * plot.height;

    context.save();
    context.beginPath();
    context.rect(plot.left, plot.top, plot.width, plot.height);
    context.clip();

    context.strokeStyle = CHANNEL_COLOURS[capture.channel];
    context.lineWidth = 1.4;
    context.lineJoin = 'round';
    context.beginPath();

    const columns = Math.max(1, Math.floor(plot.width));
    const perColumn = volts.length / columns;

    if (perColumn <= 1) {
      for (let index = 0; index < volts.length; index += 1) {
        const x = toX(times[index] ?? 0);
        const y = toY(volts[index] ?? 0);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
    } else {
      for (let column = 0; column < columns; column += 1) {
        const start = Math.floor(column * perColumn);
        const end = Math.min(volts.length, Math.floor((column + 1) * perColumn));
        if (start >= end) continue;

        let low = Infinity;
        let high = -Infinity;
        for (let index = start; index < end; index += 1) {
          const value = volts[index] ?? 0;
          if (value < low) low = value;
          if (value > high) high = value;
        }
        const x = toX(times[start] ?? 0);
        if (column === 0) context.moveTo(x, toY(high));
        // A vertical stroke spanning the column's range preserves the envelope.
        context.lineTo(x, toY(high));
        context.lineTo(x, toY(low));
      }
    }

    context.stroke();
    context.restore();
  }

  /** Crosshair plus a readout of the sample under the pointer. */
  private drawCursor(
    plot: { left: number; top: number; width: number; height: number },
    viewport: { tSpan: number; tCentre: number; vSpan: number; vCentre: number },
  ): void {
    const pointer = this.pointer;
    if (!pointer) return;
    if (
      pointer.x < plot.left || pointer.x > plot.left + plot.width ||
      pointer.y < plot.top || pointer.y > plot.top + plot.height
    ) {
      this.readout.textContent = '';
      return;
    }

    const context = this.context;
    context.save();
    context.strokeStyle = 'rgba(226, 232, 240, 0.5)';
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(Math.round(pointer.x) + 0.5, plot.top);
    context.lineTo(Math.round(pointer.x) + 0.5, plot.top + plot.height);
    context.moveTo(plot.left, Math.round(pointer.y) + 0.5);
    context.lineTo(plot.left + plot.width, Math.round(pointer.y) + 0.5);
    context.stroke();
    context.restore();

    const tMin = viewport.tCentre - viewport.tSpan / 2;
    const time = tMin + ((pointer.x - plot.left) / plot.width) * viewport.tSpan;

    const parts = [`t = ${formatEngineering(time, 's', 4)}`];
    for (const capture of this.captures) {
      const index = Math.round(
        (time - capture.preamble.xZero) / capture.preamble.xIncr + capture.preamble.ptOff,
      );
      const value = capture.volts[index];
      if (value !== undefined) {
        parts.push(`CH${capture.channel} = ${formatEngineering(value, 'V', 4)}`);
      }
    }
    this.readout.textContent = parts.join('   ');
  }
}
