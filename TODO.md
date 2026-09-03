# Running list

Open work, roughly in the order I would do it. Detail and evidence live in SPEC.md;
PLAN.md holds the invariants these all have to respect.

Guiding idea (Josh): a website in the shape of an OS. Portrait is the target, the way most
people hold a phone. Landscape is explicitly not a priority.

## Agreed with Josh

0. **Emulator off the main thread (smoothness).** Today one thread runs the guest, converts
   its pixels and composites, so a busy guest delays both the frame and your finger. Run the
   emulator in a worker so the composite keeps its own frame budget (60, and 120 on Josh's
   phone, which is ProMotion and our composite is cheap) and input is never blocked. Modest
   throughput gain too, from not being interrupted. Blockers to solve: getting guest pixels
   across without a copy needs a shared buffer, which needs cross-origin isolation headers
   (we control them on the Vercel deploy, not on the plain-http LAN dev server), so keep a
   copy-based fallback. This is the single biggest change in how the thing feels under load.
   Companions to it, both nearly free and worth doing first:
   - Turn off v86's debug flag (assertion and logging branches live in the hot paths).
   - Composite only layers whose pixels changed (the emulator already tracks dirty rows; we
     re-blit every layer every frame).
   - Stop the per-frame `getImageData` readback in the dialog hole fill: sample once, cache
     until the layout changes.
   - (Rejected by Josh: optimistic scrolling, i.e. sliding the layer's own pixels with the
     finger and filling the leading edge with a sampled background colour. No faked pixels
     standing in for the guest's real scroll; fix the latency instead — the driver blit pass
     and fast delivery below are the real fixes.)
   - Deliver scroll requests without waiting for the poll. A scroll sits in the command
     register for up to 40 ms before PVMON sees it. Either let the host mark a gesture in
     progress so PVMON polls fast for a second or two, or deliver scrolls through an
     interrupt-driven path like the mouse and keyboard (measured at 7-11 ms).
   - (Rejected by Josh: drawing ahead of the viewport by oversizing scroll windows.)
1. **Blitting for OS-level actions** (window switch, move, resize). The redraw pass fixed
   ordinary painting; moves still repaint whole windows through a sliding 64 KB window into
   video memory. Two driver changes: a screen-to-screen blit fast path so a move is a copy
   inside the frame buffer, and selector addressing so blits never switch banks. Measure
   switch/move/resize before and after, as in the redraw pass. This also covers **scrolling**:
   Windows scrolls by blitting the client up and repainting only the exposed strip, and that
   screen-to-screen blit is the case the driver handles worst today — so this is the most
   direct fix for scroll latency, which raises its priority. In the same pass, two more
   throughput wins found by the redraw agent: serve the boot BIOS's disk reads directly
   instead of port-by-port programmed I/O (a third of an app launch's instructions), and
   ship with v86's debug flag off.
2. **Edge swipe to switch windows.** Swipe in from the right cycles windows front to back
   (CMD_ACTIVATE; z-order already works). Must not fight iOS's own left-edge back gesture.
3. **Per-app screen rectangle = its slot.** On each task switch, write that app's slot into
   the screen size and desktop rectangle USER keeps in memory; real values for the shell and
   PVMON. Fixes screen-rect intersections (Paintbrush's cursor clip), dialog centring, self
   sizing, default placement. Does not replace host scaling or input translation. Scope as a
   measured experiment with the tour as the yardstick.
4. **QBasic reboots the guest.** Running it restarts Windows. Diagnose (DOS box PIF? memory?
   the idle hook? our display driver in a full-screen text mode?) and fix, or remove it from
   the image and its group if it cannot be made to work.
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
9. **MIDI and system sounds.** MSADLIB.DRV is already staged. Media Player playing MIDI, and
   Windows' own event sounds, cost little now that audio works.
10. **Deep links with state.** `/solitaire` exists; extend to opening a specific document
    (Write, Notepad, Paintbrush) and to resuming a saved session, so a link is shareable.
10b. **Shareable session snapshots (blob-backed).** A link that drops someone into a
    mid-Solitaire game, which encoded state cannot do because the deal lives in app memory.
    The page already saves and restores whole-machine state; add: host gzips it (~2 MB) and
    uploads to Vercel Blob, the link carries the blob id, opening it restores in about the
    two seconds a cold visit already takes, and a cron deletes stale ones. Two real decisions:
    - **Prerequisite: move the stamped image parts into Blob**, keyed by stamp. A snapshot is
      welded to the image build it came from (restoring across builds is what produced the
      "Segment Load Failure" earlier), and today each deploy ships only the current image, so
      yesterday's link breaks tomorrow. Blob-hosted parts outlive deployments and shrink the
      deploy.
    - **Expiry**: Blob does not track reads. Start with age-based expiry (one cron, no
      bookkeeping); add a last-read touch through a tiny function later if live links start
      expiring under people.
    - **Trigger must be native**: a small Win16 "Share Session" program (same shape as
      ABOUT.EXE) tells the host over the debug channel; the host uploads and hands the link to
      the iOS share sheet (item 7). No page chrome.
    - **Say plainly that it publishes everything**: a snapshot is a photograph of the whole
      machine, including text typed in Notepad and anything on screen. Links must be
      unguessable, not sequential.
    - Sequence after items 5 (files in/out) and 6 (clipboard), which unlock the smaller
      sharing wins first.
11. **Screen-reader access.** The page is pixels, so VoiceOver sees nothing. Build an invisible
    accessibility tree from the window, menu and control information the guest already
    reports. Not visible chrome, so it stays inside the rule.
12. **First-run note as ABOUT.EXE.** A small native Win16 program (not a Write document) that
    opens once and explains the gestures: hold to drag, swipe the menu bar, long-press for
    right-click, the keyboard bar. Built with the Watcom toolchain like PVMON.

## Known, not yet scheduled

- **JezzBall**: not on the install media and not free to download. Dropping JEZZ.EXE and
  JEZZ.HLP into `image/changes/games/` is all that is needed; everything else is wired.
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
