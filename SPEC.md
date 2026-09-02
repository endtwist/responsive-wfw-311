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
