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
