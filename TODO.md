# Running list

Open work, roughly in the order I would do it. Detail and evidence live in SPEC.md;
PLAN.md holds the invariants these all have to respect.

Guiding idea (Josh): a website in the shape of an OS. Portrait is the target, the way most
people hold a phone. Landscape is explicitly not a priority.

## Agreed with Josh

0. ~~**Emulator off the main thread (smoothness).**~~ Done 2026-09-03 (SPEC): the wasm CPU, the
   devices, the disk fetches and the pixel conversion run in a worker; the page keeps the
   compositor, the input, the audio and the snapshots. Guest pixels come across as dirty rows
   only, through a `SharedArrayBuffer` where the page is cross-origin isolated (headers now in
   `vercel.json` and the dev server) and as transferred `ImageBitmap`s otherwise — the plain-http
   LAN origin can never be a secure context, and that is the one Josh's phone uses; the path is
   chosen at run time, logged, and `?nosab=1` forces the transfer one. At 6x CPU throttle (this
   Mac standing in for the phone) a repainting guest took the composite to 31 fps with a 68 ms
   p95 frame and a 141 ms p95 input queue; it is now 60 fps, 20 ms p95, 29 ms p95 input queue,
   with the absolute-pointer round trip still at 5 ms and its tail improved from 71 ms to 5 ms.
   `tools/composite-bench.mjs` is the harness. Still open, and now cheap:
   - Turn off v86's debug flag (assertion and logging branches live in the hot paths) — left to
     the driver pass, which owns the build.
   - Composite only layers whose pixels changed. The information is published now
     (`pvRectDirty`, `pvRectDirtySince`, backed by a ring of the worker's dirty rectangles with
     generations); what is left is the skip itself in `drawWindow`/`placeLayers`.
0. **Emulator off the main thread (smoothness).** Today one thread runs the guest, converts
   its pixels and composites, so a busy guest delays both the frame and your finger. Run the
   emulator in a worker so the composite keeps its own frame budget (60, and 120 on Josh's
   phone, which is ProMotion and our composite is cheap) and input is never blocked. Modest
   throughput gain too, from not being interrupted. Blockers to solve: getting guest pixels
   across without a copy needs a shared buffer, which needs cross-origin isolation headers
   (we control them on the Vercel deploy, not on the plain-http LAN dev server), so keep a
   copy-based fallback. This is the single biggest change in how the thing feels under load.
   Companions to it, both nearly free and worth doing first:
   - ~~Turn off v86's debug flag.~~ Done 2026-09-03 (SPEC): `log.js`/`cjs.js` default `DEBUG`
     off, `globalThis.V86_DEBUG` or `V86_DEBUG=1` turns it back on. No measurable gain on node
     once the per-pixel work was in wasm; kept because a phone pays more for dead branches.
   - Composite only layers whose pixels changed (the emulator already tracks dirty rows; we
     re-blit every layer every frame).
   - ~~Stop the per-frame `getImageData` readback in the dialog hole fill.~~ Done 2026-09-03
     (SPEC): `sampleColour` caches per point; since the worker landed, an entry is invalidated
     only when the guest has actually painted over that pixel, so there is no timer and no
     readback on a still background. The watchdog's frame signature (25 rows every 8th frame)
     is gone with it: the worker says which rows changed.
   - (Rejected by Josh: optimistic scrolling, i.e. sliding the layer's own pixels with the
     finger and filling the leading edge with a sampled background colour. No faked pixels
     standing in for the guest's real scroll; fix the latency instead — the driver blit pass
     and fast delivery below are the real fixes.)
   - ~~Deliver scroll requests without waiting for the poll.~~ Done 2026-09-03 (SPEC, PVMON v36):
     the host arms `CMD_FASTPOLL` for the length of a gesture and PVMON's message loop peeks
     instead of blocking — 54 ms median delivery down to 1-2 ms, idle unchanged at 0.4 MIPS.
   - (Rejected by Josh: drawing ahead of the viewport by oversizing scroll windows.)
1. **Blitting for OS-level actions.** Mostly done 2026-09-03 (SPEC): the adapter copies
   rectangles inside the frame buffer for the driver (DISPI 0x20-0x26, seven port writes
   instead of a read-plus-write per four pixels), and the rust A000 fast path now covers
   chain-4 mode, which was every remaining JS write. Notepad and Write scrolling 13-30x
   faster, app repaints 2-4x, and the debug flag ships off. Two findings closed the other
   two sub-items: the BIOS reads the disk with **DMA**, not programmed I/O (0 data-port
   reads per app launch), so there was nothing to serve directly; and **selector
   addressing** is still open but no longer urgent — the next experiment there is whether
   WIN386 grants DPMI `INT 31h AX=0800h` over the linear frame buffer at all, since
   AllocSelector alone cannot reach physical 0xE0000000. Still repaint-bound and untouched:
   window switch and resize (neither blits in the phone layout) and File Manager's list
   scroll (GDI does it, not a screen-to-screen blit).
2. ~~**Edge swipe to switch windows.**~~ Done 2026-09-03 (SPEC): a level leftward swipe starting in
   the right 24 px brings the back-most window forward (CMD_ACTIVATE), so repeated swipes cycle;
   the right edge only, never over chrome (the menu-bar pan and the caption boxes keep their
   gestures), and a vertical wander or a tap in the margin is handed to the ordinary pipeline.
3. **Per-app screen rectangle = its slot.** On each task switch, write that app's slot into
   the screen size and desktop rectangle USER keeps in memory; real values for the shell and
   PVMON. Fixes screen-rect intersections (Paintbrush's cursor clip), dialog centring, self
   sizing, default placement. Does not replace host scaling or input translation. Scope as a
   measured experiment with the tour as the yardstick.
4. ~~**QBasic reboots the guest.**~~ Done 2026-09-03 (SPEC): the stock `QBASIC.PIF` was
   full-screen, so launching it put the display in an 80x25 text mode and the host restarted from
   the snapshot; and running a program (F5) panicked v86 on `INT EFh`, a vector past the DOS VM's
   IDT limit, which is a `#GP` on a real 386. A windowed PIF plus a one-line CPU fix; EDIT and the
   other DOS programs run under the already-windowed `_DEFAULT.PIF`.
5. **Files in and out.** Nothing can enter or leave today except a printed PDF. Give the guest
   a second disk the host reads and writes (a FAT image mounted as a drive), so a file dropped
   on the page appears in File Manager, and anything saved there comes back to the phone. The
   guest just sees a disk; no chrome.
6. **Clipboard bridge.** Copy in Notepad or Write and paste into iOS, and the reverse. The
   guest clipboard plus the hidden input, no visible UI.
7. **Share sheet for printed PDFs.** A print currently downloads. Hand it to the iOS share
   sheet instead so printing feels finished.
8. **Networking.** This is Windows *for Workgroups*, and v86 has a network card with a
   fetch-based backend. Even partial TCP/IP puts a period-correct browser and file sharing in
   reach. The largest item on the list and the most distinctive.
9. **Deep links with state.** `/solitaire` exists; extend to opening a specific document
   (Write, Notepad, Paintbrush) and to resuming a saved session, so a link is shareable.
9b. **Shareable session snapshots (blob-backed).** A link that drops someone into a
    mid-Solitaire game, which encoded state cannot do because the deal lives in app memory.
    The page already saves and restores whole-machine state; add: host gzips it (~2 MB) and
    uploads to Vercel Blob, the link carries the blob id, opening it restores in about the
    two seconds a cold visit already takes, and a cron deletes stale ones. Two real decisions:
    - **Prerequisite: move the stamped image parts into Blob**, keyed by stamp. A snapshot is
      welded to the image build it came from (restoring across builds is what produced the
      "Segment Load Failure" earlier), and today each deploy ships only the current image, so
      yesterday's link breaks tomorrow. Blob-hosted parts outlive deployments and shrink the
      deploy.
    - **Expiry, with a last-read touch, in the first version.** Blob does not track reads, so
      loads go through a tiny function that stamps a last-read time, and the cron deletes by
      that rather than by age. A link nobody opens expires; a link people keep using does not.
    - **Trigger must be native**: a small Win16 "Share Session" program (same shape as
      ABOUT.EXE) tells the host over the debug channel; the host uploads and hands the link to
      the iOS share sheet (item 7). No page chrome. Put it in **both** places: a Program
      Manager item in Main (where you would look for it), and a desktop icon by starting it
      minimised from WIN.INI's `run=` — a minimised window is exactly how Windows 3.1 puts an
      icon on the bare desktop, so it stays period-correct, and our icon placement already
      keeps labels inside the column.
    - **Say plainly that it publishes everything**: a snapshot is a photograph of the whole
      machine, including text typed in Notepad and anything on screen. Links must be
      unguessable, not sequential.
    - Sequence after items 5 (files in/out) and 6 (clipboard), which unlock the smaller
      sharing wins first.
10. **Screen-reader access.** The page is pixels, so VoiceOver sees nothing. Build an invisible
    accessibility tree from the window, menu and control information the guest already
    reports. Not visible chrome, so it stays inside the rule.
11. **First-run note as ABOUT.EXE.** Done 2026-09-03 (SPEC): `guest/about/` builds ABOUT.EXE with
    the Watcom toolchain, staged as `image/changes/windows/ABOUT.EXE`, opened once by WIN.INI
    `[windows] run=` and suppressed afterwards by `[PVMon] AboutShown`; "Read Me First" in Main
    shows it again. Remaining: the `/about` alias in `web/app.js`'s `APPS` table.

14. **First-open latency.** Mostly done 2026-09-03 (SPEC): the measurement (`redraw-bench.mjs
    --ops cold`, which restores the snapshot before every launch and splits load from paint) found
    that a quarter to a half of a launch was the guest **emulating SeaBIOS's wait loop** for a disk
    read the emulator was already fetching — a `main_loop` slice runs for a whole frame, so it
    burned ~270 000 instructions per read. The guest now gives the slice back (`pv_disk_wait` in
    `cpu.rs`, raised from `ide.js` when the guest polls with a read in flight, cleared and woken by
    the completion), and the boot snapshot is warmed by opening and closing the shell's programs
    before it is saved (`probe.mjs --save` now runs last). First open: Notepad 3.32 → 1.51 M
    instructions, Paintbrush 13.47 → 9.97, File Manager 19.33 → 14.06, FreeCell 5.42 → 3.70; the
    phone-equivalent figures 655 → 229 ms, 2084 → 1367, 2896 → 2078, 918 → 463. Two candidates from
    the original list are closed by measurement: **(c) the first paint was never the problem** (3-11%
    of a launch), and **(b) the AUTOEXEC/SMARTDRV pre-warm does nothing** — WFW 3.11 loads
    `ifsmgr.386`/`vcache.386`, so Windows' file reads never reach SMARTDRV's DOS-mode cache; the
    warming has to happen inside Windows, which is what the snapshot recipe does. Still open:
    - The remaining cost is guest work. **WIN386's VMM at linear `0x80006ec4` alone is 15-27% of a
      Paintbrush launch** — identify it; that is the next measurement, not the next patch.
    - **(a) reflecting INT 13h in the emulator** is now worth much less: BIOS + DOS is 10-30% of a
      load rather than 50-60% once the spin is gone.
    - **File Manager cannot be cached**: a fully warm second open still issues 36 disk reads,
      because it re-enumerates `C:\` every time.
    - **Part size, not caching, is the rest of the disk cost**: a launch reads 32-413 KB but touches
      1-8 parts of 256 KB. Smaller parts in `tools/split-image.py` would cut the phone's per-launch
      disk time roughly in proportion. (Chunk readahead in `buffer.js` was built and measured and
      rejected: a launch's reads are too scattered to predict — 16 speculative fetches to remove 4
      of 10 stalls.)

## Known, not yet scheduled

- **MIDI is thin, by the mapper's design**: v86 now has an OPL3 and MIDI plays (SPEC 2026-09-03),
  but MIDIMAP.CFG's only usable setup maps MIDI channels 13-16, so a .MID renders as the
  base-level Ad Lib three melodic voices plus percussion. A fuller rendition needs a MIDIMAP.CFG
  whose setup routes all 16 channels to the Ad Lib port; the file is a packed binary and the
  Control Panel applet that would write it is not offered on this install.
- **Entertainment Pack leftovers**: Tetris' Sound option is on but it drives the PC speaker (no
  .WAV of its own) and nothing is audible; Golf, Tut's Tomb, Rodent's Revenge and Pipe Dream were
  silent in the interactions tested. Taipei's Hint (H) highlight was too brief to catch headlessly,
  so a legal *pair* removal in Taipei is verified only as far as tile selection.
- **Tour: PBRUSH's `fit` row fails every run** — `Size.PBRUSH=640x424` is deliberate but the tour
  table's `PBRUSH` entry has no `fixed:` mark, so the 640>352 frame reads as a failure rather than
  information. Either mark it or teach PVW to carry the hook's own fixed-layout flag.
- **Microphone on the phone** needs https (Safari exposes no microphone over plain http).
- **Chrome/Safari autofill row** above the keyboard cannot be suppressed by the page; the
  standalone home-screen app is the way out.
- **iPad** (wide viewport plus touch) still focuses the hidden input on a keyboard request.
- **Desktop mode**: Program Manager's position is not persisted across mode switches, and a
  snapshot boot keeps the phone's 120 dpi fonts.
- **Hearts' welcome dialog** is wider than the phone; **Notepad/Write File Open** is 604 wide.
- **Calendar** is not on the image (the tour reports it every run).
- **Tour check for the screen-rect gap**: after a press, assert no app has a pinned cursor or
  an off-screen placement, so mismatches surface automatically rather than in use.
- **Sessions that survive** (raised, not yet agreed): periodic snapshots plus a reliable
  resume, so a drawing is still there tomorrow.
- **Nightly tour against production** (raised, not yet agreed).
- **Landscape**: deliberately not a priority. Portrait is the target.
