# Plan: from whack-a-mole to invariants

Written 2026-09-02 after the phone round that reported ten new bugs. Every one of them
is an instance of five root causes. The fixes below attack the causes, each at a single
choke point, and add a test loop that runs on the phone without Josh in it.

Rule that does not change: the host only composites guest pixels and translates input.
Everything visual is native Win3.1; the keyboard accessory bar is the one exception.

## Root causes

| # | Cause | Bugs it produced |
|---|-------|------------------|
| 1 | Window geometry is decided in many places (INI keys per app, PVMON park(), PVHOOK birth sizing, host scaling) with no single rule. | tiny File Manager/Control Panel, Task List and Sound Recorder mangled, maximise breaks capture, Program Manager maximises past the screen, Notepad scrollbar off the edge, dialogs wider than the phone |
| 2 | Owned dialogs overlap their owner in VRAM, so the owner's capture contains the dialog too. | double dialogs (Paintbrush, Hearts, Sound Recorder) |
| 3 | Keyboard focus is driven by guest reports, but iOS only grants focus inside a touch gesture. | no keyboard for DOS box, Notepad, Paintbrush text tool |
| 4 | Guest lockups are debugged by asking Josh to reproduce; no telemetry captures the state. | DOS-box close lockup, "freezes randomly", pointer stuck |
| 5 | All testing happens in a desktop browser engine; iOS-only behaviour (focus, audio unlock, throttling, speed) is never exercised before Josh sees it. | silent audio on iOS Chrome, keyboard, lag |

## Fix 1: one geometry invariant, enforced in PVHOOK

"No top-level window or dialog is ever larger than the phone frame (352 × shell height),
and every window is born inside its slot."

- Enforce at every path a window can change size: HCBT_CREATEWND (birth), HCBT_MINMAX
  (maximise → fill slot, minimise → icon row inside the column), and a system-wide
  WH_CALLWNDPROC hook clamping WM_GETMINMAXINFO and WM_WINDOWPOSCHANGING.
- A short whitelist of fixed-layout apps (Sound Recorder, Calc, Clock, CharMap, Task
  List, the games) is never resized or reflowed, only kept inside the frame.
- The per-app INI table shrinks to exceptions and is recorded in SPEC.md.
- Dialog reflow applies to shell dialogs only. App dialogs that are still wider than 352
  after the 20 px system font are listed, not patched one by one.
- Acceptance: an automated tour opens every stock app and asserts every reported PVW/PVO
  rect fits 352 × shellH and the host never scales a layer below 1:1.

## Fix 2: owned windows never overlap their owner

- PVHOOK places an owned dialog below its owner in the slot when there is room, else to
  the right inside the 640-wide slot, else centred (fallback). The host already anchors the
  layer over the owner, so the user sees one dialog.
- Host side: mask reported owned/transient rects out of the owner's capture as a second
  line of defence, so a fallback placement still shows one dialog.
- Acceptance: the tour triggers a dialog in Paintbrush, Hearts, Notepad (File → Open) and
  Sound Recorder and checks the owner's layer pixels do not contain the dialog caption.

## Fix 3: keyboard focus inside the gesture, guest decides afterwards

- Every tap focuses the hidden input synchronously. The guest's PVK 0/1 report then keeps
  or releases it (debounced), so focus never depends on knowing the app.
- The accessory bar follows the same signal. Long-press caption stays as manual toggle.
- Audio: the speaker's AudioContext is created and resumed inside the first gesture and
  on every visibility/focus change. Both are logged to the diag trace.
- Acceptance: the on-device self-test (Fix 5) taps into Notepad, the DOS box and
  Paintbrush's text tool and reads back visualViewport height and activeElement.

## Fix 4: watchdog and diagnostics bundle

- PVMON sends a heartbeat on the debug channel every second. The host tracks the last
  heartbeat, last input, last frame change.
- If the guest goes quiet for 5 s while the page is visible, the host posts a bundle to
  /__log: CPU regs, in_hlt/IF, idle counters, last 50 protocol lines, last 20 input events,
  layer list, and a PNG of the composite. No repro needed from Josh.
- Save-state on hide is paused while a DOS VM exists or a window is being destroyed
  (suspected cause of the close lockup; the DOS-box agent is confirming).
- Acceptance: kill the guest deliberately in a test and confirm a bundle arrives.

## Fix 5: the phone tests itself

- `?selftest=1` runs an app tour on the device: launch each stock app by URL, wait for its
  PVW, check the invariant, tap into text fields, open and dismiss one dialog, close the
  app, confirm the guest is still alive, then post a result table to /__log.
- The same tour runs headless in node (fast, on every change) and in the pane (mobile
  preset, touch events).
- Josh's involvement becomes: open one URL, put the phone down, read my summary.
- Acceptance: a run on the iPhone 16 Pro over the LAN with zero failures before any
  "please test" message is sent.

## Then: the mobile-native list, in this order

1. Full-width-by-default layers, no cascade (host placement rule).
2. One-finger scroll on read-only surfaces, pointer drag on canvases (per-class policy).
3. Instant first paint from the saved composite; PWA manifest and viewport-fit for the
   https deploy.
4. Rotation re-runs shell sizing; safe areas respected.
5. Clipboard in/out via the hidden input; PostScript printing; https for the microphone.

## Sequencing and ownership

Three agents are already on Fixes 1–4 by file ownership (guest PVMON/PVHOOK; host
app.js; emulator). Fix 5 is next to start and gates every future "please test" request.
Merges happen per fix with the node tour green; a phone self-test run closes each fix.
