/* responsive-wfw311 - the browser side.
 *
 * Runs Windows for Workgroups 3.11 in v86 on a paravirtual display adapter whose mode follows
 * the viewport (SPEC.md 2.7, 2.8). Also handles touch, the on-screen keyboard, and snapshots.
 */
import { V86 } from "../v86/src/browser/starter.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const IMAGE = params.get("hda") || "../image/work-live.img";

/* ---------------------------------------------------------------- mode selection (SPEC 2.8)
 * The emulated mode tracks the viewport rather than snapping to fixed breakpoints. Windows 3.x
 * needs room, so on small screens the emulated pixel scale shrinks instead of the mode.
 */
/* Mode selection.
 *
 * Windows needs roughly 640 columns: its dialogs are fixed templates and the common File Open
 * dialog alone wants about 620 pixels. A phone in portrait is only about 375 points wide, so
 * those 640 columns land at 0.59 points each and the result is hard to read. There is no way
 * round that in portrait; the honest options are a stable screen with small text, or a small
 * readable desktop whose screen has to widen whenever something needs the room.
 *
 * So a narrow screen gets a narrow desktop, which is what makes the interface readable, and
 * PVMON reflows any dialog that does not fit into it: controls that fall off the edge move into
 * rows underneath, nothing is scaled and no text is clipped. No zooming, no panning, and no
 * resizing the screen underneath whatever is open.
 */
function viewport() {
  const vv = window.visualViewport;
  let w = vv ? vv.width : window.innerWidth;
  let h = vv ? vv.height : window.innerHeight;
  if (!(w > 0) || !(h > 0)) { w = 1024; h = 768; }   // a hidden page can report nothing
  return [w, h];
}

// Magnification: `zoom` multiplies the fit scale. On a narrow screen it is driven by how much
// of the screen the guest says has content on it, so the view frames the content by itself.
let zoom = 1;
let autoZoom = true;
const ZOOM_MIN = 0.5, ZOOM_MAX = 6;

const MIN_W = 640, MIN_H = 400, MAX_W = 2560, MAX_H = 1600;

/* Layout of the virtual screen on a narrow display:
 *
 *   +-----------+----------+----------+  <- each column is 640 wide, always, so applications
 *   | shell     | app slot | app slot |     lay out as they were designed to
 *   | SHELL_W   | 0        | 1        |
 *   +-----------+----------+----------+
 *
 * The shell column is the desktop. Every application window is parked in a column of its own,
 * in screen space the desktop view never draws. The host then composites: the shell fills the
 * viewport as the background, and each application's CLIENT area is drawn over the top at its
 * own scale, under a title bar the host draws itself in host pixels. So several windows are
 * visible at once, their contents shrink to fit a phone, and their chrome stays finger-sized
 * and crisp instead of shrinking with them. Windows itself sees none of this: as far as it is
 * concerned the windows sit side by side on one wide screen.
 */
const pageStart = performance.now();
const SHELL_W = 448;             // width of the shell column on a narrow display
const SLOT_W = 640;              // width of each application column (must match pvmon.c)
const MAX_SLOTS = 3;             // application columns (must match pvmon.c)
const WIN_MARGIN = 8;

/* A phone in either orientation. The guest layout is fixed (the boot snapshot bakes it in), so
   turning the phone must never re-mode the guest: only the host layout changes. */
function narrow() { const [vw, vh] = viewport(); return Math.min(vw, vh) < 600; }
const SHELL_H = 970;             // shell column height, fixed so the boot snapshot always fits

function computeMode() {
  const [vw, vh] = viewport();
  if (narrow()) return { w: SLOT_W * (1 + MAX_SLOTS), h: SHELL_H, zoom: 1, shellH: SHELL_H };
  let scale = Math.max(1, MIN_W / vw, MIN_H / vh);
  scale = Math.min(scale, MAX_W / vw, MAX_H / vh);
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.floor(vw * scale / 8) * 8));
  const h = Math.max(MIN_H, Math.min(MAX_H, Math.floor(vh * scale / 2) * 2));
  return { w, h, zoom: scale, shellH: 0 };
}

const initial = computeMode();
// DPI is fixed for a session: Windows 3.x cannot change font metrics on the fly, and PVDPI.EXE
// picks the matching SYSTEM.INI at each Windows start.
const dpi = params.get("dpi") ? +params.get("dpi") : (viewport()[0] < 600 ? 120 : 96);
/* Local snapshots are keyed by the image's identity (size and modification time from the
   server), not just its name: a snapshot of an older build of the image restores a guest whose
   PVMON and screen layout no longer match this page, and it looks like a hang. */
let stateKey = `wfw311:${IMAGE}:${dpi}`;
const stateKeyReady = fetch(IMAGE, { method: "HEAD" })
  .then(r => { stateKey += `:${r.headers.get("content-length")}:${r.headers.get("last-modified")}`; })
  .catch(() => {});

/* ------------------------------------------------------------------------------- snapshots
 * Mobile browsers evict background tabs, so the VM is saved on hide and restored on load.
 */
const DB = "responsive-wfw311";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("state");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function saveState(emulator) {
  try {
    await stateKeyReady;
    const raw = await emulator.save_state();
    let blob = new Blob([raw]);
    if (typeof CompressionStream === "function") {
      blob = await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob();
    }
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put({ blob, at: Date.now() }, stateKey);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    status(`saved ${(blob.size / 1048576).toFixed(1)} MB`);
  } catch (e) { status("save failed: " + e.message); }
}
async function loadState() {
  try {
    await stateKeyReady;
    const db = await idb();
    const rec = await new Promise((res, rej) => {
      const tx = db.transaction("state", "readonly");
      const q = tx.objectStore("state").get(stateKey);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
    if (!rec) return null;
    let blob = rec.blob;
    if (typeof DecompressionStream === "function") {
      blob = await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).blob();
    }
    return await blob.arrayBuffer();
  } catch (e) { return null; }
}
let restored = false;
async function loadShippedState() {
  try {
    const r = await fetch(`../image/boot.state.gz?v=${encodeURIComponent(IMAGE)}`);
    if (!r.ok) return null;
    let blob = await r.blob();
    if (typeof DecompressionStream === "function" && !/gzip/.test(r.headers.get("content-encoding") || "")) {
      blob = await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).blob();
    }
    return await blob.arrayBuffer();
  } catch (e) { return null; }
}
/* Producing the shipped snapshot: visit with ?fresh=1&mkstate=1, and once the desktop has been
   arranged the state is gzipped and posted to the dev server, which writes image/boot.state.gz. */
async function uploadBootState() {
  try {
    await new Promise(r => setTimeout(r, 4000));                  // let the desktop settle
    const raw = await emulator.save_state();
    let blob = new Blob([raw]);
    blob = await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob();
    const r = await fetch("/__state", { method: "POST", body: blob });
    status("boot snapshot: " + await r.text());
  } catch (e) { status("snapshot failed: " + e.message); }
}
async function clearState() {
  await stateKeyReady;
  const db = await idb();
  await new Promise(res => {
    const tx = db.transaction("state", "readwrite");
    tx.objectStore("state").delete(stateKey);
    tx.oncomplete = res;
  });
  status("snapshot cleared");
}

/* ----------------------------------------------------------------------------------- boot */
const emulator = new V86({
  wasm_path: "../v86/build/v86.wasm",
  memory_size: 32 * 1024 * 1024,
  vga_memory_size: 8 * 1024 * 1024,
  screen_container: $("screen_container"),
  bios: { url: "../v86/bios/seabios.bin" },
  vga_bios: { url: "../v86/bios/vgabios.bin" },
  hda: { url: IMAGE, async: true, fixed_chunk_size: 256 * 1024, heads: 16, sectors_per_track: 32 },
  boot_order: 0x132,
  autostart: false,
});
window.emulator = emulator;

function status(msg) { $("status").textContent = msg; }

emulator.add_listener("emulator-ready", async () => {
  emulator.bus.send("pv-set-dpi", dpi);
  requestMode(true);
  /* Order of preference: the visitor's own snapshot (saved on hide), then the shipped boot
     snapshot (the desktop already up, so a cold visit takes seconds instead of a minute), then a
     real boot. After any restore PVMON is asked to describe the layout again, since the host has
     no memory of it. */
  let snap = params.get("fresh") ? null : await loadState();
  if (!snap && !params.get("fresh") && !params.get("mkstate")) snap = await loadShippedState();
  if (snap) {
    try {
      await emulator.restore_state(snap);
      status("restored");
      restored = true;
    } catch (e) { status("restore failed, cold boot"); }
  } else {
    status("booting");
  }
  emulator.run();
  if (restored) setTimeout(() => sendCommand(CMD_REPUBLISH, 0), 300);
});

emulator.add_listener("screen-set-size", s => {
  $("mode").textContent = `${s[0]}x${s[1]}`;
  emulator.screen_set_scale(1, 1);
  fitCanvas();
  // Give the guest a moment to paint the new size, then drop the held frame.
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { const h = $("hold"); if (h) h.hidden = true; }, 900);
});

/* The guest reports where it thinks the pointer is, which is what lets a tap become the right
   relative motion for the stock PS/2 mouse driver (SPEC 2.5). */
let guestCursor = null;
emulator.bus.register("pv-cursor", xy => { guestCursor = { x: xy[0], y: xy[1] }; });

/* What the guest says is where: the shell column's size, and one entry per top-level window,
   back to front, each with the rectangle it occupies in guest screen space.
     PVW slot ...   application, parked in a slot column
     PVO slot ...   window owned by the application in that slot (dialog, message box)
     PVT ...        transient (menu, drop-down, Alt+Tab switcher): drawn 1:1 where it popped up
     PVX ...        application that got no slot (all columns taken)
     PVI slot title minimised application, offered in the dock
     PVA            the shell has been arranged: the desktop is ready to show */
let shell = { w: SHELL_W, h: 0, cap: 18 };
let layers = [];
let dock = [];
let desktopReady = false;
let pendingLayers = null, pendingDock = null;
const layerPos = {};                 // layer key -> host position, moved by dragging

const pvLog = [];
window.pvState = () => ({ shell, layers, dock, placed, view, desktopReady, log: pvLog.slice(-40) });
emulator.bus.register("pv-debug", line => {
  pvLog.push(line);
  let m = /^PVD (\d+) (\d+)(?: (\d+))?/.exec(line);
  if (m) { shell = { w: +m[1], h: +m[2], cap: +m[3] || 18 }; return; }
  m = /^PVK (\d)/.exec(line);
  if (m) { wantKeyboard = m[1] === "1"; syncKeyboard(); return; }
  if (/^PVA/.test(line)) {
    desktopReady = true;
    if (params.get("mkstate") && !restored) { uploadBootState(); return; }
    launchFromUrl();
    return;
  }
  if (/^PVB /.test(line)) { pendingLayers = []; pendingDock = []; return; }
  m = /^PV([WOTX]) (-?\d+) (-?\d+) (-?\d+) (\d+) (\d+) (-?\d+) (-?\d+) (\d+) (\d+) ?(.*)$/.exec(line);
  if (m && pendingLayers) {
    pendingLayers.push({
      kind: m[1], slot: +m[2], wx: +m[3], wy: +m[4], ww: +m[5], wh: +m[6],
      gx: +m[7], gy: +m[8], gw: +m[9], gh: +m[10], title: m[11] || "",
    });
    return;
  }
  m = /^PVI (-?\d+) ?(.*)$/.exec(line);
  if (m && pendingDock) { pendingDock.push({ slot: +m[1], title: m[2] || "Window" }); return; }
  if (/^PVE/.test(line) && pendingLayers) {
    layers = pendingLayers; dock = pendingDock; pendingLayers = pendingDock = null;
    const live = new Set(layers.map(layerKey));
    for (const k of Object.keys(layerPos)) if (!live.has(k)) delete layerPos[k];
  }
});

/* Applications by URL: /solitaire opens Solitaire. The path (or ?run=) names an entry in this
   table; the command line is handed to the guest the moment the desktop is ready. */
const APPS = {
  solitaire: "SOL.EXE", sol: "SOL.EXE", hearts: "MSHEARTS.EXE", minesweeper: "WINMINE.EXE",
  paintbrush: "PBRUSH.EXE", paint: "PBRUSH.EXE", write: "WRITE.EXE", notepad: "NOTEPAD.EXE",
  calc: "CALC.EXE", calculator: "CALC.EXE", clock: "CLOCK.EXE", cardfile: "CARDFILE.EXE",
  calendar: "CALENDAR.EXE", terminal: "TERMINAL.EXE", recorder: "RECORDER.EXE",
  filemanager: "WINFILE.EXE", files: "WINFILE.EXE", controlpanel: "CONTROL.EXE",
  charmap: "CHARMAP.EXE", pifedit: "PIFEDIT.EXE", setup: "SETUP.EXE", winver: "WINVER.EXE",
  chat: "WINCHAT.EXE", mail: "MSMAIL.EXE", schedule: "SCHDPLUS.EXE", help: "WINHELP.EXE",
};
let launched = false;
function launchFromUrl() {
  if (launched) return;
  launched = true;
  const q = new URLSearchParams(location.search).get("run");
  const seg = location.pathname.split("/").filter(Boolean).pop() || "";
  const key = (q || (/^[a-z]+$/i.test(seg) && !/\./.test(seg) ? seg : "")).toLowerCase();
  const cmd = APPS[key] || (q && /^[A-Z0-9_.\\: -]+$/i.test(q) ? q : null);
  if (cmd) emulator.bus.send("pv-command-string", [CMD_RUN, cmd]);
}

/* The soft keyboard follows the guest: when an edit control takes the focus the hidden input is
   focused, which summons the platform keyboard, and it is blurred when the focus leaves. iOS only
   lets a page focus an input inside a user gesture, so the touch handlers also call this at the
   end of a tap, by which time PVMON has usually reported the new focus. */
let wantKeyboard = false;
function syncKeyboard() {
  const inp = $("kbd");
  if (!inp) return;
  if (wantKeyboard && document.activeElement !== inp) { inp.value = ""; inp.focus({ preventScroll: true }); }
  else if (!wantKeyboard && document.activeElement === inp) inp.blur();
}
const CMD_SCROLL = 7;

function layerKey(L) { return L.kind === "W" ? "s" + L.slot : L.kind + ":" + L.title; }
function sendCommand(cmd, slot) { emulator.bus.send("pv-command", [cmd, slot]); }
const CMD_ACTIVATE = 1, CMD_RESTORE = 2, CMD_CLOSE = 3, CMD_MINIMIZE = 4, CMD_RUN = 5, CMD_REPUBLISH = 6;

/* The desktop view: which slice of the guest screen is the background, and at what scale. */
let view = { x: 0, y: 0, w: 0, h: 0, scale: 1, ox: 0 };
let placed = [];                     // the composited windows, as drawn, front-most last

function chooseView(src) {
  const [vw, vh] = viewport();
  if (!narrow() || !shell.h) {                      // wide display: just show the whole screen
    const scale = Math.min(vw / src.width, vh / src.height);
    return { x: 0, y: 0, w: src.width, h: src.height, scale, ox: 0 };
  }
  const scale = Math.min(vw / shell.w, vh / shell.h);
  return { x: 0, y: 0, w: shell.w, h: shell.h, scale,
           ox: Math.round((vw - shell.w * scale) / 2) };
}

/* Where each window lands on the host, and how its chrome is cut up.

   The chrome is the guest's own pixels, drawn at the same scale as the desktop behind it (the
   shell column's scale, `view.scale`), nearest-neighbour, so every caption, menu bar and system
   box on screen is the same size, however much the client area inside has to shrink to fit. The
   caption row is composited in three pieces: the system box on the left and the minimise and
   maximise boxes on the right keep their corners untouched, and the strip of caption between
   them is cropped around its centre. The menu row below is drawn from the left and cropped,
   since menu titles are left-aligned.

   Owned windows are centred over their owner's layer. Transient windows are drawn at the chrome
   scale at the point they popped up, mapped through whichever layer's column they popped up in,
   so a menu hangs off its menu bar even though the bar's window is scaled. */
function placeLayers(src) {
  const [vw, vh] = viewport();
  const out = [];
  const bySlot = {};
  const screenW = src.width;
  const c = view.scale;                              // chrome scale: same as the desktop's
  layers.forEach((L, i) => {
    const key = layerKey(L);
    // A dialog owned by the shell already shows in the desktop column at desktop scale, and
    // PVMON reflows it to fit there; a second copy as a layer would be a double image.
    if (L.kind === "O" && L.slot < 0) return;
    if (L.kind === "T") {
      const hw = Math.round(L.ww * c), hh = Math.round(L.wh * c);
      let x, y;
      const centred = Math.abs(L.wx + L.ww / 2 - screenW / 2) < 8;      // the Alt+Tab switcher
      const col = Math.floor(L.wx / SLOT_W);
      const owner = col >= 1 ? bySlot[col - 1] : null;
      if (centred) { x = Math.round((vw - hw) / 2); y = Math.round((vh - hh) / 2); }
      else if (owner) {
        x = Math.round(owner.x + owner.hl + (L.wx - owner.gx) * owner.s);
        y = L.wy < owner.gy
          ? Math.round(owner.y + (L.wy - owner.wy) * c)                   // hangs off the chrome
          : Math.round(owner.y + owner.ht + (L.wy - owner.gy) * owner.s);
      } else { x = Math.round(view.ox + L.wx * c); y = Math.round(L.wy * c); }
      x = Math.max(0, Math.min(vw - hw, x));
      y = Math.max(0, Math.min(vh - hh, y));
      out.push({ ...L, key, s: c, c, cw: hw, ch: hh, hw, hh, x, y, hl: 0, ht: 0, hb: 0,
                 inset: { l: 0, t: 0, b: 0 }, capRow: 0, menuRow: 0, box: 0, transient: true });
      return;
    }
    const inset = {                                  // frame thickness in guest pixels
      l: Math.max(0, L.gx - L.wx),
      t: Math.max(0, L.gy - L.wy),
      b: Math.max(0, (L.wy + L.wh) - (L.gy + L.gh)),
    };
    const capRow = Math.min(inset.t, inset.l + shell.cap);   // border plus caption
    const menuRow = inset.t - capRow;                        // menu bar, if the window has one
    const box = Math.max(12, shell.cap);                     // a caption box is square
    const hl = Math.round(inset.l * c), ht = Math.round(inset.t * c), hb = Math.round(inset.b * c);
    const availW = vw - 2 * WIN_MARGIN - 2 * hl;
    const availH = vh - 2 * WIN_MARGIN - ht - hb;
    const s = Math.min(c, availW / Math.max(1, L.gw), availH / Math.max(1, L.gh));
    const cw = Math.round(L.gw * s), ch = Math.round(L.gh * s);
    const hw = cw + 2 * hl, hh = ch + ht + hb;
    let p = layerPos[key];
    if (!p) {
      const owner = L.kind === "O" ? bySlot[L.slot] : null;
      p = layerPos[key] = owner
        ? { x: Math.round(owner.x + (owner.hw - hw) / 2), y: Math.round(owner.y + (owner.hh - hh) / 2) }
        : { x: Math.round((vw - hw) / 2) + i * 16, y: Math.round(vh * 0.12) + i * 16 };
    }
    // A window that fits stays entirely on screen; one that does not may hang off the edges, but
    // never so far that less than a thumb's width of it is left to grab.
    const x = hw <= vw ? Math.max(0, Math.min(vw - hw, p.x)) : Math.max(40 - hw, Math.min(vw - 40, p.x));
    const y = Math.max(0, Math.min(vh - Math.round(capRow * c), p.y));
    const w = { ...L, key, s, c, cw, ch, hw, hh, x, y, inset, capRow, menuRow, box, hl, ht, hb };
    if (L.kind === "W") bySlot[L.slot] = w;
    out.push(w);
  });
  return out;
}

/* Hit test in host pixels, front-most first. Everything on a window except the middle of its
   caption is a real guest click at the mapped pixel, so the system box, the minimise and
   maximise boxes and the menus all behave exactly as they do on the desktop. The caption between
   those boxes is the drag handle, and dragging it only changes where the host draws the layer. */
function hitTest(px, py) {
  for (let i = placed.length - 1; i >= 0; i--) {
    const w = placed[i];
    if (px < w.x || px > w.x + w.hw) continue;
    if (py < w.y || py > w.y + w.hh) continue;
    const dx = px - w.x, dy = py - w.y;
    if (w.transient)
      return { kind: "chrome", win: w, x: Math.round(w.wx + dx / w.c), y: Math.round(w.wy + dy / w.c) };
    if (dy >= w.ht && dy < w.ht + w.ch && dx >= w.hl && dx < w.hl + w.cw) {
      return { kind: "client", win: w,
               x: Math.round(w.gx + (dx - w.hl) / w.s),
               y: Math.round(w.gy + (dy - w.ht) / w.s) };
    }
    const capH = Math.round(w.capRow * w.c), boxW = Math.round(w.box * w.c);
    if (dy < capH) {                                  // caption row: boxes click, middle drags
      const leftEnd = w.hl + boxW;
      const rightStart = w.hw - w.hl - 2 * boxW;
      if (dx < leftEnd) return { kind: "chrome", win: w, x: Math.round(w.wx + dx / w.c), y: Math.round(w.wy + dy / w.c) };
      if (dx >= rightStart)
        return { kind: "chrome", win: w, x: Math.round(w.wx + w.ww - (w.hw - dx) / w.c), y: Math.round(w.wy + dy / w.c) };
      return { kind: "drag", win: w };
    }
    if (dy < w.ht)                                    // menu row is drawn from the left
      return { kind: "chrome", win: w, x: Math.round(w.wx + dx / w.c), y: Math.round(w.wy + dy / w.c) };
    return { kind: "drag", win: w };                  // the frame itself drags, like the caption
  }
  return { kind: "desktop",
           x: Math.round(view.x + (px - view.ox) / view.scale),
           y: Math.round(view.y + py / view.scale) };
}

function drawWindow(g, src, w) {
  const c = w.c;
  if (w.transient) {
    g.imageSmoothingEnabled = false;
    g.drawImage(src, w.wx, w.wy, w.ww, w.wh, w.x, w.y, w.hw, w.hh);
    return;
  }
  const { inset, capRow, menuRow, box, hl, ht, hb } = w;
  const capH = Math.round(capRow * c), menuH = ht - capH;
  const cornerL = Math.round((inset.l + box) * c), cornerR = Math.round((inset.l + 2 * box) * c);
  const midSrcW = w.ww - 2 * inset.l - 3 * box;       // the caption strip between the boxes
  const midDstW = w.hw - cornerL - cornerR;

  g.imageSmoothingEnabled = false;
  g.drawImage(src, w.wx, w.wy, inset.l + box, capRow, w.x, w.y, cornerL, capH);
  g.drawImage(src, w.wx + w.ww - inset.l - 2 * box, w.wy, inset.l + 2 * box, capRow,
              w.x + w.hw - cornerR, w.y, cornerR, capH);
  if (midSrcW > 0 && midDstW > 0) {
    const need = midDstW / c;                         // guest pixels that fit in the gap
    if (need <= midSrcW) {
      /* Cropped rather than squeezed: equal slivers of empty caption come off each side and the
         title, which Windows centres, stays centred, at its own size and perfectly crisp. */
      const cut = Math.floor((midSrcW - need) / 2);
      g.drawImage(src, w.wx + inset.l + box + cut, w.wy, Math.round(need), capRow,
                  w.x + cornerL, w.y, midDstW, capH);
    } else {                                          // wider on the host: pad, do not stretch
      const midH = Math.round(midSrcW * c), pad = midDstW - midH;
      g.drawImage(src, w.wx + inset.l + box, w.wy, 2, capRow, w.x + cornerL, w.y, pad, capH);
      g.drawImage(src, w.wx + inset.l + box, w.wy, midSrcW, capRow, w.x + cornerL + pad, w.y, midH, capH);
    }
  }
  if (menuRow > 0 && menuH > 0) {
    const mwG = Math.min(w.ww, Math.round(w.hw / c)), mwH = Math.round(mwG * c);
    g.drawImage(src, w.wx, w.wy + capRow, mwG, menuRow, w.x, w.y + capH, mwH, menuH);
    if (w.hw > mwH)                                   // pad with the menu bar's own background
      g.drawImage(src, w.wx + mwG - 2, w.wy + capRow, 2, menuRow, w.x + mwH, w.y + capH, w.hw - mwH, menuH);
  }
  if (hl > 0) {                                       // side borders, stretched only lengthways
    g.drawImage(src, w.wx, w.gy, inset.l, w.gh, w.x, w.y + ht, hl, w.ch);
    g.drawImage(src, w.gx + w.gw, w.gy, inset.l, w.gh, w.x + hl + w.cw, w.y + ht, hl, w.ch);
  }
  if (hb > 0)
    g.drawImage(src, w.wx, w.gy + w.gh, Math.min(w.ww, Math.round(w.hw / c)), inset.b,
                w.x, w.y + ht + w.ch, w.hw, hb);
  g.imageSmoothingEnabled = w.s < 1;                  // the client, at the scale that fits
  g.drawImage(src, w.gx, w.gy, w.gw, w.gh, w.x + hl, w.y + ht, w.cw, w.ch);
}

function present() {
  const src = document.querySelector("#screen_container canvas");
  const pres = $("pres");
  if (src && src.width && pres) {
    const [vw, vh] = viewport();
    const dpr = window.devicePixelRatio || 1;
    if (pres.width !== Math.round(vw * dpr) || pres.height !== Math.round(vh * dpr)) {
      pres.width = Math.round(vw * dpr); pres.height = Math.round(vh * dpr);
      pres.style.width = vw + "px"; pres.style.height = vh + "px";
    }
    view = chooseView(src);
    const g = pres.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#000";
    g.fillRect(0, 0, vw, vh);
    /* Until the shell has been arranged, show the whole guest screen (DOS, the Windows logo)
       rather than the desktop column: the user should not watch Program Manager being resized,
       and nothing drawn here is ever the host's own. A long timeout guards a guest that never
       reports in. */
    if (narrow() && !desktopReady && performance.now() - pageStart < 90000) {
      const sc = Math.min(vw / src.width, vh / src.height);
      view = { x: 0, y: 0, w: src.width, h: src.height, scale: sc, ox: Math.round((vw - src.width * sc) / 2) };
    }
    {
      const dw = view.w * view.scale, dh = view.h * view.scale;
      g.drawImage(src, view.x, view.y, view.w, view.h, view.ox, 0, Math.round(dw), Math.round(dh));
      placed = narrow() ? placeLayers(src) : [];
      for (const w of placed) drawWindow(g, src, w);  // back to front
    }
  }
  requestAnimationFrame(present);
}
requestAnimationFrame(present);
window.pvPresent = present;
window.pvGuestCursor = () => guestCursor;

/* ------------------------------------------------------------------------- mode controller */
/* A mode change tears down the canvas and the guest repaints from scratch, so the screen goes
   blank for a moment. Hold the last frame over the top until the new one has been painted, so a
   resize dissolves into the new size instead of flashing through black. */
let holdTimer = 0;
function holdLastFrame() {
  const c = document.querySelector("#screen_container canvas");
  const hold = $("hold");
  if (!c || !c.width || !hold) return;
  try {
    hold.width = c.width; hold.height = c.height;
    hold.getContext("2d").drawImage(c, 0, 0);
    hold.style.width = c.style.width; hold.style.height = c.style.height;
    hold.hidden = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { hold.hidden = true; }, 1400);
  } catch (e) { hold.hidden = true; }
}

let lastReq = null;
function requestMode(force) {
  const { w, h, zoom: scale } = computeMode();
  if (!force && lastReq && Math.abs(lastReq.w - w) < 8 && Math.abs(lastReq.h - h) < 8) return;
  lastReq = { w, h };
  holdLastFrame();
  emulator.bus.send("pv-request-mode", [w, h]);
  $("zoom").textContent = scale === 1 ? "" : `scale ${scale.toFixed(2)}`;
  fitCanvas();
}
// The debounce deliberately avoids setTimeout: a hidden page throttles timers almost to a
// stop, so a resize while backgrounded would never be acted on. Everything time-based here is
// driven from the pump below, which also runs off a worker heartbeat.
let pending = null, pendingSince = 0;
function pump() {
  fitCanvas();
  const m = computeMode();
  if (!pending || pending.w !== m.w || pending.h !== m.h) { pending = m; pendingSince = performance.now(); return; }
  if (performance.now() - pendingSince < 300) return;                     // still settling
  if (lastReq && lastReq.w === m.w && lastReq.h === m.h) return;          // already asked
  requestMode(true);
}
(window.visualViewport || window).addEventListener("resize", pump);
window.addEventListener("orientationchange", pump);
window.addEventListener("resize", pump);
(function raf() { if (!document.hidden) pump(); requestAnimationFrame(raf); })();

/* Display scale.
 *
 * Windows needs at least 640 columns to be usable, but a phone is only about 375 points wide,
 * so fitting the whole desktop on screen shrinks every emulated pixel to well under a point and
 * the result is unreadable. Magnification is therefore a first-class control rather than an
 * afterthought: the canvas is drawn at `fit * zoom`, and anything larger than the viewport is
 * pannable. The 120 dpi font set that PVDPI selects at phone widths does the rest.
 */

function fitScale(c) {
  const [vw, vh] = viewport();
  return Math.min(vw / c.width, vh / c.height);
}

function fitCanvas() {
  const c = document.querySelector("#screen_container canvas");
  if (!c || !c.width) return;
  const scale = fitScale(c) * zoom;
  const w = Math.round(c.width * scale), h = Math.round(c.height * scale);
  if (c.style.width === w + "px" && c.style.height === h + "px") return;
  c.style.width = w + "px";
  c.style.height = h + "px";
  c.style.imageRendering = scale >= 1 && Number.isInteger(scale) ? "pixelated" : "auto";
  $("zoom").textContent = zoom === 1 ? "" : zoom.toFixed(1) + "x";
}

function setZoom(z, anchor) {
  autoZoom = false;                    // a deliberate zoom takes over from the automatic one
  const c = document.querySelector("#screen_container canvas");
  const box = $("screen_container");
  const before = c ? fitScale(c) * zoom : 1;
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  fitCanvas();
  if (c && anchor) {                     // keep the anchor point under the finger
    const after = fitScale(c) * zoom;
    box.scrollLeft = (box.scrollLeft + anchor.x) * (after / before) - anchor.x;
    box.scrollTop = (box.scrollTop + anchor.y) * (after / before) - anchor.y;
  }
}

/* ------------------------------------------------------------------------ touch (SPEC 2.5)
 * PS/2 is relative, so pointing is done by steering the guest cursor towards the target using
 * the position the driver reports, correcting a few times to absorb any scaling.
 */


const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Steer the guest pointer to a point. The stock PS/2 driver is relative, so the whole distance
   is sent as one burst of packets (mouse acceleration is off, so mickeys are pixels), then the
   position the driver reports is checked and corrected a couple of times. Targets are coalesced:
   a drag that produces fifty moves steers towards the latest one, never queues them. */
let steerTarget = null, steering = null;

function steerTo(pt) {
  steerTarget = pt;
  if (!steering) steering = (async () => {
    try {
      for (let i = 0; i < 6 && steerTarget; i++) {
        if (!guestCursor) { emulator.bus.send("mouse-delta", [1, 0]); await sleep(15); continue; }
        const dx = steerTarget.x - guestCursor.x, dy = steerTarget.y - guestCursor.y;
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) break;
        let rx = dx, ry = dy;
        while (rx || ry) {          // a PS/2 packet carries one signed byte per axis
          const sx = Math.max(-100, Math.min(100, rx)), sy = Math.max(-100, Math.min(100, ry));
          emulator.bus.send("mouse-delta", [sx, -sy]);   // guest Y grows downwards
          rx -= sx; ry -= sy;
        }
        await sleep(12);
      }
    } finally { steering = null; steerTarget = null; }
  })();
  return steering;
}

function button(down, right) { emulator.bus.send("mouse-click", [down && !right, false, down && right]); }

/* A press is resolved against the composited layers: a title bar drags that window about, a dock
   entry restores an application, and anything else becomes a guest click at the pixel the user
   actually touched, even though each layer is drawn at its own scale and offset. */
function hostPoint(ev) {
  const r = $("pres").getBoundingClientRect();
  return { px: ev.clientX - r.left, py: ev.clientY - r.top };
}

function canvasPoint(ev) {
  const { px, py } = hostPoint(ev);
  const h = hitTest(px, py);
  return { x: h.x, y: h.y };
}

/* Dragging a window is entirely a host affair: only where the layer is drawn changes, so it is
   as smooth as the display and the guest never learns the window moved. */
let chromeDrag = null;

function pressStart(ev) {
  const { px, py } = hostPoint(ev);
  const h = hitTest(px, py);
  if (h.kind === "drag") {
    const p = layerPos[h.win.key];
    chromeDrag = { key: h.win.key, dx: px - p.x, dy: py - p.y };
    return "drag";
  }
  return null;
}

function dragMove(ev) {
  if (!chromeDrag) return false;
  const { px, py } = hostPoint(ev);
  layerPos[chromeDrag.key] = { x: Math.round(px - chromeDrag.dx), y: Math.round(py - chromeDrag.dy) };
  return true;
}

const LONG_PRESS_MS = 500;
let touchInstalled = false;
function installTouch() {
  const c = $("pres");
  if (!c || touchInstalled) return;
  touchInstalled = true;
  // Button events are serialised behind the pointer: a press that lands while the pointer is
  // still moving would drag whatever is under it.
  let chain = Promise.resolve();
  const queue = fn => (chain = chain.then(fn).catch(() => {}));
  let pressTimer = 0, longFired = false, dragging = false, consumed = null;

  const down = ev => {
    consumed = pressStart(ev);
    if (consumed) return;
    const pt = canvasPoint(ev);
    longFired = false; dragging = false;
    queue(async () => {
      await steerTo(pt);
      pressTimer = setTimeout(() => queue(async () => {     // long press is the right button
        longFired = true;
        button(true, true); await sleep(60); button(false, true);
      }), LONG_PRESS_MS);
    });
  };
  const move = ev => {
    if (dragMove(ev)) return;
    if (consumed) return;
    clearTimeout(pressTimer);
    const pt = canvasPoint(ev);
    queue(async () => {
      if (longFired) return;
      if (!dragging) { dragging = true; button(true, false); await sleep(30); }
      await steerTo(pt);
    });
  };
  const up = () => {
    clearTimeout(pressTimer);
    if (consumed) { consumed = null; chromeDrag = null; return; }
    queue(async () => {
      if (dragging) { button(false, false); dragging = false; return; }
      if (longFired) { longFired = false; return; }
      button(true, false); await sleep(60); button(false, false);   // tap is a left click
    });
  };

  // Two fingers scroll whatever is under them: each SCROLL_STEP of travel is a line message to
  // the guest window under the midpoint, so lists, documents and pictures scroll natively.
  const SCROLL_STEP = 24;
  let twoFinger = null;
  const mid = t => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  const scrollTargetSlot = m => {
    const r = c.getBoundingClientRect();
    const h = hitTest(m.x - r.left, m.y - r.top);
    return h.win && h.win.kind === "W" ? h.win.slot : (h.win && h.win.slot >= 0 ? h.win.slot : -1);
  };

  c.addEventListener("touchstart", ev => {
    if (ev.touches.length === 2) {
      clearTimeout(pressTimer);
      if (dragging) { button(false, false); dragging = false; }
      const m = mid(ev.touches);
      twoFinger = { last: m, accX: 0, accY: 0, slot: scrollTargetSlot(m) };
      ev.preventDefault();
      return;
    }
    if (ev.touches.length !== 1) { clearTimeout(pressTimer); return; }
    ev.preventDefault(); down(ev.touches[0]);
  }, { passive: false });
  c.addEventListener("touchmove", ev => {
    if (twoFinger && ev.touches.length === 2) {
      ev.preventDefault();
      const m = mid(ev.touches);
      twoFinger.accX += m.x - twoFinger.last.x; twoFinger.accY += m.y - twoFinger.last.y;
      twoFinger.last = m;
      const send = (dir, n) => { if (twoFinger.slot >= 0) sendCommand(CMD_SCROLL, twoFinger.slot | dir << 8 | Math.min(15, n) << 12); };
      const ny = Math.trunc(twoFinger.accY / SCROLL_STEP), nx = Math.trunc(twoFinger.accX / SCROLL_STEP);
      if (ny) { send(ny > 0 ? 1 : 2, Math.abs(ny)); twoFinger.accY -= ny * SCROLL_STEP; }   // finger down = content up = line up
      if (nx) { send(nx > 0 ? 3 : 4, Math.abs(nx)); twoFinger.accX -= nx * SCROLL_STEP; }
      return;
    }
    if (ev.touches.length !== 1) return;
    ev.preventDefault(); move(ev.touches[0]);
  }, { passive: false });
  const end = ev => {
    ev.preventDefault();
    if (twoFinger) { if (ev.touches.length === 0) twoFinger = null; return; }
    up();
    setTimeout(syncKeyboard, 350);          // PVMON polls at 100 ms; still inside iOS's gesture grace
  };
  c.addEventListener("touchend", end, { passive: false });
  c.addEventListener("touchcancel", end, { passive: false });

  // The same gestures with a mouse, since the v86 canvas itself is off-screen in this mode.
  let mouseDown = false;
  c.addEventListener("mousedown", ev => { ev.preventDefault(); mouseDown = true; down(ev); });
  window.addEventListener("mousemove", ev => { if (mouseDown) move(ev); });
  window.addEventListener("mouseup", () => { if (!mouseDown) return; mouseDown = false; up(); });
  c.addEventListener("contextmenu", ev => ev.preventDefault());
}

/* ------------------------------------------------------------- on-screen keyboard (SPEC 2.5)
 * Windows 3.11 has no soft keyboard, so a hidden input is focused to summon the platform one.
 */
function installKeyboard() {
  const inp = $("kbd");
  $("kbdbtn").onclick = () => { inp.value = ""; inp.focus(); };
  inp.addEventListener("input", () => {
    for (const ch of inp.value) emulator.keyboard_send_text(ch);
    inp.value = "";
  });
  inp.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { emulator.keyboard_send_text("\n"); ev.preventDefault(); }
    if (ev.key === "Backspace") { emulator.bus.send("keyboard-code", 0x0E); emulator.bus.send("keyboard-code", 0x8E); ev.preventDefault(); }
  });
}

/* --------------------------------------------------------------------------------- session */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { saveState(emulator); return; }
  // A hidden page can report a zero-size viewport, so the mode picked at load may be the
  // fallback rather than the real one. Re-evaluate as soon as we are on screen again.
  pump();
});

// Browsers throttle timers in a hidden tab almost to a stop, which freezes the emulator.
// Opt in to a worker heartbeat (?keepalive=1) when a session must survive being backgrounded;
// the default is to let it idle and rely on the snapshot.
try {
  const src = URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),1)"], { type: "text/javascript" }));
  let lastPump = 0;
  new Worker(src).onmessage = () => {
    if (document.hidden) {
      const now = performance.now();
      if (now - lastPump > 100) { lastPump = now; pump(); }
      // Keeping the VM running while backgrounded is opt-in: by default it idles and the
      // snapshot covers eviction, which is what a phone wants.
      if (params.get("keepalive") && emulator.v86 && emulator.v86.running) {
        try { emulator.v86.do_tick(); } catch (e) { /* not ready */ }
      }
    }
  };
} catch (e) { /* no worker: timers only */ }


window.addEventListener("pagehide", () => saveState(emulator));
// A phone in portrait can have a readable desktop or a stable screen, not both; let the choice
// be made explicitly rather than by the page changing size underneath whatever is open.

$("zoomin").onclick = () => setZoom(zoom * 1.25);
$("zoomout").onclick = () => setZoom(zoom / 1.25);
$("zoomfit").onclick = () => { setZoom(1); autoZoom = true; contentW && applyAutoZoom();
  const b = $("screen_container"); b.scrollLeft = 0; b.scrollTop = 0; };
$("savebtn").onclick = () => saveState(emulator);
$("resetbtn").onclick = async () => { await clearState(); location.search = "?fresh=1"; };

emulator.add_listener("emulator-started", () => { installTouch(); installKeyboard(); fitCanvas(); });
setTimeout(() => { installTouch(); installKeyboard(); }, 3000);

// Not on localhost: during development the worker only gets in the way (stale code, and dead
// pooled connections after a server restart made every GET fail with ERR_FAILED).
if ("serviceWorker" in navigator && location.protocol !== "file:" &&
    !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
