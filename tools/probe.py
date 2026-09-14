#!/usr/bin/env python3
"""
Raw USBTMC prober for the Tektronix TBS1072B-EDU.

This exists so that src/device/usbtmc.ts and src/device/scpi.ts encode what the
instrument actually accepts, rather than what the internet believes a Tektronix
scope accepts. The TDS1000/2000, TBS1000 and TBS1000B families share a manual
lineage but not a command set - `HORizontal:MAIn:SCAle` is right on one and an
error on another - and the only way to know is to ask this unit.

It deliberately does NOT use PyVISA. It implements the same 12-byte USBTMC
framing that the TypeScript does, so a mistake in the framing surfaces here,
in a language with a REPL, instead of inside a browser tab.

Not part of the npm project. See docs/SETUP.md for the usbipd incantations that
put the device in front of WSL2.

Usage:
    python3 tools/probe.py info
    python3 tools/probe.py query '*IDN?'
    python3 tools/probe.py send 'CH1:SCALE 0.5'
    python3 tools/probe.py try-spellings
    python3 tools/probe.py curve --channel 1 --out /tmp/curve.csv
    python3 tools/probe.py screen --out /tmp/screen
    python3 tools/probe.py repl
"""

from __future__ import annotations

import argparse
import struct
import sys
import time

try:
    import usb.core
    import usb.util
except ImportError:
    sys.exit("pyusb is not installed. Run: pip install pyusb")

VENDOR_ID = 0x0699
PRODUCT_ID = 0x0368

# USBTMC bulk-out MsgID values.
DEV_DEP_MSG_OUT = 1
REQUEST_DEV_DEP_MSG_IN = 2

# USBTMC class requests on the interface.
INITIATE_CLEAR = 5
CHECK_CLEAR_STATUS = 6
GET_CAPABILITIES = 7

# Interface descriptor identifying a USBTMC interface.
USBTMC_CLASS = 0xFE
USBTMC_SUBCLASS = 0x03

DEFAULT_TIMEOUT_MS = 5000


class UsbTmc:
    """Minimal USBTMC session: open, write, read, clear."""

    def __init__(self, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
        device = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)
        if device is None:
            sys.exit(
                f"no {VENDOR_ID:04x}:{PRODUCT_ID:04x} on the bus.\n"
                "Attach it to WSL first:  usbipd attach --wsl --busid 1-4"
            )
        self.device = device
        self.timeout_ms = timeout_ms

        # Linux may already have usbtmc bound; take the interface off it.
        try:
            if device.is_kernel_driver_active(0):
                device.detach_kernel_driver(0)
        except (NotImplementedError, usb.core.USBError):
            pass

        device.set_configuration()
        config = device.get_active_configuration()

        interface = usb.util.find_descriptor(
            config,
            custom_match=lambda i: (
                i.bInterfaceClass == USBTMC_CLASS
                and i.bInterfaceSubClass == USBTMC_SUBCLASS
            ),
        )
        if interface is None:
            sys.exit("device has no USBTMC interface - is the USB port set to Computer?")
        self.interface = interface

        self.ep_out = usb.util.find_descriptor(
            interface,
            custom_match=lambda e: (
                usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT
                and usb.util.endpoint_type(e.bmAttributes) == usb.util.ENDPOINT_TYPE_BULK
            ),
        )
        self.ep_in = usb.util.find_descriptor(
            interface,
            custom_match=lambda e: (
                usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN
                and usb.util.endpoint_type(e.bmAttributes) == usb.util.ENDPOINT_TYPE_BULK
            ),
        )
        if self.ep_out is None or self.ep_in is None:
            sys.exit("USBTMC interface is missing a bulk endpoint pair")

        self.max_packet = self.ep_in.wMaxPacketSize
        # bTag cycles 1..255 and is never 0; 0 is reserved and some firmware stalls on it.
        self._btag = 0

    def _next_btag(self) -> int:
        self._btag = (self._btag % 255) + 1
        return self._btag

    @staticmethod
    def _pad4(data: bytes) -> bytes:
        """Every USBTMC transfer is padded to a multiple of 4 bytes."""
        return data + b"\x00" * (-len(data) % 4)

    def write(self, message: str) -> None:
        """Send one command. USBTMC is length-delimited, so no terminator is needed."""
        payload = message.encode("ascii") + b"\n"
        btag = self._next_btag()
        header = struct.pack(
            "<BBBBIBBH",
            DEV_DEP_MSG_OUT,
            btag,
            (~btag) & 0xFF,
            0x00,
            len(payload),
            0x01,  # bmTransferAttributes: EOM
            0x00,  # TermChar, unused on writes
            0x0000,
        )
        self.ep_out.write(self._pad4(header + payload), self.timeout_ms)

    def read_raw(self, max_bytes: int = 1024 * 1024) -> bytes:
        """Request a reply and reassemble it across bulk-IN transfers until EOM."""
        chunks: list[bytes] = []
        remaining = max_bytes

        while remaining > 0:
            btag = self._next_btag()
            request = struct.pack(
                "<BBBBIBBH",
                REQUEST_DEV_DEP_MSG_IN,
                btag,
                (~btag) & 0xFF,
                0x00,
                min(remaining, 0x100000),
                0x00,  # no TermChar: let the length field delimit the reply
                0x00,
                0x0000,
            )
            self.ep_out.write(self._pad4(request), self.timeout_ms)

            # Ask for header + payload rounded up to whole packets; libusb will
            # return short, which is how a transfer ends.
            want = min(remaining + 12, 64 * 1024)
            want += -want % self.max_packet
            reply = self.ep_in.read(want, self.timeout_ms).tobytes()

            if len(reply) < 12:
                raise IOError(f"truncated USBTMC header: {len(reply)} bytes")

            size = struct.unpack_from("<I", reply, 4)[0]
            attributes = reply[8]
            body = reply[12 : 12 + size]
            chunks.append(body)
            remaining -= len(body)

            if attributes & 0x01:  # EOM
                break

        return b"".join(chunks)

    def query(self, message: str) -> str:
        self.write(message)
        return self.read_raw().decode("ascii", errors="replace").strip()

    def query_binary(self, message: str) -> bytes:
        self.write(message)
        return self.read_raw()

    def capabilities(self) -> bytes:
        """GET_CAPABILITIES: 24 bytes describing what the device supports."""
        return bytes(
            self.device.ctrl_transfer(
                0xA1,  # class request, interface, device-to-host
                GET_CAPABILITIES,
                0x0000,
                self.interface.bInterfaceNumber,
                0x0018,
                self.timeout_ms,
            )
        )

    def clear(self) -> None:
        """Abort whatever is in flight and flush both endpoint buffers."""
        self.device.ctrl_transfer(
            0xA1, INITIATE_CLEAR, 0x0000, self.interface.bInterfaceNumber, 1, self.timeout_ms
        )
        for _ in range(20):
            status = self.device.ctrl_transfer(
                0xA1,
                CHECK_CLEAR_STATUS,
                0x0000,
                self.interface.bInterfaceNumber,
                2,
                self.timeout_ms,
            )
            if status[0] != 0x02:  # not PENDING
                break
            time.sleep(0.05)
        # The spec requires clearing the halt on bulk-OUT after a clear.
        self.device.clear_halt(self.ep_out.bEndpointAddress)

    def close(self) -> None:
        usb.util.dispose_resources(self.device)


def parse_block(data: bytes) -> bytes:
    """
    Unwrap an IEEE 488.2 definite-length block: #<n><length n digits><payload>.

    CURVe? and HARDCopy both answer in this form. `#42500` means "4 digits of
    length follow, and they say 2500".
    """
    if not data or data[0:1] != b"#":
        raise ValueError(f"not a definite-length block: {data[:16]!r}")
    digits = int(data[1:2])
    if digits == 0:
        raise ValueError("indefinite-length blocks are not supported")
    length = int(data[2 : 2 + digits])
    start = 2 + digits
    return data[start : start + length]


def setup_session(scope: UsbTmc) -> None:
    """
    Put the instrument in the state every other command assumes.

    HEADer OFF is the critical one: with headers on, `CH1:SCALE?` answers
    ':CH1:SCALE 5.0E-1' instead of '5.0E-1' and every parser downstream breaks.
    """
    scope.write("*CLS")
    scope.write("HEADER OFF")
    scope.write("VERBOSE OFF")


# ------------------------------------------------------------------ commands ---


def cmd_info(scope: UsbTmc, _args: argparse.Namespace) -> None:
    caps = scope.capabilities()
    print(f"USBTMC interface : #{scope.interface.bInterfaceNumber}")
    print(f"  bulk OUT       : 0x{scope.ep_out.bEndpointAddress:02x}")
    print(f"  bulk IN        : 0x{scope.ep_in.bEndpointAddress:02x} "
          f"(max packet {scope.max_packet})")
    # GET_CAPABILITIES layout: bcdUSBTMC at 2-3, USBTMC interface/device
    # capabilities at 4/5, then bcdUSB488 at 12-13 with the USB488
    # interface/device capabilities at 14/15. An earlier version of this file
    # printed bytes 4 and 5 as the USB488 pair, which they are not.
    print(f"  USBTMC version : {caps[3]:02x}.{caps[2]:02x}")
    print(f"  USBTMC iface   : 0x{caps[4]:02x}  device: 0x{caps[5]:02x}"
          f"  (TermChar {'yes' if caps[5] & 0x01 else 'no'})")
    print(f"  USB488 version : {caps[13]:02x}.{caps[12]:02x}")
    print(f"  USB488 iface   : 0x{caps[14]:02x}  device: 0x{caps[15]:02x}")
    print()

    setup_session(scope)
    for question, label in [
        ("*IDN?", "identity"),
        ("ACQUIRE:MODE?", "acquire mode"),
        ("ACQUIRE:STATE?", "acquire state"),
        ("HORIZONTAL:SCALE?", "timebase (s/div)"),
        ("CH1:SCALE?", "CH1 (V/div)"),
        ("CH1:COUPLING?", "CH1 coupling"),
        ("CH2:SCALE?", "CH2 (V/div)"),
        ("TRIGGER:MAIN:LEVEL?", "trigger level"),
        ("TRIGGER:MAIN:EDGE:SOURCE?", "trigger source"),
    ]:
        try:
            print(f"  {label:<18}: {scope.query(question)}")
        except Exception as error:  # noqa: BLE001 - probing, report and continue
            print(f"  {label:<18}: FAILED ({error})")
            scope.clear()

    # WFMPRE reports on whatever DATA:SOURCE currently names, so the source has
    # to be selected before the record length means anything.
    try:
        scope.write("DATA:SOURCE CH1")
        print(f"  {'record length':<18}: {scope.query('WFMPRE:NR_PT?')}")
    except Exception as error:  # noqa: BLE001 - probing, report and continue
        print(f"  {'record length':<18}: FAILED ({error})")
        scope.clear()


def cmd_query(scope: UsbTmc, args: argparse.Namespace) -> None:
    setup_session(scope)
    print(scope.query(args.command))


def cmd_send(scope: UsbTmc, args: argparse.Namespace) -> None:
    setup_session(scope)
    scope.write(args.command)
    # Nothing acknowledges a setting, so ask the error queue whether it liked it.
    print(f"sent: {args.command}")
    print(f"EVMSG?: {scope.query('EVMSG?')}")


def cmd_try_spellings(scope: UsbTmc, _args: argparse.Namespace) -> None:
    """
    Settle the command-set questions the manuals disagree about.

    Anything printed as OK here may be hard-coded in src/device/scpi.ts;
    anything that errors must not be.
    """
    setup_session(scope)
    candidates = [
        "HORIZONTAL:SCALE?",
        "HORIZONTAL:MAIN:SCALE?",
        "HORIZONTAL:POSITION?",
        "HORIZONTAL:DELAY:TIME?",
        "TRIGGER:MAIN:LEVEL?",
        "TRIGGER:A:LEVEL?",
        "TRIGGER:MAIN:EDGE:SLOPE?",
        "CH1:PROBE?",
        "CH1:BANDWIDTH?",
        "ACQUIRE:NUMAVG?",
        "ACQUIRE:STOPAFTER?",
        "DATA:WIDTH?",
        "SAVE:IMAGE:FILEFORMAT?",
        "HARDCOPY:FORMAT?",
        "HARDCOPY:PORT?",
        "MEASUREMENT:IMMED:TYPE?",
        "SELECT:CH1?",
        "LOCK?",
    ]
    for command in candidates:
        scope.write("*CLS")
        try:
            answer = scope.query(command)
            event = scope.query("*ESR?")
            verdict = "OK  " if event.strip() in ("0", "0.0") else f"ESR={event}"
            print(f"  {verdict}  {command:<32} -> {answer}")
        except Exception as error:  # noqa: BLE001 - probing, report and continue
            print(f"  FAIL  {command:<32} -> {error}")
            scope.clear()


def cmd_curve(scope: UsbTmc, args: argparse.Namespace) -> None:
    setup_session(scope)
    channel = args.channel
    scope.write(f"DATA:SOURCE CH{channel}")
    scope.write("DATA:ENCDG RIBINARY")
    scope.write("DATA:WIDTH 1")
    scope.write("DATA:START 1")
    scope.write("DATA:STOP 2500")

    preamble = {
        field: scope.query(f"WFMPRE:{field}?")
        for field in ("NR_PT", "XINCR", "XZERO", "PT_OFF", "YMULT", "YZERO", "YOFF")
    }
    for key, value in preamble.items():
        print(f"  {key:<8}: {value}")

    raw = parse_block(scope.query_binary("CURVE?"))
    print(f"  curve    : {len(raw)} bytes")

    x_incr = float(preamble["XINCR"])
    x_zero = float(preamble["XZERO"])
    pt_off = float(preamble["PT_OFF"])
    y_mult = float(preamble["YMULT"])
    y_zero = float(preamble["YZERO"])
    y_off = float(preamble["YOFF"])

    samples = [
        (
            x_zero + x_incr * (index - pt_off),
            y_zero + y_mult * (struct.unpack("b", raw[index : index + 1])[0] - y_off),
        )
        for index in range(len(raw))
    ]

    volts = [v for _, v in samples]
    print(f"  min/max  : {min(volts):+.4f} V / {max(volts):+.4f} V")
    print(f"  Vpp      : {max(volts) - min(volts):.4f} V")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write("time_s,voltage_v\n")
            for t, v in samples:
                handle.write(f"{t:.9e},{v:.6e}\n")
        print(f"  wrote    : {args.out}")


def cmd_screen(scope: UsbTmc, args: argparse.Namespace) -> None:
    """
    Find out which hardcopy image formats this firmware really supports.

    The TBS1000B manual lists BMP/PCX/TIFF/RLE/EPSIMAGE/JPEG. Whether PNG is
    among them decides whether ui/screenshot.ts needs a BMP decoder, so this
    tries each and reports what came back.
    """
    setup_session(scope)
    for image_format in ("PNG", "BMP", "JPEG", "TIFF", "PCX"):
        scope.write("*CLS")
        try:
            scope.write(f"SAVE:IMAGE:FILEFORMAT {image_format}")
            event = scope.query("*ESR?").strip()
            if event not in ("0", "0.0"):
                print(f"  {image_format:<5}: rejected (ESR={event})")
                continue
            data = scope.query_binary("HARDCOPY START")
            magic = data[:8].hex(" ")
            print(f"  {image_format:<5}: {len(data)} bytes, starts {magic}")
            if args.out:
                path = f"{args.out}.{image_format.lower()}"
                with open(path, "wb") as handle:
                    handle.write(data)
                print(f"         wrote {path}")
        except Exception as error:  # noqa: BLE001 - probing, report and continue
            print(f"  {image_format:<5}: FAILED ({error})")
            scope.clear()


def cmd_repl(scope: UsbTmc, _args: argparse.Namespace) -> None:
    setup_session(scope)
    print("Commands ending in ? are queried, everything else is sent. Ctrl-D exits.")
    while True:
        try:
            line = input("scope> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        try:
            if line.endswith("?"):
                print(scope.query(line))
            else:
                scope.write(line)
        except Exception as error:  # noqa: BLE001 - interactive, keep the session alive
            print(f"error: {error}")
            scope.clear()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("info", help="identity, capabilities and current settings")
    sub.add_parser("try-spellings", help="probe which SCPI spellings this firmware accepts")
    sub.add_parser("repl", help="interactive session")

    p_query = sub.add_parser("query", help="send one query and print the reply")
    p_query.add_argument("command")

    p_send = sub.add_parser("send", help="send one setting and check the error queue")
    p_send.add_argument("command")

    p_curve = sub.add_parser("curve", help="capture a waveform and report its extremes")
    p_curve.add_argument("--channel", type=int, default=1, choices=(1, 2))
    p_curve.add_argument("--out", help="write the scaled samples to this CSV")

    p_screen = sub.add_parser("screen", help="probe hardcopy image formats")
    p_screen.add_argument("--out", help="write each successful image to <out>.<ext>")

    args = parser.parse_args()
    handlers = {
        "info": cmd_info,
        "query": cmd_query,
        "send": cmd_send,
        "try-spellings": cmd_try_spellings,
        "curve": cmd_curve,
        "screen": cmd_screen,
        "repl": cmd_repl,
    }

    scope = UsbTmc()
    try:
        handlers[args.command](scope, args)
    finally:
        scope.close()


if __name__ == "__main__":
    main()
