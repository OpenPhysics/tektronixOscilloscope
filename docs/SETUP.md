# Setup

The TBS1072B-EDU speaks **USBTMC** (USB Test & Measurement Class) over its rear USB
Device port. It is not a serial device and never appears as a COM port, so the browser
reaches it through **WebUSB**, not Web Serial.

WebUSB on Windows can only claim an interface whose driver is the generic **WinUSB**.
Out of the box this scope has *no* driver bound at all — Device Manager reports problem
code 28, "the drivers for this device are not installed" — so binding WinUSB displaces
nothing.

There are two independent things you may want to set up:

| Goal | What you need |
|---|---|
| Use the web page in Chrome | WinUSB, bound once with Zadig |
| Run `tools/probe.py` from WSL2 | usbipd-win, attaching the device into WSL |

They are mutually exclusive at any given moment: while the device is attached to WSL it
disappears from Windows, and Chrome cannot see it.

---

## 1. Bind WinUSB (for the web page)

First, whichever route you take: plug in the scope, switch it on, and confirm the rear
USB Device port is set to talk to a computer — front panel **Utility → Options → USB
Device Port → Computer**. The alternative, *Printer*, puts it in PictBridge mode and
USBTMC goes away entirely.

There are two ways to bind the driver and they end in the same place. Route A needs no
download, which is what you want on a managed or school machine; route B is fewer clicks
where running a downloaded program is no obstacle. The page offers both under its
**Need help connecting?** button, so this section and that dialog stay in step.

### A. Device Manager, using the driver Windows already has

Windows ships `winusb.inf` in-box (`C:\Windows\INF\winusb.inf`, class `USBDevice`), and
it carries a generic *WinUsb Device* entry you can select by hand. Nothing is downloaded
and nothing is signed, because Microsoft signed it already.

1. Press <kbd>Win</kbd>+<kbd>X</kbd> and choose **Device Manager**.
2. Find **Tektronix TBS 1072B-EDU**, most likely under *Other devices* with a yellow
   warning triangle.
3. Right-click it → **Update driver**.
4. **Browse my computer for drivers**.
5. **Let me pick from a list of available drivers on my computer**.
6. Choose the device class **Universal Serial Bus devices**.
7. Manufacturer **WinUsb Device**, model **WinUsb Device**, then **Next**.

### B. Zadig

1. Download Zadig from <https://zadig.akeo.ie/>. It is a single portable `.exe`; nothing
   is installed.
2. Run Zadig as Administrator.
3. **Options → List All Devices**.
4. Pick **Tektronix TBS 1072B-EDU** from the dropdown. Check that the USB ID line reads
   `0699 0368` — that is this instrument, confirmed on this machine.
5. Set the target driver (the right-hand box, with the green arrow) to **WinUSB**.
6. Click **Install Driver** and wait. It takes up to a minute.

Verify from WSL:

```bash
powershell.exe -NoProfile -Command \
  "Get-PnpDevice | Where-Object InstanceId -like '*VID_0699*' | Format-List Status,Class,FriendlyName"
```

You want `Status: OK` and `Class: USBDevice`. Before the bind this reads `Status: Error`
with an empty class, and `DEVPKEY_Device_ProblemCode` is 28 — *the drivers for this device
are not installed*. That is the state a fresh scope arrives in, so binding WinUSB
displaces nothing.

### Undoing it

Either route is reversible. If you later install TekVISA or OpenChoice and want them to see the
scope again: Device Manager → find the scope under *Universal Serial Bus devices* →
right-click → **Uninstall device**, tick *Delete the driver software for this device* →
unplug and replug. Windows then re-enumerates it bare, and the Tektronix installer can
claim it.

---

## 2. Attach to WSL2 with usbipd (for `tools/probe.py`)

`usbipd-win` is a separate install from <https://github.com/dorssel/usbipd-win/releases>;
check whether this machine has it with `usbipd --version` in PowerShell. The prober runs in
Linux, where USBTMC needs no special driver at all.

From an **Administrator** PowerShell on Windows:

```powershell
usbipd list                      # confirm the busid; it is 1-4 on this machine
usbipd bind --busid 1-4          # once per device, survives reboots
usbipd attach --wsl --busid 1-4  # each time you want it in WSL
```

Then in WSL:

```bash
lsusb                            # 0699:0368 Tektronix should appear
python3 tools/probe.py info
```

**When you are done, hand it back to Windows** — otherwise Chrome will not find it:

```powershell
usbipd detach --busid 1-4
```

> `usbipd bind` swaps the Windows-side driver for the usbip stub. If you have already run
> Zadig, `usbipd detach` restores WinUSB, so the two coexist fine as long as you detach
> before going back to the browser.

### Python dependencies

**`pip install pyusb` does not work on Ubuntu 24.04.** Its Python is marked
externally managed (PEP 668), so a bare `pip install` refuses with
`error: externally-managed-environment`. Use either of these instead.

A virtual environment, which needs no root:

```bash
python3 -m venv .venv
.venv/bin/pip install pyusb
.venv/bin/python3 tools/probe.py info
```

Or the distribution package, which puts it on the system Python:

```bash
sudo apt install python3-usb
python3 tools/probe.py info
```

`.venv/` is gitignored. Either way pyusb needs libusb, which Ubuntu ships by default
(`libusb-1.0-0`) — check the backend resolved with
`.venv/bin/python3 -c "import usb.backend.libusb1 as b; print(b.get_backend())"`.

The prober deliberately does *not* use PyVISA. It speaks the same raw USBTMC framing that
`src/device/usbtmc.ts` implements, so a discrepancy in the framing shows up here rather
than inside a browser tab.

### Permissions

WSL2 exposes the attached device as a raw USB node that root owns with mode 0664, so
claiming it as an ordinary user fails with:

```
usb.core.USBError: [Errno 13] Access denied (insufficient permissions)
```

That error means pyusb *found* the scope — the attach worked and only the permission is
missing. Install a udev rule once and neither `sudo` nor a reattach is needed again:

```bash
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="0699", ATTR{idProduct}=="0368", MODE="0666"' \
  | sudo tee /etc/udev/rules.d/99-tektronix.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --attr-match=idVendor=0699
```

The `trigger` is what applies the new rule to a device that is *already* attached, by
replaying a change event against it. Without that line you would have to detach and
reattach from Windows to get the node recreated.

Confirm it took:

```bash
ls -l /dev/bus/usb/*/*     # the scope's node should now be crw-rw-rw-
python3 tools/probe.py info
```

`sudo` is the alternative, but it needs a terminal to prompt on. Run from anything
non-interactive — a script, a CI step, an editor's shell integration — it fails with
`sudo: a terminal is required to read the password`. The udev rule avoids the problem
entirely, which is why it is the recommended route rather than merely a convenience.
Under `sudo` you must also name the venv's interpreter explicitly,
`sudo .venv/bin/python3 tools/probe.py`, since root's PATH will not find it.

> The udev rule only takes effect if systemd is running in WSL, which requires
> `[boot]` / `systemd=true` in `/etc/wsl.conf`. Check with `ps -p 1 -o comm=` — if that
> prints `init` rather than `systemd`, udev rules are not applied and `sudo` from a real
> terminal is the only route.

---

## 3. Run the page

```bash
npm install
npm run dev
```

Open <http://localhost:5173/tektronixOscilloscope/> in **Windows Chrome or Edge**. WSL2
forwards localhost, so the dev server running in Linux is reachable from the Windows
browser, and `localhost` counts as a secure context for WebUSB.

Firefox and Safari do not implement WebUSB and never will — this is a Chromium-only page.
