# Responsive Windows for Workgroups 3.11

Windows for Workgroups 3.11 running in the browser, where **the operating system itself resizes
with the browser window**. Drag the window, or rotate a phone, and Windows changes resolution
underneath and reflows its shell. No reboot, no restart, no letterboxing.

Windows 3.x had no API for this. `ChangeDisplaySettings` arrived with Windows 95. It works here
because we control both sides of the hardware interface: a paravirtual display adapter added to
the [v86](https://github.com/copy/v86) emulator, and a 16-bit display driver written against it.

`SPEC.md` is the working document: the design, every decision, and a dated log of what was tried,
what worked, and what did not. `responsive-wfw311-spec.md` is the original brief.

## Status

| | |
|---|---|
| Boots WfW 3.11 at any viewport-derived mode, 256 colours | working |
| Resize the window, Windows re-modes and the shell reflows, live | working |
| Phone portrait, landscape, and rotation | working |
| Touch, pixel-exact absolute pointing | working |
| Snapshot and restore (2.0 MB, instant) | working |
| 30-minute soak, real-device testing, lean disk image | outstanding |

## The pieces

- **`v86/`** — a vendored v86 with the paravirtual adapter. Host registers on the Bochs VBE
  interface tell the guest what size the host wants; a writable scanline pitch lets the visible
  size change without moving any pixels. Local changes are listed in `v86/VENDORED.md`.
- **`guest/driver/`** — `PVDISP.DRV`, ported from the Windows 3.1 DDK's Video Seven sample. Reads
  its mode from the adapter at startup, and re-modes on demand through a private escape.
- **`guest/pvmon/`** — `PVMON.EXE`, the companion utility. Watches for a host request, drives the
  re-mode, patches the screen size into USER and GDI, and re-lays-out the shell.
- **`guest/pvdpi/`** — `PVDPI.EXE`, picks the 96 or 120 dpi font set before each Windows start.
- **`web/`** — the page. Mode controller, touch, on-screen keyboard, snapshots, service worker.
- **`image/`** — reproducible disk image builds.
- **`tools/`** — the build plumbing, including a headless DOS toolchain runner.

## Building

Everything runs on the host; the 1992 toolchain runs headless under DOSBox-X.

```bash
tools/build-driver.sh                  # PVDISP.DRV, via the DDK's own MASM and linker
guest/pvmon/build.sh                   # PVMON.EXE, Open Watcom in Docker
guest/pvdpi/build.sh                   # PVDPI.EXE
(cd v86 && make build/v86.wasm)        # the emulator core
image/build-image.sh display=pvdisp load=PVMON.EXE live=1 out=work-live.img
node tools/devserver.mjs 8311 .        # a static server that supports Range requests
```

Then open `http://localhost:8311/web/index.html`. Add `?fresh=1` to ignore a saved snapshot.

## Requirements

Microsoft's Windows for Workgroups 3.11 media, the Windows 3.1 DDK, and the disk images are not
in this repository and are not redistributable. The build scripts expect them locally; see
`SPEC.md` section 0.
