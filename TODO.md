# Running list

Open work, roughly in the order I would do it. Detail and evidence live in SPEC.md;
PLAN.md holds the invariants these all have to respect.

Guiding idea (Josh): a website in the shape of an OS. Portrait is the target, the way most
people hold a phone. Landscape is explicitly not a priority.

Numbers are stable: an item keeps its number for life, so a reference like "item 3" always
means the same thing. Finished items keep their numbers under **Completed** below rather than
being struck through in place. Slugs in brackets are the safer way to refer to one.

## Agreed with Josh

1. [blitting] **Blitting for OS-level actions.** Mostly done 2026-09-03 (SPEC): the adapter copies
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

3. [screen-rect] **Per-app screen rectangle = its slot.** On each task switch, write that app's slot into
   the screen size and desktop rectangle USER keeps in memory; real values for the shell and
   PVMON. Fixes screen-rect intersections (Paintbrush's cursor clip), dialog centring, self
   sizing, default placement. Does not replace host scaling or input translation. Scope as a
   measured experiment with the tour as the yardstick.

5. [files-io] **Files in and out.** Nothing can enter or leave today except a printed PDF. Give the guest
   a second disk the host reads and writes (a FAT image mounted as a drive), so a file dropped
   on the page appears in File Manager, and anything saved there comes back to the phone. The
   guest just sees a disk; no chrome.

7. [share-sheet] **Share sheet for printed PDFs.** A print currently downloads. Hand it to the iOS share
   sheet instead so printing feels finished.

8. [networking] **Networking.** Started 2026-09-04, host half built and tested; the guest half needs
   an asset decision from Josh. Architecture, which is Josh's (a proxy, off-device, reached through
   a simulated serial port):
   - **The guest dials up.** WFW 3.11 shipped NetBEUI and IPX and no TCP/IP at all (the install
     source on the image has NDIS and PROTMAN and nothing else), and it could not do TLS if it had.
     So it gets a period-correct dial-up link: a Winsock over SLIP on COM1, which is how everyone
     reached the internet in 1994. v86 already emulates the UART, so there is no device to write --
     bytes arrive as `serial0-output` and go back as `serial0-input`.
   - **The host is the terminal server** (`web/net.js`, done): SLIP framing, IPv4, ICMP echo so
     `ping` proves the link, a DNS responder that hands every name an address out of 10.64/16 and
     remembers whose it is, and enough TCP for a handshake, in-order data and a close. A request to
     port 80 is handed up as (host, bytes); the response is streamed back. 37/37 checks in
     `v86/tests/pv/slipnet.mjs`, driven with synthetic frames -- no emulator needed.
   - **The real internet is a function** (`api/fetch.js`, done): the page cannot fetch arbitrary
     sites itself (CORS), and the guest cannot do TLS, so the request is made server-side. GET and
     HEAD only, http/https only, private and loopback addresses refused, 4 MB and 15 s limits, a
     period user agent, nothing forwarded from the caller. The guest asks for http and gets what
     the site serves over TLS, knowing nothing about it.
   - **Still to do**: wire `web/net.js` to the bus and `api/fetch.js` (an afternoon); then the guest
     side. Two ways, and it is Josh's call because it is an asset question: **Trumpet Winsock**
     (shareware, SLIP over COM1, no NIC driver -- matches this design exactly) or **Microsoft
     TCP/IP-32** (free at the time, needs an NDIS driver for v86's NE2000, and then the link is
     ethernet rather than serial and `web/net.js` grows an ARP responder).
   - Not yet: UDP beyond DNS, more than one connection at a time (the code allows it, nothing has
     tested it), retransmission (a local link that never drops a packet does not need it, and a
     1994 stack will retransmit at us anyway, which the sequence handling tolerates).

9. [deep-links] **Deep links with state.** `/solitaire` exists; extend to opening a specific document
   (Write, Notepad, Paintbrush) and to resuming a saved session, so a link is shareable.

9b. [session-snapshots] **Shareable session snapshots (blob-backed).** A link that drops someone into a
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

10. [screen-reader] **Screen-reader access.** The page is pixels, so VoiceOver sees nothing. Build an invisible
    accessibility tree from the window, menu and control information the guest already
    reports. Not visible chrome, so it stays inside the rule.

16. [dynamic-slots] **Grow and shrink the application columns on demand.** Four fixed columns
    (2026-09-04) are enough for the note plus a double-width program plus one more, but each costs
    640 x 970 x 4 bytes of pixel buffer and widens every dirty-row conversion whether it is in use
    or not. PVMON already re-modes live to widen the screen while a dialog is up and narrow it
    afterwards, which is the mechanism; add hysteresis and grow when a program has nowhere to go.
    Needs [pointer-base] first, since the mouse base moves with every re-mode.
17. [tiles] **Popup and dialog tiles, off by default.** Painting a menu or a dialog in rows the
    phone never shows means it never takes its owner's pixels, and it worked: the menu ghost and
    the dismiss flash stop existing rather than being papered over (`maskShellDialogCopies`, the
    coincident-dialog path, `holdRegion`). Dialog tiling additionally needs the host to treat a
    tiled dialog as a first-class layer -- the tall-dialog column pan, the drag, and the pointer
    mapping all assume a dialog is where Windows put it. Behind `[PVMon] PopupTiles=1` and
    `DialogTiles=1`. Needs [pointer-base] first: the tiles make the screen taller, which is what
    moved the mouse base.
18. [verify-touch] **Confirm two fixes on the device.** Both are deployed and neither has been
    seen working by Josh or measured on the phone: the scroll-bar touch-drag (a finger on the
    client's right or bottom strip is a pointer drag, not a scroll), and where the MS-DOS/QBASIC
    exit dialog lands (reported bottom-right, from a tab several rebuilds old).

26. [lcd-filter] **A passive-matrix LCD look, in WebGL.** Josh's photo of ProSell Professional on
    a 1992 laptop panel is the target: backlit greyscale, no colour at all, blacks lifted to a
    warm grey, a cyan-white bloom along one edge where the tube is, visible pixel grid, and the
    smear that a passive matrix leaves behind moving text. A post-process over the finished
    composite, `?lcd=1`, purely visual -- the composite geometry, hit testing and input are
    untouched, and nothing about the guest changes.
    - **Pass structure.** Upload the 2D composite (402x684 on the phone, ~275k pixels: nothing)
      to a texture each frame it changes, render one fragment shader to a canvas over the top.
      One extra texture holds the previous filtered frame for the smear.
    - **Tone.** Luminance first (Rec.601), then a lifted-black curve: `mix(0.10, 0.92, pow(l,
      0.85))` is close to the photo, which has no true black anywhere. Then the tint -- the panel
      is not neutral, it is a green-grey around #c8ccc0 at white and #4a4f48 at black, so the
      grey is multiplied by that ramp rather than left neutral.
    - **The smear (the giveaway).** Passive matrix is slow and asymmetric: a pixel going dark
      lags more than one going light. `out = mix(prev, now, now > prev ? 0.55 : 0.28)` per frame,
      which leaves a two-to-three-frame trail behind a dragged window and a visible ghost behind
      scrolling text. This is what makes it read as an LCD of that era rather than a grey CRT.
    - **Structure.** A 1px grid at the guest pixel pitch (multiply by 0.93 on the last row and
      column of each pixel), and because the panel is 640x480 stretched, the horizontal pitch is
      wider than the vertical -- worth keeping, it is half the look.
    - **Backlight.** A broad radial gradient brightening toward one edge plus a narrow cyan-white
      band along it (the photo has it left and bottom), a mild vignette, and a slow ~0.5% flicker
      at a frequency that is not a multiple of the frame rate so it never beats.
    - **Costs and risks.** Trivial GPU work; the real costs are a second canvas in the compositing
      path and losing the "composite nothing on 95% of frames" saving, because the smear has to
      keep running for a few frames after the last change (bounded: stop when the trail is within
      one 8-bit step of the source). Screenshots for Josh should be taken pre-filter, or the
      grid and the smear will be read as bugs in the compositor.
    - **Rule note.** This draws pixels Windows never painted -- it is a display, not chrome, and
      Josh asked for it, but it is the first thing in the system that is neither guest pixels nor
      the keyboard bar. Off by default.

## Completed

Finished, newest work last within its number. Numbers are for life.

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
   Rejected along the way, and recorded so they are not proposed again: **optimistic
   scrolling** (sliding a layer's own pixels with the finger and filling the leading edge with a
   sampled colour -- no faked pixels standing in for the guest's real scroll) and **drawing ahead
   of the viewport** by oversizing scroll windows.

2. [edge-swipe] ~~**Edge swipe to switch windows.**~~ Done 2026-09-03 (SPEC): a level leftward swipe starting in
   the right 24 px brings the back-most window forward (CMD_ACTIVATE), so repeated swipes cycle;
   the right edge only, never over chrome (the menu-bar pan and the caption boxes keep their
   gestures), and a vertical wander or a tap in the margin is handed to the ordinary pipeline.

4. [qbasic] ~~**QBasic reboots the guest.**~~ Done 2026-09-03 (SPEC): the stock `QBASIC.PIF` was
   full-screen, so launching it put the display in an 80x25 text mode and the host restarted from
   the snapshot; and running a program (F5) panicked v86 on `INT EFh`, a vector past the DOS VM's
   IDT limit, which is a `#GP` on a real 386. A windowed PIF plus a one-line CPU fix; EDIT and the
   other DOS programs run under the already-windowed `_DEFAULT.PIF`.

6. [clipboard] ~~**Clipboard bridge.**~~ Done 2026-09-04: PVMON joins the clipboard viewer
   chain and ships CF_TEXT out as base64 on the debug channel; the host holds it and writes it to
   the system clipboard on the next touch, since iOS only permits that inside a gesture. A paste
   anywhere on the page comes back as CMD_CLIP and PVMON puts it on the clipboard as CF_TEXT.
   ANSI and CRLF, 4 KB either way, no visible UI. Verified headlessly in both directions and
   round trip (new probe step `clip:<text>`).

11. [about-exe] ~~**First-run note as ABOUT.EXE.**~~ Done 2026-09-03 (SPEC): `guest/about/` builds ABOUT.EXE with
    the Watcom toolchain, staged as `image/changes/windows/ABOUT.EXE`, opened once by WIN.INI
    `[windows] run=` and suppressed afterwards by `[PVMon] AboutShown`; "Read Me First" in Main
    shows it again. Remaining: the `/about` alias in `web/app.js`'s `APPS` table.

12. [switcher] ~~**Card app switcher.**~~ Done 2026-09-04: a swipe up from the bottom edge lays
    every open window out as a card -- its own frame and client, blitted from the guest frame
    buffer and scaled, on the desktop's own colour. Pan the strip, tap to raise, flick a card up
    to close (CMD_CLOSE), swipe down to leave. Cards are laid out from their real widths so the
    neighbours peek in, and the list is re-read every frame so a program that moves or closes
    itself is never drawn from a stale rectangle. Nothing was added to the guest for it.
13. [pointer-shape] ~~**The host pointer matches the guest's.**~~ Done 2026-09-03 (SPEC, PVMON
    v39): PVMON classifies `GetCursor` against the standard cursors and reports `PVC <name>`;
    the host sets the CSS cursor from it (arrow, ibeam, all four resize shapes) and hands the
    pointer back to the guest for an application's own cursor. `wait` was never observed -- 3.11's
    hourglass is shorter than PVMON's poll -- and Paintbrush's canvas genuinely has no cursor.
14. [first-open] ~~**First-open latency.**~~ Mostly done 2026-09-03 (SPEC): the measurement (`redraw-bench.mjs
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

15. [pointer-base] ~~**Measure the size USER scales an absolute mouse position by.**~~ The host
    normalises a pointer placement against its own idea of the screen; USER keeps a copy of that
    size which neither the live re-mode nor FakeScreen reaches, so any change of screen size
    silently misplaces every tap and drag. That is what 2026-09-04's bad afternoon was: taps
    hundreds of pixels from the finger, drags that never confirmed and retried instead, a card in
    Solitaire lagging behind. The fix is to measure rather than assume -- place the pointer at a
    known fraction, read back where the guest says it went, divide -- and to re-measure on every
    mode change. Done 2026-09-04: two probes an eighth and three eighths across, base from the
    difference (which cancels any offset of USER's own and catches a stale report), then verified
    before it is adopted -- place the pointer at a known point with it and require the guest to
    land within two pixels, or keep the old behaviour and say so in the trace. Measured in the
    pane: 3200x968 against a host screen of 3200x970, USER's own rounding. The first attempt was
    thought wrong on evidence that turned out to be an artifact of the Browser pane freezing
    requestAnimationFrame while hidden, so `view` was stale and a tap that looked misplaced was
    correct for it. Unblocks 16 and 17.
19. [popup-publish] ~~**A popup is reported the moment it is shown.**~~ Done 2026-09-04: nothing
    activates when a menu pops up, so the CBT hook never fired and the host learned of it only at
    PVMON's next poll -- 287 ms during which the popup was already painted and composited at
    guest coordinates that hang off a phone-wide column, then drawn again, shifted, as its own
    layer. PVHOOK publishes from `WM_WINDOWPOSCHANGED` when a real popup is shown or hidden,
    before it paints. Measured on the phone: tap to layer 287 ms -> 84 ms.
20. [momentum] ~~**Momentum scrolling.**~~ Done 2026-09-04: a swipe that ends moving keeps
    scrolling and decays, stopping at the end of a list or on the next touch. Velocity is
    measured over the last 120 ms rather than between two events (touch moves arrive in bursts
    with no time between them), and scroll the guest cannot keep up with is dropped rather than
    queued -- the backlog after a flick in a program group was the "everything freezes for a
    minute".
21. [hold-select] ~~**Hold to select text.**~~ Done 2026-09-04: holding still on a scrolling
    surface presses the left button where the finger is, so the caret jumps there and the drag
    that follows is a selection -- the guest's own version of the cue iOS gives with its
    magnifier. Dragging into the edge band keeps feeding points past the edge so an Edit keeps
    scrolling the selection.
22. [wheel] ~~**Wheel and scroll bars on the desktop.**~~ Done 2026-09-04: the wheel finds the
    window under the pointer in the guest's own coordinates (there are no placed layers on the
    desktop, so hit testing could only answer "desktop" and everything scrolled the shell), and
    it scrolls the way a wheel scrolls rather than the way a finger does. A finger on a window's
    scroll-bar strip is a pointer drag, not a scroll (unverified on the device: item 18).
23. [keyboard-latch] ~~**The keyboard stops coming back.**~~ Done 2026-09-04: the caption hold
    latches the keyboard on, and dismissing it with its own key does not go through us, so the
    latch stayed on and every later tap raised it again. The latch drops when a gesture starts
    with the keyboard not showing, and the class the hold taught is unlearned at the same moment
    -- one stray hold on Solitaire's title bar had made every tap on the cards raise the
    keyboard. `?forget=1` empties a learned set that has already gone wrong.
24. [four-columns] ~~**A fourth application column.**~~ Done 2026-09-04: the first-run note takes
    a column and a fixed-layout program wider than one takes two, so a third program found none
    left and opened as a caption-high stub in the staging area. Screen 3200x970.
25. [browser-resize] ~~**A browser resize uncovers the desktop instead of shrinking it.**~~ Done
    2026-09-04: the guest screen stays its old size until the resize settles, and scaling it down
    made the whole desktop shrink inside black bars for the length of the drag. It is cropped
    instead, the leftover columns take the desktop's own colour, and if the guest has not followed
    within two seconds the old scale-to-fit comes back so nothing is stranded off the edge. The
    saved first frame is only shown to a window the same shape as the one that saved it.

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

## Maybe

- **Full colour in the guest** (2026-09-04, Josh: the plan is to put modern content — photos,
  gradients, browser-sourced images — into the guest). Windows 3.1 is not the obstacle: vendor
  drivers shipped 15/16/24 bpp and GDI handles direct-colour DIBs with no palette. The obstacles
  are ours, and there are three ways round them.
  - **Prerequisite: done.** The PV blit engine addresses the frame buffer in bytes rather than
    assuming a pixel is one, so it works at 8/15/16/24/32 bpp (`pv_px_bytes`, 136/136 adapter
    checks, eleven at 16 bpp). Above 8 bpp the host pixel path already converts in rust and
    derives its dirty rows by pixel size, so the host needs nothing.
  - **(1) Palette-optimised 8 bpp** — days, no driver work, fully native. The host quantises an
    image to a per-image 236-colour palette with Floyd-Steinberg dithering and hands the guest an
    ordinary BMP; the palette manager gives an application 236 of the 256 entries, which is what
    1993 software did with photographs and it looks it. Limits: two photos on screen share one
    palette, and gradients band.
  - **(2) A 16 bpp driver** — the real project, and the largest piece of work discussed here.
    `PVDISP` is the full DDK VGA-family driver: `BLT88/18/81/11/216`, `BS216`, `BLTPAT`,
    `BLTSTOS`, `STRBLT`, the bitmap-conversion family (`BMC_MAIN/ITE/ETI/NEW/WSEG`) and the ROP
    tables, all depth-specific, with text, pattern fills, the cursor's XOR and the DIB entry
    points going through them. Staging: format tables and `Enable`, then 16->16 and 1->16 blits
    (the mono paths are masks and mostly depth-agnostic), then text, then patterns -- 8 bpp kept
    as a switch so the frame rate can be A/B'd rather than discovered on the phone. Cost at run
    time: two bytes a pixel is 2x the bandwidth for every blit the guest performs, on a machine
    whose constraint is guest CPU (~35 MIPS while busy).
  - **(3) Host-composited images** — cheap, looks perfect, and it breaks the standing rule: the
    host would be drawing pixels Windows never painted, over a rectangle the guest reserves.
    Recorded for completeness; not to be built without Josh saying so.
