# Responsive Windows for Workgroups 3.11 in the Browser

## Objective

Run Windows for Workgroups 3.11 in a browser via the v86 emulator, with the OS itself responding to viewport changes. When the browser window or device crosses a size breakpoint (phone, tablet, desktop), the emulated display adapter signals Windows, and a custom display driver re-modes the OS to the new resolution without a reboot. The project delivers a paravirtual display device in v86, a 16-bit Windows display driver for that device, and a resize path connecting the two.

## Why

Every existing retro-Windows-in-browser project treats the emulator canvas as a fixed-size window: the OS runs at one resolution and the host scales or letterboxes it. That works, but on a phone it means either illegibly small UI or panning around a desktop viewport. Making the OS itself resize is the interesting version of the problem, and it is newly possible because we control both sides of the hardware interface. A 1993 driver author had to target real silicon; here the virtual adapter can be designed to cooperate with the driver. No one has shipped dynamic resolution switching for Windows 3.x. The API for it (ChangeDisplaySettings) did not arrive until Windows 95.

## Target platforms

- Desktop: Chrome, Firefox, Safari, Edge
- iOS: Safari and Chrome (both WebKit under the hood, so one engine to validate)
- Android: Chrome

Mobile is a first-class target, not a fallback. The mobile constraints below are requirements, not polish.

## Architecture

Three components:

1. **Paravirtual display adapter (v86 modification, JavaScript/Rust).** A clean framebuffer device: linear framebuffer at a fixed physical address, an I/O port register block exposing width, height, bits per pixel, a mode-set latch, and an interrupt line the host raises when the viewport crosses a breakpoint. No VGA register emulation, no bank switching.

2. **Display driver (16-bit x86 assembly/C, built with the Windows 3.1 DDK).** Ported from the DDK sample drivers. Fills GDIINFO, implements the required GDI exports, leans on the DIB engine for raster operations. Services the resize interrupt: reprograms the device, updates its own surface state, patches GDI and USER internals (screen metrics, cached screen DC dimensions), and broadcasts a custom resize message.

3. **Companion utility (ring-3 Windows EXE, runs at startup).** Handles app-level window wrangling on resize: repositions and resizes top-level windows via SetWindowPos and EnumWindows, nudges Program Manager and File Manager, repaints the desktop. Keeping this logic out of the driver keeps the driver small and gives access to the full USER API.

## Phases and milestones

**Phase 0: Environment (1-2 weekends).** Reproducible WfW 3.11 install in a locally built v86. DDK, MASM-era toolchain running under DOSBox, debug output piped from the emulated serial port to the host console. Milestone: build and boot the DDK sample VGA driver from source.

**Phase 1: Virtual device (2-4 weekends).** Implement the paravirtual adapter in v86. Milestone: a DOS test program changes modes via the port interface and the browser canvas resizes to match.

**Phase 2: Static driver (4-8 weekends).** Windows driver for the new device at a fixed boot-time resolution. Milestone: WfW 3.11 runs a full work session on the paravirtual adapter, stable. This is the halfway trophy and the longest grind.

**Phase 3: Resize path (open-ended, the research).** Interrupt-driven re-mode with live GDI/USER patching. Milestone: dragging the browser from phone width to desktop width reflows Program Manager without a reboot.

**Phase 4: Mobile and polish.** Breakpoint table, touch input, snapshot-resume, DPI variants if needed.

## Breakpoint behavior

| Class | Trigger (CSS px viewport width) | Emulated resolution | DPI |
|---|---|---|---|
| Phone | under 600 | 640x480 | 120 (large fonts) |
| Tablet | 600-1024 | 800x600 | 96 or 120, TBD in testing |
| Desktop | over 1024 | 1024x768 | 96 |

Resolution changes dynamically via the resize path. DPI is fixed per boot session (mid-session font metric changes are out of scope); the host picks the boot DPI from the initial device class. A phone rotating to landscape triggers a resolution change within the same DPI.

## Mobile requirements

**WebKit (iOS Safari and Chrome).** All iOS browsers use WebKit, so iOS validation is one engine. WASM is supported, but memory is the binding constraint: budget the emulated machine at 32-64 MB RAM (generous for WfW 3.11, which is happy at 16 MB) and keep total WASM linear memory well under WebKit's per-tab limits. Test on a real low-end device, not just the simulator.

**Viewport handling.** Use the visualViewport API, not window.resize, to detect usable screen area. iOS URL bar collapse, keyboard appearance, and rotation all change the visual viewport without a resize event in some cases. Breakpoint evaluation runs on visualViewport resize with a debounce (roughly 300 ms) so a rotation animation fires one re-mode, not twenty.

**Touch input.** Map touch to mouse in the v86 host: tap as click, drag as drag, long-press as right-click, two-finger drag as scroll where the app supports it. An on-screen keyboard toggle is required since Windows 3.11 has no soft keyboard concept. Pointer precision on 1993 UI targets (16 px hit areas rendered small) is why the phone breakpoint uses 640x480 at 120 DPI: fewer, larger targets.

**Lifecycle and persistence.** Mobile browsers evict background tabs aggressively. Auto-snapshot VM state to IndexedDB (or OPFS where available) on visibilitychange, and restore from snapshot on load. Cold boot should never happen on a phone after first run. Snapshot size at 32 MB RAM compresses to a manageable payload; measure and budget in Phase 4.

**Delivery.** First load pulls the disk image and v86 WASM binary. Keep the disk image lean (a trimmed WfW install fits in 15-30 MB compressed) and cache everything with a service worker so second load is offline-capable.

**Interaction with the resize path.** Rotation is the mobile resize trigger. Portrait-to-landscape on a phone re-modes from 640x480 to a wide mode (or swaps dimensions). This is the same interrupt path as desktop window dragging, so mobile gets it for free once Phase 3 lands.

## Risks

1. **GDI may not tolerate live surface dimension changes.** Biggest unknown, sits in Phase 3. If GDI-internal caches cannot all be found and patched, fall back to a "soft restart" design: the driver forces a USER/GDI reinitialization on resize, costing a roughly two-second flicker instead of a seamless re-mode. Decide whether that fallback is acceptable before Phase 3 starts, since it cuts the phase's scope roughly in half.
2. **1992 toolchain rot.** MASM, the DDK build system, and 16-bit linkers need to run under DOSBox on the dev machine. Budget real Phase 0 time for this.
3. **App compatibility tail.** Well-behaved apps and the shell should survive resizes; era software that caches screen dimensions at startup will misbehave or crash. Scope is "the shell and bundled apps work," not "all 1993 software works."
4. **WebKit memory ceilings on older iPhones.** Mitigated by the small VM footprint, but validate early on real hardware rather than discovering it in Phase 4.

## Stretch goal: reflow in bundled apps

Ideally the default Windows apps reflow on resize, not just survive it. Feasibility varies sharply by app, so this is tiered:

1. **Free or near-free.** Program Manager (group windows and icons rearrange via its own Arrange logic, triggered by the companion utility), File Manager (its panes resize natively), Clock, and maximized windows generally. The companion utility drives these with SetWindowPos and existing app menus/messages. This tier ships with Phase 3.
2. **Achievable with per-app handling.** Apps whose main windows use child controls positioned in code, like Calculator and Notepad (Notepad's edit control already fills the client area; Calculator is fixed-size and stays fixed-size, centered). The companion utility carries a small table of per-app policies: fill, center, or restack.
3. **Dialog rescaling.** A shim hooking CreateDialog/DialogBox that rescales dialog templates proportionally to the current DPI-adjusted resolution. This is stretching, not true reflow: controls grow but do not restack. Worth doing for legibility at the phone breakpoint; genuine restacking of fixed templates stays out of scope.

The companion utility is the home for all of this. Nothing in tiers 1-3 requires driver changes, so the stretch goal can proceed independently after Phase 3 lands.

## Out of scope

- UI reflow within third-party applications (Win16 dialogs are fixed templates; nothing restacks). Reflow within the bundled Windows apps is a stretch goal, described below.
- Mid-session DPI changes
- Compatibility guarantees for third-party Win16 software
- Networking beyond what stock v86 provides

## Checkpoint

Phase 2 completion is the decision point for whether Phase 3's research risk is worth continuing or whether a fixed-resolution driver plus host-side canvas scaling is the ship point.
