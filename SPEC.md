# Responsive Windows for Workgroups 3.11 in the Browser — Expanded Spec

Expands `responsive-wfw311-spec.md` (the original, kept unchanged). Sections marked
**DECISION** need a call from Josh before the affected phase starts. Sections marked
**VERIFY** are claims I am confident enough to plan around but will confirm against the
DDK docs or by experiment in Phase 0.

---

## 0. What already exists (and gets reused)

Found in `~/Source/386boot` while surveying the machine:

| Asset | Path | Use here |
|---|---|---|
| WfW 3.11 OEM floppies (8 disks) + DOS 6.22 | `386boot/Microsoft Windows for Workgroups 3.11 (OEM)...`, `386boot/Dos6.22.img` | Source media for a fresh trimmed install |
| Installed DOS 6.22 + WfW 3.11 CF image, boots to Program Manager unattended | `386boot/wfw311-cf.img` (plain OS), `wfw311-cf-v5.img` (latest, with WLINK apps) | Phase 0 boot target in v86; base for the lean delivery image |
| Open Watcom v2 (linux-x64 static binaries, run via Docker) + working Win16 NE build script | `386boot/wifi-dongle/tools/watcom`, `win16/build.sh` | Builds the companion EXE and the C parts of the driver DLL |
| QEMU headless harness (monitor driver, screenshots, typing) | `386boot/wifi-dongle/tools/qemu-harness` | Regression testing the driver in QEMU alongside v86 (QEMU has its own Bochs VBE adapter, see §2) |

Machine state: node 22, clang, make, python 3.14, git/gh, QEMU 11.1, UTM, Docker (per
build.sh). **Missing:** Rust toolchain (v86 needs `cargo` + `wasm32-unknown-unknown`),
DOSBox/DOSBox-X, a MASM-compatible assembler, and the WfW 3.11 DDK.

Consequence for the plan: Phase 0 shrinks. There is already a known-good WfW install and a
macOS-hosted Win16 build loop. Phase 0 becomes "v86 builds locally and boots the existing
image" plus "DDK toolchain runs", not a from-scratch install.

---

## 1. Objective (unchanged) and success criteria

Run WfW 3.11 in the browser on v86 such that crossing a viewport breakpoint re-modes
Windows to a new resolution without a reboot.

Concrete acceptance tests, in order of ambition:

1. **A0 (Phase 2):** WfW 3.11 boots on the paravirtual adapter at any of 640x480,
   800x600, 1024x768 (chosen at boot), runs Program Manager, File Manager, Write,
   Paintbrush, Solitaire for a 30-minute session with no visual corruption or hang.
2. **A1 (Phase 2.5, baseline ship):** Dragging the browser across a breakpoint causes
   Windows to restart itself (`ExitWindows(EW_RESTARTWINDOWS)`) at the new resolution
   within ~10 s, session state in apps lost, no DOS prompt visible.
3. **A2 (Phase 3):** Same drag re-modes live. Program Manager reflows, open apps keep
   state, mouse hit-testing is correct, screen repaints cleanly. Total time under 1 s.
4. **A3 (Phase 4):** Phone rotation portrait/landscape does A2. Background the tab, kill
   the browser, reopen: session restored from snapshot in under 5 s, no cold boot.

---

## 2. Architecture

### 2.1 Paravirtual display adapter (v86 side)

**DECISION D1 — extend v86's existing Bochs VBE ("DISPI") adapter rather than build a
new device.** Recommended.

v86 already implements the Bochs/QEMU VBE display interface: index/data ports
`0x1CE`/`0x1CF` with registers `XRES`, `YRES`, `BPP`, `ENABLE`, `BANK`,
`VIRT_WIDTH/HEIGHT`, `X/Y_OFFSET`, and a linear framebuffer at physical
`0xE0000000`, rendered to the canvas with dirty-rectangle tracking. QEMU's `-vga std`
is the same interface. That gives us:

- A framebuffer device that already exists, is tested, and is identical in v86 and QEMU,
  so the driver can be regression-tested in QEMU's harness and run in the browser
  unchanged.
- An existing DDK code path to start from: the WfW 3.11 DDK SVGA sample driver
  (DIB-engine based) has a VESA VBE code path, and v86 ships a VGA BIOS with VBE. That
  sample driver very likely boots on stock v86 today with zero code written. This is the
  new Phase 1 milestone (see §3).

What we add to the DISPI register set, in v86 only at first (QEMU gets a tiny patch or a
stub if we want parity):

| Reg (index) | Name | R/W | Meaning |
|---|---|---|---|
| `0x0A` | `HOST_XRES` | R | Resolution the host wants, from breakpoint table |
| `0x0B` | `HOST_YRES` | R | " |
| `0x0C` | `HOST_DPI` | R | 96 or 120, chosen from initial device class, fixed per session |
| `0x0D` | `STATUS` | R/W1C | bit0 `MODE_REQUEST` set by host when HOST_XRES/YRES change; guest writes 1 to clear. bit1 `IRQ_ENABLE` |
| `0x0E` | `CURSOR_X` | W | Guest cursor position, written by the driver's `MoveCursor` (see §2.5) |
| `0x0F` | `CURSOR_Y` | W | " |
| `0x10` | `DEBUG` | W | Byte written appears on the host console (like Bochs port `0xE9`) |
| `0x11` | `GENERATION` | R | Increments on every host mode request; lets a poller detect a missed edge |

Plus an optional IRQ line (ISA IRQ 9 or 11, or PCI INTA if we present the device as
PCI) raised when `MODE_REQUEST` sets and `IRQ_ENABLE` is on. See D2 for why this is
optional.

If D1 is rejected in favour of the original "clean device with its own I/O block", the
register list above still stands; we just also own `XRES/YRES/BPP/ENABLE` and the
framebuffer mapping, and lose the free QEMU parity and the free SVGA-sample starting
point. Cost estimate: +2 weekends in Phase 1 and a harder Phase 2.

**Framebuffer policy: fixed pitch.** Allocate the framebuffer once at the largest mode
(1024 px × 768 lines × 1 byte = 768 KB; at 16 bpp, 1.5 MB) and keep `VIRT_WIDTH`
(pitch) fixed at 1024 pixels across all modes. A re-mode then changes only the visible
width and height. Anything in GDI, USER, or the DIB engine that cached the scanline
stride stays valid, which removes an entire class of Phase 3 corruption bugs. Host side,
rendering simply reads a `w×h` window out of a `1024×768` buffer.

**Colour depth.** 8 bpp palettised for Phases 1-3 (what the DDK SVGA sample does, what
Win 3.x apps expect, smallest framebuffer, cheapest host conversion). 16 bpp is a
Phase 4 option if palette flashing in the shell is bothersome; the DIB engine supports
it. Rendering 8 bpp on the host requires the palette: the DISPI interface has no
palette registers, so the driver programs the standard VGA DAC ports `0x3C8/0x3C9`,
which v86 already emulates and applies to LFB modes at 8 bpp. **VERIFY** in Phase 1.

### 2.2 Display driver (guest, 16-bit)

An NE-format DLL, `PVDISP.DRV`, installed via `SYSTEM.INI [boot] display.drv=` plus a
matching `OEMSETUP.INF`-style entry (or just hand-edited `SYSTEM.INI` since we own the
image). Based on the WfW 3.11 DDK SVGA sample, which sits on top of `DIBENG.DLL`
(shipped with WfW 3.11). The driver:

- Implements the required GDI display-driver exports by ordinal (`Enable`, `Disable`,
  `ReEnable`, `BitBlt`, `Output`, `ExtTextOut`, `RealizeObject`, `Control`,
  `Inquire`, `SetCursor`, `MoveCursor`, `CheckCursor`, `SetPalette`, `GetPalette`,
  `SetPaletteTranslate`, `UpdateColors`, `DibBlt`, `StretchBlt`, `StretchDIBits`,
  `CreateDIBitmap`, `DibToDevice`, `SelectBitmap`, `BitmapBits`, `EnumDFonts`,
  `EnumObj`, `ColorInfo`, `Pixel`, `StrBlt`, `ScanLR`, `DeviceMode`, `DeviceBitmap`,
  `FastBorder`, `SetAttribute`, `GetCharWidth`, `GetDriverResourceID`,
  `UserRepaintDisable`). Nearly all forward to the DIB engine's `DIB_*` twins; the
  sample already does this. **VERIFY** exact ordinal list against the DDK.
- `Enable` (first call, fills `GDIINFO`): reads `HOST_XRES/YRES/DPI` from the device and
  reports `dpHorzRes/dpVertRes/dpLogPixelsX/Y` accordingly. This alone makes the
  restart-based fallback (A1) work with no other code.
- `Enable` (second call, fills `PDEVICE`/`DIBENGINE`): maps the LFB. In 386 enhanced
  mode (the only mode WfW 3.11 has), get a linear address for physical `0xE0000000` via
  DPMI `INT 31h / 0800h` (Physical Address Mapping), allocate a selector, set base to
  that linear address and limit to 768 KB or 1.5 MB (DPMI `0008h` accepts limits over
  64 KB under Windows' 32-bit-capable DPMI host). The DIB engine addresses the surface
  through one selector with a large limit, which is exactly how `VFLATD.386`-backed
  drivers worked; we skip VFLATD because the LFB is real. **VERIFY** in Phase 2; the
  fallback is to ship a tiny VxD that hands out the mapping.
- `Control` gains private escapes (numbers in the OEM range, `0x8000+`):
  `PV_QUERY_MODE` (return current and host-requested w/h/dpi and `GENERATION`),
  `PV_REMODE` (perform the resize, §2.4), `PV_DEBUG` (write a string to the debug
  register). These are how the companion utility talks to the driver.
- `MoveCursor` mirrors the cursor position to `CURSOR_X/Y` (§2.5).

Build toolchain, two options:

- **Preferred:** Open Watcom (already vendored, runs in Docker) for C and `wlink` for
  the NE DLL, plus a MASM-compatible assembler for the DDK sample's `.ASM` files.
  UASM (JWasm's successor) has a native macOS build and accepts MASM 5/6 syntax, so
  the DDK asm can be built on the host with no DOS emulation. Expect some
  `.MODEL`/segment-directive fixups. The DDK's own `MAKEFILE`s are NMAKE; we rewrite
  as a small `Makefile`.
- **Fallback:** MASM 5.10/6.11 + Microsoft C 7 / VC++ 1.52 + `LINK` under DOSBox-X,
  driven by a script. This is the "1992 toolchain rot" risk from the original spec;
  we only pay it if UASM/Watcom cannot swallow the sample.

### 2.3 Companion utility (guest, ring 3)

`PVMON.EXE`, Win16, built with the existing `win16/build.sh` flow. Started from
`WIN.INI [windows] load=` so it is up before Program Manager. Hidden window with a
message loop. Responsibilities:

- **Poll for resize.** `SetTimer` at 200 ms; each tick `Escape(hdcScreen, PV_QUERY_MODE)`.
  On a `GENERATION` change, run the re-mode sequence (§2.4).
- **Window wrangling after re-mode.** `EnumWindows` over top-level windows:
  maximised windows get `SetWindowPos` to the new screen rect; others are clamped
  on-screen and proportionally repositioned; Program Manager gets `WM_COMMAND` for
  Window > Arrange Icons and its group windows are re-tiled; File Manager is told to
  redraw. Then `RedrawWindow(hwndDesktop, NULL, NULL, RDW_INVALIDATE|RDW_ERASE|RDW_ALLCHILDREN)`.
- **Broadcast** a registered message `"PV_DISPLAYCHANGE"` with `wParam=LOWORD(w)`,
  `lParam=MAKELONG(h, dpi)` so any app we write (or patch) can react; also
  `WM_WININICHANGE` with `"windows"` and `WM_SYSCOLORCHANGE`, which make many stock apps
  re-query metrics.
- **Per-app policy table** (stretch tier 2): `{module name → fill | center | restack}`.
- **Debug channel.** Writes to `PV_DEBUG` so the host console shows what the utility is
  doing; no serial cable needed.

**DECISION D2 — polling via `Escape` instead of a hardware interrupt as the primary
resize trigger.** Recommended. A resize is already debounced to ~300 ms on the host, so
200 ms poll latency is invisible. It removes the hardest constraint of the original
design: an interrupt handler in a Win16 DLL runs in a context where calling GDI or USER
is illegal, so the "patch GDI/USER internals in the ISR" plan would have needed a
deferred-work mechanism anyway. From the utility's message loop we are in a normal
ring-3 context on the system VM and can call anything. The device keeps the IRQ line so
we can switch later (a VxD that services the IRQ and posts a message is the clean form)
if polling turns out to cost battery on phones; it will not, at 5 Hz reading one port.

### 2.4 The re-mode sequence (Phase 3)

Executed by `PV_REMODE` inside the driver, called from the utility's message loop.

1. Read `HOST_XRES/YRES`. Refuse if larger than the allocated framebuffer.
2. `UserRepaintDisable(TRUE)` (the export USER calls around DOS-box switches; **VERIFY**
   direction of call) or simply `LockWindowUpdate`-style suppression from the utility.
3. Program the device: write `XRES`, `YRES`; `VIRT_WIDTH` stays 1024. Host canvas
   resizes on the write.
4. Update the driver's own `DIBENGINE`: `deWidth`, `deHeight` (stride unchanged),
   cursor clip bounds.
5. Patch GDI's copy of the display `GDIINFO` (`dpHorzRes`, `dpVertRes`, `dpHorzSize`,
   `dpVertSize`) and the screen DC's cached caps and visible region (screen rect).
6. Patch USER: the system-metrics table (`SM_CXSCREEN`, `SM_CYSCREEN`,
   `SM_CXFULLSCREEN`, `SM_CYFULLSCREEN`, `SM_CXMAXIMIZED/CYMAXIMIZED` equivalents),
   the desktop `WND`'s `rcWindow`/`rcClient`, USER's cached screen DCs (the DC cache
   holds a small fixed number, each with a visible region), the cursor clip rectangle,
   and the mouse-coordinate scaling bounds.
7. Return; the utility does the window wrangling and broadcast (§2.3).

**How we find the GDI/USER offsets.** We ship one exact `USER.EXE` and `GDI.EXE` (WfW
3.11 retail, known checksums), so hard-coded offsets guarded by a checksum check are
acceptable and vastly simpler than heuristic scanning. To derive them:

- The Windows 3.1/3.11 SDK debug system (`USER.EXE`/`GDI.EXE` debug builds with `.SYM`
  files) names every global. Locate `rgwSysMet`, `hwndDesktop`, the DC cache, and the
  GDI device block in the debug build, then map to retail by matching the code that
  references them (e.g. disassemble retail `GetSystemMetrics` to read the `DS:`
  displacement of the table).
- The v86 host can read guest memory directly. A small JS helper dumps GDI's and USER's
  data segments and diffs them across two boots at different resolutions; the words that
  change from 640/480 to 800/600 are the candidates. This is the fastest way to find
  every cache we did not think of, and it is a tool only this project has (a 1993 driver
  author could not diff the OS's heap from outside the machine).
- Anything remaining is confirmed with WDEB386 or the v86 debugger.

**Research plan for Phase 3, ordered by risk reduction:**

- 3a. Shrink-only re-mode with steps 1-4 only. Expect: the desktop keeps drawing at the
  old size (clipped by the host), proving the driver and device halves work.
- 3b. Add step 6 (USER metrics + desktop rect). Expect: new windows open correctly
  positioned, maximise works, but repaint artefacts remain in old DCs.
- 3c. Add step 5 and DC-cache patching. Expect: clean.
- 3d. Grow re-mode (640 → 1024). Same code path; verifies nothing depended on the
  visible area being the whole buffer.
- 3e. Stress: re-mode every 500 ms for an hour in the QEMU harness, screenshot diffing.

### 2.5 Touch, cursor, and keyboard (Phase 4, designed now)

- PS/2 mouse emulation is relative, so a tap at a point cannot place the cursor without
  knowing where the guest cursor is. The driver's `MoveCursor` writes the guest cursor
  position to `CURSOR_X/Y`; the host reads it, computes the delta to the tap point, and
  injects that as mouse motion followed by a click. Result: absolute touch pointing with
  a stock mouse driver, no guest mouse-driver work.
- Cursor rendering: keep the DIB engine software cursor for Phase 2. In Phase 4,
  optionally let the host draw the cursor from the driver's `SetCursor` bitmap so the
  cursor can be rendered at device pixels and hidden entirely on touch devices.
- Gestures: tap = click, drag = drag, long-press (500 ms) = right click, two-finger
  vertical drag = `WM_VSCROLL` via mouse-wheel emulation is impossible in 3.11 (no wheel);
  instead the host sends Page Up/Down or the utility scrolls the focused window via
  `SendMessage(WM_VSCROLL)` triggered by a private escape. Defer the two-finger path;
  it is the least important.
- Keyboard: hidden `<input>` element focused by an on-screen toggle button; `keydown`
  events forward to v86's keyboard adapter. IME/autocorrect off.

### 2.6 DPI selection at boot

DPI is per session. Windows 3.x DPI is a property of the driver's `GDIINFO` plus the
font set in `SYSTEM.INI [boot]` (`fonts.fon`, `fixedfon.fon`, `oemfonts.fon`) and the
`[FontSubstitutes]`/`sysfonts` used at 120 DPI. Mechanism: `AUTOEXEC.BAT` runs a
20-line DOS utility `PVDPI.COM` that reads `HOST_DPI` and copies `SYSTEM.96` or
`SYSTEM.120` to `SYSTEM.INI` before `WIN`. Snapshots are keyed by DPI (§2.7); if a
restored device class implies a different DPI, we restart Windows rather than reboot
DOS, reusing the A1 path.

### 2.7 Host application (browser side)

Static site (any host; Vercel is connected if we want previews). Components:

- v86 fork with the adapter changes, built to `libv86.js` + `v86.wasm`.
- **Breakpoint controller:** listens to `visualViewport` `resize` (and `orientationchange`
  as a hint), debounces 300 ms, maps CSS width to the table below, writes
  `HOST_XRES/YRES`, bumps `GENERATION`, raises the IRQ if enabled. Also chooses the
  session DPI once at boot.
- **Canvas scaling:** the emulated mode is chosen so integer or near-integer scaling is
  possible; the canvas is CSS-sized to the viewport with `image-rendering: pixelated`
  when the scale is integer and default (bilinear) otherwise.
- **Disk delivery:** v86 supports lazily fetched disk images via HTTP Range requests
  (`async: true`), so first load does not need the whole image, only the sectors DOS and
  Windows actually touch. Combined with a service worker that caches fetched ranges, the
  second load is offline. Image is still trimmed (§4, Phase 0) to keep the total small.
- **Snapshot/restore:** `emulator.save_state()` on `visibilitychange` → hidden and on
  `pagehide`; compress with `CompressionStream('gzip')`; store in IndexedDB (OPFS where
  available). Restore on load if a snapshot exists for the current DPI class and disk
  image version. Budget: 32 MB RAM state compresses to roughly 5-15 MB; measure in
  Phase 4.
- **Memory budget:** VM RAM 32 MB, VGA/LFB 2 MB, v86 overhead ~20-30 MB, snapshot
  buffer transient. Target under 150 MB total tab footprint on iOS.

### 2.8 Breakpoint table (unchanged, plus orientation)

| Class | CSS viewport width | Emulated mode | DPI (per session) |
|---|---|---|---|
| Phone portrait | < 600 | 640x480 | 120 |
| Phone landscape | < 600 tall, or < 1024 wide with height < 600 | 800x480 (or 800x600 if height allows; test) | 120 |
| Tablet | 600-1024 | 800x600 | 96 or 120, decide in Phase 4 testing |
| Desktop | > 1024 | 1024x768 | 96 |

Non-4:3 modes such as 800x480 are free with a fixed-pitch framebuffer and are worth
having for phone landscape. All modes must fit in the 1024x768 allocation.

---

## 3. Phases, revised

**Phase 0 — Environment (1 weekend, down from 1-2).**
- Install Rust + `wasm32-unknown-unknown`; clone and build v86 (`make all`; needs Java
  for Closure Compiler, or use the debug build target).
- Boot `wfw311-cf.img` in the local v86 build. Milestone 0a.
- Build the DDK SVGA sample driver from source with UASM + Watcom; if that fails within
  a day, fall back to DOSBox-X + MASM/MSC. Milestone 0b: the sample driver we built
  boots WfW at 640x480x256 on stock v86 via its VESA path. This is the "toolchain rot"
  risk retired.
- Serial and `DEBUG`-port logging to the host console.
- New repo `responsive-wfw311` (this folder), layout in §5.

**Phase 1 — Adapter (1-2 weekends, down from 2-4 under D1).**
- Add the registers in §2.1 to v86's VBE device; add the breakpoint controller to a test
  page. Milestone: a DOS test program (`PVTEST.EXE`, Watcom 16-bit DOS) reads
  `HOST_XRES/YRES`, sets the mode, fills the screen with a test pattern; dragging the
  browser changes `HOST_*`, the program re-modes, canvas follows. Also verify 8 bpp
  palette via DAC ports, LFB write speed, and dirty-rect behaviour with a fixed pitch.

**Phase 2 — Static driver (3-6 weekends).**
- Port the sample to `PVDISP.DRV`: DISPI mode set instead of VESA BIOS calls, LFB via
  DPMI mapping instead of VFLATD, `Enable` reads mode from the device. Acceptance A0
  at each of the three resolutions. QEMU harness runs a scripted 30-minute session
  nightly with screenshot checks.

**Phase 2.5 — Restart-based resize (1 weekend). New.** `PVMON.EXE` polls
`GENERATION`; on change, `ExitWindows(EW_RESTARTWINDOWS)`. Acceptance A1. This is a
shippable product and the fallback if Phase 3 stalls, so it lands before the research
starts, not after.

**Phase 3 — Live re-mode (research, time-boxed to 6 weekends before re-evaluating).**
Steps 3a-3e in §2.4. Acceptance A2.

**Phase 4 — Mobile and delivery (3-4 weekends).** Touch (§2.5), keyboard, snapshot
(§2.7), service worker, image trimming, real-device testing, DPI variants, stretch
tiers 1-2 in the companion utility. Acceptance A3.

**Checkpoints.** End of Phase 2: is the driver stable enough to build on? End of
Phase 3 time-box: A2 or ship A1.

---

## 4. Disk image and install

- Start from the OEM floppies, not the 245 MB CF image, to get a clean minimal install:
  DOS 6.22 minimal, WfW 3.11 Custom Setup with networking, printers, extra fonts,
  screensavers, and the tutorial deselected. Target 12-20 MB on disk, 32 MB partition.
- Keep: Program Manager, File Manager, Notepad, Write, Paintbrush, Calculator, Clock,
  Cardfile, Calendar, Solitaire, Minesweeper, Control Panel, Terminal (harmless).
- `SYSTEM.INI`: `display.drv=PVDISP.DRV`, `mouse.drv=mouse.drv` (stock PS/2),
  `keyboard.drv` stock, `[386Enh]` sound off, `EMMExclude=E000-EFFF` is not needed since
  the LFB is far above the 1 MB boundary. `WIN.INI` `load=PVMON.EXE`.
- Two `SYSTEM.INI` variants for DPI (§2.6).
- Build reproducibly with a script that drives QEMU or v86 through the installer using
  the existing `mon.py` harness, so the image is regenerated from floppies plus a
  changes directory rather than hand-edited.

---

## 5. Repo layout

```
responsive-wfw311/
  SPEC.md, responsive-wfw311-spec.md
  v86/                 git submodule or subtree of a v86 fork; src/vga.js + new pvdisp registers
  guest/
    driver/            PVDISP.DRV: .asm (UASM) + .c (Watcom) + .def + Makefile
    pvmon/             PVMON.EXE companion utility (Watcom, reuses build.sh conventions)
    pvtest/            PVTEST.EXE DOS mode-set test (Phase 1), PVDPI.COM
    ddk/               DDK sample sources we ported from (not redistributed; gitignored)
  image/
    build-image.sh     floppies + changes/ -> wfw311-lean.img
    changes/           SYSTEM.96, SYSTEM.120, WIN.INI, AUTOEXEC.BAT, CONFIG.SYS, PVDISP.DRV, PVMON.EXE
  web/
    index.html, app.js (breakpoint controller, touch, keyboard, snapshot), sw.js
  tools/
    qemu-session.sh    30-minute scripted session + screenshot diff (from 386boot mon.py)
    memdiff.js         v86 host-side GDI/USER data segment differ (Phase 3)
  docs/
    OFFSETS.md         derived USER/GDI offsets with derivation notes and checksums
```

Licensing note: the WfW 3.11 binaries, the DDK sources, and the disk image are
Microsoft-copyrighted. The repo holds our code and build scripts; images and DDK
sources stay out of git (gitignored, or a private LFS bucket). The public deployment
serving a WfW image is the same legal posture as every other retro-Windows-in-browser
project; flagging, not deciding.

---

## 6. Risks, revised

| # | Risk | Change from original | Mitigation |
|---|---|---|---|
| 1 | GDI/USER will not tolerate live dimension changes | Unchanged, still the research core | Fixed pitch removes stride caches; host-side memory diffing finds the rest; A1 restart path exists before Phase 3 begins |
| 2 | 1992 toolchain rot | Reduced | Watcom already runs here; UASM native; DOSBox-X only as fallback; retire in Phase 0 |
| 3 | App compatibility tail | Unchanged | Scope is shell + bundled apps |
| 4 | WebKit memory ceilings | Unchanged | 32 MB VM; measure in Phase 1, not Phase 4. Local device is an iPhone 16 Pro (not memory-constrained); older iPhones and low-end Android via BrowserStack real-device cloud. Target the oldest iOS BrowserStack offers that still gets Safari updates (iPhone SE 2nd gen / iPhone XR class) as the floor |
| 5 | **New:** DDK availability and completeness | New | Need the WfW 3.11 DDK specifically (has DIB engine + SVGA sample). The Win 3.1 DDK lacks DIBENG; the Win95 DDK has DIBENG minidriver samples but in the 95 model. If only the 95 DDK is available, we write the DLL shell ourselves against DIBENG exports, +2 weekends |
| 6 | **New:** DPMI physical mapping of the LFB from a ring-3 driver | New | Standard DPMI 0800h; fallback is a 200-line VxD |
| 7 | **New:** DISPI 8 bpp palette path in v86 | New | Verified in Phase 1; fallback is 16 bpp from the start |

---

## 7. Open decisions (need Josh)

- **D1** Extend v86's Bochs VBE adapter (recommended) vs. new clean device.
- **D2** Polled `Escape` from the companion utility as the resize trigger (recommended)
  vs. hardware IRQ into the driver.
- **D3** Accept the A1 restart-based resize as the shipping fallback? (Original spec
  said decide before Phase 3; recommending yes, and building it in Phase 2.5.)
- **D4** Phone landscape mode: 800x480 (fills modern phones) vs. stay 4:3.
- **D5** Rebuild a lean image from the floppies (recommended) vs. trim the existing CF
  image.
