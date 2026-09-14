# Talking to a TBS1072B-EDU

Reference for the two protocols this project implements: **USBTMC**, which carries
bytes, and **SCPI**, which is what those bytes say.

Every claim below is marked, and the marking is the point — a command that looks right
and is silently ignored is the characteristic failure of this instrument, so a claim
that has not been tested is worth less than no claim at all.

| Mark | Meaning |
|---|---|
| **[V]** | Read back from the instrument with `tools/probe.py` |
| **[M]** | From the TBS1000B-series programmer manual, not yet exercised |
| **[?]** | Believed but uncertain; the manuals for neighbouring models disagree |

To verify a row, run `python3 tools/probe.py try-spellings` (see [SETUP.md](SETUP.md)),
then change its mark here and add the date.

**Verified against:** a TBS1072B-EDU, serial C011239, firmware `CF:91.1CT FV:v2.52`,
USB `0699:0368`, on **2026-09-14** with `tools/probe.py info`, `try-spellings`, `curve`
and `screen`. The capture path is confirmed end to end: a transferred record scaled
here reads 1000.0 Hz / 5.200 V pk-pk / −160 mV minimum, matching the instrument's own
front-panel readout of 1.000 kHz / 5.20 V / −160 mV digit for digit.

---

## The transport: USBTMC

**[V]** The scope enumerates as `0699:0368` and offers a USBTMC interface —
`bInterfaceClass = 0xFE` (application specific), `bInterfaceSubClass = 0x03`
(test & measurement). Confirmed from `usbipd list` on this machine.

**[V]** The USBTMC interface is number **0**, with bulk-OUT at endpoint address
`0x04`, bulk-IN at `0x82`, and a **64-byte** maximum packet size. USBTMC version
reports as **01.00**.

**[V]** `*IDN?` answers `TEKTRONIX,TBS 1072B-EDU,C011239,CF:91.1CT FV:v2.52` — note
the space in the model name, and that the firmware field carries two colon-separated
parts.

**[V]** USBTMC device capabilities byte reads `0x01`, i.e. the device supports ending
a bulk-IN transfer on a TermChar. This driver does not use that, since the header's
length field already delimits every reply.

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

**[V]** `HEADER OFF` is the one that matters. With headers on, `CH1:SCALE?` answers
`:CH1:SCALE 5.0E-1` instead of `5.0E-1`, and every numeric parser in `scpi.ts`
breaks. `LOCK NONE` keeps the physical front panel alive while the page is
connected — without it the knobs go dead, which is baffling if you are standing at
the bench.

### [V] VERBOSE OFF means replies come back abbreviated

This one cost a real bug. Under `VERBOSE OFF` the instrument answers enumerated
queries with the **minimum-length** keyword, not the full one:

| Query | Reply observed | Full form |
|---|---|---|
| `ACQUIRE:MODE?` | `SAM` | `SAMPLE` |
| `ACQUIRE:STATE?` | `1` | — |
| `CH1:COUPLING?` | `DC` | `DC` |
| `TRIGGER:MAIN:EDGE:SOURCE?` | `CH1` | `CH1` |

Comparing a reply against the full word therefore rejects every valid answer. Because
`readbackPlan` skips a reply it cannot interpret — deliberately, so one bad reply costs
one control rather than the whole sync — the symptom was not an error but a control
that silently never updated.

`matchEnum` in `scpi.ts` now resolves abbreviations, taking an exact match ahead of a
prefix so that `EXT` stays distinct from `EXT5`, and refusing an ambiguous
abbreviation rather than guessing. Note that the instrument **sends** short forms but
**accepts** long ones, so the encoders are unaffected.

### Commands this project sends

All **[M]** unless noted. Spellings are the long forms; the instrument also accepts
the abbreviated forms shown in mixed case in the manual (`HORizontal:SCAle`).

| Purpose | Command |
|---|---|
| Channel on/off | `SELECT:CH<n> ON\|OFF` **[V]** |
| Probe attenuation | `CH<n>:PROBE <1\|10\|100\|1000>` **[V]** |
| Volts per division | `CH<n>:SCALE <volts>` **[V]** |
| Vertical position | `CH<n>:POSITION <divisions>` |
| Coupling | `CH<n>:COUPLING DC\|AC\|GND` **[V]** |
| Bandwidth limit | `CH<n>:BANDWIDTH ON\|OFF` **[V]** |
| Timebase | `HORIZONTAL:SCALE <seconds>` **[V]** |
| Horizontal position | `HORIZONTAL:POSITION <seconds>` **[V]** |
| Trigger source | `TRIGGER:MAIN:EDGE:SOURCE CH1\|CH2\|EXT\|EXT5\|LINE` **[V]** |
| Trigger slope | `TRIGGER:MAIN:EDGE:SLOPE RISE\|FALL` **[V]** |
| Trigger mode | `TRIGGER:MAIN:MODE AUTO\|NORMAL` |
| Trigger level | `TRIGGER:MAIN:LEVEL <volts>` **[V]** |
| Acquisition mode | `ACQUIRE:MODE SAMPLE\|PEAKDETECT\|AVERAGE` **[V]** |
| Averaging count | `ACQUIRE:NUMAVG 4\|16\|64\|128` **[V]** |
| Run / stop | `ACQUIRE:STATE RUN\|STOP` **[V]** |
| Free-run vs single | `ACQUIRE:STOPAFTER RUNSTOP\|SEQUENCE` **[V]** |

#### The spellings marked [?]

The TDS1000/2000 family uses `HORIZONTAL:MAIN:SCALE` and `TRIGGER:A:LEVEL`; the
TBS1000B manual gives the unprefixed forms.

**[V] Settled 2026-09-14: this firmware takes the unprefixed forms.** Both
`HORIZONTAL:SCALE?` (answered `5.0E-4`) and `TRIGGER:MAIN:LEVEL?` (answered `3.28E0`)
return values rather than errors, so the TBS spellings are correct and the TDS ones
are not needed.

`HORIZONTAL:POSITION?` also answers (`0.0E0`), so the whole horizontal group uses the
unprefixed spelling. `HORIZONTAL:MAIN:SCALE?` happens to work *as well* — the firmware
accepts both — but `HORIZONTAL:DELAY:TIME?` and `TRIGGER:A:LEVEL?` do not.

#### [V] The bandwidth limit takes ON|OFF

Not `FULL|TWENTY`, which both raise `102,"Syntax error; invalid character data"`. The
query answers `ON` or `OFF` too. This is worth singling out because it is the one case
found so far where a *setting* is rejected outright rather than ignored — most of this
instrument's failure modes are silent.

#### [V] An unrecognised query times out; it does not return an error

`HORIZONTAL:DELAY:TIME?`, `TRIGGER:A:LEVEL?` and `SAVE:IMAGE:LAYOUT?` all produce
`[Errno 110] Operation timed out` rather than an error reply. The event queue does
record `113,"Undefined header"` afterwards, but only if you can still talk to the
instrument — and the endpoint is left mid-transaction, so the *next* query fails too
unless a USBTMC clear runs first.

This is why `withTimeout` in `usbtmc.ts` performs a clear on every timeout. Without it
one typo in the raw console would poison every command after it.

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
SAVE:IMAGE:FILEFORMAT BMP
HARDCOPY START
```

**[V]** The format vocabulary, settled 2026-09-14 by setting each and reading it back:

| Format | Accepted | Browser can decode |
|---|---|---|
| `PNG` | **no** — `102,"Syntax error"` | — |
| `BMP` | yes | yes |
| `JPEG` | yes | yes |
| `TIFF` | yes | no |
| `PCX` | yes | no |

So the app tries **BMP then JPEG**. BMP is preferred despite its size: the screen is
thin traces and small text, exactly what JPEG artefacts damage most.

**[V]** The screen is **800x480**, and a 24-bit BMP of it is **1,152,054 bytes**
(`cbSize` from the header, 1,152,000 of pixel data plus a 54-byte header).

That number matters. `MAX_REPLY_BYTES` was originally 1 MB, so the transfer stopped one
chunk short of the end and the reply was silently truncated — and worse, the remainder
stayed queued in the endpoint, so every subsequent query read the tail of the abandoned
image and timed out. Both the TypeScript and the prober now cap at 4 MB **and raise
rather than return** when the cap is reached without EOM, so the failure is loud and the
caller's clear can resynchronise.

**[V] Hardcopy is confirmed working**, after a power cycle:

| Format | Size | Time | Rate |
|---|---|---|---|
| JPEG | 184,845 bytes | 1.8 s | ~98 kB/s |
| BMP | 1,152,108 bytes | 9.5 s | ~119 kB/s |

The app tries **JPEG first** on that evidence. At the quality this firmware encodes at,
the traces and menu text are crisp, and five times the wait for a difference you cannot
see is the wrong trade at a teaching bench. The JPEG also carries EXIF naming the
manufacturer, model and capture time, which is useful provenance for a lab report.

**[V] `HARDCOPY START` returns raw image bytes, not an IEEE 488.2 block.** The reply
begins `42 4d` (`BM`) or `ff d8 ff` directly, with no `#<n><length>` prefix — unlike
`CURVe?`, which does use one. So the screenshot path must *not* run
`parseDefiniteLengthBlock`, and the waveform path must.

**[V]** The BMP arrives with **54 trailing zero bytes** beyond the `cbSize` its own
header declares. Harmless — decoders use the declared size — but do not treat the
transfer length as the image length.

#### [V] An aborted hardcopy wedges the instrument

When the truncated 1 MB read above abandoned a transfer mid-flight, every subsequent
`HARDCOPY START` returned **nothing at all**: no data, `*ESR?` reporting 0, an empty
event queue, and `BUSY?` stuck at 1 even with the acquisition stopped. A USBTMC clear
resets the endpoints but not the instrument's own sense of what it was doing, and no
command sequence recovered it. **Only a power cycle did** — after which `BUSY?` read 0
and hardcopy worked first time.

This is the strongest argument for the "raise, do not truncate" rule in `readReply`: a
silently short read does not merely corrupt one image, it can take the instrument out
of service until someone walks over and switches it off.

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
