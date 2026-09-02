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

**Update (Phase 0, day 1):** Josh supplied the *Windows 3.1* DDK (ISO, which also carries
Visual C++ 1.52c) and the *Windows for Workgroups 3.1* SDK (two floppies). Neither has the
DIB engine or the 3.11 SVGA sample. What they do have, and how the plan adapts:

- `DDK/286/DISPLAY/8PLANE/V7VGA`: a complete 256-colour SVGA display driver in MASM 5.1
  (~55k lines, Video Seven, bank-switched). This is the porting base for `PVDISP.DRV`
  instead of the DIB-engine sample: same GDI export surface, 8 bpp, already handles
  palettes, cursors, DIBs, RLE, and the 3.x mode-switch protocol. Bank switching gets
  removed in favour of the linear framebuffer, which simplifies rather than complicates.
- `DDK/286/TOOLS`: MASM 5.10, LINK, LINK4, NMAKE, WDEB386. `VISUALC/US/VC152C` on the
  same ISO: full VC++ 1.52c incl. `RC` and 16-bit `CL`, plus **debug `USER.SYM`/`GDI.SYM`**.
- `DDK/DOCUMENT/DDAG31.TXT`: the Display Driver Adaptation Guide.
- WfW 3.1 SDK `DEBUG/`: debug `USER.EXE`, `GDI.EXE`, `KRNL386.EXE` with `.SYM` files, and
  `WDEB386`. These are the *3.1* kernels, not 3.11; symbol names carry over, offsets do
  not, which is fine for the derivation method in §2.4.
- The DIB-engine route stays available if the 3.11 SVGA supplement (`SVGA.EXE`, with
  `DIBENG.DLL`, `SVGA256.DRV`, `VFLATD.386`) or the 3.11 DDK turns up; it is no longer
  on the critical path.

Consequence for the plan: Phase 0 shrinks. There is already a known-good WfW install and a
macOS-hosted Win16 build loop. Phase 0 becomes "v86 builds locally and boots the existing
image" plus "DDK toolchain runs", not a from-scratch install.

---

## 1. Objective (unchanged) and success criteria

Run WfW 3.11 in the browser on v86 such that crossing a viewport breakpoint re-modes
Windows to a new resolution without a reboot.

Concrete acceptance tests, in order of ambition:

1. **A0 (Phase 2):** WfW 3.11 boots on the paravirtual adapter at the resolution the
   host requests at boot (any width that is a multiple of 8, from 640x480 up to
   2560x1600), runs Program Manager, File Manager, Write,
   Paintbrush, Solitaire for a 30-minute session with no visual corruption or hang.
2. **A1 (Phase 2.5, baseline ship):** Resizing the browser window causes
   Windows to restart itself (`ExitWindows(EW_RESTARTWINDOWS)`) at the new resolution
   within ~10 s, session state in apps lost, no DOS prompt visible.
3. **A2 (Phase 3):** Same resize re-modes live to the new viewport size. Program Manager reflows, open apps keep
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
- WfW 3.11 itself ships `SVGA256.DRV`, a VESA-VBE 256-colour driver, and v86 ships a
  VGA BIOS with VBE. Selecting that stock driver on stock v86 should already give
  640x480x256 and 800x600x256 with zero code written; that is the Phase 0/1 smoke test
  that proves the VBE LFB path and the 8 bpp palette path in v86 before we write a byte
  of driver.

What we add to the DISPI register set, in v86 only at first (QEMU gets a tiny patch or a
stub if we want parity):

| Reg (index) | Name | R/W | Meaning |
|---|---|---|---|
| `0x10` | `HOST_XRES` | R | Resolution the host wants, derived from the viewport (§2.8) |
| `0x11` | `HOST_YRES` | R | " |
| `0x12` | `HOST_DPI` | R | 96 or 120, chosen from initial device class, fixed per session |
| `0x13` | `STATUS` | R/W1C | bit0 `MODE_REQUEST` set by host when HOST_XRES/YRES change; guest writes 1 to clear. bit1 `IRQ_ENABLE` |
| `0x14` | `CURSOR_X` | W | Guest cursor position, written by the driver's `MoveCursor` (see §2.5) |
| `0x15` | `CURSOR_Y` | W | " |
| `0x16` | `DEBUG` | W | Byte written appears on the host console (like Bochs port `0xE9`) |
| `0x17` | `GENERATION` | R | Increments on every host mode request; lets a poller detect a missed edge |

Indices `0x00-0x0A` are the standard Bochs set (`0x0A` is `VIDEO_MEMORY_64K`), so ours start at
`0x10`. Confirmed against `v86/src/vga.js`: v86 caps modes at exactly 2560x1600 (`MAX_XRES` /
`MAX_YRES`), which matches the allocation in §2.8. One gap: v86 treats `VIRT_WIDTH` (index 6)
as read-only and uses the visible width as the scanline pitch. Fixed pitch therefore needs a
small v86 change in Phase 1: honour `VIRT_WIDTH` writes and carry a separate `svga_pitch`
through the renderer and dirty-rect tracking. QEMU already honours `VIRT_WIDTH`.

Plus an optional IRQ line (ISA IRQ 9 or 11, or PCI INTA if we present the device as
PCI) raised when `MODE_REQUEST` sets and `IRQ_ENABLE` is on. See D2 for why this is
optional.

If D1 is rejected in favour of the original "clean device with its own I/O block", the
register list above still stands; we just also own `XRES/YRES/BPP/ENABLE` and the
framebuffer mapping, and lose the free QEMU parity and the free SVGA-sample starting
point. Cost estimate: +2 weekends in Phase 1 and a harder Phase 2.

**Framebuffer policy: fixed pitch.** Allocate the framebuffer once at the largest mode
(2560 px × 1600 lines × 1 byte = 4 MB at 8 bpp; see §2.8) and keep `VIRT_WIDTH`
(pitch) fixed at 2560 pixels across all modes. A re-mode then changes only the visible
width and height. Anything in GDI, USER, or the DIB engine that cached the scanline
stride stays valid, which removes an entire class of Phase 3 corruption bugs. Host side,
rendering simply reads a `w×h` window out of a `2560×1600` buffer.

**Colour depth.** 8 bpp palettised for Phases 1-3 (what the DDK SVGA sample does, what
Win 3.x apps expect, smallest framebuffer, cheapest host conversion). 16 bpp is a
Phase 4 option if palette flashing in the shell is bothersome; the DIB engine supports
it. Rendering 8 bpp on the host requires the palette: the DISPI interface has no
palette registers, so the driver programs the standard VGA DAC ports `0x3C8/0x3C9`,
which v86 already emulates and applies to LFB modes at 8 bpp. **VERIFY** in Phase 1.

### 2.2 Display driver (guest, 16-bit)

An NE-format DLL, `PVDISP.DRV`, installed via `SYSTEM.INI [boot] display.drv=` plus a
matching `OEMSETUP.INF`-style entry (or just hand-edited `SYSTEM.INI` since we own the
image). Based on the Windows 3.1 DDK `8PLANE/V7VGA` sample (see §0 update), a
self-contained 8 bpp driver; the DIB-engine variant is an alternative if that toolkit
becomes available. The driver:

- Implements the required GDI display-driver exports by ordinal (`Enable`, `Disable`,
  `ReEnable`, `BitBlt`, `Output`, `ExtTextOut`, `RealizeObject`, `Control`,
  `Inquire`, `SetCursor`, `MoveCursor`, `CheckCursor`, `SetPalette`, `GetPalette`,
  `SetPaletteTranslate`, `UpdateColors`, `DibBlt`, `StretchBlt`, `StretchDIBits`,
  `CreateDIBitmap`, `DibToDevice`, `SelectBitmap`, `BitmapBits`, `EnumDFonts`,
  `EnumObj`, `ColorInfo`, `Pixel`, `StrBlt`, `ScanLR`, `DeviceMode`, `DeviceBitmap`,
  `FastBorder`, `SetAttribute`, `GetCharWidth`, `GetDriverResourceID`,
  `UserRepaintDisable`). The V7VGA sample implements all of these in asm; we keep its
  implementations and change only the surface addressing (linear instead of banked),
  `Enable`/`SetMode`, and `Control`. **VERIFY** exact ordinal list against DDAG31.
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
- 3d. Grow re-mode (e.g. 640 → 1600 wide). Same code path; verifies nothing depended on the
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
- **Mode controller:** listens to `visualViewport` `resize` (and `orientationchange`
  as a hint), debounces 300 ms, computes the mode per §2.8, writes
  `HOST_XRES/YRES`, bumps `GENERATION`, raises the IRQ if enabled. Also chooses the
  session DPI once at boot.
- **Canvas scaling:** with `zoom` = 1 the canvas is exactly viewport-sized and each
  emulated pixel is one CSS pixel (rendered at device-pixel ratio, so crisp on retina).
  With other zooms the canvas is CSS-scaled; `image-rendering: pixelated` for integer
  ratios, bilinear otherwise.
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

### 2.8 Mode selection: match the screen (supersedes the breakpoint table)

Per Josh's update: the emulated resolution follows the actual viewport instead of
snapping to 640x480 / 800x600 / 1024x768 classes. The fixed-pitch framebuffer (§2.1)
makes arbitrary widths free.

- **Mode:** `w = floor(visualViewport.width × zoom / 8) × 8`,
  `h = floor(visualViewport.height × zoom / 2) × 2`, clamped to the framebuffer
  allocation. `zoom` is 1.0 by default (one emulated pixel per CSS pixel) and is a
  user-adjustable setting persisted in `localStorage`, for people who want a bigger or
  smaller Windows on the same screen.
- **Framebuffer allocation:** 2560 × 1600 × 8 bpp = 4 MB, pitch fixed at 2560. Viewports
  wider than that are letterboxed/scaled by the host rather than re-moded larger.
- **Re-mode trigger:** after the 300 ms debounce, re-mode if either dimension changed by
  8 px or more. Smaller jitters (iOS URL bar animations mid-flight) are ignored.
- **DPI (per session, unchanged):** 120 if the initial CSS viewport width is under 600,
  else 96.
- **Minimum size risk (new):** a phone in portrait is roughly 390 × 850 CSS px. Windows
  3.x assumes at least 640 px of width in places (some dialogs, Program Manager's
  default group layout, Setup). The OS will run below that, but dialogs may clip. If
  this is unacceptable in Phase 4 testing, the fix is a default `zoom` below 1 on narrow
  screens (e.g. 0.6, giving ~640 wide on a 390 px phone) rather than a return to fixed
  classes. The 120 DPI fonts partly offset the shrink.
- **Rotation** is just a resize: portrait 390 × 850 becomes landscape 850 × 390.

Reference viewport sizes (CSS px) the plan is tested against:

| Device | Portrait | Landscape |
|---|---|---|
| iPhone 16 Pro | 402 × 874 | 874 × 402 |
| iPhone SE 2 (BrowserStack floor) | 375 × 667 | 667 × 375 |
| iPad 11" | 820 × 1180 | 1180 × 820 |
| Laptop browser window | — | typically 1200-1900 × 700-1100 |

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
| 5 | DDK availability and completeness | **Resolved** | We have the Win 3.1 DDK, no DIB engine. Base is the V7VGA 8 bpp sample (§0 update). Cost: the driver is ~55k lines of MASM we own rather than a thin shell over DIBENG; benefit: no dependency on a DLL we cannot rebuild |
| 6 | **New:** DPMI physical mapping of the LFB from a ring-3 driver | New | Standard DPMI 0800h; fallback is a 200-line VxD |
| 7 | **New:** DISPI 8 bpp palette path in v86 | New | Verified in Phase 1; fallback is 16 bpp from the start |

---

## 7. Open decisions (need Josh)

- **D1** Extend v86's Bochs VBE adapter (recommended) vs. new clean device.
- **D2** Polled `Escape` from the companion utility as the resize trigger (recommended)
  vs. hardware IRQ into the driver.
- **D3** Accept the A1 restart-based resize as the shipping fallback? (Original spec
  said decide before Phase 3; recommending yes, and building it in Phase 2.5.)
- **D4** ~~Phone landscape mode~~ Superseded: modes match the screen (§2.8). Remaining
  sub-question: default `zoom` on phones (1.0 vs. ~0.6), decided in Phase 4 testing.
- **D5** Rebuild a lean image from the floppies (recommended) vs. trim the existing CF
  image.

---

## 8. Status log

**2026-09-01 — Phase 0 essentially complete (one afternoon, not one weekend).**

Done:
- Repo initialised in this folder; v86 vendored under `v86/` with local patches listed in
  `v86/VENDORED.md`. Rust stable + wasm32 target installed; `v86.wasm` builds
  (`make build/v86.wasm`, after a one-line fix to v86's linker wrapper for macOS rustup).
- **Milestone 0a: WfW 3.11 boots to Program Manager in the locally built v86** at
  `web/dev.html` (serve with `node tools/devserver.mjs`, or the `dev` launch config), disk
  streamed lazily via HTTP Range requests, 32 MB RAM. Two v86 fixes were needed: an
  `hda: { heads, sectors_per_track }` CHS override, and not forcing SeaBIOS LBA translation
  when an override is present (the DOS 6.22 MBR uses raw CHS and the image is 16/32).
- **Milestone 0b: the DDK's V7VGA 8 bpp sample display driver builds from source** with the
  genuine MASM 5.10A / LINK4 / RC 3.11 / MAPSYM toolchain running headless under DOSBox-X
  (`tools/dosbuild.sh`), ~2 minutes for the full driver. Toolchain-rot risk retired.
- UASM (native MASM-compatible assembler) was built (`tools/build-uasm.sh`) but does not
  accept the DDK's `cmacros.inc` nested-macro idioms even in `-Zm` mode. Parked; the real
  MASM path is the build of record.

Findings that adjust the plan:
- The base image runs the stock 4 bpp `VGA.DRV` (640x480x16). `SVGA256.DR_` was
  installed into a scripted work image (`image/build-image.sh display=svga256 res=2`) and
  **fails with "An error occurred while trying to initialize the video adapter" on both v86
  and QEMU `-vga std`**. `strings` on the driver shows only chipset-specific init paths
  (`VIDEOINIT_TSENG/TRIDENT/CIRRUS542X/CIRRUS6420/ATI/OAK`) and no VESA path, so the
  "free" 256-colour smoke test is off the table. §2.1's claim that the stock driver would
  run on v86 is withdrawn; 8 bpp palette and LFB behaviour get verified by our own
  `PVTEST` in Phase 1 instead. v86 itself is not implicated (QEMU fails identically).
- Image editing is scripted: `image/build-image.sh [display=vga|svga256|pvdisp] [res=] [dpi=]`
  copies `image/changes/**` into a fresh `work.img` with mtools and edits `SYSTEM.INI`
  via `tools/inied.py`. `tools/msexpand.py` handles SZDD files; the WfW 3.11 setup files
  are KWAJ (LZH), so those are expanded with the image's own `EXPAND.EXE` via
  `tools/dosbuild.sh` instead.
- No DIB engine on the image or in the supplied DDK/SDK (see §0 update). V7VGA is the base.

Next:
2. Phase 1: add the host registers (§2.1) to `vga.js` and the `VIRT_WIDTH` pitch support;
   `PVTEST.EXE` DOS mode-set test (banked A000 writes in real mode; the LFB mapping is
   exercised by the Windows driver in Phase 2 where DPMI is available).
3. Start the V7VGA → `PVDISP.DRV` port: strip bank switching, DISPI mode set, LFB via DPMI.

**2026-09-01 (later) — Phase 1 complete.**
- `v86/src/vga.js`: `VIRT_WIDTH` (index 6) is writable and carried as a separate pitch through
  the enable path, offsets, dirty-rect rows, and the 8 bpp renderer; host registers `0x10-0x17`
  implemented (`HOST_XRES/YRES/DPI`, `STATUS` W1C + IRQ enable, `CURSOR_X/Y`, `DEBUG` byte
  port with a `'PV'` signature on read, `GENERATION`); `pv_request_mode()` on the bus
  (`pv-request-mode`, `pv-set-dpi`; emits `pv-debug`, `pv-cursor`); optional IRQ 9.
- `web/dev.html`: mode controller per §2.8 (visualViewport, 300 ms debounce, zoom, follow
  toggle, guest debug log panel).
- `guest/pvtest/pvtest.c` (Open Watcom, 16-bit DOS, built via `tools/watcom.sh`): detects the
  adapter, sets an 8 bpp mode with pitch 2560 from `HOST_XRES/YRES`, draws a test pattern
  through the A000 bank window, polls `GENERATION` and re-modes. Verified in the browser:
  initial mode follows the viewport (e.g. 1000x578), a host request to 640x400 is picked up
  and applied by the guest in under 1.5 s, palette via DAC ports renders correctly.
- Image builder gained `boot=win|pvtest|dos`.

**2026-09-01 (evening) — Phase 2 milestone: PVDISP.DRV runs Windows; input fixed.**
- `PVDISP.DRV` (the V7VGA port, bank-window model kept, pitch 4096) boots WfW 3.11 at the
  viewport size in 256 colours (`image/work-pvdisp.img`, `tools/build-driver.sh`).
- Fills were coming out as a single colour: the V7 driver never writes pixel bytes for solid
  and pattern fills. It loads colours into Video Seven "foreground latch" sequencer registers
  (EC-EF), sets sequencer FE bit 3, and every CPU write then stores those latches into the
  map-masked planes through the normal ALU. v86 now emulates that subset (`v7_seq` in
  `vga.js`: extended sequencer storage with read-back, fore-latch write mode in both the
  unchained and chain-4 paths, back-latch access A0-A3). Same 4-pixel-per-address model as
  the driver's planar "nibble" loops. The original spec's "no VGA register emulation" holds
  for the mode-set path; the *write* path emulates the V7 ALU because that is far cheaper
  than rewriting ~55k lines of blit code.
- Keyboard and mouse were dead under Windows on **every** image, including stock VGA.DRV.
  Root cause (found by tracing PIC mask writes and 8042 traffic in v86 and QEMU side by
  side): VKD disables the keyboard interface (0xAD), reads the command byte by polling, and
  re-enables. v86 raised IRQ1 for that polled byte; the real 8042 and QEMU do not raise the
  keyboard IRQ while the interface is disabled. WfW 3.11's VKD never completes that dataless
  interrupt, so VPICD leaves IRQ1 masked for the session (this is the known "WfW 3.11
  freezes keyboard/mouse under v86" issue for which v86's docs prescribe Microsoft's VKDA.386).
  Fixed in `v86/src/ps2.js`: no IRQ while an interface is disabled, re-raise on enable, AUXB
  status bit only while a mouse byte is pending. No Microsoft patch needed.
- Open: title bars come out sky blue (index 9) where the default scheme's dark blue (0,0,128)
  should map to index 4. Colour matching in the driver's RealizeObject path to check.

**2026-09-01 (night) — Phase 2.5 done: acceptance A1 met.**
- **A1 achieved.** Resizing the viewport re-modes Windows to the new size, unattended, with the
  shell laid out for it. Verified 1024x768 -> 800x600 -> 1280x698 and back in the browser.
- **`ExitWindows(EW_RESTARTWINDOWS)` does not work here and was abandoned.** It restarts
  Windows at the new mode (the driver re-reads `HOST_XRES/YRES` in `Enable`, and PVMON in the
  restarted instance reports the new `SM_CXSCREEN`), but the restarted instance never paints:
  a full framebuffer scan shows *no* writes reach video memory, not even for Ctrl+Esc, while
  the identical mode reached by a fresh start paints correctly. Something keeps the screen
  "owned" across the in-place restart (VDD / USER repaint suppression is the likely culprit).
  Not worth chasing, because Phase 3 never exits Windows at all.
- **What ships instead:** `PVMON.EXE` calls `ExitWindows(0, 0)` and `AUTOEXEC.BAT` runs
  `WIN` in a loop, so Windows comes straight back up through exactly the fresh-start path that
  works. Costs a brief text-mode flash and a full Windows start (~25-40 s in v86 at present).
- **`PVDPI.EXE` (SPEC 2.6) implemented and verified.** Runs before each `WIN`, reads
  `HOST_DPI` and copies `SYSTEM.96` or `SYSTEM.120` over `SYSTEM.INI`. PVMON now logs what GDI
  actually ended up with: 96 dpi gives a 16-pixel system font, 120 dpi a 20-pixel one, so the
  driver's reported DPI and the loaded font set agree. Because the DPI is re-chosen at every
  restart, a device-class change across a resize is handled for free.
- **PVMON does the window wrangling of SPEC 2.3 / stretch tier 1**: sizes Program Manager to
  the screen, maximises the active group, arranges the group icons, and invokes Program
  Manager's own *Arrange Icons* command. That command is located by scanning menu text for
  "Arrange" rather than hard-coding Program Manager's private menu IDs.
- Two things that looked like driver bugs and were not: icon captions collided because Program
  Manager restores item positions saved at the old resolution (fixed by the arrange above,
  plus `IconSpacing=100` for the large-font case), and a full-resolution framebuffer dump
  confirmed glyph rendering itself is correct.
- The host now never asks for a mode below 640x400, shrinking the emulated pixel scale on small
  viewports instead (SPEC 2.8). Windows 3.x shells and dialogs clip badly below that, and the
  browser pane can report a zero-size viewport while hidden, which previously produced
  nonsense modes like 640x1600.

Next: Phase 3. Steps 3a-3e in 2.4, starting with the driver-side `PV_REMODE` escape and the
host-side memory differ for finding GDI/USER cached screen dimensions.

**2026-09-01 (night) — Phase 3 step 3a done: the adapter re-modes under a running Windows.**
- `PVDISP.DRV` gained two private escapes in `CONTROL.ASM`: `PV_QUERY_MODE` (0x4A00) reports
  current and host-requested geometry, and `PV_REMODE` (0x4A01) performs the re-mode. Both live
  in the resident-enough `_BLUEMOON` segment rather than `_INIT`, which Windows discards once
  it is up, so the mode-programming sequence is duplicated there instead of calling `setmode`.
- The re-mode writes `ENABLE` with bit 7 set, so video memory keeps its contents across the
  mode change. That matters: a live re-mode must not blank the screen.
- **GDI hands the driver its own copy of the screen `BITMAP` as `lp_device` on every call**, so
  the driver patches `bmWidth`, `bmHeight` and `bmWidthPlanes` directly through that pointer.
  No memory scanning is needed for the surface itself, which removes a chunk of the risk in 2.4
  step 5. Scanning is still needed for USER's metrics and GDI's cached caps.
- `PVMON` calls the escape when `WIN.INI [PVMon] Live=1` (`image/build-image.sh live=1`),
  otherwise it uses the Phase 2.5 restart. Verified in the browser: a request for 800x500 while
  running at 1024x768 re-modes immediately, the escape returns 1, **Windows does not crash, the
  cursor stays live and the desktop repaints**. As predicted for 3a, the shell keeps its old
  1024x768 geometry and is simply clipped by the smaller screen, because USER's metrics and
  GDI's cached caps are still the old size.

Next (3b): patch USER's screen metrics and the desktop window rectangle. Approach, avoiding
hard-coded offsets: reach USER's DGROUP through TOOLHELP.DLL (shipped with WfW 3.11), then find
`rgwSysMet` by matching a run of entries against `GetSystemMetrics` return values, and find the
desktop window's rectangles by matching `0,0,cx,cy` inside its `WND` structure, which in Win16
is addressed by the `HWND` value itself as an offset into USER's DGROUP. Both are self-verifying
signatures rather than version-specific constants.

**2026-09-01 (night) — Phase 3 step 3b: Windows reflows live. Acceptance A2 substantially met.**
- `PVMON` now finds USER's state without a single hard-coded offset, and logs what it found:
  `USER ds=0766 sysmet=+0074 deskrc=hwnd+8`. The method:
  1. USER's data segment comes from TOOLHELP.DLL, loaded dynamically so a missing DLL just
     disables the live path: walk the global heap for the `GT_DGROUP` block owned by USER.
  2. `rgwSysMet` is found by scanning that segment for twelve consecutive words that equal
     `GetSystemMetrics(0..11)`. The match was unique.
  3. The desktop window's rectangle is found by scanning its `WND` structure for `0,0,cx,cy`,
     using the fact that a Win16 `HWND` *is* the offset of that structure in USER's segment.
  Each location is verified against live values before anything is written, which is what makes
  this safe to do to a running OS.
- On re-mode PVMON patches `SM_CXSCREEN`/`SM_CYSCREEN`, the full-screen metrics, and the desktop
  window's `rcWindow`/`rcClient`, then repaints and re-arranges the shell.
- **Result: Program Manager resizes itself to the new screen and its icons re-wrap, live, with no
  restart and no reboot.** Verified shrinking (1024x768 -> 800x500), growing (-> 1200x700), and
  seven consecutive changes ending at 776x440, with 98% of the final screen painted and no
  corruption. This is the thing the project set out to prove is possible.
- **The cursor must be hidden across the mode change.** Re-moding with the software cursor drawn
  does not just leave a stale cursor: USER's mouse path stops dead, and mouse bytes stop being
  read out of the 8042 entirely (the controller's buffer fills and never drains). Wrapping the
  escape in `ShowCursor(FALSE)`/`ShowCursor(TRUE)`, plus `ClipCursor(NULL)` and a clamped
  `SetCursorPos` afterwards, fixes it completely: the pointer then reaches past the old screen
  width on a grow, and the mouse still works after seven re-modes.
- Timing: about 1.3 s for a shrink end to end. Most of that is deliberate delay, 300 ms of host
  debounce plus three 250 ms settle polls; the re-mode itself is not the cost.
- Tooling note: `web/dev.html` now keeps the VM running when the page is hidden, by driving the
  emulator from a worker heartbeat. Browsers throttle hidden-tab timers to a standstill, which
  froze the emulator mid-test and looked exactly like a guest hang, costing a wrong diagnosis
  before it was spotted.

Remaining for a complete A2: step 3c, GDI's cached device caps. The shell reflows correctly
without it because layout comes from USER, but `GetDeviceCaps(HORZRES/VERTRES)` still reports the
boot-time screen for applications that ask.

**2026-09-01 (night) — Phase 3 step 3c done: A2 complete.**
- GDI's cached `GDIINFO` is found the same self-verifying way: `GetDeviceCaps` indexes that block
  by byte offset, so twelve caps read back through the API are a signature for the block itself.
  Found uniquely at `GDI ds=05BE gdiinfo=+264E`.
- On re-mode PVMON patches `HORZRES`/`VERTRES` and the matching `HORZSIZE`/`VERTSIZE` millimetre
  values, then reads the caps back through the API to prove the patch is the block GDI answers
  from: **`GetDeviceCaps now reports 960x600`** after a live change from 1024x768.
- With 3a, 3b and 3c together, a live re-mode now updates every copy of the screen geometry that
  matters: the adapter, the driver's own state, GDI's screen surface, GDI's device caps, USER's
  system metrics and the desktop window. **Acceptance A2 is met.**

**2026-09-01 (night) — Phase 4: the product page, touch, snapshots. A3 met.**
`web/index.html` + `web/app.js` are the real page now; `web/dev.html` stays as the debug page.
Verified in an emulated 375x812 phone viewport:
- **Mode follows the phone.** Windows boots straight into **640x1384 portrait**, scaled to fill
  the screen, shell reflowed, large fonts. PVDPI picks 120 dpi automatically at phone width, so
  the text is legible rather than merely small.
- **Rotation is just a resize.** Turning the viewport to 812x375 live re-modes to **864x400**,
  patching USER, GDI caps and the shell, exactly as a desktop resize does. Rotation came for
  free from Phase 3, as the original spec predicted.
- **Touch pointing is pixel-exact.** The driver now mirrors the cursor position to the adapter's
  `CURSOR_X/Y` registers from `MoveCursor`, and the page steers the guest pointer to a tap by
  sending relative motion and correcting against that reported position. A tap at guest (700,320)
  lands at (700,320), **error zero**, and tapping the menu bar opens the menu. Mouse acceleration
  is switched off in `WIN.INI` so a mickey is a pixel.
  Gestures are serialised behind a promise chain: a press that fires while the pointer is still
  being steered drags whatever is under it, which is exactly what happened first time.
- **Snapshots meet A3 comfortably.** 32 MB of VM compresses to **2.0 MB** with `CompressionStream`
  and saves in about 0.65 s; restore from IndexedDB is effectively instantaneous, well inside the
  5 s the spec asked for. Snapshots are keyed by image and DPI, so a device-class change cold
  boots rather than restoring a mismatched font set.
- Two v86 bugs of my own making, both worth recording:
  1. My Phase 1 state fields were written into slots 60-67 of the VGA save state, which upstream
     already uses. Restoring therefore read `line_compare` as the scanline pitch and rendered a
     sheared screen. PV state now lives from slot 80 up.
  2. A hidden page throttles timers to a standstill, which freezes the emulator and stalls any
     `setTimeout` debounce. The mode controller is now driven by a worker heartbeat and a
     `requestAnimationFrame` loop instead, and keeping the VM running while hidden is opt-in
     (`?keepalive=1`); by default it idles and the snapshot covers eviction.
- The service worker is network-first with a cache fallback. Cache-first pinned the first build
  it ever saw and silently served stale code, which cost a confusing debug cycle.

Not done, and honestly outstanding:
- The 30-minute soak of A0 has not been run.
- No testing on real hardware yet: the iPhone 16 Pro and BrowserStack runs need a deployment.
- The disk image is still derived from the 245 MB CF image rather than rebuilt lean from the
  floppies, so first-load size is untuned. Lazy Range loading hides most of it, but the
  delivery budget in 2.7 is unverified.
- Two-finger scroll is still deferred, as planned.

**2026-09-01 (night) — window wrangling completed (SPEC 2.3, stretch tier 1).**
`PVMON` now walks every top-level window after a re-mode with `EnumWindows`: maximised windows
are restored and re-maximised so they refill the new screen, and the rest are clamped, and shrunk
if they no longer fit. Verified by measuring the title bar of a maximised application in the
framebuffer across three live re-modes: it spans 0-1279 at 1280x698, 0-799 after shrinking to
800x500, and 0-1095 after growing to 1096x600. Without this, a window maximised at the old size
kept it, and windows could be left entirely off-screen after a shrink.

**2026-09-01 (night) — delivery budget measured, and it changes a Phase 4 assumption.**
Resource timings for a cold load through to Program Manager, plus several live re-modes:

| | MB |
|---|---|
| Disk image (of a 245 MB image, fetched lazily by Range) | 14.0 |
| `v86.wasm` | 2.0 |
| Everything else (BIOSes, module scripts) | 1.2 |
| **Total** | **17.2** |

So a first load costs about 17 MB against SPEC 2.7's 15-30 MB target, *without* trimming the disk
image at all: lazy Range fetching means only the sectors DOS and Windows actually touch are
transferred. Rebuilding a lean image from the floppies is therefore a size optimisation worth
maybe a few MB, not a prerequisite for shipping. The server does not compress, so gzip on the
wire would cut this further.

**2026-09-01 (night) — verification round: apps, keyboard, soak.**
- **Bundled applications survive live re-modes.** With Program Manager, Write and Solitaire all
  open, three live changes (720x440 -> 1240x720 -> 960x560) left every window intact and correctly
  drawn; Solitaire's fixed-size window is clamped rather than stretched, which is the per-app
  policy SPEC 2.3 tier 2 asks for. 89-96% of each screen paints, the remainder being the desktop
  background that is legitimately one flat colour.
- **The on-screen keyboard works.** Focusing the hidden input and driving it the way a phone's
  soft keyboard would typed a full sentence into Write.
- **Soak: passed, and then some.** A continuous run changing mode every 15 seconds finished at
  **45 minutes and 181 live re-modes, with zero stalls, zero blank frames and zero errors**, still
  executing at the end, and with a second emulator running alongside it the whole time. A0 asks
  for a 30-minute session; this is half again as long and far harsher than one, since a normal
  session would not change resolution 181 times.
- Screenshots in this session were taken by rendering the guest framebuffer through the palette
  and posting the PNG to the dev server, because the browser pane stopped compositing and the
  screenshot API went with it. `tools/devserver.mjs` gained the endpoint for it.

**2026-09-01 (night) — a real limitation found in window reflow.**
`PVMON` now resizes any window that filled the old screen directly with `SetWindowPos`, rather
than restore-then-maximise: Windows 3.x is cooperative, so a maximise only takes effect once the
owning task pumps messages. Width refits correctly in every case tested.

**Height does not grow past the old screen for an already-maximised application window.** Write,
maximised at 1280x698 and then re-moded to 640x1180, comes back 640 wide (correct) but still
about 700 tall. USER caches a maximum tracking size per window, derived from the screen metrics
when the window was created, and patching the screen metrics does not revisit it. Shrinking is
unaffected, and Program Manager is unaffected because the companion utility sizes it explicitly.

**Fixed, see the next entry.**

**2026-09-01 (night) — the height clamp is fixed: USER's cached maximum tracking size.**
Measured rather than guessed. `SetWindowPos(640, 1180)` on the shell returned **640x706
immediately**, and `MoveWindow` did the same, so USER was clamping the call rather than the
application resizing itself afterwards. 706 is the old screen height plus 8, which is exactly the
standard maximum tracking size of screen plus window frame.

The metrics array and both desktop rectangles were already patched (the desktop's window *and*
client rectangles were found at `hwnd+8` and `hwnd+16`, and confirmed by signature rather than
assumed), so USER was reading the screen size from somewhere `GetSystemMetrics` does not.

Rather than hard-code an offset, `PVMON` now finds it by experiment, which is the same
self-verifying idea as the rest of the patching but with a behavioural test instead of a data
signature:

1. Ask a real window to resize. If it is not clamped, there is nothing to find.
2. Otherwise scan USER's data segment for every adjacent word pair holding the old screen size,
   first as screen plus frame, then bare, then plus twice the frame.
3. For each candidate: write the new value, retry the resize, and keep the candidate only if the
   clamp goes away. Anything that does not help is restored immediately.

It found the cache on the first strategy: **`tracking size cached at USER:+079E (screen+8,8)`**.
The offset is learned once and reused for the session, so later re-modes cost nothing.

With it patched, Program Manager fills a 640x1180 portrait screen top to bottom, and a 1240x860
landscape one, across live re-modes in both directions. Stretch tier 1 is now genuinely complete
rather than complete-except-for-height.

**2026-09-01 (night) — legibility on phones, first attempt (superseded by the next entry).**
Reported from an actual iPhone: everything is too small to read. The cause was the mode rule in
2.8. Holding the emulated width at 640 so Windows stays usable means that on a 375-point phone
every emulated pixel is scaled *down* to 0.59 of a point, and 640 columns of 1993 user interface
across a phone is simply too fine to read, whatever the font.

There is no way to have both the whole desktop and readable text on a screen that narrow, so the
page now treats magnification as a first-class control rather than fitting by default:
- The canvas is drawn at `fit x zoom`, and anything larger than the viewport pans.
- **Phones start at 1.7x**, which puts an emulated pixel at roughly one point. With the 120 dpi
  font set PVDPI already selects at phone widths, the system font lands at about 20 points and
  icon labels are comfortably readable.
- Pinch to zoom, two-finger drag to pan, and `-` / `+` / `fit` buttons. Two-finger gestures never
  reach the guest as mouse input.
- Touch pointing stays pixel-exact while magnified and panned: a tap at guest (300,260) with the
  view scrolled by (120,200) lands at exactly (300,260), because the mapping is taken from the
  canvas's rectangle, which already accounts for zoom and scroll.

**2026-09-01 (night) — legibility on phones, properly: fewer pixels, and widen only for dialogs.**
The magnification above was a workaround, and shipping it as the phone default was wrong: it
lands you zoomed in on a scrolling page. It also came with the claim that you cannot have both a
readable screen and the whole desktop, which was not true, just unmeasured.

**What actually sets the floor.** Everything in this interface is sized in pixels, so the way to
make icons, hit areas and text all larger is to run *fewer* pixels, not to magnify. The limit is
that Windows 3.x dialogs are fixed-size templates. Measured at 120 dpi on a 375-point viewport:

| Emulated width | Run dialog | File Open dialog |
|---|---|---|
| 400 | buttons cut off | cut off |
| 480 | buttons clipped | cut off |
| 560 | fits | cut off (needs ~620) |
| 640 | fits | fits |

Dropping to 96 dpi shrinks dialogs by a fifth but shrinks the text with them, so the readable
text size at the resulting floor is about the same. DPI trades icon size against text size; it
does not move the constraint.

**The fix.** A re-mode now costs about a second and nothing else, so the screen does not have to
be sized for the worst case all the time. Phones run at **448 wide** where everything is 43%
larger than at 640 and the whole desktop is visible with no scrolling, and `PVMON` widens the
screen to 640 for exactly as long as a dialog is on it:

- The driver gained `PV_SETMODE` (0x4A02), which takes an explicit size, so the guest can ask for
  a mode rather than only accepting the host's. `pv_remode` and the new escape share one
  `pv_apply_mode`.
- `PVMON` polls for a visible window of class `#32770`, widens when one appears, and goes back
  four polls after the last one closes, so a closing dialog does not cause a flicker.
- Verified end to end on a phone viewport: 448x970 normally, 640x1384 while the Run dialog is up
  with all four buttons visible, and 448x970 again afterwards.

Magnification stays as a control (pinch, two-finger pan, and buttons), but the default on every
device is now fit-to-screen. Off by default via `WIN.INI [PVMon] DialogWiden=0` if it is not
wanted.

Also fixed: `zoom` was declared after the code path that first calls `fitCanvas`, so a real
browser hit a temporal-dead-zone `ReferenceError` on load. It is now declared before first use.

**2026-09-01 (night) — two rendering bugs from the phone work, both fixed.**

*The Run dialog came back half drawn.* Its right-hand part, beyond where the old screen edge had
been, showed the desktop through it. Cause: after a re-mode PVMON called
`InvalidateRect(NULL, ...)`, which invalidates the desktop and nothing else, so windows kept
content that had been clipped to the old screen. Fixed by invalidating each window *and its
controls* explicitly (`EnumChildWindows`) and then `UpdateWindow`, as part of the pass that
already walks the window list.

*Solitaire broke.* Its tableau collapsed into a column of overlapping cards, and after the first
repair attempt it drew no cards at all. Two distinct causes:

1. **The window fitter was shrinking it.** Clamping a window to a narrow screen makes an
   application of this era re-lay itself to a size it was never designed for. The fitter now only
   resizes windows that filled the old screen; everything else keeps its size and is merely moved
   back on screen. Applications lay out to their own window, so a window that no longer fits is
   better left alone than resized into nonsense.
2. **Windows clamps a new window to the screen.** Started on a 448-wide screen, Solitaire's window
   is *born* 448 wide, which is under the size it needs to lay out a tableau at all, so it draws
   nothing and never asks for more. Measuring what is on screen cannot discover that, because the
   window is already too small.

So the widening rule became: keep the screen as small as the content allows, and treat the
presence of any application window as requiring a standard 640-wide screen. The window, having
been clamped to the old screen, is then grown by the fill rule and lays itself out properly. The
shell is excluded from the measurement, since it is always sized to the screen and would
otherwise stop the screen ever shrinking again.

Verified on a phone viewport: **448x970 with just the desktop, 648x1402 while Solitaire is open
and dealing correctly, and 448x970 again when it closes.** The Run dialog now draws complete,
frame closed and all four buttons visible.

**2026-09-01 (night) — responsive dialogs, so a phone can just be used.**
The brief got sharper: it should be usable in portrait the way a website is. No rotation prompt,
no zoom controls to reach for, and no screen resizing itself underneath whatever is open. Both of
my earlier answers failed that test: magnification is fiddly, and widening the screen whenever an
application or dialog appeared was worse, because the whole desktop changed size while you were
using it.

The thing that forced all of it was dialog width. So instead of sizing the screen around dialogs,
`PVMON` now makes the dialogs fit: **controls that fall off the right-hand edge are moved into
rows underneath the ones that fit, and the dialog is made narrower and taller to match.** Nothing
is scaled, so no text is squashed or clipped; the buttons that normally run down the right simply
end up in a row along the bottom, which is what the dialog would look like if it had been designed
for a narrow screen. This is stretch tier 3 from the original spec, arrived at by reflow rather
than by rescaling templates, which avoids the clipped-text problem rescaling would have had.

Two details that mattered: child window positions are relative to the parent's *client* area, so
the new positions are computed through `ClientToScreen` rather than the window rectangle (getting
this wrong made the buttons vanish entirely), and the frame is added back when resizing by taking
the difference between the window and client rectangles.

Result on a 375-point portrait phone, with the desktop at a fixed 448x970 and a 17-point system
font: **File > Run reflows its four buttons into a row along the bottom, and the common File Open
dialog, the widest one at about 620 pixels, becomes a single readable column** with everything
reachable. Write's menu bar wraps to two rows by itself. The screen never changes size, and
nothing needs to be zoomed or panned.

Still outstanding, and the honest limit of this approach: an application that draws its own
fixed layout rather than laying out controls cannot be reflowed this way. **Solitaire needs about
570 columns for its tableau and is cramped at 448** -- its cards are drawn by the game, not
arranged as child windows, so there is nothing for PVMON to move. Fixing that needs either a
per-application rule that gives such programs a wider screen, or leaving them to landscape, where
a phone gets 864x400 and everything works at a comfortable size anyway.

**2026-09-01 (night) — where the scaling should happen, and the flicker fixes.**

*Flicker.* Reflowing a dialog moved a dozen controls one at a time, and each move repainted the
dialog. Painting is now suppressed for the dialog (`WM_SETREDRAW`) while the controls move with
`SWP_NOREDRAW`, then turned back on for a single paint. Two things must **not** be suppressed,
learned by breaking them: the dialog's own resize, because suppressing it means Windows never
invalidates the area the shrinking dialog *uncovers* and the old right-hand button column stays
painted on the desktop behind it; and the erase on the parent's final invalidate, because content
that moved leaves the area behind it stale. Children still invalidate without erasing, since each
paints its whole surface. The host also holds the last frame over the canvas across a mode change
so a resize does not flash through black.

*Where to scale.* A guest window cannot be scaled on its own: everything lands in one framebuffer
at one scale, and a window only lays out at 640 columns if the screen is 640. Two arrangements
work, and they differ in what shrinks:

1. **Narrow screen, reflowed dialogs.** The screen is 448, so the desktop is readable, and dialogs
   are reflowed to fit it. Applications that draw a fixed layout wider than that, Solitaire being
   the example, cannot be reflowed and stay broken.
2. **Full 640 screen, host scales the picture.** The guest never re-modes, so nothing relayouts
   and nothing flashes. PVMON keeps the shell to a 448-column strip and reports how far right the
   content reaches; the page scales so that much fills the viewport. Solitaire genuinely lays out
   at 640 and deals correctly, and the host scales it to fit.

Arrangement 2 is what is currently built. Its cost is that the scale applies to the whole picture,
so opening a wide window scales the shell down with it. Scaling *only* that window would mean
compositing two scales from one framebuffer, and the pixels behind the window are not in the
framebuffer to draw underneath it, so a smaller overlay would leave a ring of the window's own
pixels around itself. The variant that avoids this is to frame the *focused* window: give it the
whole screen so scaling to fit it is scaling only it, and scale back to the shell strip on return
to the desktop. That is a small change from what exists and has not been built yet.

**2026-09-01 (late) — windows composited as layers with their own chrome.**

The guest screen is now one row of 640-column slots: the shell in a 448-wide column, every
application window parked in a column of its own (`MAX_SLOTS` = 2). PVMON publishes each
window's window rect, client rect and title (`PVB`/`PVW`/`PVE`), back to front, and keeps a window
in its slot for life so activation never moves it. The host draws the shell column as the desktop
and each application over it: the client area at whatever scale fits, and the chrome nine-sliced
from the guest's own pixels at 1:1, so captions, menus, and the system/min/max boxes stay
finger-sized and are real (they click through to the guest). The caption strip between the boxes
is cropped around its centre rather than squeezed, so the title stays crisp. The caption is the
drag handle; dragging only moves where the host draws the layer. Oversized (maximised) windows are
pulled back to their slot by PVMON. Verified: Solitaire + Clock + Task List layered over Program
Manager; z-order follows the guest (Alt+Tab); drag moves by the exact delta.

Known, not yet fixed: (1) torn repaints in Solitaire during play -- `PLYBITM8.ASM
SetCurrentBankDL` still programs the V7 registers (3C2, SEQ F6/F9) directly instead of the PV bank
shadows, so PolyBitmap draws through a stale bank; (2) transient top-level windows placed by
Windows in screen space (the Alt+Tab switcher `#32771`, menus) land inside whichever slot column
they fall in and need their own 1:1 layer path anchored to the owning layer; (3) a third
application gets no slot and is never published (Hearts). A stale `C:\WINDOWS\PVMON.EXE`
shadowed the staged binary for a while; PVMON is now staged in `changes/windows`.

**2026-09-01 (later) — layer kinds, native minimise, run-by-URL, boot snapshot.**

Rule from Josh, now standing: everything on screen is Windows' own pixels. The host composites,
scales, crops and places guest pixels and translates input; it draws nothing of its own. The
host dock was removed; minimise is native (Program Manager leaves `ICON_ROW` free at the bottom of
the shell column, where Windows puts its icons).

PVMON now classifies top-level windows: applications (`PVW`, parked in a slot; maximise = restore
then fill the slot), owned windows (`PVO`, dialogs, drawn over the owner), transients (`PVT`:
menus, combo drop-downs, the Alt+Tab switcher `#32771`, drawn at chrome scale where they popped
up, anchored through the layer whose column they fell in; the switcher, centred on the whole
screen, is centred on the viewport), iconic (`PVI`), slot-less (`PVX`). Icon titles (`#32772`)
and windows owned by a minimised app are skipped. Chrome is drawn at the desktop's scale so every
caption and menu bar matches; the caption strip is cropped around its centre, never squeezed.

Host->guest command channel: DISPI 0x1A command / 0x1B argument / 0x1C command string (one byte
per read). Commands: activate, restore, close, minimise (a slot), run (WinExec a command line),
republish (after a snapshot restore). `/solitaire`, `/hearts`, ... or `?run=` launch an app the
moment `PVA` arrives. `image/boot.state.gz` (2.1 MB gzipped, made with `?fresh=1&mkstate=1`,
posted to the dev server's `/__state`) is restored on a cold visit: desktop up in a few seconds
instead of a minute. Local snapshots are keyed by the image's size and mtime, since a stale one
restores an old PVMON and looks like a hang. The 8 bpp palette conversion now covers only dirty
rows (rust `svga_dirty_range` + JS-side min/max for the banked write path). `PLYBITM8.ASM`'s
bank switch now goes through BANK.INC (`far_set_both_pages`), which was the torn-card bug.

Dev notes: the service worker is not registered on localhost (dead pooled connections after a
server restart made every GET fail with ERR_FAILED); PVMON is staged in `changes/windows`
because `C:\WINDOWS` shadows `C:\` on the PATH.

**2026-09-01 (night) — chrome size: bitmaps are not the lever.** The display driver carries the
OEM bitmaps (OBM_CLOSE, arrows, check boxes; `RES96/`). `tools/scalebmp.py` produced a 2x set
(`RES192/`, `tools/build-driver.sh res=192`) and the built driver verifiably contains them
(72x36 SYSMENU), yet Windows drew identical chrome: at 120 dpi USER sizes captions, menus and
caption boxes from the system font, not from the bitmaps. The native route to thumb-sized chrome
is therefore a larger SYSTEM font (a scaled or freshly rasterised FON), with the DPI left at 120
so dialog layouts (MS Sans Serif) stay as they are. Not done yet. Also: two-finger scroll, focus
report (`PVK`) for the soft keyboard, per-app maximise height (`[PVMon] MaxHeight.PBRUSH=480`),
owned windows parked in the owner's column, fixed guest layout in both phone orientations, and the
dev server now listens on the LAN (`http://<mac-ip>:8311/solitaire`) for real-device testing.

**2026-09-01 (late night) — thumb-sized chrome, natively.** Correction to the entry above: the
driver's RC carries two bitmap sets, `OBM_*` (used at 120 dpi, files in `RES31/`) and `OBM_96_*`
(`RES96/`); the first attempt scaled the wrong one. With `RES31X2/` (2x, `tools/scalebmp.py`) built
in (`tools/build-driver.sh res=192`) and the system font replaced by MS Sans Serif 18 pt / 29 px
wrapped as `PVSYS.FON` (`tools/mkfon.py`, SYSTEM.INI `fonts.fon`), SM_CYCAPTION went from 28 to
54 and menus from ~26 to ~52 guest pixels: on a 375-wide phone the caption boxes are ~45 CSS px,
Apple's 44 pt. Everything is Windows' own drawing. Costs: Program Manager's menu wraps to two rows
at 448 columns (Help lands on the second row); icon titles keep their own smaller font.

Tuned after Josh found 2x "way too big": 120-dpi bitmaps at 1.5x (`RES31X15/`, `res=150`),
system font MS Sans Serif 14 pt / 24 px, shell column 400 x 866 (WIN.INI `ShellHeight`, matched to
a 375x812 phone so the width binds and there are no side bars). Result on the phone: caption
boxes ~38 px, menu row ~36 px, single-row Program Manager menu, icons ~30 px (32-px bitmaps at
0.94; icons are the programs' own 32x32 images and only the column scale can make them bigger).

**2026-09-01 (midnight) — first real-device round (iPhone 16 Pro, Safari).** Viewport is
402x684 with Safari's bars, so the shell column height is now set at runtime (`CMD_SHELLSIZE`),
and no host toolbar is shown on phones. Pointer "stuck after dropping a card" and the torn card
streaks had one cause: the host re-sent the whole remaining PS/2 delta up to six times while the
guest was busy repainting, driving the pointer screens away and making Solitaire restore its drag
image at the wrong place. Presses now place the pointer absolutely (`CMD_SETPOS` -> SetCursorPos,
confirmed by the driver's MoveCursor report), and drag motion waits for each report before
correcting. Minimised icons, which Windows puts at the bottom of the 970-row screen, are moved
into the visible icon row. The shell takes part in z-order (`PVS`), pinch zooms a layer's client
area, and the page reports errors, a heartbeat and main-thread stalls to the dev server
(`shots/devicelog.txt`). Blur on the phone: canvas backing store now matches whole-pixel CSS
size and `image-rendering: pixelated` guards against Safari resampling.

**2026-09-02 — device trace, and how testing is done now.** `?diag=1` traces every input step to
the dev server log; the iPhone's trace showed (a) `SetCursorPos` reports arriving after the 350 ms
wait (the guest on a phone is slow), so presses now wait up to 1.2 s and never click before the
pointer is confirmed; (b) a drag whose finger left the small Solitaire layer being re-hit-tested
against the desktop, which flung the pointer into the shell column: moves now map through the
layer the press started in; (c) Safari's IndexedDB rejecting a Blob (snapshots stored as bytes);
(d) a right-click after every tap (long-press timer armed after touchend). PVMON reports its
version in `PVD` and the heartbeat carries MIPS, so a stale snapshot or a slow guest is visible in
the log. Testing: synthetic `TouchEvent`s through the real handlers in the (hidden, throttled) pane,
with the app's `sleep()` driven by the worker heartbeat so background throttling cannot stall it;
regression = tap, card drag (incl. off-layer), caption drag, desktop tap, menu, Program Manager to
front, minimise/restore.

**2026-09-02 (early) — drag pipeline and icon scale.** The phone trace showed each touchmove being
queued as its own guest round-trip, so a 0.4 s drag became seconds of backlog on a slow guest and
the next gesture queued behind it (and shared press flags were clobbered by the next gesture,
firing right-clicks). A press is now one pipeline with its own state: place, press, a single
follow loop steering to the latest finger position, release once caught up. Verified with three
back-to-back synthetic drags. Icons are 32x32 bitmaps inside the programs, so the desktop scale is
the only native lever: shell column 352 wide (≈1.14x on a 402-pt phone, icons ≈37 pt). Open:
Solitaire's drag residue reproduces on the fast pane guest too, so it is the driver's
screen-to-screen blit (bank crossings at 4096 pitch, 16 rows per 64K), not the pointer.

**2026-09-02 — absolute drag motion, dialogs, DOS box.** Relative PS/2 packets lag far behind a
finger on the phone's slow guest while `SetCursorPos` via PVMON lands in tens of milliseconds, so
drag motion now goes through the absolute path too (Windows raises WM_MOUSEMOVE for the dragging
program); three back-to-back synthetic drags land exactly. Dialog reflow is judged against the
shell column (the screen is 2560 wide, so nothing ever overflowed it): Run reflows to 327 in a 352
column. System font 20 px so Program Manager's menu stays on one row at 352. MS-DOS Prompt: the
PIF now runs it windowed with Alt+Enter disabled (`tools/pifwin.py`), since a full-screen DOS
session switches the display to text mode under the compositor. Open: Solitaire drag residue
(driver screen-to-screen blit), icons still 32 px bitmaps.

**2026-09-02 — DOS box.** With a 386 enhanced DOS session running, USER only calls the driver's
MoveCursor on the next mouse interrupt, so `SetCursorPos` moves the pointer but the host waited a
full timeout for confirmation: PVMON now writes the cursor registers itself after SetCursorPos
(confirmation 11 ms with the DOS box open, was >1200). The DOS box's PIF is windowed, Alt+Enter
disabled, priorities 20/10. `[PVMon] Size.WINOA386=400x340` (PVMON applies a per-module initial
size once per window) makes the DOS window a phone's width, so its text is shown at ~1:1 with a
horizontal scroll bar (WinOldAp does not switch fonts on its own; a smaller DOSAPP.FON face would
give all 80 columns). The emulator itself slows sharply while a DOS VM runs (phone: 64 -> 11-37
MIPS), which is the remaining lag.

**2026-09-02 — absolute pointing device.** PVMON-driven `SetCursorPos` depends on PVMON's timer,
which a busy Win16 system (WinOldAp starting, a DOS VM running) starves for a second or more, so
everything routed through PVMON lagged. `PVMOUSE.DRV` (guest/mouse/port, the DDK PS/2 driver;
`tools/build-mouse.sh`) fixes this at the root: the host posts the wanted position, normalised
0..65535, in adapter registers 1Dh/1Eh (flag 1Fh) and sends any PS/2 packet; the interrupt
handler reports `SF_ABSOLUTE` and USER puts the pointer there at interrupt time. Confirmation
9-11 ms, exact to the pixel (aim at pixel centres: USER truncates norm*cx/65536), independent of
what applications are doing. SetCursorPos remains the fallback after three missed reports.
Regression on the restored snapshot: tap, three back-to-back drags, desktop tap all exact.

**2026-09-02 — idle.** Windows 3.x never halts: an idle desktop spins on INT 2Fh AX=1680h (release
time slice) / 1689h (kernel idle), which kept the emulator at 60-90 MIPS and a phone warm. v86's
`instr_CD` now treats either call as a halt until the next hardware interrupt (the handler runs
after the wake-up, which is what "yield" means). Idle: 0.1 MIPS, input still immediate. Also:
`_DEFAULT.PIF` windowed; the phone's "DOS window never appears" is DOS VM start-up dragging the
emulator to ~3 MIPS (5 s in the pane at 55 MIPS), i.e. the DOS VM speed item.

**2026-09-02 — CBT hook, printer, immutable builds, tearing (part 1).**
- `PVHOOK.DLL` (guest/pvhook, Open Watcom `system windows_dll`): a system-wide WH_CBT hook.
  HCBT_CREATEWND rewrites the CREATESTRUCT so application windows are born in the staging column
  (x=640) sized to `[PVMon] DefaultSize` (or `Size.<MODULE>`, unless in `KeepSize`) and owned
  windows are centred on their owner in the owner's column. Verified: Hearts' welcome dialog first
  appears at x=663 (never in the desktop column); Notepad opens 352x600 (1:1 on the phone). PVMON
  loads it at start ("CBT hook installed") and keeps its poll-time parking as the fallback.
- Printing: "PDF Printer" = stock PSCRIPT.DRV + HP LaserJet III PostScript description, port
  `C:\PRINT.PS`. PVMON ships the finished file over the debug channel as `PVP-BEGIN/PVP <b64>/PVP-END`
  and deletes it; the page converts with Ghostscript wasm (@jspawn/ghostscript-wasm, loaded on
  first use) and triggers a download. Status: Notepad printing gave "Not enough memory to print"
  (CreateDC failing); the per-printer section is now written under both `[PSCRIPT,...]` and
  `[PostScript,...]`; retest pending.
- Immutable builds: `build-image.sh` clones each build to `work-phone-<stamp>.img`, writes
  `image/current.json` {image, state}; the page reads the manifest (top-level await) and mkstate
  writes `boot-<stamp>.state.gz`. Cause: the phone restored a snapshot over a newer image and hit
  "Segment Load Failure in PVDISP.DRV at 0001:3E11".
- Tearing, part 1 (agent): the interrupt-time software cursor switched the PV banks under a running
  blit (CURSOR.ASM saved the inert V7 registers, not the PV shadows). Fixed and merged (f744552);
  residue still reproduces with the cursor hidden, so a second cause remains (under investigation).
- Idle hook (v86 INT 2F 1680/1689) merged earlier; pointer hidden on touch; caption tap activates;
  caption long-press toggles the soft keyboard; layers draggable off-screen; DOS box keyboard via
  class "tty".
- Sound: WfW's SNDBLST2.DRV refuses v86's SB16 even at DSP 2.1 (agent investigating); off by
  default. DOS VM speed: agent investigating v86's V86-mode/JIT path.

**2026-09-02 — printing status.** A file port must be named `*.PRN` (WIN.INI's own comment);
with `C:\PRINT.PS` CreateDC failed in Notepad ("Not enough memory to print") and Write hung the
system after spooling. Now `C:\PRINT.PRN`. Remaining: printing from Write opens its Print dialog,
then the guest spins at ~150-1400 MIPS in a ring-3 16-bit segment (CS 0x437, linear ~0x36000)
with PVMON starved and the dialog never painted. Not yet identified; the host side (PVP transfer,
Ghostscript wasm, download) is in place but untested end to end.

**2026-09-02 — printing works (text), PostScript pending.** Two guest-side hangs found on the way:
the idle hook halting with IF clear (fixed: only with IF set), and PVHOOK.DLL built without `-bd`
(rebuilt). With the "Generic / Text Only" driver (TTY.DRV, expanded from the media) as "PDF
Printer" on port `C:\PRINT.PRN`, spooler off: Write prints, PVMON ships the file
(`PVP-BEGIN 51 … PVP-END`), the host builds a PDF itself for text jobs (hand-written PDF, Courier,
form feed = new page; verified rendering) and downloads it. PSCRIPT.DRV still spins the guest
(~150 MIPS, ring 3, low-memory segment) as soon as the Print dialog creates the printer DC; kept
off. Ghostscript wasm path ready for PostScript jobs (`locateFile` on the CDN) once PSCRIPT works.

**2026-09-02 — tearing root cause (agent, verified live).** `set_page` in the Phase 2 port of
VGAUTIL.ASM did `pushf … pop ax / pop ds / push dx / shr dl,2 / popf`, so `popf` restored the
just-pushed DX instead of the saved flags: `set_banko`'s carry (read vs write bank) became bit 0 of
the 64K bank number, and every screen-source blit starting on an odd 64K bank (16 rows at pitch
4096) programmed the WRITE bank and read its first rows through a stale READ bank — Solitaire's
save-under captured frame/desktop grey and painted it back. Found by monkey-patching vga.js A000
accesses per row with the guest stack, hot-patching the 27 bytes in guest RAM to confirm. Fixed
(76d71e4) with a node unit test of the banked VGA emulation (v86/tests/pv/banked-vga.mjs, 43
checks). Four touch drags now leave a clean tableau. Also this round: DOS box closable (PIF
fEnableClose), 352 wide, keyboard by module (KeyboardApps=WINOA386 TERMINAL); shell maximise
clamps to its column; shell-owned dialogs created inside the column by the hook; menu row drawn
between the side borders.

**2026-09-02 — keyboard.** Soft keyboard: summoned when an Edit/ComboBox/DOS box has focus or the
active program is in `[PVMon] KeyboardApps`; a caption long-press toggles it. The CBT hook now
reports focus changes the instant they happen (`HCBT_SETFOCUS` -> `PVK`), inside iOS's gesture
window. While the keyboard is up the layout is frozen (no shell re-arrange) and the focused layer
is panned above it; taps map through the same shift. Gaps: no Esc/Tab/arrows/F-keys/Alt on the
iOS keyboard (needs a gesture map or a hardware keyboard).

### 2026-09-02 — keyboard accessory bar verified
- `/notepad?keybar=1` in the pane: `#keybar` shown, docked at `bottom:0` of the visual viewport; Alt+F opened Notepad's File menu (`T:#32768` layer present), a synthetic `touchstart` on the bar's **Esc** button closed it (layer list back to `S`,`W`). The `#kbd` input keeps focus because the button handlers `preventDefault` on touchstart.
- TTY.DRV (Generic/Text "PDF Printer") staged in `image/changes/system/`.

### 2026-09-02 — DOS-VM speed merged (v86 rust)
- Merged worktree branch `worktree-agent-a23863c66d4768c09` (adaptive idle `pv_idle_set(mode,limit)` default 2/20000; flat-compatible JIT modules; `PAGE_HAS_CODE` bitmap + FastHasher on TLB miss; mixed code/data page hotness kept + volatile backoff; byte-granular SMC off by default). Headless: DOS box 29 → 66 MIPS throughput, idle DOS box halts. Conflict in `instructions.rs` resolved in favour of the adaptive version (it keeps the IF=1 guard). 43/43 banked-vga checks pass; DOS box launches from the snapshot in the pane and `pv_idle_stat` shows the idle box mostly halted.

### 2026-09-02 — sound unblocked: PVDPI was truncating SYSTEM.INI
- Sound agent: v86's SB16 already satisfies SNDBLST2.DRV (DSP 2.1 spoof); the "configuration or hardware problem" box was `ConfigGetPortBase()` reading a SYSTEM.INI whose tail (`[network drivers]`, `[sndblst.drv]`) had been destroyed by PVDPI's `copy_file()`: a 4 KB auto buffer in a small-model DOS program overran the stack. Fixed by making the buffer `static` (guest/pvdpi/pvdpi.c), rebuilt PVDPI.EXE, image rebuilt with `sound=1` (work-phone-20260902-104044), cold boot in the pane shows no error box; new boot snapshot posted.
- `v86/src/sb16.js`: optional `sb16-trace` bus toggle (default off) merged from the agent.
- Microphone: v86 SB16 has no record path (DSP 0x24/0x2C unhandled) — follow-up agent implementing DMA input + getUserMedia.
- `web/app.js`: `?wasm=<file>` picks a wasm under v86/build for A/B tests.
- Found: launching the DOS box paints a 4-row desktop-coloured band (index 247) across the shell column at y=60..63 (guest VRAM, not compositor). Reproduces with the pre-merge wasm too; Notepad launch does not do it. Being investigated.

### 2026-09-02 — microphone: SB16 recording path + getUserMedia
- What SNDBLST2.DRV does (capstone over the NE segments; seg 4 offset 0x75c is the start routine, `al` = direction): programs the 8-bit DMA channel with mode `0x54` for record (`0x58` playback: single, autoinit, address increment; bit 2 flips the direction) and count `0xFFF` (a 4 KB autoinit double buffer), then DSP `0x40` time constant (`256 - 1e6/rate`; Sound Recorder's 11.025 kHz lands on 0xA6 = 11111 Hz), `0x48` block size `0x7FF` (2048 samples), then the command `0x1C ^ (0x30 & dir)`: **`0x1C` to play, `0x2C` to record** — always auto-init, never the single-cycle `0x14`/`0x24` or the high-speed forms. Stop is `0xD0` followed by masking the DMA channel (port 0x0A); `0xDA` is never sent. Speaker on/off `0xD1`/`0xD3`; detection `0xE1`, `0xF2` (IRQ probe).
- `v86/src/sb16.js`: `0x24`, `0x2C`, `0x91`/`0x99`, `0x98` and the `0xC8..0xCF` forms now start an ADC transfer (`rec_start`). Samples come from the host over the bus (`sb16-record-data`: `[Float32Array, hostRate]`) into a 64 K-sample ring and are pulled with linear-interpolation resampling to the DSP's programmed rate, converted to 8-bit (unsigned 0x80-centred, or signed when `0xC8` asks), and written into guest memory through a new `DMA.prototype.do_read_sync` (`v86/src/dma.js`: incremental device→memory with address/count accounting and autoinit wrap, which the existing floppy-oriented `do_read` lacks). Pacing is wall-clock: `SB16.prototype.timer(now)` is called from `CPU.run_hardware_timers` (`v86/src/cpu.js`), writes the bytes owed since the last tick, and raises the 8-bit IRQ at every block boundary; with no host data it writes 0x80 silence, so Record runs and Stop works without a microphone. `0xD0` pauses; a paused recording whose DMA channel is then masked is ended (that is the driver's stop). A stall (throttled tab) is capped at two blocks of make-up. Recording state is not snapshotted (restore ends it). Bus out: `sb16-record-start` (rate) / `sb16-record-stop`. `0x20` (direct ADC) now returns a ring sample instead of a constant. Latency bound: if the host runs more than ~250 ms ahead the read position skips forward.
- `web/app.js`: on `sb16-record-start` the page lazily calls `getUserMedia({audio})` (first Record = the browser's permission prompt; nothing drawn by us), routes it through a `ScriptProcessorNode(1024)` on the speaker adapter's AudioContext (an AudioWorklet would need a separate module file; ScriptProcessor works everywhere including iOS Safari), downmixes to mono and sends `sb16-record-data`. The stream is kept between takes (one prompt per visit) and released when the page is hidden while idle. `window.micState()` for diagnosis; `/soundrecorder`, `/mediaplayer` URL aliases.
- Verified in the pane (localhost:8314, this worktree, boot snapshot): Record → `rec start: ch 1 block 2048 rate 11111 autoinit true`, DMA mode 0x55 at 0x4C8000 len 4096; IRQ 5 raised and acknowledged (2xE) every 184 ms; 186 IRQs in 34.28 s = exactly 186×2048/11111. Stop → `0xD0`, channel masked, `rec stop`. Play → `dma start ... 0x1C`, `dac-send-data` flowing. Data path: a synthetic 440 Hz tone pushed over `sb16-record-data` appears in the guest DMA buffer as an 8-bit sine (52..204) and, after Stop / rewind / Play, reaches the DAC at ±0.6. The pane itself blocks `getUserMedia` (Browser pane notice), so the microphone capture was exercised only as far as the prompt; the silence path covered the rest.
- Secure context: `navigator.mediaDevices` does not exist over plain `http://192.168.4.62:8311`, so on the phone over the LAN Record produces a silent recording of the right length (no prompt, no error; `report("mic", "unavailable ...")` on the dev server log). `http://localhost` counts as secure, so desktop testing works. For the phone the page needs https (a self-signed cert on the dev server, a tunnel, or the real deployment). iOS Safari additionally needs the AudioContext resumed from a gesture (already done on touchstart) and shows its own microphone prompt per page load; Safari also stops the capture when the tab is backgrounded, which is why the track's `onended` releases and the next Record re-opens it.
- Build: `cd v86 && make build/libv86.js` passes closure's VERBOSE type checks (0 errors, 0 warnings); the web page loads `v86/src` modules directly, so no rebuild is needed for it.
### 2026-09-02 — DOS box band (rows 60..63) root cause: WIN386's VDD lending "spare" video memory
- Symptom: starting the MS-DOS Prompt painted a 4-row band of index 247 across the shell column at
  y=60..63 (guest VRAM). Traced by wrapping `vga_memory_write` in the pane and recording CS:IP and
  VGA state per write: none came from PVDISP. The band was written by ring-0 code at
  CS=0028h EIP=8001AD20h/AD40h (WIN386's `*vddvga`) and by the DOS VM's video BIOS (C000:0FC3, V86
  mode, ES=B800) — 0720h char/attr pairs and a plane-2 font clear — all at physical A000:F000-FFFF
  with chain-4 off. In the adapter's planar addressing A000:F000-FFFF is linear 3C000h-3FFFFh, i.e.
  rows 60..63 of the 4096-pitch frame buffer.
- Mechanism (DDK `386\VDDVGA` source): a display driver that answers INT 2Fh 4000h without first
  calling the VDD's `VDD_SVC_Set_Addresses` (INT 2Fh 1684h, VxD 0Ah, function 0Ch) is "not 3.1
  aware"; the VDD then derives the system VM's visible pages from the CRTC state it tracked
  (`VDD_PH_Mem_Save_Sys_Latch_Addr`) — 15 of the 16 4K pages of the A000 window — and demand-pages
  the remaining page(s) among DOS VMs: a windowed DOS box's B800 pages are mapped by page table onto
  physical A000:F000, its font plane is cleared there by the VDD, and the VDD also pokes a
  `shadow_mem_status` byte into video memory past the visible pages. The VDD models a 256K VGA; on
  this adapter every byte of the window is frame buffer. (Declaring all 16 pages visible is not an
  option: `VDD_PH_Mem_Alloc_Video_Page` then fails for the DOS box, `VDD_Error_NoPagesAvail`, and
  the box shows nothing — the VDD needs at least one physical page even for a windowed text VM;
  the grabber reads the VDD's SaveMem copy, not VRAM.)
- Fix, adapter side (v86 `src/vga.js`): `pv_text_mem`, a private 256K store. A000-window accesses
  made in ring 0 or V86 mode with paging on (the VDD and its DOS VMs) are decoded into it with the
  normal planar/chained addressing; ring 3 (the display driver) and real mode (DOS programs on the
  bare adapter) still reach the frame buffer. Same spirit as upstream v86's FLAG_VM special case
  on the DISPI enable register for Win9x VDDs. Saved in the snapshot (state[88]).
  `tests/pv/banked-vga.mjs` section 8 covers it (67/67).
- Driver side: left as is (PVDISP stays "not 3.1 aware"; the VDD's guess gave enough spare pages).
  Tried and rejected: calling `VDD_SVC_Set_Addresses` from physical_enable as the DDK's VGA.DRV
  does (INT 2Fh 1684h, VxD 0Ah, AX=0Ch, BX=latch byte, DS:SI=shadow_mem_status). With 16 visible
  pages the DOS box shows nothing (`VDD_Error_NoPagesAvail`: the VDD demand-pages a windowed text
  VM's pages among physical video pages and cannot run one without any); with 15 or 8 visible
  pages the box also stays black even though its text lands in the text store — the VDD then
  steals/saves/restores pages between the system VM and the DOS VM (`fVDD_DspDrvrAware` paths),
  and the grabber's SaveMem copy comes back empty. Not pursued further; the adapter-side fix is
  sufficient and independent of the driver.
- Verified in the pane (`/solitaire` snapshot of the shipped image work-phone-20260902-104044,
  `pv-command-string` DOSPRMPT.PIF, then `dir`): no all-247 rows in the shell column, row 60
  intact, DOS text visible (105 text rows, 218 after `dir`), the VM's text/font pages in
  `pv_text_mem` (16K), the VDD's traffic never reaches `svga_memory`. No driver or image rebuild
  needed: vga.js is loaded as a source module.

### 2026-09-02 — the phone tests itself: app tour (Fix 5) and remote control
- `web/selftest.js` (ES module, draws nothing): opens every stock app (NOTEPAD, WRITE, CALC, CLOCK,
  CHARMAP, CARDFILE, CALENDAR, PBRUSH, SOL, WINMINE, MSHEARTS, WINFILE, CONTROL, PRINTMAN, CLIPBRD,
  SOUNDREC, MPLAYER, RECORDER, TERMINAL, PACKAGER, WINHELP, TASKMAN via Ctrl+Esc, DOSPRMPT.PIF) and
  per app checks: `launch` (PVW within 15 s, 40 s for the DOS box), `fit` (window ≤ 352 × shell
  height, also re-checked after the dialog), `slot` (born inside its 640-wide column), `scale` (the
  host layer's client scale `placed[].s` ≥ 1), `tap` (synthetic TouchEvents on `#pres` through
  app.js's real handlers; node: the absolute pointer), `kbd` (guest asks for the keyboard, PVK 1;
  asserted for NOTEPAD, CARDFILE, TERMINAL, DOSPRMPT, informational elsewhere), `focus` (DOM
  evidence only: `activeElement===#kbd`, visualViewport height; informational because a synthetic
  touch never grants focus on iOS), one dialog where cheap (`dlg` appeared, `dlg1` exactly one PVO,
  `dlgfit`, `dlgsep` dialog rect does not intersect the owner rect — Fix 2's acceptance, `?lenient=1`
  makes it informational, `dlgpix` with `?pixels=1`: the composite on `#pres` inside the owner layer
  and outside the dialog layer must not contain a 120 px run of the dialog's caption colour,
  `dlgclose` after Esc), `close` (CMD_CLOSE, a "save changes?" box gets N, Alt+F4 fallback), `layer`
  (host layer gone), `alive` (instruction counter advancing). Dialogs: Notepad/Write Alt+F,O;
  Paintbrush a stroke then Alt+F,X (save prompt) then Esc; Hearts' welcome box (Enter). Waits are
  resolved from a Worker heartbeat so a hidden tab's throttled timers cannot stall the tour; in a
  hidden tab `pvPresent()` is called by hand (with requestAnimationFrame stubbed for the call so no
  second render loop is left behind). Output: `TOUR-BEGIN …`, one `TOUR <app> check=pass|fail|info…`
  line per app and `TOUR-END pass=N fail=M …` posted to `/__log` (shots/devicelog.txt), plus
  `window.tourResult`. Options: `?apps=NOTEPAD,CALC`, `?pixels=1`, `?lenient=1`.
- Three ways to run it:
  1. Phone: `http://192.168.4.62:8311/?selftest=1` (app.js loader:
     `if (params.get("selftest")) import("./selftest.js").then(m => m.run());`), read the TOUR lines
     in shots/devicelog.txt.
  2. Pane (mobile preset, own tab, own server `node tools/devserver.mjs 8330 .`): with the loader in
     place `?selftest=1`, or by hand from the console `import("/web/selftest.js").then(m => m.run())`.
  3. Headless: `node tools/tour.mjs [--apps A,B] [--lenient] [--log] [--json out.json]` boots v86 in
     node from image/current.json (image + boot snapshot, restored then CMD_REPUBLISH), runs the same
     tour over the bus (no DOM: scale/focus/pixel checks skipped, taps via PVMOUSE absolute
     registers), prints the table and exits 1 on any failure. Needs `v86/build/v86.wasm`,
     `v86/bios/*.bin` and the image files present locally (all gitignored). ~4 min for all apps.
- Remote control (`web/remote.js`, loader `if (params.get("remote")) import("./remote.js").then(m => m.run(params.get("remote")));`):
  park the phone on `http://192.168.4.62:8311/solitaire?remote=phone&diag=1`. The page long-polls
  `GET /__cmd?device=phone` (held up to 25 s, JSON command or 204; the poll doubles as presence),
  runs the command and posts `{id, ok, value|error, t}` to `POST /__result?device=phone`, which the
  server stores in `shots/results/<device>/<id>.json` and appends to the device log. Commands
  (`POST /__cmd?device=phone` with `{type, ...}`): `ping`, `eval {src}` (async function body; `emulator`,
  `pvState`, `pvPresent`, `sleep`, `tap`, `keys`, `type` in scope), `shot` (PNG of `#pres` to
  `/__shot`), `tour {opts}`, `reload {query}`, `tap {x,y}` (real DOM TouchEvents), `type {text}`
  (`keyboard_send_text`), `keys {codes}` (PS/2 scancodes). Commands older than 60 s are dropped by
  the server and refused by the page. `GET /__devices` lists devices with last-seen; `GET
  /__result?device=&id=` long-polls one result. Wake: `navigator.wakeLock('screen')` requested on
  load, on the first touch and on every visibilitychange; without it a muted looping 16×16 inline
  MP4 (1 px, near-transparent element) is played; which one is active is logged (`remote phone wake …`).
  CLI: `node tools/remote.mjs [--server http://host:8311] [--timeout s] <device> <type> [args]`, e.g.
  `node tools/remote.mjs phone tour`, `… phone shot`, `… phone eval 'return pvState().layers'`,
  `… phone tap 200 400`, `… phone keys 0x38 0x21 0xa1 0xb8`, `… --devices`. Exit 0 ok, 1 failed
  (or a tour with failures), 2 no answer.
### 2026-09-02 — "closing the DOS box locks up the system": WINOLDAP's confirmation box, invisible to the host
- Reproduced headless (scratchpad `exitbug/harness.mjs`: restore the shipped snapshot, `pv-command-string` DOSPRMPT.PIF, then `pv-command [CMD_CLOSE, slot]`, i.e. what the Close box / system-menu Close / host close all become: `PostMessage(hwnd, WM_CLOSE)`). Typing `exit` closes the box in 0.4 s; WM_CLOSE never closes it, PVMON stops publishing (no more `PVB` lines), the emulator runs at 100-130 MIPS in ring 0/ring 3 with no idle calls. Not the emulator: identical with the pre-merge wasm (`?wasm=v86-base.wasm`), with `pv_idle_set(0,0)`, with the `pv_text_mem` redirect disabled, and after a host-side `full_clear_tlb()`. Timer IRQ 0 keeps arriving (18/s), the PIC is clean.
- What the guest is doing (CS:EIP sampling + descriptor/TDB decoding in the harness): ring 3 is KRNL386 `WaitEvent`→`Reschedule` (segment 0117h, `dec TDB_nEvents; call Reschedule` loop at 117:7CCA-7CF0), current task WINOLDAP (nEvents 0) while PVMON and PROGMAN have events pending; Reschedule returns without switching because the current task is *locked* (`cmp cx, es:[pLockTDB]` at 117:8104): WINOLDAP does `LockCurrentTask(TRUE)` around the VM termination. Every `cli`/`sti` of that loop traps to the VMM (28:80006Dxx, the PM fault dispatcher), which is the ring-0 time. The DOS VM's control block (found by scanning for CB_High_Linear/CB_VMID; `Cur_VM_Handle` at VMM linear 80012958h) goes `VMStat_Suspended` right after the close.
- Why: WINOLDAP suspends the VM and puts up a system-modal `MessageBox` — "Application still active. Choose OK to end it." — and waits for input. The box (frame buffer dump `exitbug/hang.png`: at about x=1105..1450, y=395..572 of the 2560-wide desktop) is a top-level window PVMON never reports, because PVMON's timer task is locked out; the host therefore never composites it, never routes a tap to it, and the shell column shows no change, so the phone looks frozen. It is also why the CPU is hot: a locked task in WaitEvent busy-waits in KRNL386 (no INT 2Fh 1689h idle), so the adaptive idle cannot help.
- Proof: sending Enter 5 s after the close dismisses the box; the VM is nuked (disk writes), the DOS box layer disappears, idle halts resume. Esc cancels: the VM is resumed and the box stays open. Alt+F4 does nothing to a windowed DOS box even when it is the active window (WINOLDAP does not treat it as Close; the Control menu / Close box is the way).
- Fix belongs to the guest/host side, not v86: (a) PVMON should publish window changes from its CBT hook (HCBT_CREATEWND/HCBT_ACTIVATE/HCBT_DESTROYWND run in the *creating* task's context, so they run even while WINOLDAP is locked), or at least publish the `#32770` owned by the DOS-box slot so the host draws it and routes taps; (b) alternatively the host could answer WM_CLOSE on a DOS-box layer by driving the dialog itself (send Enter after the layer list goes quiet), or the keyboard bar could stay reachable so Enter/Esc are one tap away. No v86 change made; `?wasm=` A/B and the pre-merge wasm are untouched.

### 2026-09-02 — host pass: keyboard in the gesture, audio unlock, placement, scroll policy, watchdog, PWA
Verified in the pane (mobile preset, synthetic TouchEvents through the real handlers, `?diag=1` trace
in `shots/devicelog.txt`); "phone" items below are what still needs the real device.
- **Keyboard (Fix 3).** The focus decision is made *inside* the tap's touchend, synchronously
  (`tapKeyboard` -> `focusKeyboard`); the old path focused 350 ms later from a timer, which iOS does
  not count as the gesture — that was the whole bug, for Notepad as much as the DOS box. Rule: the
  guest's last word (`PVK 1`) or a manual hold focuses; otherwise a tap on a window (or inside a
  shell-owned dialog) focuses speculatively and `speculativeRelease` lets go after 700 ms if no
  `PVK 1` arrives; `PVK 0` blurs after a 400 ms debounce. Programs that never take text (Solitaire,
  Hearts, Minesweeper, Paintbrush, Clock) and bare desktop taps do not try, so the keyboard does not
  pop up and down on every card. `?kbtest=1` focuses on every tap regardless. The caption long-press
  toggle now focuses on the release (inside the gesture). Every attempt logs `kbd ...` with
  `activeElement`, `visualViewport.height/innerHeight`, want/held. `#kbd` is on screen (2x2 px,
  opacity .01, 16 px font, `inputmode=text`) so it is focusable on iOS; a focused input whose
  keyboard was dismissed is blurred first, or `focus()` is a no-op. Pane: DOS box tap ->
  `focus try (want "MS-DOS Prompt")`, `activeElement === kbd` right after the touchend; desktop tap
  while wanted -> focus, then `PVK 0` -> blur 400 ms later. Phone: watch for `kbd focus result ...
  vvh=<less than innerHeight>` after a Notepad or DOS box tap.
- **Keyboard bar.** Ctrl/Alt: one tap arms (blue), a second locks (blue with a white inset ring)
  until tapped again, a third clears; armed modifiers are spent by the next key, locked ones stay.
  A hide key (`⌄`, first on the bar) blurs the input and suppresses `PVK 1` for 1.5 s so the focus
  that is still in the guest does not summon it straight back. The layer pan above the keyboard
  (`keyboardShift`) is unchanged: it shows the focused layer's bottom edge, so the DOS box (340
  rows) is fully above the keyboard and Notepad's caption stays at the top with the first lines
  visible — the host does not know where the caret is. Not testable in the pane (no visual viewport
  change); phone item.
- **Audio.** `unlockAudio` on touchend/click/keydown/pointerup (capturing, whole document), on
  touchstart, visibilitychange, focus and pageshow: resumes the speaker adapter's context and starts
  a looped silent WAV `<audio>` in the same gesture, which is what lets Web Audio through the
  iPhone's ring/silent switch (nothing is drawn). `report("audio", ...)` logs state, sampleRate and
  the media element's state whenever they change, and `onstatechange` logs "interrupted" (iOS after
  a call/background). Pane: `state=running rate=48000 silent=playing`. Phone: look for the same
  line after the first tap in Chrome; if state stays `suspended` the log will say which event fired.
- **Placement.** New layers: no cascade; x centred (0 when the layer fills the width, which it may
  now — the 8 px side margin is gone), y under the shell's caption strip (Program Manager's caption
  stays reachable), top-aligned when taller than that. Solitaire opens 375 wide at y=48. Drag is
  unchanged (off-screen allowed).
- **One-finger scroll policy** (`SURFACE_POLICY`, by published title): Help, Write, Notepad,
  Cardfile, File Manager, Control Panel, Print Manager, Task List, Calendar, Character Map, Media
  Player, Clipboard scroll (CMD_SCROLL line messages, 24 px per line, no button); Solitaire,
  Paintbrush, Minesweeper, Hearts, MS-DOS, Terminal, Reversi and anything unknown pointer-drag. A
  tap is a click everywhere; the scroll starts after 8 px of travel. Pane: a 120 px drag on
  Notepad's client sent `scroll 2 2`, `scroll 2 1`, `scroll 2 1` and no button events.
- **Pointer.** `setGuestCursor(false)` on every touchstart, `(true)` on a real mouse `pointermove`
  or mousedown; only transitions are sent. Verified in VRAM: after CMD_CURSOR 0 the 16x24 block at
  the reported pointer position is all background; after CMD_CURSOR 1 Notepad's I-beam is there (27
  black pixels, hotspot centred). Finding on the way: **the command register is single-slot** —
  two `pv-command` sends within PVMON's 40 ms poll overwrote each other (CMD_CURSOR 1 followed by
  CMD_ACTIVATE lost the cursor command). `sendCommand`/`sendCommandString` now queue and send the
  next command only once the guest has cleared the register (`vga.pv_cmd === 0`), with a 2 s
  timeout so a hung guest cannot wedge the host; consecutive scroll steps merge.
- **Rotation / safe areas.** `viewport()` is now the visual viewport minus `env(safe-area-inset-*)`
  (read from CSS tokens on :root); the compositor translates by the insets and paints them black,
  `hostPoint` subtracts them. On an orientation change the layer positions and zooms are reset (the
  default placement rule applies to the new width), the shell height is re-sent in both orientations
  (landscape 375x812 -> 480 rows at 0.78), and `orient <o> WxH safe={...}` is logged. Pane: 812x375
  re-arranged the shell (PVS 352x404) and re-placed Solitaire/DOS box/Notepad for the width.
- **Instant first paint.** `saveFrame` stores `#pres` as a PNG data URL in IndexedDB (`lastframe`;
  Safari rejects Blobs) on hide/pagehide and every 20 s while visible and changed; `loadFrame`
  reads it before the emulator exists and `presentOnce` draws it until the restored guest reports
  `PVA` (30 s cap; never over a cold boot). `report("firstframe", "shown ...")` marks the moment.
  Pane: the record is written (750x1624, 58 KB) and loaded on the next visit (`pvState().firstFrame`);
  the pre-PVA paint itself could not be caught because the hidden pane has no rAF and the local
  restore completes in ~3 s — phone item (the page should open on the last desktop, not black).
- **PWA.** `web/manifest.webmanifest` (standalone/fullscreen, portrait, start_url `/`),
  `apple-mobile-web-app-*` meta, icons `web/icon-192.png`/`icon-512.png` (originally hand-drawn by
  `tools/mkicon.mjs`; since 2026-09-02 the guest's own flag icon, see below). The service worker is registered only over https and not
  on localhost, with scope `/` (the dev server sends `Service-Worker-Allowed: /` for `/web/sw.js`;
  the https deploy must too, or serve sw.js from the root — the registration falls back to the
  default scope otherwise). `sw.js`: network-first, per-asset precache that tolerates 404s, never
  touches `*.img`, `*.state.gz`, `current.json`, `/__*` or cross-origin (Ghostscript CDN), and caches
  the page once under `/web/index.html` for every clean path. LAN http is unaffected (no secure
  context, registration rejects quietly). The dev server also serves `/` as the page.
- **Watchdog (Fix 4).** `PVH` heartbeat lines are tracked when PVMON sends them (none yet); the
  page records the last input (`noteInput` ring, 20 entries) and the last composite change (a
  sampled signature of the guest canvas every 8th frame). Visible page + heartbeat silent 5 s, or
  input with no change for 5 s -> one `WATCHDOG {json}` line to `/__log` (why, mips, CPU regs,
  eip/cs/ds/ss, flags with IF/VM, in_hlt, cr0, `pv_idle_stat(0/1)`, last 50 protocol lines, last 20
  inputs, keyboard trace, layers, viewport, safe insets) plus a PNG to `/__shot`; one bundle per
  minute. `window.pvWatchdog()` forces one (pane: eax=1689 in_hlt=1 IF=true, i.e. the idle hook).
- **Owned/transient masking (Fix 2, host side).** `drawWindow` clips the rects of PVO/PVT children
  that overlap the owner's client in VRAM out of the client blit and fills each with a one-pixel
  strip of the owner's own client bordering the rect, so a fallback placement never shows two copies
  and there is no see-through ring where the child's layer is smaller than the hole. Pane: Notepad
  File > Open — the dialog layer is the only copy, Notepad's client around it is its own white.
- Test harness notes: the pane is hidden, so `document.hidden` is true (the watchdog and the
  periodic frame save skip; `pvWatchdog()` / `pvSaveFrame()` force them) and a synthetic tap must
  dispatch touchstart and touchend in the same JS call (a tool round-trip between them is >500 ms
  and becomes a long press).
- Follow-up (same day): with the page booted at `/solitaire`, the tour attributed Solitaire's rect to
  Notepad — PVMON publishes the layout only on change, so a tracker registered late had an empty
  `before` set and took the first PVW it saw. Now: the tour asks for a republish first, closes every
  pre-existing non-shell layer (recorded as `preexisting=` / `cleaned=` in TOUR-BEGIN), and matches
  the launched program's window by a title pattern per app (`match=title`), falling back to the
  newly occupied slot (`match=slot`).
### 2026-09-02 — geometry invariant (PVHOOK), owned dialogs off the owner, hook-side publish, icon row
Phone round bugs 1-7 plus the DOS-box close lockup, all guest-side (PVMON v22, PVHOOK.DLL; PLAN.md
Fix 1, 2 and 4). One rule now, enforced in the hook DLL at every path a window's rectangle changes:
*no top-level window is larger than the phone frame (ShellWidth x the runtime shell height), every
window lives in its column, fixed-layout programs are never resized, only kept in their column.*

- **Root causes found.** (1) Program Manager's minimised icon vanished because `CMD_SHELLSIZE`
  (Safari's bars come and go, so it arrives at any time) ran `arrange_shell` on the *iconic* shell:
  `SetWindowPos` on a minimised window sizes the icon window, so the icon became a 352x664 iconic
  window with the icon drawn in its middle (reproduced in the pane). Now: an iconic shell is left
  alone and arranged on restore. (2) Task List / Sound Recorder were mangled by `DefaultSize`
  (352x600) applied to dialog-template main windows and by the shell-column dialog reflow catching
  *unowned* dialogs. (3) Maximise went to 2560x970 because nothing gave USER a maximised size; PVMON
  only restored it afterwards. (4) Owned dialogs were captured twice because they overlap the owner
  in VRAM. (5) Exit Windows was invisible because it is an *unowned, system-modal* box Windows
  centres on the 2560-column screen (x≈1100), and while a system-modal window is up PVMON's timer
  never runs (heartbeat stopped), so PVMON can neither move nor report it; the same mechanism is the
  DOS-box close lockup (WinOldAp's "Application still active", task lock held). (6) Notepad's
  vertical scroll bar: Notepad's *main window* has WS_VSCROLL/WS_HSCROLL, so the bar is non-client
  area between the client and the right border; the reported rects are right (window 352, client
  313 wide), the host draws the right border as wide as the left one (4 px) and cuts the 35-px bar.
  Host change needed: `inset.r = (wx+ww) - (gx+gw)` and blit the right strip that wide.
- **PVHOOK.DLL** (guest/pvhook): WH_CBT + WH_CALLWNDPROC. `HCBT_CREATEWND`: application windows
  born at x=640 sized to `Size.<MOD>` / `DefaultSize` and clamped to ShellWidth x frame (frame =
  runtime shell height from `PvHookSetShell`, `MaxHeight.<MOD>` if lower); fixed-layout windows
  (class `#32770` main windows, `[PVMon] KeepSize` modules) keep their size. Owned windows are
  placed *below* the owner when the column has room, else right of it inside the 640 column, else
  centred; unowned `#32770`s of a task with a main window (WinOldAp's box) count as owned by it,
  unowned `#32770`s of the shell's task (Exit Windows) are centred in the shell column.
  `WM_GETMINMAXINFO`: maximised size/position = the frame at the top of the window's column (shell:
  its column less ICON_ROW), so a zoomed window is real and the box toggles back (verified: Notepad
  352x762 zoomed, restore 352x600). Fixed-layout windows keep their normal size on maximise; USER
  sends this message dozens of times per window (also from CreateWindow with a degenerate rect:
  Minesweeper came out 170x47 until degenerate rects were ignored). `WM_WINDOWPOSCHANGING` clamps
  are in the code but USER 3.1 does not route that message through the hook (verified: never
  fired), so programs that size themselves after creation (PIF Editor 592, Packager 516) are
  clamped at `HCBT_ACTIVATE` in their own task, with PVMON's `park()` as the last resort. Pointers
  to stack data in a `-zu` DLL must be FAR (the old hook's `in_list` compared garbage: 15 W112s).
- **Hook-side publish.** On `HCBT_ACTIVATE` / `HCBT_SETFOCUS` / `HCBT_DESTROYWND` of a `#32770`
  the hook emits the whole `PVB..PVE` list itself (slots read off the columns), so system-modal
  boxes are composited and tappable while PVMON is starved. Verified: Alt+F4 on Program Manager ->
  `PVO -1 0 306 370 150 ... Exit Windows` in the shell column (370 wide: 18 px clipped at the
  right, both buttons visible); DOS box `CMD_CLOSE` -> `PVO 0 640 360 346 180 ... MS-DOS Prompt`
  below the DOS window, Enter ends it, `PVB` resumes.
- **PVMON v22**: `PVH <GetTickCount>` heartbeat every ~25 polls and after every host command
  (1.37 s apart in the pane); zoomed windows left zoomed when inside the frame; unowned dialogs
  adopt their task's main window as owner; only owner chains ending at Program Manager are
  reflowed; `PVQ wide <MOD> "<title>" WxH` once per dialog wider than the column; icons placed in
  `SM_CXICONSPACING` cells (3 per row, second row above) through `SetWindowPlacement` so labels stay
  inside the column and follow the icon (verified 4 icons incl. the shell's).
- **Image**: `PROGMAN.INI [Settings] Window=0 0 352 684 1` (the fifth field 0 *hides* Program
  Manager: found the hard way), `[Windows Help] M_/H_WindowPosition` pre-written to the slot rect so
  WinHelp's restore is a no-op (the tearing Josh saw was its multi-step restore),
  `WINFILE.INI Window=0,0,352,600`. `CALENDAR.EXE` is not in the image (WinExec -> 2); WINCHAT shows
  no window without NetDDE peers.

Size table (pane, shell 352x762; phone shell height is lower and the frame follows it):

| Module | Rule | Result |
|---|---|---|
| PROGMAN | shell column, arranged by PVMON | 352 x shellH-76 |
| NOTEPAD WRITE CARDFILE WINFILE CONTROL CLIPBRD RECORDER MPLAYER WINHELP TERMINAL SYSEDIT | DefaultSize | 352x600 |
| PBRUSH | Size 352x480, MaxHeight 480 | 352x480 |
| CLOCK | Size 352x352 | 352x352 |
| WINOA386 (DOS box) | Size 352x360 | 352x360 |
| CALC | KeepSize | 293x349 |
| WINMINE | KeepSize | 170x277 |
| SOUNDREC | KeepSize | 407x241 (host scales 0.86) |
| TASKMAN | dialog class | 370x264 (0.95) |
| PACKAGER | KeepSize (re-sizes itself) | 516x600 (0.68) |
| MSHEARTS | KeepSize | 540x480 (0.65) |
| PIFEDIT | KeepSize (fixed dialog frame) | 592x600 (0.59) |
| SOL | KeepSize | 593x471 (0.59) |
| CHARMAP | KeepSize (dialog) | 640x278 (0.55) |
| PRINTMAN (spooler off) | USER message box | 640x188 (0.55) |
| WINVER | KeepSize | message box |

Dialogs wider than 352 at the 20 px system font (host scales, `PVQ`): COMMDLG Open/Save 604x318
(Notepad, Write), Hearts welcome 531x252, Paintbrush save prompt 429x208 (phone), Exit Windows
370x150 (shell column, unowned: not reflowed). Fits: Terminal Default Serial Port 249x170.

Open / host side: (a) right-hand non-client inset (Notepad scroll bar); (b) transient `T` layers
are anchored through the `W` in their column, so a combo drop-down of a dialog placed *below* its
owner lands relative to the owner window, not the dialog: anchor a `T` to the `O` layer whose guest
rect contains its origin; (c) `PVO -1` owned by a `PVX` (no free slot: `MAX_SLOTS` is 3 and iconic
windows keep their slot) is not drawn; (d) the 4-icons-across Program Manager group on the phone
did not reproduce in the pane (3 per row at IconSpacing 100, group maximised by `arrange_shell`).

### 2026-09-02 — host fixes from the parked phone (remote loop)
- Remote loop is in use: Josh's iPhone parked on `/solitaire?remote=phone&diag=1`; `node tools/remote.mjs phone tour|eval|shot|reload`. First device tour: 23 apps, 205 s, failures were all geometry (fixed by the guest pass) + the DOS-box close box.
- Keyboard up shrank everything: the visual viewport (684→383) was read as landscape → `vh/480` scale. `fullViewport()` freezes on the layout viewport whenever `visualViewport.height < innerHeight-100` at scale 1 (geometric; a focus-based test let the shell re-arrange to 404 rows during the dismiss animation).
- Keybar: keys fire on tap release (touchstart passive) so the bar pans; `keyboardShift()` subtracts the bar height; a stale focused `#kbd` (keyboard dismissed by its own key) is blurred on touchstart so the next tap's focus is fresh.
- Owned dialogs: the strip-fill mask smeared vertical streaks over the owner (Sound Recorder + Open). Removed. An O layer that still overlaps its owner in guest space is drawn coincident with its copy (transient-style, owner's client scale/position); one placed clear of the owner by the hook goes below the owner on the host too when there is room.
- Image `work-phone-20260902-133432` (PVMON v22, PVHOOK invariant) + snapshot; Sound Recorder 407x241 with Open below it composites as one image; Program Manager 3 icons across.
- Follow-up 2 (same day, after the merge with PVMON v22): Print Manager with the spooler off puts up
  a 924-wide "Print Manager has been turned off" message box as its only window; it is off the phone,
  so no tap reaches it, and every later launch timed out behind it. The tour now dismisses anything
  that is not the shell before each launch and after each close — front-most first: Enter (a
  message box's default button), Esc, CMD_CLOSE (N to a save prompt), Alt+F4, each followed by a
  wait for a layout without it — and records it in the row (`stray=W0:Print_Manager/enter`). A
  launch that times out while something else is on the desktop is reported as
  `launch=fail:blocked-by=<layers>` and the desktop is cleared before the next app, so one stuck box
  costs one row, not the rest of the run. `close` also checks that no window with the program's
  title is still published anywhere (`fail:still-published`).

### 2026-09-02 — keyboard bar: density, Chrome-iOS autofill row, pan above the bar
- Phone (Chrome iOS) showed three stacked rows: our bar (~56 px), Chrome's autofill accessory
  (~70 px), the keyboard; ~380 px of guest left. Bar is now 34 px keys, 2 px gaps, 2 px vertical
  padding + safe-area inset (39 px total, measured `bar=0,773 375x39` in the pane), flex row with
  Esc Tab ←↑↓→ Ctrl Alt Del first, F-keys and Home/End/PgUp/PgDn/Ins behind the horizontal scroll,
  the hide key sticky at the right.
- The browser's own row cannot be drawn over; whether it appears depends on what kind of element
  has the focus, which only the device can tell. The element kind is selectable with `?kbd=` and
  logged (`kbd mode=… tag=… ua=…`): `ce` (contenteditable div, **default** — the candidate most
  likely to be treated as "not a form field" by Chrome's autofill), `input` (text, autocomplete=off,
  the old one), `otc` (autocomplete=one-time-code, hides password suggestions in Chrome), `search`,
  `url` (with inputmode=text), `none` (inputmode=none: no soft keyboard at all). All are name-less.
  The typed-character path reads `.value` or `.textContent` (`kbdRead`/`kbdClear`), ignores
  `isComposing` input events and flushes on `compositionend`; Enter in the contenteditable arrives
  as a newline and is sent as one. Pane: `ab`, `x⏎` -> `a b x \n`. **Phone item:** try
  `?kbd=ce`, `otc`, `search`, `input` in Chrome iOS and Safari and note which show the autofill row;
  the winner becomes the default.
- `keyboardShift()` now pans the focused window's bottom edge to 4 px above *our* bar's real top
  (`getBoundingClientRect`), which sits at the bottom of the visual viewport, i.e. on top of the
  browser's row. `updateKeybar` logs `keybar bar=x,y WxH vv=offset+height/innerHeight scale shift
  guestRoom=<px above the bar> mode=` whenever the geometry changes, for the parked phone.
### 2026-09-02 — PWA icons are the guest's own Windows flag
- The hand-drawn pixel-art flag (`tools/mkicon.mjs`, removed) is replaced by the genuine 32x32
  16-colour Windows logo icon from the disk image: `C:\WINDOWS\PROGMAN.EXE` RT_ICON **18** (the
  16-colour member of RT_GROUP_ICON 31944, first entry — the "Microsoft Windows" flag in Program
  Manager's icon browser). `USER.EXE` RT_ICON 3 (group 32647) and `WINVER.EXE` RT_ICON 2 are
  byte-identical copies. `SHELL.DLL` RT_BITMAP 130 is the opaque 64x64 About-box logo (not used).
- `tools/ne-icons.py`: lists NE resources; extracts RT_ICON (DIB fragment + AND mask → RGBA PNG)
  and RT_BITMAP (incl. BI_RLE4/RLE8); `icon` writes one id with `--scale N` (nearest-neighbour
  integer), `--pad W H`, `--bg RRGGBB`. PNGs are written by hand (zlib), no Pillow needed.
- Outputs, all integer scales so the pixels stay crisp: `web/icon-192.png` (x6, transparent),
  `web/icon-512.png` (x16, transparent), `web/icon-512-maskable.png` (x12 centred on desktop grey
  `#C0C0C0`, inside the 80 % safe zone), `web/apple-touch-icon.png` 180x180 (x5 + 10 px pad on
  `#C0C0C0`; iOS ignores alpha), `web/favicon.png` 32x32 (the icon as-is). `index.html` links
  the touch icon and both favicons; the manifest's maskable entry points at the grey variant;
  `sw.js` precache bumped to v5 with the new files.
- Reproduce: `mcopy -i image/wfw311-base.img@@16384 ::/WINDOWS/PROGMAN.EXE .` then
  `python3 tools/ne-icons.py icon PROGMAN.EXE 18 web/icon-512.png --scale 16`.
### 2026-09-02 — message boxes wrapped natively, File Manager directory window maximised
- **Print Manager with spooler off** shows only a MessageBox (924 wide on the phone, 629 in the
  pane): it escaped the clamp because message boxes are fixed-layout dialogs. The hook now re-lays
  USER's message boxes at `HCBT_ACTIVATE` (before they paint): the text Static is narrowed to the
  column and its wrapped height measured with `DrawText(DT_CALCRECT|DT_WORDBREAK)`, the buttons
  move down by the growth and are re-centred, the box becomes ShellWidth wide and taller
  (`pvhook: message box 629x208 -> 352x225 (text +17)`). Applies to every MessageBox (module USER),
  e.g. Paintbrush's save prompt; programs' own dialogs are untouched. Spooler stays off.
- **WINFILE.INI**: format read back from a file the guest saved after maximising its directory
  window: `Window=x,y,w,h, , ,showcmd` and `dir1=x,y,w,h,split,-1,showcmd,0,view,sort,attr,path`;
  the image now writes `dir1=0,0,344,400,-1,-1,3,...,C:\*.*` (3 = SW_MAXIMIZE), so File Manager
  opens with the tree and list filling its 352-wide client ("File Manager - [C:\*.*]").
- File Manager's seven menus wrap to two rows at the 20 px system font: menus use the system font
  in 3.1 and there is no per-menu font, so the only native lever is a narrower system font (which
  would shrink every caption too). Left as is.
- `node tools/tour.mjs --apps PRINTMAN,WINFILE`: pass=12 fail=0 (PRINTMAN rect 640,0,352,225).

### 2026-09-02 — oversized popups and dialogs pan
- Win3.1 never scrolls a popup menu, a drop-down or the switcher, and a dialog cannot scroll either;
  on a phone whatever does not fit was simply clipped. A `T` layer, an owned dialog, or a dialog
  drawn coincident with its owner that is wider or taller than the viewport is now panned by one
  finger anywhere on it (`pressStart` -> `chromeDrag.pan`), clamped so the clipped edge can be
  brought exactly into view and no further; an axis that fits does not move; a finger that does not
  travel is still a click at the pixel under it (`chromeDrag.guest`). Coincident dialogs pan their
  *owner* layer (bounded by the dialog's edges) so the dialog and its copy in the owner's capture
  stay one image. Initial placement: anchored where it popped up, shifted up/left so the whole
  popup fits when it can; when it cannot, it starts at its top/left edge. Trace: `pan start …`.
- Geometry note: at chrome scale `c <= min(vw/352, vh/480)` a menu up to 480 guest rows always
  fits, so the case that occurs on the phone is the wide coincident dialog (Notepad's Open box,
  604 guest px -> 643 host px on a 375 px phone) and combo drop-downs longer than the column.
  Pane (375x812): Open box x 1 -> -268 (= 375-643, exact clamp) and back to 0, owner moved with it,
  tap on it clicked. File Manager's View menu at 375x400 shifts up to y=43 so its 357 px fit.

### 2026-09-02 — one-finger scroll on Program Manager and MDI programs
- Program Manager's client area (the group windows: a desktop hit inside the `S` layer's client
  rect, not the icon row or the bare desktop) is now a scroll surface: a vertical/horizontal
  one-finger drag sends `CMD_SCROLL` with the slot field **15 (0xF) = the shell**; PVMON routes it
  to the active MDI group (guest agent's change; the encoding is `SHELL_SCROLL_SLOT` in app.js and
  must match pvmon.c when it lands — the PVMON on the current image ignores slot 15, harmlessly).
  A tap is still a click, a double-tap still opens, the icon row and desktop still pointer-drag.
- W layers in the scroll policy (File Manager, Write, …) scroll from anywhere on their client even
  when the scroll bar belongs to an MDI child; the guest targets the focused/child window. Two-finger
  scroll unchanged.
- Pane: File Manager client drag -> `CMD_SCROLL slot=0 dir=2`; with File Manager closed, a drag on
  Program Manager's client (guest 282,582) -> `scroll start slot=15 Program Manager`,
  `slot=15 dir=2 lines=2`, no button events; a tap at the same spot -> `button down/up`, no scroll;
  a drag on the icon row -> ordinary pointer drag.

### 2026-09-02 — hold to drag on scroll surfaces; boot watchdog
- On every one-finger-scroll surface (Program Manager's groups, File Manager, Write, Notepad, …) a
  plain drag scrolls; a finger held still for `HOLD_MS` = 350 ms and then moved is a guest
  left-button drag from the hold point (button down, follow, up on release: moving a group window
  by its MDI caption, an icon, a selection). A hold released without moving (>= 500 ms) is the right
  button; a short tap is a click. On scroll surfaces the right-click timer no longer fires during
  the hold, so the decision is made on movement/release. Trace: `hold-drag start slot=… after …ms`.
  Two-finger scroll also targets the shell (slot 15) when the midpoint is inside Program Manager's
  client. Pane: plain drag -> `CMD_SCROLL slot 0`; hold 1 s + move -> `hold-drag start`, button
  down, `drag released at …`, no scroll commands; hold 1 s + release -> `button down/up right`;
  two fingers on PM's groups -> `slot 15 dir 2`, on the icon row -> nothing.
- Boot watchdog: every boot step is recorded (`boot.steps`), the boot sequence runs in try/catch and
  `unhandledrejection`/`error` are collected. 15 s after load with the emulator not running, or
  40 s after a snapshot restore without `PVA`, a `BOOTFAIL {json}` bundle goes to `/__log` (status
  text, path local/shipped/cold with byte sizes, restored/desktopReady, errors, steps, protocol
  tail, viewport, hidden, UA), the local snapshot and the first frame are wiped and the page
  restarts with `bootretry=1` (which skips the local snapshot; a second failure only reports).
  `?bootfailtest=1` simulates a throw before `run()`: pane -> `boot failed: …`, `BOOTFAIL {"why":
  "emulator not running 15 s after load", "running":false,"ic":0,"path":"shipped",…}`, reload with
  `bootretry=1`, `status=restored running=true`. A local snapshot is never saved before
  `desktopReady` (`state not saved: desktop not ready`, seen on the failed page's pagehide) or
  within 30 s of a WATCHDOG bundle while the screen has not changed since.
- Follow-up 3 (same day): fixed-layout programs (no WS_THICKFRAME — Character Map, Solitaire,
  Hearts, Object Packager, Task List, WINVER, Network Setup) are deliberately never resized by the
  hook, so a frame wider than 352 or a host scale below 1:1 is reported for them as
  `info:fixed:…`, not `fail`. Named by title / app-table `fixed:` until PVW carries the hook's flag.
- Follow-up 4 (same day) — the real cause of the post-PRINTMAN cascade, found with the tour's own
  diagnostics (`chan=cmd=5,str=11,pvh=0`): after Print Manager's "turned off" box (re-parked to slot 1
  by PVMON while slot 0 still held the just-closed Control Panel) the tour's close fallback sent
  CMD_ACTIVATE for slot 0 and then Alt+F4; PVMON stopped polling entirely — no PVH heartbeat, no
  publish, CMD_RUN left unread in the register — until Ctrl+Esc opened Task List, when it resumed.
  Consistent with PVMON blocked in an inter-task SendMessage (SetActiveWindow/BringWindowToTop on a
  window whose task is exiting). Tour side: no CMD_ACTIVATE before Alt+F4 any more; before each
  launch the tour waits for a heartbeat, nudges a silent PVMON with Ctrl+Esc/Esc, and marks the app
  `launch=skip:pvmon-stalled` (`stall=pvmon:no-heartbeat,…` in the row) if it stays silent, so a
  stalled guest costs seconds, not 15 s per remaining app. Timed-out rows are now posted to the log
  too (they were only in the table before). Guest side (PVMON owner): CMD_ACTIVATE/CMD_CLOSE on a
  slot whose window belongs to an exiting task should not block the poll — Print Manager with the
  spooler off is the reproduction (`node tools/tour.mjs --apps CONTROL,PRINTMAN,CLIPBRD --log`).
- `--skip A,B` (headless) / `?skip=A,B` (page) leave apps out; with `--skip PRINTMAN` the other 22
  complete headless and in the pane (Print Manager with the spooler off still stalls PVMON; see
  follow-up 4 — a guest fix, after which the skip goes away).
### 2026-09-02 — non-resizable windows keep their size; touch scroll routed to MDI children (PVMON v23)
- **Invariant refined.** Clamping only helps a window that reflows. A top-level window *without*
  `WS_THICKFRAME` (dialog frames, fixed-layout programs such as Windows Setup's "Network Setup",
  whose text and driver list were simply cut off at 352) is now fixed-layout by definition, in the
  hook (`learn()`, from `CREATESTRUCT.style` at birth) and in PVMON (`fixed_layout`,
  `apply_initial_size`): never shrunk, only kept in its column; the host scales it. Windows with
  `WS_THICKFRAME` reflow and are clamped as before; `KeepSize` stays as the override for
  resizable-but-fixed programs (Sound Recorder, the games...); message boxes are still re-laid.
  Verified: Windows Setup (`WINSETUP.EXE`; `SETUP.EXE` is the DOS setup and runs in a DOS box)
  main window `PVW 0 1031 265 497 173`, Options -> Change Network Settings ->
  `PVO 0 640 438 708 378 Network Setup` at its natural width (`PVQ wide WFWSETUP "Network Setup"
  708x378`). **Tour expectation:** `fit=fail` is acceptable for a window without `WS_THICKFRAME`
  (and for `KeepSize` modules); the invariant for those is "inside its column", not "352 wide".
- **CMD_SCROLL** (7) `arg = slot | dir << 8 | lines << 12`; **slot 15 = the shell** (Program
  Manager). The scroll target is found in order: the focused control if it is inside the window
  and has a scroll bar of the wanted direction; the active MDI child (`WM_MDIGETACTIVE` on the
  window's `MDIClient`: a Program Manager group, a File Manager directory window), or its first
  visible child with such a bar, or the focused control inside it; the window's first child with a
  bar; the window itself. Plain `WM_VSCROLL`/`WM_HSCROLL` `SB_LINEUP/LINEDOWN` x lines, then
  `SB_ENDSCROLL`. Verified: with the Main group restored (2 rows visible of 3),
  `[7, 15 | 2<<8 | 3<<12]` scrolled the group to its last rows and `1<<8` scrolled it back.

### 2026-09-02 — single-tap opens, keyboard report widened, DISPI guard, dead-task guard (PVMON v24)
- **TapOpens** (`[PVMon] TapOpens=1`, default on): PVHOOK's WH_MOUSE hook converts a left click
  that ends in the *client* area of a Program Manager group window (`PMGroup`) into a posted
  `WM_LBUTTONDBLCLK` at the same point, and a click on a minimised group's icon (iconic `PMGroup`,
  hit-tested HTCAPTION) into `WM_NCLBUTTONDBLCLK`; captions, scroll bars and frames are untouched.
  Verified: one click on "File Manager" launches it (`PVW ... File Manager`), a click on empty
  group space does nothing, a caption click only activates.
- **PVK** (HCBT_SETFOCUS) now also reports 1 when the focused window is not a known non-text
  control (Button, Static, ScrollBar, ListBox, ComboLBox, `#`-classes, MDIClient, PMGroup, Progman)
  and its top-level window's module is in `[PVMon] KeyboardApps` (now `WINOA386 TERMINAL WRITE
  CARDFILE CALENDAR RECORDER NOTEPAD`). Verified: Write's document takes focus -> `PVK 1`; a
  menu-bar click and Esc produce no report (focus unchanged). Paintbrush's text tool is left to
  the host's long-press toggle (no hookable caret creation).
- **DISPI index/data pairs** (PVMOUSE.DRV's interrupt handler writes the same index register):
  the first attempt (v24) wrapped PVMON's `rd`/`wr` and the hook's `pv_dbg` in `pushf/cli ... popf`
  and **hung the whole system VM** on the first mouse click on Write's menu bar (heartbeat stopped,
  no input; bisected: v22/v23 fine, v24 dead, hook version irrelevant) — ring-3 cli is trapped and
  virtualised by the VMM and a ring-3 popf does not give the interrupt flag back the same way. v25
  drops cli and checks instead: after each pair the index register is read back and the access is
  repeated if the handler changed it (a clobbered write lands once in a cursor register the host
  rewrites on the next move). PVDISP.DRV's BANK.INC and CURSOR.ASM use the DDK's `EnterCrit`;
  PVDPI runs under DOS before any mouse handler exists.
- **Dead-task guard**: Print Manager (spooler off) exits the moment its box is dismissed, and a
  cross-task SendMessage from PVMON's poll to a window of an exiting task (GetWindowText,
  SetWindowPos) blocked PVMON until Ctrl+Esc. The hook records `HCBT_DESTROYWND` of top-level
  windows (`PvHookIsDead`), PVMON skips those windows and frees their slot; hidden top-level
  windows free their slot too (a closed program's window lingers hidden while its task exits, so a
  new program landed in slot 1). Verified: PRINTMAN box, Esc -> heartbeat continues
  (`PVH 86397 ... 110179`), Control Panel launched next gets slot 0.
- Fixed-layout windows are moved into a column at `HCBT_ACTIVATE` when they straddle one
  (Task List centres itself at x=1095); PVMON then parks them. Terminal: after "Default Serial
  Port" closes the focus returns to the `Terminal` window, which the widened rule now reports.
- The "Write menu click kills all input" seen while testing was the v24 cli hang above
  (heartbeat had stopped too); gone in v25 (cursor moves, `PVH` advances after the same sequence).
- `WM_WINDOWPOSCHANGING` does reach the hook for some windows after all (`pvhook: clamp
  CtlPanelClass 471x283 -> 352x283`); the activate-time clamp stays as the backstop.

### 2026-09-02 — icons: user drags respected, label room; MDI icons re-arranged (PVMON v26)
- Minimised icons are placed once, when first seen minimised (or when they have left the column);
  an icon whose position differs from the one PVMON set was dragged by the user and stays where it
  was dropped (per-hwnd record). Previously every poll snapped it back to its cell, so a dragged
  Program Manager icon "vanished".
- `ICON_ROW` 76 -> 88 (PVMON, hook, PROGMAN.INI pre-write): 36 px icon + two 20 px label lines fit
  inside the column (pane: shell 762 -> Program Manager 674 tall, icon at y=678, label to ~758).
- `arrange_shell` re-sends `WM_MDIICONARRANGE` on a later poll as well, so minimised groups line up
  along the bottom of the MDI client as it is after the resize; the active group is maximised there
  (`WM_MDIMAXIMIZE`) on every arrange, including `CMD_SHELLSIZE`.
- Task List is still first reported at its self-centred x=1095 (the hook's publish runs before its
  column placement lands); PVMON parks it in a slot on the next poll. Tour: `slot` for TASKMAN reads
  the first report and fails; harmless.

### 2026-09-02 — image work-phone-20260902-145131 (PVMON v26, PVHOOK non-resizable rule)
- Merged: guest batch (CMD_SCROLL slot 15 = shell → active MDI child; WS_THICKFRAME-less windows never shrunk; TapOpens=1 single-tap opens Program Manager items; PVK widened via KeyboardApps=WINOA386 TERMINAL WRITE CARDFILE CALENDAR RECORDER NOTEPAD; DISPI index read-back-and-retry instead of cli — the cli/popf guard hung the system VM on the first click; dead-task guard frees slots and skips destroyed windows (Print Manager cascade); user-dragged icons stay put, ICON_ROW 88, MDI icons re-arranged, active group maximised), host (hold-to-drag on scroll surfaces, two-finger shell scroll, boot watchdog + BOOTFAIL bundle + automatic retry, keybar folded behind a `#keybartab`, contenteditable `#kbd` with single-source Enter/Backspace in beforeinput, no speculative focus (late focus on PVK 1 within 1 s), title-rule focus only for client taps outside the scrollbar strip, iconic shell not a scroll surface, real Windows flag icon, manifest start_url points at the parked dev instance), tour (stray dismissal, fixed-layout info, PVMON-stall detection, `--skip`).
- Open on the phone: Chrome/Safari autofill row cannot be suppressed (all `?kbd=` kinds show it; standalone home-screen mode is the way out); microphone needs https; graphical printing (PSCRIPT) under investigation by an agent.

### 2026-09-02 — graphical printing: PSCRIPT.DRV is the PDF Printer (agent, verified)
- **The PSCRIPT "spin at CreateDC" does not reproduce** on an image built by the current
  `build-image.sh` with `printer=PSCRIPT` (spooler on or off): cold-booted headless (`tools/print-test.mjs`)
  and in the pane (cold boot, snapshot made with `?mkstate=1`), Notepad, Write (COMMDLG Print dialog +
  Enter), Paintbrush (own Print dialog) and Cardfile all create the DC, spool to `C:\PRINT.PRN`, and
  PVMON ships the job (`PVP-BEGIN 11676 … PVP-END`; heartbeats keep coming, idle samples sit in the
  INT 2F 1689 halt). The earlier spin was observed before the two guest hangs fixed the same day (idle
  hook halting with IF clear; PVHOOK.DLL without `-bd`) and with a boot snapshot from a different
  WIN.INI; nothing PSCRIPT-specific was left to fix. No extra files were needed: PSCRIPT.DRV (expanded
  3.11 media Disk06) + HPIII522.WPD in `image/changes/system/` suffice; PSCRIPT.HLP, TESTPS.TXT and
  FINSTALL.DLL (Disk07) are only for the driver's setup/font-installer dialogs.
- **Host side had the real bug:** `@jspawn/ghostscript-wasm@0.0.2` is an Emscripten MODULARIZE build
  with `noInitialRun` and no `postRun` hook, so `psToPdf` (which passed `arguments`/`postRun`) waited
  forever — the job was received (`print job 11673 bytes, PostScript`) and nothing else happened.
  Now: `createModule({locateFile, print, printErr})`, `FS.writeFile`, synchronous `callMain([...])`
  (returns the exit status), `FS.readFile("/out.pdf")`; a fresh instance per job (the 16 MB wasm is
  browser-cached after the first). In the pane: 11.7 KB Notepad job → 5413-byte PDF in ~300 ms.
- Both printers stay installed, one port: `[devices] PDF Printer=PSCRIPT,C:\PRINT.PRN` and
  `Text Printer=TTY,C:\PRINT.PRN` (+ matching `[PrinterPorts]`); `printer=PSCRIPT|TTY` (build option)
  only picks `[windows] device=`. Default is PSCRIPT. The host still tells the two apart by content
  (`%!`/`^D%!` → Ghostscript, else the hand-made Courier PDF). PVMON's transport is base64 lines, so
  binary jobs are safe too (a Paintbrush job is 107 KB of ASCII-hex image data anyway).
- Diagnostics: `finishPrintJob` publishes `window.pvLastPrint = {name, type, bytes}` and reports
  `print <name> <bytes> bytes`; with `?diag=1` it also POSTs the PDF to the dev server's new
  `/__print` (→ `shots/print-<ms>.pdf`), since the pane's sandbox swallows downloads.
  `tools/print-test.mjs [--image] [--apps PBRUSH,WRITE,CARDFILE,NOTEPAD]` cold-boots headless, prints
  from each app (Paintbrush: four brush drags through the absolute pointer), converts each job with
  the local `gs` and renders page 1 to PNG under `shots/print-test/`.
- Evidence (this run, `work-phone` rebuilt with `printer=PSCRIPT spooler=no`): Paintbrush 106732-byte
  job → 8.5 KB PDF, the four strokes render as an asterisk; Write README.WRI → 157 KB, 8 pages, 92 KB
  PDF with proportional (Arial→Helvetica-substituted) text and the rule; Cardfile → 11.8 KB, the card
  frame and text; pane Notepad → `shots/print-1788375391890.pdf`. PNGs in `shots/print-*.png`.
- Image rebuild needed (main): `image/build-image.sh display=pvdisp dpi=120 sysfont=PVSYS.FON
  mouse=PVMOUSE.DRV sound=1 load=PVMON.EXE live=1 shellw=352 shellh=760 spooler=no printer=PSCRIPT
  out=work-phone.img` then a new boot snapshot (`?mkstate=1`). Only WIN.INI keys changed
  (`[windows] device`, `[devices]`, `[PrinterPorts]`); no new files in `image/changes/`.
