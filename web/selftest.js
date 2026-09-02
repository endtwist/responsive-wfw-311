/* responsive-wfw311 - the app tour (PLAN.md Fix 5).
 *
 * Opens every stock application, checks the geometry invariant (a window is never wider than the
 * phone frame nor taller than the shell column, and is born inside its slot), that the host draws
 * its layer at 1:1 or larger, taps into it, opens and dismisses one dialog where that is cheap,
 * closes it and confirms the guest is still alive. Results go to the dev server log as `TOUR `
 * lines and a final `TOUR-END pass=N fail=M`, and to `window.tourResult`.
 *
 * Runs in three places with one code path:
 *   - on the phone / in the pane: app.js loads it with
 *       if (params.get("selftest")) import("./selftest.js").then(m => m.run());
 *     or by hand from the console: import("/web/selftest.js").then(m => m.run())
 *   - headless in node: tools/tour.mjs boots v86 and calls tour(env) with a bus-only environment
 *     (no DOM: taps go through the absolute pointer, keyboard focus and pixel checks are skipped).
 *
 * It draws nothing. It depends on app.js only through the globals app.js exposes: window.emulator,
 * window.pvState(), window.pvPresent(), #pres and #kbd. Everything about the guest is read from
 * the PV debug protocol itself (PVB/PVW/PVO/PVT/PVS/PVI/PVE, PVD, PVK, PVA).
 */

export const SHELL_W = 352, SLOT_W = 640;
const CMD_ACTIVATE = 1, CMD_CLOSE = 3, CMD_RUN = 5, CMD_REPUBLISH = 6;
const SC = { esc: 0x01, tab: 0x0F, enter: 0x1C, ctrl: 0x1D, alt: 0x38, f: 0x21, o: 0x18, x: 0x2D, n: 0x31, f4: 0x3E };

/* The tour table. `text`: a tap into the client area must make the guest ask for the keyboard
   (PVK 1: an Edit/ComboBox/tty control or a [PVMon] KeyboardApps module). `dialog`: how to get
   one owned dialog cheaply. `timeout`: how long its main window may take to appear. `fixed`: a
   fixed-layout program (no WS_THICKFRAME: the hook keeps it in its column but deliberately never
   resizes it), so a frame wider than the phone and a host scale below 1:1 are reported as
   information, not failures. Until PVW carries the hook's own flag these are named by title;
   WINVER and Network Setup are fixed too but not toured. */
/* [PVMon] KeepSize in build-image.sh: SOL MSHEARTS WINMINE CALC CHARMAP SOUNDREC TASKMAN WINVER PIFEDIT PACKAGER
   (kept in step by hand; the same set as the `fixed:` marks above plus the untoured WINVER/PIFEDIT). */
const FIXED_TITLES = /^(Character Map|Solitaire|The Microsoft Hearts|Minesweeper|Calculator|Sound Recorder|Media Player|Object Packager|Task List|About |PIF Editor|Network Setup|Print Manager)/;
export const APPS = [
  { name: "NOTEPAD",  cmd: "NOTEPAD.EXE",  title: /^Notepad/,        text: true,  dialog: "alt-f-o" },
  { name: "WRITE",    cmd: "WRITE.EXE",    title: /^Write/,          dialog: "alt-f-o" },
  { name: "CALC",     cmd: "CALC.EXE",     title: /^Calculator/, fixed: true },
  { name: "CLOCK",    cmd: "CLOCK.EXE",    title: /^Clock/ },
  { name: "CHARMAP",  cmd: "CHARMAP.EXE",  title: /^Character Map/, fixed: true },
  { name: "CARDFILE", cmd: "CARDFILE.EXE", title: /^Cardfile/,       text: true },
  { name: "CALENDAR", cmd: "CALENDAR.EXE", title: /^Calendar/ },
  { name: "PBRUSH",   cmd: "PBRUSH.EXE",   title: /^Paintbrush/,     dialog: "pbrush" },
  { name: "SOL",      cmd: "SOL.EXE",      title: /^Solitaire/, fixed: true },
  { name: "WINMINE",  cmd: "WINMINE.EXE",  title: /^Minesweeper/, fixed: true },
  { name: "MSHEARTS", cmd: "MSHEARTS.EXE", title: /Hearts/,          dialog: "launch", fixed: true },
  { name: "WINFILE",  cmd: "WINFILE.EXE",  title: /^File Manager/ },
  { name: "CONTROL",  cmd: "CONTROL.EXE",  title: /^Control Panel/ },
  { name: "PRINTMAN", cmd: "PRINTMAN.EXE", title: /^Print Manager/, fixed: true },   // spooler off: only its message box appears
  { name: "CLIPBRD",  cmd: "CLIPBRD.EXE",  title: /^Clip[Bb]o/ },
  { name: "SOUNDREC", cmd: "SOUNDREC.EXE", title: /^Sound Recorder/, fixed: true },
  { name: "MPLAYER",  cmd: "MPLAYER.EXE",  title: /^Media Player/, fixed: true },     // 448 wide, no thick frame
  { name: "RECORDER", cmd: "RECORDER.EXE", title: /^Recorder/ },
  { name: "TERMINAL", cmd: "TERMINAL.EXE", title: /^Terminal/,       text: true },
  { name: "PACKAGER", cmd: "PACKAGER.EXE", title: /^Object Packager/, fixed: true },
  { name: "WINHELP",  cmd: "WINHELP.EXE",  title: /Help/ },
  { name: "TASKMAN",  keys: "ctrl-esc",    title: /^Task List/, fixed: true },
  { name: "DOSPRMPT", cmd: "DOSPRMPT.PIF", title: /^MS-DOS/,         text: true, timeout: 40000 },
];

/* ------------------------------------------------------------------------------ time
 * A hidden tab throttles setTimeout to once a second or worse; a Worker's timers are not
 * throttled the same way, so waits are resolved from a worker heartbeat when one can be made
 * (the same idea as app.js's own sleep()). Node and browsers without Worker use setTimeout. */
function makeClock() {
  const sleepers = [];
  let worker = null;
  if (typeof Worker === "function" && typeof Blob === "function" && typeof URL !== "undefined") {
    try {
      const src = URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 4);"], { type: "text/javascript" }));
      worker = new Worker(src);
      worker.onmessage = () => {
        const now = performance.now();
        for (let i = sleepers.length - 1; i >= 0; i--) if (sleepers[i].at <= now) sleepers.splice(i, 1)[0].r();
      };
    } catch (e) { worker = null; }
  }
  const sleep = ms => new Promise(r => {
    if (worker) sleepers.push({ at: performance.now() + ms, r });
    else setTimeout(r, ms);
  });
  return { sleep, stop: () => { if (worker) worker.terminate(); worker = null; }, driven: worker ? "worker" : "timer" };
}

/* ------------------------------------------------------------------------------ guest state
 * Our own reading of the protocol, so the tour does not depend on app.js's internals and works in
 * node too. Mirrors the parsing in app.js. */
export function trackGuest(emulator) {
  const st = { shell: { w: SHELL_W, h: 0, cap: 18, ver: 0 }, layers: [], dock: [], kbd: 0, kbdSeq: 0, desktopReady: false,
               pubSeq: 0, log: [], runs: [], hb: 0 };
  let pending = null, pendingDock = null;
  emulator.bus.register("pv-debug", line => {
    st.log.push(line); if (st.log.length > 200) st.log.shift();
    let m = /^PVD (\d+) (\d+)(?: (\d+))?(?: v(\d+))?/.exec(line);
    if (m) { st.shell = { w: +m[1], h: +m[2], cap: +m[3] || 18, ver: m[4] ? +m[4] : 0 }; return; }
    m = /^PVK (\d)/.exec(line);
    if (m) { st.kbd = +m[1]; st.kbdSeq++; return; }
    if (/^PVA/.test(line)) { st.desktopReady = true; return; }
    if (/^pvmon: run /.test(line)) { st.runs.push(line); return; }
    if (/^PVH /.test(line)) { st.hb++; return; }         // PVMON heartbeat, about once a second
    if (/^PVB /.test(line)) { pending = []; pendingDock = []; return; }
    m = /^PV([WOTXS]) (-?\d+) (-?\d+) (-?\d+) (\d+) (\d+) (-?\d+) (-?\d+) (\d+) (\d+) ?(.*)$/.exec(line);
    if (m && pending) {
      pending.push({ kind: m[1], slot: +m[2], wx: +m[3], wy: +m[4], ww: +m[5], wh: +m[6],
                     gx: +m[7], gy: +m[8], gw: +m[9], gh: +m[10], title: m[11] || "" });
      return;
    }
    m = /^PVI (-?\d+) ?(.*)$/.exec(line);
    if (m && pendingDock) { pendingDock.push({ slot: +m[1], title: m[2] || "" }); return; }
    if (/^PVE/.test(line) && pending) { st.layers = pending; st.dock = pendingDock; pending = pendingDock = null; st.pubSeq++; }
  });
  return st;
}

const rectsIntersect = (a, b) => a.wx < b.wx + b.ww && b.wx < a.wx + a.ww && a.wy < b.wy + b.wh && b.wy < a.wy + a.wh;

/* ------------------------------------------------------------------------------ the tour */
export async function tour(env, opts = {}) {
  const { emulator } = env;
  const clock = makeClock();
  const sleep = clock.sleep;
  const t0 = performance.now();
  const apps = (opts.apps ? APPS.filter(a => opts.apps.includes(a.name)) : APPS).filter(a => !(opts.skip || []).includes(a.name));
  const strictDialogs = opts.strictDialogs !== false;          // Fix 2 acceptance: dialog never overlaps its owner
  const st = env.state || trackGuest(emulator);
  const post = line => { try { env.post(line); } catch (e) {} };
  const bus = (name, data) => emulator.bus.send(name, data);
  const ic = () => { try { return emulator.v86.cpu.instruction_counter[0] >>> 0; } catch (e) { return 0; } };

  const until = async (pred, timeout, step = 40) => {
    const start = performance.now();
    for (;;) {
      const v = pred();
      if (v) return v;
      if (performance.now() - start > timeout) return null;
      await sleep(step);
    }
  };
  const key = async (sc, down) => { bus("keyboard-code", down ? sc : sc | 0x80); await sleep(30); };
  const press = async (sc) => { await key(sc, true); await key(sc, false); };
  const chord = async (mod, sc) => { await key(mod, true); await press(sc); await key(mod, false); };
  const alive = async () => { const a = ic(); await sleep(300); return ic() !== a; };
  const winOf = slot => st.layers.find(L => L.kind === "W" && L.slot === slot);
  const dialogsOf = slot => st.layers.filter(L => L.kind === "O" && L.slot === slot);
  const hostLayer = (kind, slot, title) => {
    if (!env.hostState) return null;
    const s = env.hostState();
    if (!s || !s.placed) return null;
    return s.placed.find(w => w.kind === kind && (kind === "W" ? w.slot === slot : w.slot === slot && (!title || w.title === title))) || null;
  };
  const mips = () => { const a = ic(), ta = performance.now(); return sleep(500).then(() => (((ic() - a) >>> 0) / (performance.now() - ta) / 1000)); };

  /* Where a finger goes: the middle of the layer's client area on the host (DOM), else the middle
     of the client rect in guest pixels through the absolute pointer (node). */
  const tapClient = async (L, fx = 0.5, fy = 0.5) => {
    if (env.dom) {
      let h = hostLayer("W", L.slot);
      if (!h && env.present) { env.present(); await sleep(60); h = hostLayer("W", L.slot); }
      if (!h) return { ok: false, why: "no host layer" };
      const x = h.x + h.hl + h.cw * fx, y = h.y + h.ht + h.ch * fy;
      await env.tap(x, y);
      return { ok: true, x: Math.round(x), y: Math.round(y) };
    }
    const x = Math.round(L.gx + L.gw * fx), y = Math.round(L.gy + L.gh * fy);
    await env.tapGuest(x, y);
    return { ok: true, x, y };
  };
  const dragClient = async (L, fx0, fy0, fx1, fy1) => {
    if (env.dom) {
      let h = hostLayer("W", L.slot);
      if (!h) return false;
      await env.drag(h.x + h.hl + h.cw * fx0, h.y + h.ht + h.ch * fy0, h.x + h.hl + h.cw * fx1, h.y + h.ht + h.ch * fy1);
      return true;
    }
    await env.dragGuest(Math.round(L.gx + L.gw * fx0), Math.round(L.gy + L.gh * fy0), Math.round(L.gx + L.gw * fx1), Math.round(L.gy + L.gh * fy1));
    return true;
  };

  /* Dialog checks: exactly one owned window, its rectangle apart from the owner's (the guest side
     of Fix 2), and, optionally, that the host composite shows one caption band (the host side). */
  const checkDialog = (row, L) => {
    const dl = dialogsOf(L.slot);
    row.dlg = dl.length ? "pass" : "fail";
    if (!dl.length) return null;
    const D = dl[dl.length - 1];
    row.dlg1 = dl.length === 1 ? "pass" : `fail:${dl.length}`;
    row.dlgfit = D.ww <= SHELL_W && D.wh <= st.shell.h ? "pass" : `fail:${D.ww}x${D.wh}`;
    const owner = winOf(L.slot) || L;
    const sep = !rectsIntersect(D, owner);
    row.dlgsep = sep ? "pass" : (strictDialogs ? "fail" : "info") + `:${D.wx},${D.wy},${D.ww},${D.wh}/${owner.wx},${owner.wy},${owner.ww},${owner.wh}`;
    if (opts.pixels && env.dom && env.doubleCaption) {
      try { const r = env.doubleCaption(hostLayer("W", L.slot), hostLayer("O", L.slot, D.title)); row.dlgpix = r === null ? "info:unreadable" : r ? "fail:band" : "pass"; }
      catch (e) { row.dlgpix = "info:" + e.message; }
    }
    return D;
  };

  /* Closing: PVMON posts WM_CLOSE; a "save changes?" box gets an N; Alt+F4 is the fallback. */
  const closeApp = async (slot, row, title) => {
    // gone from its slot and not still published under any slot (a box PVMON re-slotted)
    const gone = () => !winOf(slot) && !(title && st.layers.some(x => x.kind === "W" && x.title === title));
    const wait = async ms => {
      const start = performance.now();
      while (performance.now() - start < ms) {
        if (gone()) return true;
        const dl = dialogsOf(slot);
        // "Save changes?" gets N; WinOldAp's "Application still active. Choose OK to end it." (a box carrying
        // the DOS window's own title) needs Enter, N would leave the DOS box open
        if (dl.length) { const d = dl[dl.length - 1]; await press(title && (d.title === title || /^MS-DOS/.test(title)) ? SC.enter : SC.n); await sleep(400); }
        else await sleep(60);
      }
      return gone();
    };
    bus("pv-command", [CMD_CLOSE, slot]);
    if (await wait(8000)) { row.close = "pass"; return true; }
    await chord(SC.alt, SC.f4);                 // no CMD_ACTIVATE first: SetActiveWindow on a dying task blocks PVMON
    if (await wait(8000)) { row.close = "pass:alt-f4"; return true; }
    row.close = "fail" + (title && st.layers.some(x => x.kind === "W" && x.title === title) ? ":still-published" : "");
    return false;
  };

  /* Anything on the desktop besides the shell is in the way of the next launch: a message box the
     last program left behind (Print Manager's "has been turned off" box is 924 wide, off the phone,
     so only the keyboard reaches it), a stray menu, a program that did not close. Front-most first:
     Enter (a #32770 message box's default button), then Esc, then CMD_CLOSE (N to a save prompt),
     then Alt+F4, each followed by a wait for a layout without it. Returns what was dismissed. */
  const dismissStrays = async (row, key = "stray") => {
    const removed = [];
    for (let round = 0; round < 8; round++) {
      const strays = st.layers.filter(L => L.kind !== "S");
      if (!strays.length) break;
      const L = strays[strays.length - 1];
      const tag = `${L.kind}${L.slot}:${(L.title || "?").slice(0, 24)}`;
      const gone = () => !st.layers.some(x => x.kind === L.kind && x.slot === L.slot && x.title === L.title);
      let how = null;
      for (const step of ["enter", "esc", "close", "alt-f4"]) {
        if (step === "enter") await press(SC.enter);
        else if (step === "esc") await press(SC.esc);
        else if (step === "close") { if (!(L.kind === "W" && L.slot >= 0)) continue; bus("pv-command", [CMD_CLOSE, L.slot]); }
        else await chord(SC.alt, SC.f4);
        const start = performance.now();
        while (performance.now() - start < 2500 && !gone()) {
          if (L.kind === "W" && step !== "enter" && dialogsOf(L.slot).length) await press(SC.n);
          await sleep(100);
        }
        if (gone()) { how = step; break; }
      }
      removed.push(`${tag}/${how || "stuck"}`);
      if (!how) break;
      await sleep(300);
    }
    if (removed.length && row) row[key] = (row[key] ? row[key] + "|" : "") + removed.join("|").replace(/\s+/g, "_");
    return removed;
  };

  /* ---- preamble */
  const hostReady = () => (env.hostState && env.hostState() && env.hostState().desktopReady) || st.desktopReady;
  if (!hostReady()) { bus("pv-command", [CMD_REPUBLISH, 0]); }
  if (!(await until(hostReady, opts.bootTimeout || 120000, 200))) {
    post(`TOUR-END pass=0 fail=1 error=desktop-not-ready`);
    clock.stop();
    return { rows: [], pass: 0, fail: 1, error: "desktop not ready" };
  }
  if (!st.shell.h && env.hostState) { const s = env.hostState(); if (s && s.shell) st.shell = { ...st.shell, ...s.shell }; }
  if (!st.shell.h) { bus("pv-command", [CMD_REPUBLISH, 0]); await until(() => st.shell.h, 5000); }
  /* PVMON publishes the layout only when it changes, so a tracker registered late knows nothing
     until something moves: ask for the full picture, then start from a clean desktop so windows
     already open (the page booted at /solitaire) can never be taken for the launched one. */
  if (env.hostState) { const s = env.hostState(); if (s && s.layers && !st.layers.length) st.layers = s.layers.slice(); }
  { const seq = st.pubSeq; bus("pv-command", [CMD_REPUBLISH, 0]); await until(() => st.pubSeq !== seq, 4000); }
  const preexisting = st.layers.filter(L => L.kind !== "S").map(L => `${L.kind}${L.slot}:${L.title}`);
  let cleaned = "none";
  if (preexisting.length) {
    const removed = await dismissStrays(null);
    cleaned = st.layers.some(l => l.kind !== "S") ? "fail:" + removed.join("|") : "ok:" + removed.join("|");
  }
  const mips0 = await mips();
  post(`TOUR-BEGIN apps=${apps.length} shell=${st.shell.w}x${st.shell.h} pvmon=v${st.shell.ver} mips=${mips0.toFixed(1)} clock=${clock.driven} dom=${!!env.dom} preexisting=${preexisting.length ? preexisting.join("|") : "-"} cleaned=${cleaned} ua=${env.ua}`);

  const rows = [];
  let dead = false;
  for (const app of apps) {
    const row = { app: app.name };
    const ta = performance.now();
    rows.push(row);
    if (dead) { row.launch = "skip"; continue; }
    try {
      if (st.layers.some(L => L.kind !== "S")) await dismissStrays(row);       // left by the last program
      const before = new Set(st.layers.filter(L => L.kind === "W").map(L => L.slot));
      const pubBefore = st.pubSeq, hbBefore = st.hb;
      /* PVMON must be polling (PVH about once a second) or CMD_RUN is never read. A stalled PVMON
         (seen after Print Manager's box was closed while PVMON was blocked in an inter-task call)
         resumed when Task List was opened, so that is the nudge; without a heartbeat afterwards the
         app is skipped at once instead of waiting 15 s for nothing. */
      const beat = async ms => { const h = st.hb; await until(() => st.hb !== h, ms, 100); return st.hb !== h; };
      if (!(await beat(2500))) {                    // Ctrl+Esc apps need PVMON too: it publishes the window
        await chord(SC.ctrl, SC.esc); await sleep(1500); await press(SC.esc); await sleep(500);
        const ok = await beat(3000);
        row.stall = "pvmon:no-heartbeat," + (ok ? "recovered-by-ctrl-esc" : "still-silent");
        if (!ok) { row.launch = "skip:pvmon-stalled"; row.alive = (await alive()) ? "pass" : "fail"; row.t = Math.round(performance.now() - ta); post("TOUR " + fmtRow(row)); continue; }
      }
      /* launch */
      if (app.keys === "ctrl-esc") await chord(SC.ctrl, SC.esc);
      else bus("pv-command-string", [CMD_RUN, app.cmd]);
      /* The launched program's window: by title, preferring a slot that was free before the
         launch; a new slot alone is the fallback (untitled or renamed windows). */
      const claimed = new Set(st.layers.filter(x => x.kind === "W").map(x => `${x.slot}:${x.title}`));
      const findWin = () => {
        const ws = st.layers.filter(x => x.kind === "W");
        return ws.find(x => !before.has(x.slot) && app.title && app.title.test(x.title))
            || ws.find(x => app.title && app.title.test(x.title) && !claimed.has(`${x.slot}:${x.title}`))
            || ws.find(x => !before.has(x.slot) && (!app.title || !ws.some(y => y !== x && !before.has(y.slot))));
      };
      const L = await until(findWin, app.timeout || 15000);
      row.match = L ? (app.title && app.title.test(L.title) ? "title" : "slot") : undefined;
      row.tLaunch = Math.round(performance.now() - ta);
      if (!L) {
        const x = st.layers.find(l => l.kind === "X");
        // "pvmon: run FOO.EXE -> N": WinExec's return, below 32 is an error (2 = file not found)
        const we = /-> (\d+)$/.exec(st.runs[st.runs.length - 1] || "");
        // something else on the desktop (a box the program itself put up, a leftover) is the likely
        // reason: name it rather than let every later launch time out behind it
        const blockers = st.layers.filter(l => l.kind !== "S").map(l => `${l.kind}${l.slot}:${(l.title || "?").slice(0, 24)}`);
        row.launch = x ? "fail:noslot" : we && +we[1] < 32 ? `fail:winexec=${we[1]}` : blockers.length ? "fail:blocked-by=" + blockers.join("|").replace(/\s+/g, "_") : "fail:timeout";
        // the command channel as the guest left it: cmd still set = PVMON never took it; a string
        // left behind = it took the command but not the text
        try { const v = emulator.v86.cpu.devices.vga; row.chan = `info:cmd=${v.pv_cmd},str=${v.pv_cmd_str.length},pvh=${st.hb - hbBefore},run=${(st.runs[st.runs.length - 1] || "-").replace(/^pvmon: run /, "").replace(/\s+/g, "_")}`; } catch (e) {}
        row.alive = (await alive()) ? "pass" : "fail";
        if (row.alive === "fail") dead = true;
        if (blockers.length) await dismissStrays(row);       // so the next app starts clean
        row.t = Math.round(performance.now() - ta);
        post("TOUR " + fmtRow(row));                          // timed-out rows are logged too
        continue;
      }
      row.launch = "pass";
      row.title = L.title;
      const born = { ...L };
      row.rect = `${born.wx},${born.wy},${born.ww},${born.wh}`;
      /* the invariant, on the first report of the window; fixed-layout programs are information */
      const fixed = !!app.fixed || FIXED_TITLES.test(born.title);
      const soft = fixed ? "info:fixed" : "fail";
      row.fit = born.ww <= SHELL_W && born.wh <= st.shell.h ? "pass" : `${soft}:${born.ww}x${born.wh}>${SHELL_W}x${st.shell.h}`;
      const sx = SLOT_W * (born.slot + 1);
      row.slot = born.wx >= sx && born.wx + born.ww <= sx + SLOT_W && born.wy >= 0 && born.wy + born.wh <= Math.max(st.shell.h, 970)
        ? "pass" : `fail:slot${born.slot}@${born.wx},${born.wy}`;
      /* the host's layer: never scaled below 1:1 */
      if (env.dom) {
        let h = await until(() => hostLayer("W", L.slot), 1500, 50);
        if (!h && env.present) { env.present(); await sleep(80); h = hostLayer("W", L.slot); }
        row.scale = !h ? "fail:nolayer" : h.s >= 0.999 ? "pass" : `${soft}:${h.s.toFixed(3)}`;
      } else row.scale = "-";
      await sleep(600);                                           // let it paint and settle
      /* a dialog the program opened on its own (Hearts' welcome box, an error) */
      let launchDlg = dialogsOf(L.slot);
      if (launchDlg.length && app.dialog !== "launch") {
        row.launchdlg = "info:" + launchDlg.map(d => d.title).join("|");
        await press(SC.esc); await until(() => !dialogsOf(L.slot).length, 3000);
      }
      /* tap into the client area through the same input path a finger takes */
      // PVK is only sent on change, so an edit control that already had the focus at launch
      // counts too: the question is whether the guest wants the keyboard after the tap.
      const tp = await tapClient(winOf(L.slot) || L);
      row.tap = tp.ok ? "pass" : "fail:" + tp.why;
      if (tp.ok) {
        const got = await until(() => st.kbd === 1, 3500, 50);
        row.kbd = app.text ? (got ? "pass" : "fail") : (got ? "info:wanted" : "-");
        if (env.dom && env.focusEvidence) row.focus = "info:" + env.focusEvidence();
      }
      /* one dialog, where cheap */
      if (app.dialog === "alt-f-o") {
        await chord(SC.alt, SC.f); await sleep(500); await press(SC.o);
        if (await until(() => dialogsOf(L.slot).length, 8000)) { await sleep(400); checkDialog(row, L); await press(SC.esc); }
        else row.dlg = "fail:timeout";
        row.dlgclose = (await until(() => !dialogsOf(L.slot).length, 5000)) ? "pass" : "fail";
        if (row.dlgclose === "fail") { await chord(SC.alt, SC.f4); await until(() => !dialogsOf(L.slot).length, 3000); }
      } else if (app.dialog === "pbrush") {
        await dragClient(winOf(L.slot) || L, 0.35, 0.55, 0.65, 0.6);
        await sleep(600);
        await chord(SC.alt, SC.f); await sleep(500); await press(SC.x);   // Exit: "Save current changes?"
        if (await until(() => dialogsOf(L.slot).length, 8000)) { await sleep(400); checkDialog(row, L); await press(SC.esc); }
        else row.dlg = "fail:timeout";
        row.dlgclose = (await until(() => !dialogsOf(L.slot).length, 5000)) ? "pass" : "fail";
      } else if (app.dialog === "launch") {
        if (!launchDlg.length) launchDlg = await until(() => dialogsOf(L.slot).length ? dialogsOf(L.slot) : null, 6000) || [];
        if (launchDlg.length) { checkDialog(row, L); await press(SC.enter); }
        else row.dlg = "fail:timeout";
        row.dlgclose = (await until(() => !dialogsOf(L.slot).length, 5000)) ? "pass" : "fail";
      }
      /* the window after all that: still inside the frame? */
      const now = winOf(L.slot);
      if (now && row.fit === "pass" && (now.ww > SHELL_W || now.wh > st.shell.h)) row.fit = `${soft}:grew:${now.ww}x${now.wh}`;
      /* close and confirm the guest survived */
      await closeApp(L.slot, row, L.title);
      if (env.dom) {
        const drawn = () => { if (env.present && typeof document !== "undefined" && document.hidden) env.present(); return hostLayer("W", L.slot); };
        row.layer = (await until(() => !drawn(), 2000, 100)) ? "pass" : "fail:still-drawn";
      }
      row.alive = (await alive()) ? "pass" : "fail";
      if (row.alive === "fail") dead = true;
      await sleep(300);
      if (st.layers.some(l => l.kind !== "S")) await dismissStrays(row);   // a box it left behind
      if (app.name === "DOSPRMPT") await sleep(1500);            // the DOS VM tears down slowly
    } catch (e) {
      row.error = "fail:" + (e && e.message || e);
    }
    row.t = Math.round(performance.now() - ta);
    post("TOUR " + fmtRow(row));
  }
  const mips1 = await mips();
  let pass = 0, fail = 0, skip = 0;
  for (const r of rows) for (const [k, v] of Object.entries(r)) {
    if (k === "app" || k === "t" || k === "tLaunch" || k === "rect" || k === "title") continue;
    if (v === "pass" || /^pass:/.test(v)) pass++; else if (/^fail/.test(v)) fail++; else if (/^skip/.test(v)) skip++;
  }
  const result = { rows, pass, fail, skip, dead, seconds: Math.round((performance.now() - t0) / 1000), mips: [mips0, mips1],
                   pvmon: st.shell.ver, shell: st.shell, ua: env.ua, dom: !!env.dom, clock: clock.driven };
  post(`TOUR-END pass=${pass} fail=${fail} skip=${skip} dead=${dead} time=${result.seconds}s mips=${mips0.toFixed(1)}/${mips1.toFixed(1)} pvmon=v${st.shell.ver} ua=${env.ua}`);
  clock.stop();
  return result;
}

export function fmtRow(r) {
  const order = ["launch", "match", "fit", "slot", "scale", "tap", "kbd", "focus", "launchdlg", "dlg", "dlg1", "dlgfit", "dlgsep", "dlgpix", "dlgclose", "close", "layer", "alive", "stray", "stall", "chan", "error"];
  const parts = [r.app.padEnd(8)];
  for (const k of order) if (r[k] !== undefined) parts.push(`${k}=${r[k]}`);
  if (r.t !== undefined) parts.push(`t=${r.t}`);
  if (r.tLaunch !== undefined) parts.push(`tl=${r.tLaunch}`);
  if (r.rect) parts.push(`rect=${r.rect}`);
  if (r.title) parts.push(`title="${r.title}"`);
  return parts.join(" ");
}

/* Plain-text table for a terminal or a log. */
export function table(result) {
  const cols = ["app", "launch", "fit", "slot", "scale", "tap", "kbd", "dlg", "dlg1", "dlgsep", "dlgpix", "dlgclose", "close", "alive", "t"];
  const cell = v => v === undefined ? "-" : String(v).replace(/^(pass|fail|info)(:.*)?$/, (m, a, b) => a === "pass" ? "ok" : a === "fail" ? "FAIL" + (b || "") : "i" + (b || ""));
  const rows = result.rows.map(r => cols.map(c => cell(r[c])));
  const widths = cols.map((c, i) => Math.min(28, Math.max(c.length, ...rows.map(r => r[i].length))));
  const line = r => r.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i])).join(" ");
  return [line(cols), ...rows.map(line), `pass=${result.pass} fail=${result.fail} skip=${result.skip} time=${result.seconds}s mips=${result.mips.map(m => m.toFixed(1)).join("/")} pvmon=v${result.pvmon}`].join("\n");
}

/* ------------------------------------------------------------------------------ browser env
 * Synthetic TouchEvents on #pres go through app.js's real touch handlers (hit test, absolute
 * pointer, click). On iOS a synthetic touch does not grant focus, so the keyboard evidence read
 * back from the DOM is informational; the guest's own PVK is the check. */
function browserEnv() {
  const pres = document.getElementById("pres");
  const kbd = document.getElementById("kbd");
  const emulator = window.emulator;
  const touch = (type, pts) => {
    const r = pres.getBoundingClientRect();
    const ts = pts.map((p, i) => new Touch({ identifier: i + 1, target: pres, clientX: r.left + p.x, clientY: r.top + p.y,
                                             pageX: r.left + p.x, pageY: r.top + p.y, screenX: r.left + p.x, screenY: r.top + p.y }));
    const live = type === "touchend" || type === "touchcancel" ? [] : ts;
    pres.dispatchEvent(new TouchEvent(type, { touches: live, targetTouches: live, changedTouches: ts, bubbles: true, cancelable: true }));
  };
  const clock = makeClock();
  const env = {
    emulator, dom: true, ua: navigator.userAgent,
    hostState: () => (window.pvState ? window.pvState() : null),
    /* rAF is asleep in a hidden tab, so app.js's `placed` goes stale: draw one frame by hand. present()
       re-arms itself with requestAnimationFrame, which is stubbed out for the call so the page does not
       end up with a second render loop once it is visible again. */
    present: () => {
      if (!window.pvPresent) return;
      const raf = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 0;
      try { window.pvPresent(); } finally { window.requestAnimationFrame = raf; }
    },
    post: line => fetch("/__log", { method: "POST", body: line, keepalive: true }).catch(() => {}),
    tap: async (x, y) => { touch("touchstart", [{ x, y }]); await clock.sleep(70); touch("touchend", [{ x, y }]); await clock.sleep(1500); },
    drag: async (x0, y0, x1, y1) => {
      touch("touchstart", [{ x: x0, y: y0 }]); await clock.sleep(80);
      for (let i = 1; i <= 6; i++) { touch("touchmove", [{ x: x0 + (x1 - x0) * i / 6, y: y0 + (y1 - y0) * i / 6 }]); await clock.sleep(50); }
      touch("touchend", [{ x: x1, y: y1 }]); await clock.sleep(1800);
    },
    focusEvidence: () => {
      const vv = window.visualViewport;
      return `active=${document.activeElement === kbd ? "kbd" : (document.activeElement && document.activeElement.tagName || "none").toLowerCase()},vvh=${vv ? Math.round(vv.height) : "?"},ih=${window.innerHeight},hidden=${document.hidden}`;
    },
    /* Host-side double dialog: within the owner's layer on #pres, outside the dialog's layer, is
       there a run of the dialog's caption colour wide enough to be a second caption? */
    doubleCaption: (owner, dlg) => {
      if (!owner || !dlg || !pres.width) return null;
      const dpr = pres.width / pres.getBoundingClientRect().width || 1;
      const g = pres.getContext("2d");
      const capH = Math.round(dlg.capRow * dlg.c);
      const row = g.getImageData(Math.round(dlg.x * dpr), Math.round((dlg.y + capH / 2) * dpr), Math.max(1, Math.round(dlg.hw * dpr)), 1).data;
      const hist = new Map();
      for (let i = 0; i < row.length; i += 4) { const k = (row[i] << 16 | row[i + 1] << 8 | row[i + 2]); hist.set(k, (hist.get(k) || 0) + 1); }
      let cap = 0, best = 0; for (const [k, n] of hist) if (n > best) { best = n; cap = k; }
      const img = g.getImageData(Math.round(owner.x * dpr), Math.round(owner.y * dpr), Math.round(owner.hw * dpr), Math.round(owner.hh * dpr));
      const W = img.width, need = Math.round(120 * dpr);
      for (let y = 0; y < img.height; y++) {
        const hy = owner.y + y / dpr;
        if (hy >= dlg.y && hy < dlg.y + dlg.hh) { /* rows the dialog covers: only look outside its x range */ }
        let run = 0;
        for (let x = 0; x < W; x++) {
          const hx = owner.x + x / dpr;
          const inDlg = hx >= dlg.x && hx < dlg.x + dlg.hw && hy >= dlg.y && hy < dlg.y + dlg.hh;
          const i = (y * W + x) * 4;
          const k = img.data[i] << 16 | img.data[i + 1] << 8 | img.data[i + 2];
          run = (!inDlg && k === cap) ? run + 1 : 0;
          if (run >= need) return true;
        }
      }
      return false;
    },
  };
  return env;
}

/* Entry point for the page. Options come from the URL as well: ?selftest=1&apps=NOTEPAD,CALC
   &pixels=1&lenient=1. Waits for the emulator if app.js has not created it yet. */
export async function run(opts = {}) {
  const p = new URLSearchParams(location.search);
  if (p.get("apps") && !opts.apps) opts.apps = p.get("apps").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (p.get("pixels") && opts.pixels === undefined) opts.pixels = true;
  if (p.get("skip") && !opts.skip) opts.skip = p.get("skip").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (p.get("lenient") && opts.strictDialogs === undefined) opts.strictDialogs = false;
  const t0 = performance.now();
  while (!window.emulator || !window.emulator.v86) { if (performance.now() - t0 > 60000) throw new Error("no emulator"); await new Promise(r => setTimeout(r, 200)); }
  const env = browserEnv();
  window.tourRunning = true;
  try {
    const result = await tour(env, opts);
    window.tourResult = result;
    return result;
  } finally { window.tourRunning = false; }
}
