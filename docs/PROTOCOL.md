# Talking to a TBS1072B-EDU

Reference for the two protocols this project implements: **USBTMC**, which carries
bytes, and **SCPI**, which is what those bytes say.

Not yet verified against hardware. Every claim below is marked, and the marking is
the point — a command that looks right and is silently ignored is the characteristic
failure of this instrument, so a claim that has not been tested is worth less than
no claim at all.

| Mark | Meaning |
|---|---|
| **[V]** | Read back from the instrument with `tools/probe.py` |
| **[M]** | From the TBS1000B-series programmer manual, not yet exercised |
| **[?]** | Believed but uncertain; the manuals for neighbouring models disagree |

To verify a row, run `python3 tools/probe.py try-spellings` (see [SETUP.md](SETUP.md)),
then change its mark here and add the date.

**Verified against:** nothing yet. Device on the bench is a TBS1072B-EDU,
serial C011239, USB `0699:0368`.

---

## The transport: USBTMC

**[V]** The scope enumerates as `0699:0368` and offers a USBTMC interface —
`bInterfaceClass = 0xFE` (application specific), `bInterfaceSubClass = 0x03`
(test & measurement). Confirmed from `usbipd list` on this machine.

**[M]** `bInterfaceProtocol = 0x01` means USB488, i.e. it also speaks IEEE 488.2
common commands (`*IDN?`, `*CLS`, `*ESR?`).

There is no UART bridge inside. **The Web Serial API cannot see this instrument** —
Windows creates no COM port for it, so `navigator.serial.requestPort()` opens an
empty picker. This is the single biggest difference from the sibling
[feelTechFunctionGenerator][feeltech] project, whose FY3200S contains a CH340.

### Bulk transfer framing

Every message on the bulk endpoints carries a 12-byte header, little-endian:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | `MsgID` — `1` DEV_DEP_MSG_OUT, `2` REQUEST_DEV_DEP_MSG_IN |
| 1 | 1 | `bTag` — cycles 1..255, **never 0** |
| 2 | 1 | `bTagInverse` — `~bTag & 0xFF` |
| 3 | 1 | reserved, must be 0 |
| 4 | 4 | `TransferSize` — payload bytes, excluding this header |
| 8 | 1 | `bmTransferAttributes` — bit 0 `EOM`, bit 1 `TermCharEnabled` |
| 9 | 1 | `TermChar` |
| 10 | 2 | reserved, must be 0 |

The whole transfer is then zero-padded to a multiple of 4 bytes.

Reading a reply is two steps: send a `REQUEST_DEV_DEP_MSG_IN` naming how many bytes
you will accept, then read from bulk-IN. The device sets `EOM` on the transfer that
completes the message, so a long reply is a loop.

Three things that are easy to get wrong, all of which `test/usbtmc.test.ts` pins:

- `bTag` of 0 is reserved. Firmware may stall rather than answer.
- `TransferSize` counts the payload only, not the header.
- The bulk-IN read length should be a whole number of endpoint packets. A bulk
  transfer ends on a short packet, so asking for a non-multiple can truncate a
  full-length reply.

### Class control requests

Sent as `bmRequestType 0xA1` (class, interface, device-to-host):

| Request | Value | Purpose |
|---|---|---|
| `INITIATE_CLEAR` | 5 | Abort what is in flight, flush the buffers |
| `CHECK_CLEAR_STATUS` | 6 | Poll until it stops returning `0x02` PENDING |
| `GET_CAPABILITIES` | 7 | 24 bytes of what the device supports |

**A clear is not finished until you also send `CLEAR_FEATURE(ENDPOINT_HALT)` on the
bulk-OUT endpoint.** Skip that and the endpoint stays halted and every later write
fails. This is the recovery path after a query times out, and `usbtmc.ts` runs it
automatically from `withTimeout`.

### Timeouts

WebUSB transfers never time out on their own. A device that stops answering leaves
the promise pending forever, which the user experiences as a frozen page. Every
transfer in `usbtmc.ts` therefore races a timer — 5 s for commands, 30 s for image
transfers, because the scope renders the bitmap before it starts sending.

---

## The language: SCPI

### Session setup

**[M]** Send these once, on connect, before anything else:

```
*CLS
HEADER OFF
VERBOSE OFF
LOCK NONE
```

`HEADER OFF` is the one that matters. With headers on, `CH1:SCALE?` answers
`:CH1:SCALE 5.0E-1` instead of `5.0E-1`, and every numeric parser in `scpi.ts`
breaks. `LOCK NONE` keeps the physical front panel alive while the page is
connected — without it the knobs go dead, which is baffling if you are standing at
the bench.

### Commands this project sends

All **[M]** unless noted. Spellings are the long forms; the instrument also accepts
the abbreviated forms shown in mixed case in the manual (`HORizontal:SCAle`).

| Purpose | Command |
|---|---|
| Channel on/off | `SELECT:CH<n> ON\|OFF` |
| Probe attenuation | `CH<n>:PROBE <1\|10\|100\|1000>` |
| Volts per division | `CH<n>:SCALE <volts>` |
| Vertical position | `CH<n>:POSITION <divisions>` |
| Coupling | `CH<n>:COUPLING DC\|AC\|GND` |
| Bandwidth limit | `CH<n>:BANDWIDTH FULL\|TWENTY` |
| Timebase | `HORIZONTAL:SCALE <seconds>` **[?]** |
| Horizontal position | `HORIZONTAL:POSITION <seconds>` **[?]** |
| Trigger source | `TRIGGER:MAIN:EDGE:SOURCE CH1\|CH2\|EXT\|EXT5\|LINE` |
| Trigger slope | `TRIGGER:MAIN:EDGE:SLOPE RISE\|FALL` |
| Trigger mode | `TRIGGER:MAIN:MODE AUTO\|NORMAL` |
| Trigger level | `TRIGGER:MAIN:LEVEL <volts>` **[?]** |
| Acquisition mode | `ACQUIRE:MODE SAMPLE\|PEAKDETECT\|AVERAGE` |
| Averaging count | `ACQUIRE:NUMAVG 4\|16\|64\|128` |
| Run / stop | `ACQUIRE:STATE RUN\|STOP` |
| Free-run vs single | `ACQUIRE:STOPAFTER RUNSTOP\|SEQUENCE` |

#### The spellings marked [?]

The TDS1000/2000 family uses `HORIZONTAL:MAIN:SCALE` and `TRIGGER:A:LEVEL`; the
TBS1000B manual gives the unprefixed forms. Since the families share a manual
lineage but not a command set, `tools/probe.py try-spellings` asks the instrument
which of each pair it accepts. **Until that has been run, these four rows are
guesses.**

`ACQUIRE:STOPAFTER` and `ACQUIRE:STATE` are sent as a pair. Setting `STATE` alone
leaves the previous stop-after mode in force, so a run command after a single-shot
would arm one more single acquisition instead of free-running.

### Reading a waveform

```
DATA:SOURCE CH1
DATA:ENCDG RIBINARY
DATA:WIDTH 1
DATA:START 1
DATA:STOP 2500
WFMPRE:NR_PT?     ... and XINCR, XZERO, PT_OFF, YMULT, YZERO, YOFF
CURVE?
```

**[M]** The record is **2500 points** on this series, and `RIBINARY` at `WIDTH 1` is
signed 8-bit — the instrument's native resolution. `WIDTH 2` returns the same
information padded to twice the size.

`CURVE?` answers with an IEEE 488.2 definite-length block: `#42500` followed by 2500
bytes. `#42500` reads as "four digits of length follow, and they say 2500".

Scaling, straight from the manual:

```
volts   = YZERO + YMULT * (code - YOFF)
seconds = XZERO + XINCR * (index - PT_OFF)
```

Two practical notes:

- **Read the preamble immediately before `CURVE?`, every time.** The codes and the
  preamble only agree if nothing touched the vertical or horizontal settings in
  between. A stale preamble produces a plot that is wrong by a constant factor,
  with nothing in the data to reveal it.
- The preamble fields are queried one at a time rather than with a bare `WFMPRE?`,
  whose comma-separated field order differs between firmware revisions. Several
  short queries are slower but cannot silently misassign a scale factor.

### Measurements

```
MEASUREMENT:IMMED:SOURCE CH1
MEASUREMENT:IMMED:TYPE FREQUENCY
MEASUREMENT:IMMED:VALUE?
```

**[M]** `IMMED` is used rather than the five numbered `MEAS<x>` slots because it can
be repointed freely without disturbing what the user has set up on the front panel.

**[M]** A value of **9.9e37** means "cannot measure" — an unstable signal, or a
frequency request on a flat line. It is not an error and not a real reading; the UI
shows it as `unstable`.

These run over the full acquisition, not over the 2500 transferred points, so they
will not agree to the last digit with the statistics computed under the plot. Both
are shown precisely so that difference is visible.

### Screen capture

```
SAVE:IMAGE:FILEFORMAT PNG
HARDCOPY START
```

**[?]** **Genuinely unknown.** The TBS1000B manual lists BMP, PCX, TIFF, RLE,
EPSIMAGE and JPEG. Whether PNG is among them on this firmware has not been tested.

The app tries PNG then BMP, checking `*ESR?` after setting the format to see whether
it was rejected, and sniffs the returned bytes' magic numbers rather than trusting
the format it asked for. Browsers decode PNG, JPEG and BMP natively, so no image
decoder is needed; PCX and TIFF would need one, and are not offered.

`python3 tools/probe.py screen --out /tmp/screen` settles this in one run.

### Error checking

Nothing acknowledges a setting. To find out whether the instrument accepted one:

- `*ESR?` — the standard event status register, non-zero after a rejected command
- `EVMSG?` — the event queue, with a human-readable message

`probe.py send` sends a command and then reads `EVMSG?`, which is the fastest way to
find out that a spelling is wrong.

---

## Probing

Full setup in [SETUP.md](SETUP.md). The short version, from an Administrator
PowerShell on Windows:

```powershell
usbipd bind --busid 1-4
usbipd attach --wsl --busid 1-4
```

Then in WSL:

```bash
python3 tools/probe.py info           # identity, capabilities, current settings
python3 tools/probe.py try-spellings  # settle the [?] rows above
python3 tools/probe.py curve --out /tmp/curve.csv
python3 tools/probe.py screen --out /tmp/screen
python3 tools/probe.py repl
```

And hand it back before using the browser, or Chrome will not find it:

```powershell
usbipd detach --busid 1-4
```

`probe.py` implements the same USBTMC framing as `src/device/usbtmc.ts` rather than
using PyVISA, so a mistake in the framing surfaces in a language with a REPL instead
of inside a browser tab.

[feeltech]: https://github.com/OpenPhysics/feelTechFunctionGenerator
