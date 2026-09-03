# Running list

Open work, roughly in the order I would do it. Detail and evidence live in SPEC.md;
PLAN.md holds the invariants these all have to respect.

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
