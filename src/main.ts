/**
 * Wiring. Finds the DOM, builds the panels, and glues the store to the transport.
 *
 * The shape of the page is: panels mutate the store, the store notifies with
 * both old and new state, and this file sends the difference. Nothing else
 * decides what goes on the wire, so there is exactly one place to look when the
 * instrument does something unexpected.
 */

import {
  CURVE_QUERY, ERROR_QUERY, IDENTITY_QUERY, MEASUREMENT_TYPE_QUERY,
  MEASUREMENT_VALUE_QUERY, PREAMBLE_FIELDS, SCREENSHOT_FORMATS, SCREENSHOT_QUERY,
  SESSION_SETUP, SINGLE_SHOT, diffAll, encodeAll, isPlausibleCommand, measurementSetup,
  measurementTypeMatches, parseIdentity, parseNumber, preambleQuery, readbackPlan,
  screenshotSetup, waveformSetup,
} from './device/scpi.ts';
import { CHANNELS, type ChannelId, type MeasurementTypeCode } from './device/types.ts';
import { UsbTmcTransport, isWebUsbSupported, type TransportIo } from './device/usbtmc.ts';
import {
  buildCapture, emptyPreamble, summarise, type Capture, type Preamble,
} from './device/waveform.ts';
import { capturesToCsv } from './export/csv.ts';
import { downloadBytes, downloadCanvas, downloadText } from './export/download.ts';
import { Store, type AppState } from './state.ts';
import { buildPanels } from './ui/controls.ts';
import { formatEngineering, timestampForFilename } from './ui/format.ts';
import { HelpDialog, currentPlatform } from './ui/help.ts';
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
const help = new HelpDialog(need<HTMLDialogElement>('help-dialog'));

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
    if (detail) log.add('info', detail);
    if (status !== 'connected') {
      // Enabling waits until onConnected has adopted the front panel. Turning
      // the controls on here would let "Push all" land before that read.
      setControlsEnabled(false);
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
async function readPreamble(io: TransportIo): Promise<Preamble> {
  const replies = new Map<string, string>();
  for (const field of PREAMBLE_FIELDS) {
    replies.set(field, await io.query(preambleQuery(field)));
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

async function captureChannel(io: TransportIo, channel: ChannelId): Promise<Capture> {
  for (const command of waveformSetup(channel)) await io.write(command);
  const preamble = await readPreamble(io);
  const reply = await io.queryBinary(CURVE_QUERY);
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

  const wasRunning = state.instrument.acquisition.running;
  const results = await transport.exclusive(async (io) => {
    // Two CURVE? reads from a free-running scope can come from different
    // sweeps. Stop first so both channels are the same frozen acquisition,
    // which is what the CSV header claims. The settings queue stays blocked
    // until this callback returns: exclusive holds the endpoint mutex the
    // drain also needs.
    if (wanted.length > 1) await io.write('ACQUIRE:STATE STOP');
    const taken: Capture[] = [];
    for (const id of wanted) taken.push(await captureChannel(io, id));
    return taken;
  });

  captures = results;
  if (wanted.length > 1 && wasRunning) {
    store.update((draft) => {
      draft.instrument.acquisition.running = false;
    });
  }

  plot.show(captures, store.get().instrument);
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
let measurementInFlight = false;

/** Types the instrument has already refused, so the log is not filled every second. */
const rejectedMeasurementTypes = new Set<string>();

/**
 * One immediate measurement.
 *
 * Two things both put a neighbour's number in the slot, and both are checked:
 *
 * The type is read back before the value is trusted. A rejected keyword leaves
 * the previous type in force and `VALUE?` answers for that, with no error.
 *
 * `VALUE?` is issued twice and the first reply is discarded. Changing the type
 * does not generate an operation-complete message on this series, so there is
 * nothing to wait on, and the first value after a type change is still the
 * previous quantity. The second query is the one for the type just set.
 */
async function readMeasurement(
  source: ChannelId,
  type: MeasurementTypeCode,
): Promise<number | null> {
  await sendSequence(measurementSetup(source, type));
  const reported = await transport.query(MEASUREMENT_TYPE_QUERY);
  if (!measurementTypeMatches(reported, type)) {
    const answer = reported.trim() || 'nothing';
    const key = `${type}:${answer}`;
    if (!rejectedMeasurementTypes.has(key)) {
      rejectedMeasurementTypes.add(key);
      log.add(
        'error',
        `the instrument kept ${answer} instead of measurement type ${type}`,
      );
    }
    return null;
  }
  await transport.query(MEASUREMENT_VALUE_QUERY);
  return parseNumber(await transport.query(MEASUREMENT_VALUE_QUERY));
}

async function pollMeasurements(): Promise<void> {
  if (measurementInFlight) return;
  measurementInFlight = true;
  try {
    const state = store.get();
    const values = new Map<MeasurementTypeCode, number>();
    for (const type of state.measurements) {
      const reading = await readMeasurement(state.activeChannel, type);
      if (reading === null) continue;
      values.set(type, reading);
    }
    measurementPanel.setValues(values);
  } finally {
    measurementInFlight = false;
  }
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
  // A screen transfer is slow enough to look like a hang - 1.8 s as JPEG and
  // 9.5 s as BMP, measured - so say something before going quiet.
  const button = need<HTMLButtonElement>('screenshot-button');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Capturing...';
  try {
    await transferScreen();
  } finally {
    button.textContent = label;
    button.disabled = !transport.isConnected;
  }
}

async function transferScreen(): Promise<void> {
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
 *
 * Adopting a readback is the exception: the store is catching up with the
 * bench, and echoing that diff would write the instrument's own settings
 * back onto it, including any value the clamps had adjusted. The hold covers
 * the whole read, not only the store write, so a control changed while the
 * queries are in flight cannot push the page's settings onto the bench.
 */
let instrumentWriteHold = 0;

function holdInstrumentWrites(): () => void {
  instrumentWriteHold += 1;
  return () => {
    instrumentWriteHold -= 1;
  };
}

function onStateChanged(next: AppState, prev: AppState): void {
  for (const panel of panels) panel.refresh();
  measurementPanel.refresh();
  if (captures.length > 0) plot.show(captures, next.instrument);

  if (!transport.isConnected || instrumentWriteHold > 0) return;
  transport.enqueueAll(diffAll(prev.instrument, next.instrument));
}
store.subscribe(onStateChanged);

for (const id of ['help-button', 'help-banner-button']) {
  need(id).addEventListener('click', () => help.open(currentPlatform()));
}

connectButton.addEventListener('click', () => {
  if (transport.isConnected) {
    run(() => transport.disconnect());
    return;
  }
  // No await before requestDevice: the browser only allows it inside the gesture.
  transport
    .connect()
    .then(() => {
      // Ignored when a reconnect is already opening the device. Only a call
      // that left us connected should run session setup.
      if (transport.isConnected) return onConnected();
    })
    .catch((error: unknown) => {
      // NotFoundError covers both "the user closed the chooser" and "the chooser
      // had nothing in it to choose", which WebUSB gives no way to tell apart.
      // Neither deserves an error, but the second is where people get stuck, so
      // name the way out instead of failing silently.
      if (error instanceof Error && error.name === 'NotFoundError') {
        log.add('info', 'no instrument chosen. If the chooser was empty, see "Need help connecting?"');
        return;
      }
      reportError(error);
    });
});

async function onConnected(): Promise<void> {
  setControlsEnabled(false);
  // Held from the first command. Session setup does not change the front
  // panel, but the panels are already live, and a click before the read
  // finished would diff against the page and overwrite the bench.
  const release = holdInstrumentWrites();
  try {
    await sendSequence(SESSION_SETUP);
    const identity = parseIdentity(await transport.query(IDENTITY_QUERY));
    identityText.textContent = `${identity.model} - serial ${identity.serial}`;
    log.add('info', `connected to ${identity.model}, firmware ${identity.firmware}`);
    // The bench is the source of truth. Pushing the page's settings here
    // would undo a setup made at the front panel, and the default probe is
    // 10X on a rig that is often actually 1X.
    await adoptFromInstrument();
    log.add('info', 'adopted the front panel from the instrument');
  } finally {
    release();
  }
  if (store.get().liveMeasurements) startMeasurementPolling();
  if (transport.isConnected) setControlsEnabled(true);
}

/** Read the front panel and make the page match it, without writing back. */
async function adoptFromInstrument(): Promise<void> {
  setControlsEnabled(false);
  const release = holdInstrumentWrites();
  try {
    const draft = structuredClone(store.get().instrument);
    for (const item of readbackPlan()) {
      item.apply(draft, await transport.query(item.command));
    }
    store.replaceInstrument(draft);
  } finally {
    release();
    // Nested inside onConnected, which is still holding writes and will
    // enable the controls itself once the link is fully up.
    if (transport.isConnected && instrumentWriteHold === 0) setControlsEnabled(true);
  }
}

need('capture-button').addEventListener('click', () => run(capture));

need('single-button').addEventListener('click', () => {
  const acquisition = store.get().instrument.acquisition;
  const alreadyArmed = acquisition.stopAfter === 'SEQUENCE' && acquisition.running;
  store.update((draft) => {
    draft.instrument.acquisition.stopAfter = 'SEQUENCE';
    draft.instrument.acquisition.running = true;
  });
  // Already in that state: the diff is empty, but the button should re-arm.
  if (!transport.isConnected) return;
  // Already SEQUENCE and running: the diff was empty, so re-send the pair.
  if (alreadyArmed) transport.enqueueAll(SINGLE_SHOT);
  log.add('info', 'armed for a single acquisition');
});

need('run-stop-button').addEventListener('click', () => {
  store.update((draft) => {
    const nextRunning = !draft.instrument.acquisition.running;
    draft.instrument.acquisition.running = nextRunning;
    // Starting a run is free-running. Leaving STOPAFTER at SEQUENCE would arm
    // another single shot the next time STATE goes to RUN.
    if (nextRunning) draft.instrument.acquisition.stopAfter = 'RUNSTOP';
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
    await adoptFromInstrument();
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
