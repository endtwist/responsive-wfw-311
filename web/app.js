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
const SHELL_W = 448;             // width of the shell column on a narrow display
const SLOT_W = 640;              // width of each application column (must match pvmon.c)
const MAX_SLOTS = 2;             // application columns (must match pvmon.c)
const WIN_MARGIN = 8;

function narrow() { return viewport()[0] < 600; }

function computeMode() {
  const [vw, vh] = viewport();
  if (narrow()) {
    const shellH = Math.min(MAX_H, Math.round(vh * SHELL_W / vw) & ~1);
    return { w: SLOT_W * (1 + MAX_SLOTS), h: shellH, zoom: 1, shellH };
  }
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
const stateKey = `wfw311:${IMAGE}:${dpi}`;

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
async function clearState() {
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
  const snap = params.get("fresh") ? null : await loadState();
  if (snap) {
    try {
      await emulator.restore_state(snap);
      status("restored");
    } catch (e) { status("restore failed, cold boot"); }
  } else {
    status("booting");
  }
  emulator.run();
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

/* What the guest says is where: the shell column's size, and one entry per application window
   giving the client rectangle it occupies in guest screen space, back to front. */
let shell = { w: SHELL_W, h: 0, cap: 18 };
let layers = [];
let pendingLayers = null;
const layerPos = {};                 // slot -> host position, moved by dragging

const pvLog = [];
window.pvState = () => ({ shell, layers, placed, view, log: pvLog.slice(-40) });
emulator.bus.register("pv-debug", line => {
  pvLog.push(line);
  let m = /^PVD (\d+) (\d+)(?: (\d+))?/.exec(line);
  if (m) { shell = { w: +m[1], h: +m[2], cap: +m[3] || 18 }; return; }
  if (/^PVB /.test(line)) { pendingLayers = []; return; }
  m = /^PVW (\d+) (-?\d+) (-?\d+) (\d+) (\d+) (-?\d+) (-?\d+) (\d+) (\d+) ?(.*)$/.exec(line);
  if (m && pendingLayers) {
    pendingLayers.push({
      slot: +m[1], wx: +m[2], wy: +m[3], ww: +m[4], wh: +m[5],
      gx: +m[6], gy: +m[7], gw: +m[8], gh: +m[9], title: m[10] || "",
    });
    return;
  }
  if (/^PVE/.test(line) && pendingLayers) {
    layers = pendingLayers; pendingLayers = null;
    const live = new Set(layers.map(l => l.slot));
    for (const k of Object.keys(layerPos)) if (!live.has(+k)) delete layerPos[k];
  }
});

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

   The chrome is the guest's own pixels, drawn at one host pixel per guest pixel, so it stays
   exactly as crisp and as large as it is on the desktop behind while the client area inside it
   shrinks to fit. The caption row is composited in three pieces: the system box on the left and
   the minimise and maximise boxes on the right keep their corners untouched, and only the strip
   of caption between them is squeezed to span the gap. The menu row below is drawn from the left
   and cropped, since menu titles are left-aligned. */
function placeLayers() {
  const [vw, vh] = viewport();
  const out = [];
  layers.forEach((L, i) => {
    const inset = {                                  // frame thickness, straight from the guest
      l: Math.max(0, L.gx - L.wx),
      t: Math.max(0, L.gy - L.wy),
      b: Math.max(0, (L.wy + L.wh) - (L.gy + L.gh)),
    };
    const capRow = Math.min(inset.t, inset.l + shell.cap);   // border plus caption
    const menuRow = inset.t - capRow;                        // menu bar, if the window has one
    const box = Math.max(12, shell.cap);                     // a caption box is square
    const chromeW = 2 * inset.l;
    const availW = vw - 2 * WIN_MARGIN - chromeW;
    const availH = vh - 2 * WIN_MARGIN - inset.t - inset.b;
    const s = Math.min(view.scale, availW / L.gw, availH / L.gh);
    const cw = Math.round(L.gw * s), ch = Math.round(L.gh * s);
    const hw = cw + chromeW, hh = ch + inset.t + inset.b;
    let p = layerPos[L.slot];
    if (!p) {
      p = layerPos[L.slot] = { x: Math.round((vw - hw) / 2) + i * 16,
                               y: Math.round(vh * 0.12) + i * 16 };
    }
    const x = Math.max(40 - hw, Math.min(vw - 40, p.x));
    const y = Math.max(0, Math.min(vh - capRow, p.y));
    out.push({ ...L, s, cw, ch, hw, hh, x, y, inset, capRow, menuRow, box });
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
    if (dy >= w.inset.t && dy < w.inset.t + w.ch &&
        dx >= w.inset.l && dx < w.inset.l + w.cw) {
      return { kind: "client", win: w,
               x: Math.round(w.gx + (dx - w.inset.l) / w.s),
               y: Math.round(w.gy + (dy - w.inset.t) / w.s) };
    }
    if (dy < w.capRow) {                              // caption row: boxes click, middle drags
      const leftEnd = w.inset.l + w.box;
      const rightStart = w.hw - w.inset.l - 2 * w.box;
      if (dx < leftEnd) return { kind: "chrome", win: w, x: w.wx + dx, y: w.wy + dy };
      if (dx >= rightStart)
        return { kind: "chrome", win: w, x: w.wx + w.ww - (w.hw - dx), y: w.wy + dy };
      return { kind: "drag", win: w };
    }
    if (dy < w.inset.t)                               // menu row is drawn 1:1 from the left
      return { kind: "chrome", win: w, x: w.wx + dx, y: w.wy + dy };
    return { kind: "drag", win: w };                  // the frame itself drags, like the caption
  }
  return { kind: "desktop",
           x: Math.round(view.x + (px - view.ox) / view.scale),
           y: Math.round(view.y + py / view.scale) };
}

function drawWindow(g, src, w) {
  const { inset, capRow, menuRow, box } = w;
  const midSrcW = w.ww - 2 * inset.l - 3 * box;       // the caption strip between the boxes
  const midDstW = w.hw - 2 * inset.l - 3 * box;

  g.imageSmoothingEnabled = false;
  g.drawImage(src, w.wx, w.wy, inset.l + box, capRow, w.x, w.y, inset.l + box, capRow);
  g.drawImage(src, w.wx + w.ww - inset.l - 2 * box, w.wy, inset.l + 2 * box, capRow,
              w.x + w.hw - inset.l - 2 * box, w.y, inset.l + 2 * box, capRow);
  if (midSrcW > 0 && midDstW > 0) {
    if (midDstW <= midSrcW) {
      /* The caption is narrower on the host than in the guest, so the strip between the boxes
         is cropped rather than squeezed: equal slivers of empty caption come off each side and
         the title, which Windows centres, stays centred, at its own size and perfectly crisp.
         Only a title too long for the gap loses its ends, which is what Windows does anyway. */
      const cut = Math.floor((midSrcW - midDstW) / 2);
      g.drawImage(src, w.wx + inset.l + box + cut, w.wy, midDstW, capRow,
                  w.x + inset.l + box, w.y, midDstW, capRow);
    } else {                                          // wider on the host: pad, do not stretch
      const pad = midDstW - midSrcW;
      g.drawImage(src, w.wx + inset.l + box, w.wy, 2, capRow,
                  w.x + inset.l + box, w.y, pad, capRow);
      g.drawImage(src, w.wx + inset.l + box, w.wy, midSrcW, capRow,
                  w.x + inset.l + box + pad, w.y, midSrcW, capRow);
    }
  }
  if (menuRow > 0) {
    const mw = Math.min(w.ww, w.hw);
    g.drawImage(src, w.wx, w.wy + capRow, mw, menuRow, w.x, w.y + capRow, mw, menuRow);
    if (w.hw > mw)                                    // pad with the menu bar's own background
      g.drawImage(src, w.wx + mw - 2, w.wy + capRow, 2, menuRow,
                  w.x + mw, w.y + capRow, w.hw - mw, menuRow);
  }
  if (inset.l > 0) {                                  // side borders, stretched only lengthways
    g.drawImage(src, w.wx, w.gy, inset.l, w.gh, w.x, w.y + inset.t, inset.l, w.ch);
    g.drawImage(src, w.gx + w.gw, w.gy, inset.l, w.gh,
                w.x + inset.l + w.cw, w.y + inset.t, inset.l, w.ch);
  }
  if (inset.b > 0)
    g.drawImage(src, w.wx, w.gy + w.gh, Math.min(w.ww, w.hw), inset.b,
                w.x, w.y + inset.t + w.ch, Math.min(w.hw, w.ww), inset.b);
  g.imageSmoothingEnabled = w.s < 1;                  // the client, at the scale that fits
  g.drawImage(src, w.gx, w.gy, w.gw, w.gh, w.x + inset.l, w.y + inset.t, w.cw, w.ch);
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
    const dw = view.w * view.scale, dh = view.h * view.scale;
    g.drawImage(src, view.x, view.y, view.w, view.h, view.ox, 0, Math.round(dw), Math.round(dh));

    placed = narrow() ? placeLayers() : [];
    for (const w of placed) drawWindow(g, src, w);    // back to front
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
const LONG_PRESS_MS = 500;

/* A tap is resolved against the composited layers: a title bar drags that window about, and
   anything else becomes a guest click at the pixel the user actually touched, even though each
   layer is drawn at its own scale and offset. */
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

function dragStart(ev) {
  const { px, py } = hostPoint(ev);
  const h = hitTest(px, py);
  if (h.kind !== "drag") return false;
  const p = layerPos[h.win.slot];
  chromeDrag = { slot: h.win.slot, dx: px - p.x, dy: py - p.y };
  return true;
}

function dragMove(ev) {
  if (!chromeDrag) return false;
  const { px, py } = hostPoint(ev);
  layerPos[chromeDrag.slot] = { x: Math.round(px - chromeDrag.dx),
                                y: Math.round(py - chromeDrag.dy) };
  return true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function steerTo(pt) {
  for (let i = 0; i < 8; i++) {
    if (!guestCursor) { emulator.bus.send("mouse-delta", [1, 0]); await sleep(30); continue; }
    const dx = pt.x - guestCursor.x, dy = pt.y - guestCursor.y;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return true;
    // v86 forwards a delta straight into a PS/2 packet, whose fields are one signed byte
    let rx = dx, ry = dy;
    while (rx || ry) {
      const sx = Math.max(-100, Math.min(100, rx)), sy = Math.max(-100, Math.min(100, ry));
      emulator.bus.send("mouse-delta", [sx, -sy]);   // guest Y grows downwards
      rx -= sx; ry -= sy;
    }
    await sleep(25);
  }
  return false;
}

function button(down, right) { emulator.bus.send("mouse-click", [down && !right, false, down && right]); }

let touchInstalled = false;
function installTouch() {
  const c = $("pres");
  if (!c || touchInstalled) return;
  touchInstalled = true;
  // Steering the pointer takes several packets, so the gesture handlers are serialised: a
  // press that lands while the pointer is still moving would drag whatever is under it.
  let chain = Promise.resolve();
  const queue = fn => (chain = chain.then(fn).catch(() => {}));
  let pressTimer = 0, longFired = false, dragging = false;

  let pinchDist = 0, panLast = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = t => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

  c.addEventListener("touchstart", ev => {
    if (ev.touches.length === 2) {          // two fingers: zoom and pan, never mouse input
      ev.preventDefault();
      clearTimeout(pressTimer);
      pinchDist = dist(ev.touches);
      panLast = mid(ev.touches);
      return;
    }
    if (ev.touches.length !== 1) return;
    ev.preventDefault();
    if (dragStart(ev.touches[0])) return;
    const pt = canvasPoint(ev.touches[0]);
    longFired = false; dragging = false;
    queue(async () => {
      await steerTo(pt);
      pressTimer = setTimeout(() => queue(async () => {     // long press is the right button
        longFired = true;
        button(true, true); await sleep(60); button(false, true);
      }), LONG_PRESS_MS);
    });
  }, { passive: false });

  c.addEventListener("touchmove", ev => {
    if (ev.touches.length === 2) {
      ev.preventDefault();
      const box = $("screen_container");
      const d = dist(ev.touches), m = mid(ev.touches);
      if (panLast) { box.scrollLeft -= m.x - panLast.x; box.scrollTop -= m.y - panLast.y; }
      panLast = m;
      if (pinchDist > 0 && Math.abs(d - pinchDist) > 8) {
        const r = c.getBoundingClientRect();
        setZoom(zoom * (d / pinchDist), { x: m.x - r.left, y: m.y - r.top });
        pinchDist = d;
      }
      return;
    }
    if (ev.touches.length !== 1) return;
    ev.preventDefault();
    clearTimeout(pressTimer);
    if (dragMove(ev.touches[0])) return;
    const pt = canvasPoint(ev.touches[0]);
    queue(async () => {
      if (longFired) return;
      if (!dragging) { dragging = true; button(true, false); await sleep(40); }
      await steerTo(pt);
    });
  }, { passive: false });

  c.addEventListener("touchend", ev => {
    ev.preventDefault();
    clearTimeout(pressTimer);
    if (chromeDrag) { chromeDrag = null; return; }
    if (panLast) { panLast = null; pinchDist = 0; return; }   // finishing a two-finger gesture
    queue(async () => {
      if (dragging) { button(false, false); dragging = false; return; }
      if (longFired) { longFired = false; return; }
      button(true, false); await sleep(60); button(false, false);   // tap is a left click
    });
  }, { passive: false });

  // The same gestures with a mouse, since the v86 canvas itself is off-screen in this mode.
  let mouseDown = false, mouseDragging = false;
  c.addEventListener("mousedown", ev => {
    ev.preventDefault();
    if (dragStart(ev)) { mouseDown = true; return; }
    mouseDown = true; mouseDragging = false;
    const pt = canvasPoint(ev);
    queue(async () => { await steerTo(pt); button(true, ev.button === 2); });
  });
  window.addEventListener("mousemove", ev => {
    if (!mouseDown) return;
    if (dragMove(ev)) return;
    const pt = canvasPoint(ev);
    mouseDragging = true;
    queue(() => steerTo(pt));
  });
  window.addEventListener("mouseup", ev => {
    if (!mouseDown) return;
    mouseDown = false;
    if (chromeDrag) { chromeDrag = null; return; }
    queue(async () => { button(false, ev.button === 2); });
  });
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

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
