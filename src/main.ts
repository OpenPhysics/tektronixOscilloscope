/**
 * Wiring. Finds the DOM, builds the panels, and glues the store to the transport.
 *
 * The shape of the page is: panels mutate the store, the store notifies with
 * both old and new state, and this file sends the difference. Nothing else
 * decides what goes on the wire, so there is exactly one place to look when the
 * instrument does something unexpected.
 */

import {
  CURVE_QUERY, ERROR_QUERY, IDENTITY_QUERY, MEASUREMENT_VALUE_QUERY, PREAMBLE_FIELDS,
  SCREENSHOT_FORMATS, SCREENSHOT_QUERY, SESSION_SETUP, SINGLE_SHOT,
  diffAll, encodeAll, isPlausibleCommand, measurementSetup, parseIdentity, parseNumber,
  preambleQuery, readbackPlan, screenshotSetup, waveformSetup,
} from './device/scpi.ts';
import { CHANNELS, type ChannelId, type MeasurementTypeCode } from './device/types.ts';
import { UsbTmcTransport, isWebUsbSupported } from './device/usbtmc.ts';
import {
  buildCapture, emptyPreamble, summarise, type Capture, type Preamble,
} from './device/waveform.ts';
import { capturesToCsv } from './export/csv.ts';
import { downloadBytes, downloadCanvas, downloadText } from './export/download.ts';
import { Store, type AppState } from './state.ts';
import { buildPanels } from './ui/controls.ts';
import { formatEngineering, timestampForFilename } from './ui/format.ts';
import { CommandLog } from './ui/log.ts';
import { MeasurementPanel } from './ui/measurements.ts';
import { Plot } from './ui/plot.ts';
import { ScreenshotView } from './ui/screenshot.ts';

function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

/* --------------------------------------------------------------- setup --- */

const store = new Store();
const log = new CommandLog(need('log'));

const statusText = need('status-text');
const statusPill = need('status-pill');
const identityText = need('identity-text');
const connectButton = need<HTMLButtonElement>('connect-button');

const plot = new Plot(need<HTMLCanvasElement>('plot'), need('plot-readout'));
const measurementPanel = new MeasurementPanel(need('measurements'), store);
const screenshotView = new ScreenshotView(need('screenshot'));
const statsText = need('capture-stats');

const transport = new UsbTmcTransport({
  onStatus: (status, detail) => {
    const labels = {
      unsupported: 'WebUSB unavailable',
      disconnected: 'Not connected',
      connecting: 'Connecting...',
      connected: 'Connected',
    } as const;
    statusText.textContent = labels[status];
    statusPill.dataset['status'] = status;
    connectButton.textContent = status === 'connected' ? 'Disconnect' : 'Connect';
    setControlsEnabled(status === 'connected');
    if (detail) log.add('info', detail);
    if (status !== 'connected') {
      identityText.textContent = '';
      stopMeasurementPolling();
    }
  },
  onSent: (command) => log.add('tx', command),
  onReceived: (text) => log.add('rx', text),
  onError: (message) => log.add('error', message),
});

const panels = buildPanels(store);
const controlsRoot = need('controls');
for (const panel of panels) controlsRoot.append(panel.root);

/** Buttons that do nothing useful without an instrument on the other end. */
const instrumentButtons = [
  'capture-button', 'single-button', 'run-stop-button', 'screenshot-button',
  'measure-button', 'readback-button', 'push-all-button', 'raw-send',
].map((id) => need<HTMLButtonElement>(id));

function setControlsEnabled(enabled: boolean): void {
  for (const button of instrumentButtons) button.disabled = !enabled;
}

/* ------------------------------------------------------------- helpers --- */

/** Send a sequence and wait for each, for setup that a query depends on. */
async function sendSequence(commands: readonly string[]): Promise<void> {
  for (const command of commands) await transport.write(command);
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  log.add('error', message);
}

/** Wrap an instrument action so a failure logs instead of rejecting unhandled. */
function run(action: () => Promise<void>): void {
  action().catch(reportError);
}

/* ----------------------------------------------------------- acquiring --- */

/**
 * Read the scaling information for the pending transfer.
 *
 * Fetched immediately before CURVe? and never cached: the codes and the
 * preamble only agree if nothing touched the vertical or horizontal settings in
 * between, and a stale preamble produces a plot that is wrong by a constant
 * factor with nothing in the data to reveal it.
 */
async function readPreamble(): Promise<Preamble> {
  const replies = new Map<string, string>();
  for (const field of PREAMBLE_FIELDS) {
    replies.set(field, await transport.query(preambleQuery(field)));
  }
  const number = (field: string): number => parseNumber(replies.get(field) ?? '');
  const text = (field: string): string => (replies.get(field) ?? '').replace(/"/g, '').trim();

  const preamble = emptyPreamble();
  preamble.points = number('NR_PT');
  preamble.xIncr = number('XINCR');
  preamble.xZero = number('XZERO');
  preamble.ptOff = number('PT_OFF');
  preamble.xUnit = text('XUNIT') || 's';
  preamble.yMult = number('YMULT');
  preamble.yZero = number('YZERO');
  preamble.yOff = number('YOFF');
  preamble.yUnit = text('YUNIT') || 'V';
  return preamble;
}

async function captureChannel(channel: ChannelId): Promise<Capture> {
  await sendSequence(waveformSetup(channel));
  const preamble = await readPreamble();
  const reply = await transport.queryBinary(CURVE_QUERY);
  log.add('rx', `CURVE? -> ${reply.length} bytes`);
  return buildCapture(channel, reply, preamble, Date.now());
}

let captures: Capture[] = [];

/**
 * Capture every displayed channel.
 *
 * Both channels come from the same acquisition, so their time axes line up and
 * the CSV can share one time column. Channels that are switched off are skipped
 * rather than transferred as flat lines.
 */
async function capture(): Promise<void> {
  const state = store.get();
  const wanted = CHANNELS.filter(
    (id) => state.instrument[id === 1 ? 'ch1' : 'ch2'].enabled,
  );
  if (wanted.length === 0) {
    log.add('info', 'no channel is switched on');
    return;
  }

  const results: Capture[] = [];
  for (const id of wanted) results.push(await captureChannel(id));

  captures = results;
  plot.show(captures, state.instrument);
  showStats();
}

function showStats(): void {
  const parts = captures.map((item) => {
    const stats = summarise(item);
    return (
      `CH${item.channel}: ` +
      `${formatEngineering(stats.peakToPeak, 'V', 4)} pk-pk, ` +
      `${formatEngineering(stats.rms, 'V', 4)} RMS, ` +
      `${formatEngineering(stats.mean, 'V', 4)} mean, ` +
      `${item.volts.length} points at ${formatEngineering(stats.sampleRateHz, 'Sa/s', 3)}`
    );
  });
  statsText.textContent = parts.join('\n');
}

/* -------------------------------------------------------- measurements --- */

let measurementTimer: ReturnType<typeof setInterval> | null = null;

async function pollMeasurements(): Promise<void> {
  const state = store.get();
  const values = new Map<MeasurementTypeCode, number>();
  for (const type of state.measurements) {
    await sendSequence(measurementSetup(state.activeChannel, type));
    values.set(type, parseNumber(await transport.query(MEASUREMENT_VALUE_QUERY)));
  }
  measurementPanel.setValues(values);
}

function startMeasurementPolling(): void {
  if (measurementTimer !== null) return;
  // One second is slower than the instrument can answer, deliberately: each poll
  // is several round trips, and a tighter loop starves the rest of the UI of the
  // endpoint mutex.
  measurementTimer = setInterval(() => run(pollMeasurements), 1000);
}

function stopMeasurementPolling(): void {
  if (measurementTimer === null) return;
  clearInterval(measurementTimer);
  measurementTimer = null;
  measurementPanel.clearValues();
}

/* ------------------------------------------------------------ hardcopy --- */

/**
 * Pull the scope's screen.
 *
 * Formats are tried in order because it is not yet verified which this firmware
 * accepts; a rejected format shows up as an error in the event queue rather than
 * as a failed transfer, so the event queue is what decides whether to move on.
 */
async function captureScreen(): Promise<void> {
  for (const format of SCREENSHOT_FORMATS) {
    await transport.write('*CLS');
    await sendSequence(screenshotSetup(format));
    const event = await transport.query('*ESR?');
    if (parseNumber(event) !== 0) {
      log.add('info', `the instrument rejected ${format}, trying the next format`);
      continue;
    }
    const bytes = await transport.queryBinary(SCREENSHOT_QUERY);
    log.add('rx', `HARDCOPY -> ${bytes.length} bytes`);
    screenshotView.show(bytes);
    return;
  }
  log.add('error', 'no supported hardcopy format; check Utility > Options on the scope');
}

/* -------------------------------------------------------------- events --- */

/**
 * On every state change: refresh the panels, then send only what differs.
 *
 * The model change case does not arise here - unlike the sibling generator
 * project there is one model - so a full resend is only ever explicit.
 */
function onStateChanged(next: AppState, prev: AppState): void {
  for (const panel of panels) panel.refresh();
  measurementPanel.refresh();
  if (captures.length > 0) plot.show(captures, next.instrument);

  if (!transport.isConnected) return;
  transport.enqueueAll(diffAll(prev.instrument, next.instrument));
}
store.subscribe(onStateChanged);

connectButton.addEventListener('click', () => {
  if (transport.isConnected) {
    run(() => transport.disconnect());
    return;
  }
  // No await before requestDevice: the browser only allows it inside the gesture.
  transport
    .connect()
    .then(onConnected)
    .catch((error: unknown) => {
      // The user closing the device picker is a normal outcome, not a failure.
      if (error instanceof Error && error.name === 'NotFoundError') return;
      reportError(error);
    });
});

async function onConnected(): Promise<void> {
  await sendSequence(SESSION_SETUP);
  const identity = parseIdentity(await transport.query(IDENTITY_QUERY));
  identityText.textContent = `${identity.model} - serial ${identity.serial}`;
  log.add('info', `connected to ${identity.model}, firmware ${identity.firmware}`);
  // Push the remembered settings so the page and the instrument agree from the start.
  await sendSequence(encodeAll(store.get().instrument));
  if (store.get().liveMeasurements) startMeasurementPolling();
}

need('capture-button').addEventListener('click', () => run(capture));

need('single-button').addEventListener('click', () =>
  run(async () => {
    await sendSequence(SINGLE_SHOT);
    log.add('info', 'armed for a single acquisition');
  }),
);

need('run-stop-button').addEventListener('click', () => {
  store.update((draft) => {
    draft.instrument.acquisition.running = !draft.instrument.acquisition.running;
  });
});

need('screenshot-button').addEventListener('click', () => run(captureScreen));

need('measure-button').addEventListener('click', () => run(pollMeasurements));

need<HTMLInputElement>('live-measure').addEventListener('change', (event) => {
  const checked = (event.target as HTMLInputElement).checked;
  store.update((draft) => {
    draft.liveMeasurements = checked;
  });
  if (checked && transport.isConnected) startMeasurementPolling();
  else stopMeasurementPolling();
});

need<HTMLSelectElement>('active-channel').addEventListener('change', (event) => {
  const value = Number((event.target as HTMLSelectElement).value);
  store.update((draft) => {
    draft.activeChannel = value === 2 ? 2 : 1;
  });
});

need('readback-button').addEventListener('click', () =>
  run(async () => {
    const draft = structuredClone(store.get().instrument);
    for (const item of readbackPlan()) {
      item.apply(draft, await transport.query(item.command));
    }
    store.replaceInstrument(draft);
    log.add('info', 'read the front panel back from the instrument');
  }),
);

need('push-all-button').addEventListener('click', () =>
  run(async () => {
    await sendSequence(encodeAll(store.get().instrument));
    log.add('info', 'resent every setting');
  }),
);

/* -------------------------------------------------------------- export --- */

need('export-csv').addEventListener('click', () => {
  if (captures.length === 0) {
    log.add('info', 'nothing captured yet');
    return;
  }
  const first = captures[0];
  if (!first) return;
  const stamp = timestampForFilename(first.capturedAt);
  downloadText(capturesToCsv(captures, store.get().instrument), `tbs1072b-${stamp}.csv`);
  log.add('info', `saved tbs1072b-${stamp}.csv`);
});

need('export-png').addEventListener('click', () => {
  const stamp = timestampForFilename(captures[0]?.capturedAt ?? Date.now());
  downloadCanvas(plot.element, `tbs1072b-${stamp}.png`);
  log.add('info', `saved tbs1072b-${stamp}.png`);
});

need('export-screenshot').addEventListener('click', () => {
  const bytes = screenshotView.bytes;
  if (!bytes) {
    log.add('info', 'no screen captured yet');
    return;
  }
  const extension = screenshotView.extension;
  const stamp = timestampForFilename(Date.now());
  downloadBytes(bytes, `tbs1072b-screen-${stamp}.${extension}`, `image/${extension}`);
});

/* ----------------------------------------------------------- raw entry --- */

const rawInput = need<HTMLInputElement>('raw-input');

function sendRaw(): void {
  const command = rawInput.value.trim();
  if (!isPlausibleCommand(command)) {
    log.add('error', 'that does not look like a SCPI command');
    return;
  }
  run(async () => {
    if (command.endsWith('?')) {
      await transport.query(command);
    } else {
      await transport.write(command);
      const event = await transport.query(ERROR_QUERY);
      if (event && !/^0/.test(event)) log.add('error', event);
    }
    rawInput.value = '';
  });
}

need('raw-send').addEventListener('click', sendRaw);
rawInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendRaw();
});

need('log-clear').addEventListener('click', () => log.clear());

/* --------------------------------------------------------------- start --- */

need('unsupported-banner').hidden = isWebUsbSupported();
need('insecure-banner').hidden = window.isSecureContext;

need<HTMLSelectElement>('active-channel').value = String(store.get().activeChannel);
need<HTMLInputElement>('live-measure').checked = store.get().liveMeasurements;
setControlsEnabled(false);

// Reopen a device the user has already granted, so a mid-experiment refresh does
// not put a permission dialog between the student and their measurement.
void transport.tryReconnect().then((reconnected) => {
  if (reconnected) void onConnected().catch(reportError);
});
