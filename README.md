# Tektronix TBS1072B-EDU

Capture waveforms from a Tektronix TBS1072B-EDU oscilloscope in the browser, drive its
front panel, and save what it measures — no vendor software, no install.

Built for a teaching lab. A student plugs the scope into a laptop, opens a page, and
has the trace as a CSV they can take into a report. Nothing needs administrator rights
at the point of use, and there is no application to keep up to date on a room full of
shared machines.

## Requirements

**Desktop Chrome or Edge.** This page uses the [WebUSB API][webusb], which Firefox and
Safari do not implement and browsers on iOS never will. It also needs a secure
context, so `https://` or `localhost`.

**A one-time driver bind.** The scope must be bound to Windows' generic WinUSB driver
before any browser can claim it. This takes about a minute with [Zadig][zadig] and is
reversible. See **[docs/SETUP.md](docs/SETUP.md)**, which also covers the front-panel
setting (*Utility → Options → USB Device Port → Computer*) that has to be right first.

### Why WebUSB and not Web Serial

The sibling [feelTechFunctionGenerator][feeltech] project talks to its instrument over
the Web Serial API, because the FY3200S contains a CH340 USB-serial bridge and Windows
turns that into a COM port.

The TBS1072B has no such bridge. It is a native **USBTMC** device — USB Test &
Measurement Class, raw bulk endpoints — so no COM port is ever created and Web Serial's
device picker comes up empty. This project therefore uses WebUSB and implements the
USBTMC bulk protocol itself, in about 150 lines of `src/device/usbtmc-frame.ts`. The
cost is the driver bind above; the benefit is that it works at all.

## Using it

Connect, and the page pushes its remembered settings so that it and the instrument
agree from the start. Then:

- **Capture** transfers 2500 points per displayed channel and plots them. The graticule
  matches the scope's own screen — ten divisions across, eight down — so the two can be
  compared at a glance.
- **Save CSV** writes a metadata block and then `time_s,voltage_v`. Both channels share
  one time column when both are on, because they come from the same acquisition.
- **Save plot PNG** renders the plot as it appears. **Capture screen** fetches the
  instrument's own display instead, which is what a lab report usually wants.
- The **control panels** drive the real front panel. Scales are dropdowns, not sliders,
  because the instrument only accepts ladder values and silently rounds anything else.
- **Read from instrument** goes the other way, adopting whatever the knobs have been
  set to. Use it after anyone has touched the bench, or the page will overwrite their
  changes on its next update.

Some things worth being clear about:

- **The measurements panel and the capture statistics will disagree slightly.** The
  panel reports what the instrument measures over its whole acquisition; the statistics
  are computed from the 2500 points that were transferred. Both are shown so the
  difference is visible rather than hidden.
- **A measurement of `unstable` is the instrument's answer, not a failure.** It returns
  9.9e37 when it cannot measure — asking for a frequency on a flat line, for instance.
- **Settings are remembered in this browser only**, and captures live in memory until
  you save them. Reloading loses them.

## Development

```bash
npm install
npm run dev        # http://localhost:5173/tektronixOscilloscope/
npm run typecheck
npm test
npm run build
```

The dev server runs happily in WSL2 with the browser on the Windows side — WSL forwards
localhost, and localhost is a secure context. Note the `/tektronixOscilloscope/` path:
`base` is set for project-site hosting, so the bare root will 404.

| File | Role |
|---|---|
| `src/main.ts` | Wiring only: DOM lookup, handlers, store ↔ transport glue |
| `src/state.ts` | `Store`: one `AppState`, `subscribe((next, prev))`, localStorage |
| `src/device/types.ts` | Shared vocabulary. No I/O, no DOM |
| `src/device/limits.ts` | What the instrument can do: scale ladders and clamps |
| `src/device/usbtmc-frame.ts` | USBTMC header packing and parsing. Pure bytes |
| `src/device/usbtmc.ts` | WebUSB transport. **The only file that touches hardware** |
| `src/device/scpi.ts` | Command encoding, diffing and reply parsing. Pure strings |
| `src/device/waveform.ts` | Block parsing and raw → volts/seconds scaling. Pure |
| `src/ui/plot.ts` | Canvas waveform display with cursor readout |
| `src/ui/controls.ts` | Channel, horizontal, trigger and acquisition panels |
| `src/ui/measurements.ts` | The instrument's own automatic measurements |
| `src/ui/screenshot.ts` | Instrument screen capture, with format sniffing |
| `src/export/csv.ts` | Capture → CSV. Pure string building |
| `tools/probe.py` | Raw USBTMC prober, for verifying the protocol against hardware |

The layering rule is the important part: `scpi.ts`, `waveform.ts` and `limits.ts` never
import the transport. That is what lets the entire instrument language be tested in CI
with no oscilloscope attached — and most of the risk in a project like this lives in
the instrument language, because a misspelt SCPI keyword is accepted silently and
simply does nothing.

The plot decimates into per-pixel min/max columns rather than subsampling. Plain
subsampling would drop the extremes and make a noisy signal look cleaner than it is,
which is the one thing a measurement display must never do.

## The protocol

[docs/PROTOCOL.md](docs/PROTOCOL.md) is the reference for both USBTMC framing and the
SCPI command set, with every claim marked as verified against hardware, taken from the
manual, or uncertain. Several spellings are genuinely uncertain — the TDS1000/2000 and
TBS1000B families share a manual lineage but not a command set — and
`python3 tools/probe.py try-spellings` is how they get settled.

## Licence

MIT. See [LICENSE](LICENSE).

[webusb]: https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API
[zadig]: https://zadig.akeo.ie/
[feeltech]: https://github.com/OpenPhysics/feelTechFunctionGenerator
