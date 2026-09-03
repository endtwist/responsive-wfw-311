# Running list

Open work, roughly in the order I would do it. Detail and evidence live in SPEC.md;
PLAN.md holds the invariants these all have to respect.

Guiding idea (Josh): a website in the shape of an OS. Portrait is the target, the way most
people hold a phone. Landscape is explicitly not a priority.

## Agreed with Josh

1. **Blitting for OS-level actions** (window switch, move, resize). The redraw pass fixed
   ordinary painting; moves still repaint whole windows through a sliding 64 KB window into
   video memory. Two driver changes: a screen-to-screen blit fast path so a move is a copy
   inside the frame buffer, and selector addressing so blits never switch banks. Measure
   switch/move/resize before and after, as in the redraw pass.
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
- **Two findings from the redraw pass**: a third of an app launch's instructions are BIOS
  disk I/O port traps, and the page runs v86 with its debug flag on.
- **Tour check for the screen-rect gap**: after a press, assert no app has a pinned cursor or
  an off-screen placement, so mismatches surface automatically rather than in use.
- **Sessions that survive** (raised, not yet agreed): periodic snapshots plus a reliable
  resume, so a drawing is still there tomorrow.
- **Nightly tour against production** (raised, not yet agreed).
- **Landscape**: deliberately not a priority. Portrait is the target.
