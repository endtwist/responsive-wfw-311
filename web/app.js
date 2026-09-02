/* responsive-wfw311 - the browser side.
 *
 * Runs Windows for Workgroups 3.11 in v86 on a paravirtual display adapter whose mode follows
 * the viewport (SPEC.md 2.7, 2.8). Also handles touch, the on-screen keyboard, and snapshots.
 */
import { V86 } from "../v86/src/browser/starter.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
/* Which disk image and boot snapshot to use come from image/current.json, written by the image
   build, so a session always pairs a snapshot with the exact image it was made from. ?hda=
   overrides for development. */
const manifest = await fetch("../image/current.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null);
const IMAGE = params.get("hda") || (manifest && manifest.image ? "../image/" + manifest.image : "../image/work-live.img");
const SHIPPED_STATE = manifest && manifest.state ? "../image/" + manifest.state : "../image/boot.state.gz";

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
function fullViewport() {
  const vv = window.visualViewport;
  // Whole pixels: the canvas backing store must match its CSS box exactly, or Safari resamples
  // the whole canvas (a half-pixel mismatch read as "everything is blurry" on the phone).
  let w = Math.floor(vv ? vv.width : window.innerWidth);
  let h = Math.floor(vv ? vv.height : window.innerHeight);
  // The soft keyboard shrinks the visual viewport (684 -> 383 on the phone) without touching the
  // layout viewport. That must not re-lay-out anything: it turned portrait into "landscape" and
  // shrank the whole desktop to 0.8x. Freeze on the layout viewport while the keyboard is up; the
  // focused layer is panned into the visible part by keyboardShift() instead.
  // Geometric test, not focus-based: the keyboard can still be animating away after the input
  // lost focus (PVK 0 -> blur), and that gap once re-arranged the shell to 404 rows. A visual
  // viewport shorter than the layout viewport at scale 1 can only be the keyboard.
  if (vv && vv.scale === 1 && vv.height < window.innerHeight - 100) h = Math.floor(window.innerHeight);
  if (!(w > 0) || !(h > 0)) { w = 1024; h = 768; }   // a hidden page can report nothing
  return [w, h];
}
/* Safe areas (notch, home indicator, rounded corners): read from the CSS env() tokens on :root
   so the compositor never puts guest pixels under them. Re-read on resize/rotation. */
let safe = { l: 0, t: 0, r: 0, b: 0 }, safeReadAt = 0;
function readSafeInsets() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const n = v => { const x = parseFloat(cs.getPropertyValue(v)); return Number.isFinite(x) && x > 0 ? Math.round(x) : 0; };
    safe = { l: n("--sal"), t: n("--sat"), r: n("--sar"), b: n("--sab") };
    // Safari with its own bars reports no insets; the standalone (home-screen) page does.
    // The soft keyboard replaces the bottom inset while it is up.
    if (keyboardUp()) safe.b = 0;
  } catch (e) { safe = { l: 0, t: 0, r: 0, b: 0 }; }
  safeReadAt = performance.now();
}
/* The area the desktop and the layers are laid out in: the visual viewport less the safe areas.
   Everything in host pixels below is relative to its top-left corner (see presentOnce, hostPoint). */
function viewport() {
  const [w, h] = fullViewport();
  if (performance.now() - safeReadAt > 500) readSafeInsets();
  return [Math.max(1, w - safe.l - safe.r), Math.max(1, h - safe.t - safe.b)];
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
const SHELL_W = 352;             // width of the shell column on a narrow display (must match build-image shellw=)
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
if (narrow()) document.documentElement.classList.add("phone");
// DPI is fixed for a session: Windows 3.x cannot change font metrics on the fly, and PVDPI.EXE
// picks the matching SYSTEM.INI at each Windows start.
const dpi = params.get("dpi") ? +params.get("dpi") : (viewport()[0] < 600 ? 120 : 96);
/* Local snapshots are keyed by the image's identity (size and modification time from the
   server), not just its name: a snapshot of an older build of the image restores a guest whose
   PVMON and screen layout no longer match this page, and it looks like a hang. */
let stateKey = `wfw311:${IMAGE}:${dpi}`, stateKeyQualified = false, shippedStamp = "";
const stateKeyReady = Promise.all([
  fetch(IMAGE, { method: "HEAD" }).then(r => {
    if (!r.ok) throw new Error("HEAD " + r.status);
    stateKey += `:${r.headers.get("content-length")}:${r.headers.get("last-modified")}`;
    stateKeyQualified = true;
  }),
  // The shipped boot snapshot's stamp: a local snapshot is only trusted if it was made on top of
  // the same shipped state, so a new build can never be shadowed by an old local save.
  fetch(SHIPPED_STATE, { method: "HEAD" })
    .then(r => { if (r.ok) shippedStamp = `${r.headers.get("content-length")}:${r.headers.get("last-modified")}`; }),
]).catch(e => report("statekey", String(e)));

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
    if (!stateKeyQualified) return;                     // cannot label it: do not keep it
    const raw = await emulator.save_state();
    let blob = new Blob([raw]);
    if (typeof CompressionStream === "function") {
      blob = await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob();
    }
    const bytes = await blob.arrayBuffer();           // Safari's IndexedDB rejected a Blob here
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put({ bytes, at: Date.now(), shipped: shippedStamp }, stateKey);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    status(`saved ${(bytes.byteLength / 1048576).toFixed(1)} MB`);
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
    if (!stateKeyQualified || (rec.shipped || "") !== shippedStamp) {
      report("state", `local snapshot ignored: qualified=${stateKeyQualified} shipped=${rec.shipped}/${shippedStamp}`);
      return null;
    }
    let blob = rec.blob || new Blob([rec.bytes]);
    if (typeof DecompressionStream === "function") {
      blob = await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).blob();
    }
    return await blob.arrayBuffer();
  } catch (e) { return null; }
}
let restored = false;
async function loadShippedState() {
  try {
    const r = await fetch(SHIPPED_STATE);
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
    const r = await fetch("/__state?name=" + encodeURIComponent(SHIPPED_STATE.split("/").pop()), { method: "POST", body: blob });
    status("boot snapshot: " + await r.text());
  } catch (e) { status("snapshot failed: " + e.message); }
}
/* The last composited frame, as a PNG data URL (Safari's IndexedDB rejects Blobs), under a fixed
   key so it can be read before the image's identity is known: it is only pixels, and it is shown
   only until the restored guest paints. Saved whenever the state is saved. */
const FRAME_KEY = "lastframe";
async function saveFrame() {
  try {
    const pres = $("pres");
    if (!pres || !pres.width || !desktopReady) return;
    const url = pres.toDataURL("image/png");
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put({ url, at: Date.now(), w: pres.width, h: pres.height }, FRAME_KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) { report("firstframe", "save failed: " + e.message); }
}
async function loadFrame() {
  try {
    const db = await idb();
    const rec = await new Promise((res, rej) => {
      const tx = db.transaction("state", "readonly");
      const q = tx.objectStore("state").get(FRAME_KEY);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
    if (!rec || !rec.url) return;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = rec.url; });
    firstFrame = img;
    firstFrameUntil = performance.now() + 30000;       // a restore that takes longer shows the guest
  } catch (e) { /* no frame: the page opens on the guest's own first paint */ }
}
loadFrame();
// Hide and pagehide are not always given time to finish (a navigation cuts IndexedDB work short),
// so the frame is also saved every 20 s while the desktop is up and something has changed.
window.pvSaveFrame = saveFrame;
let frameSavedSig = 0;
setInterval(() => { if (!document.hidden && desktopReady && wd.frameSig !== frameSavedSig) { frameSavedSig = wd.frameSig; saveFrame(); } }, 20000);
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
  wasm_path: "../v86/build/" + (params.get("wasm") || "v86.wasm"),   // ?wasm=v86-base.wasm for A/B
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
if (params.get("selftest")) import("./selftest.js").then(m => m.run());              // app tour (PLAN.md Fix 5)
if (params.get("remote")) import("./remote.js").then(m => m.run(params.get("remote"))); // parked-phone remote control

function status(msg) { $("status").textContent = msg; }

emulator.add_listener("emulator-ready", async () => {
  emulator.bus.send("pv-set-dpi", dpi);
  emulator.bus.send("sb16-dsp-version", [2, 1]);     // Windows 3.x's Sound Blaster driver wants a 2.x DSP
  requestMode(true);
  /* Order of preference: the visitor's own snapshot (saved on hide), then the shipped boot
     snapshot (the desktop already up, so a cold visit takes seconds instead of a minute), then a
     real boot. After any restore PVMON is asked to describe the layout again, since the host has
     no memory of it. */
  if (params.get("reset")) {
    try { await new Promise(r => { const d = indexedDB.deleteDatabase(DB); d.onsuccess = d.onerror = d.onblocked = r; }); } catch (e) {}
  }
  let snap = params.get("fresh") || params.get("reset") ? null : await loadState();
  if (!snap && !params.get("fresh") && !params.get("mkstate")) { snap = await loadShippedState(); report("state", `shipped snapshot ${snap ? snap.byteLength + " bytes" : "unavailable"}`); }
  if (snap) {
    try {
      await emulator.restore_state(snap);
      status("restored");
      restored = true;
    } catch (e) { status("restore failed, cold boot"); firstFrameUntil = 0; }
  } else {
    status("booting");
    firstFrameUntil = 0;                                 // a cold boot shows its own DOS and logo
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
let guestCursor = null, cursorSeq = 0;
emulator.bus.register("pv-cursor", xy => { guestCursor = { x: xy[0], y: xy[1] }; cursorSeq++; });

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
const layerZoom = {};                // layer key -> { z, px, py }: pinch zoom and pan of the client area

const pvLog = [];
/* Watchdog bookkeeping: PVMON's heartbeat (`PVH <tick>`, once a second once the guest ships it),
   the last input event, and the last time the composite changed. See watchdog() below. */
const wd = { lastBeat: 0, beats: 0, lastInput: 0, lastChange: 0, lastBundle: 0, frameSig: 0, inputs: [] };
function noteInput(s) { wd.lastInput = performance.now(); wd.inputs.push(`${Math.round(wd.lastInput)} ${s}`); if (wd.inputs.length > 20) wd.inputs.shift(); }
window.pvState = () => ({ shell, layers, dock, placed, view, desktopReady, log: pvLog.slice(-50), wd, wantKeyboard, keyboardHeld, kbd: kbdTrace.slice(-10),
                          firstFrame: !!firstFrame, firstFrameShown, safe, cursorShown: guestCursorShown, cmdQueue: cmdQueue.length });
emulator.bus.register("pv-debug", line => {
  pvLog.push(line);
  if (pvLog.length > 200) pvLog.splice(0, pvLog.length - 150);
  let m = /^PVH/.exec(line);
  if (m) { wd.lastBeat = performance.now(); wd.beats++; return; }
  m = /^PVD (\d+) (\d+)(?: (\d+))?(?: v(\d+))?/.exec(line);
  if (m) { shell = { w: +m[1], h: +m[2], cap: +m[3] || 18, ver: m[4] ? +m[4] : 0 }; return; }
  if (/^PVP-BEGIN /.test(line)) { printJob = []; return; }
  if (/^PVP /.test(line)) { if (printJob) printJob.push(line.slice(4)); return; }
  if (/^PVP-END/.test(line)) { if (printJob) finishPrintJob(printJob.join("")); printJob = null; return; }
  m = /^PVK (\d)/.exec(line);
  if (m) { guestWantsKeyboard(m[1] === "1"); return; }
  if (/^PVA/.test(line)) {
    desktopReady = true;
    shellHeightSent = 0;
    if (touchDevice) setTimeout(() => setGuestCursor(false, true), 500);   // an arrow means nothing to a finger
    if (params.get("mkstate") && !restored) { uploadBootState(); return; }
    launchFromUrl();
    return;
  }
  if (/^PVB /.test(line)) { pendingLayers = []; pendingDock = []; return; }
  m = /^PV([WOTXS]) (-?\d+) (-?\d+) (-?\d+) (\d+) (\d+) (-?\d+) (-?\d+) (\d+) (\d+) ?(.*)$/.exec(line);
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
    for (const k of Object.keys(layerZoom)) if (!live.has(k)) delete layerZoom[k];
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
  soundrecorder: "SOUNDREC.EXE", soundrec: "SOUNDREC.EXE", mediaplayer: "MPLAYER.EXE",
};
let launched = false;
function launchFromUrl() {
  if (launched) return;
  launched = true;
  const q = new URLSearchParams(location.search).get("run");
  const seg = location.pathname.split("/").filter(Boolean).pop() || "";
  const key = (q || (/^[a-z]+$/i.test(seg) && !/\./.test(seg) ? seg : "")).toLowerCase();
  const cmd = APPS[key] || (q && /^[A-Z0-9_.\\: -]+$/i.test(q) ? q : null);
  if (cmd) sendCommandString(CMD_RUN, cmd);
}

/* Printing: the guest's PostScript driver prints to a file, PVMON ships it here base64-encoded,
   and Ghostscript (WebAssembly, loaded on first use) turns it into a PDF the browser downloads.
   Nothing is drawn for this: the browser's own download UI is the only thing the user sees. */
let printJob = null, gsModule = null;
async function loadGhostscript() {
  if (gsModule) return gsModule;
  const mod = await import("https://cdn.jsdelivr.net/npm/@jspawn/ghostscript-wasm@0.0.2/gs.mjs");
  gsModule = mod.default;
  return gsModule;
}
async function psToPdf(psBytes) {
  const createModule = await loadGhostscript();
  return new Promise((resolve, reject) => {
    let out = null;
    createModule({
      locateFile: f => "https://cdn.jsdelivr.net/npm/@jspawn/ghostscript-wasm@0.0.2/" + f,   // the glue looks next to the page otherwise
      arguments: ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite", "-sOutputFile=/out.pdf", "/in.ps"],
      preRun: [m => { m.FS.writeFile("/in.ps", psBytes); }],
      postRun: [m => { try { out = m.FS.readFile("/out.pdf"); } catch (e) { reject(e); return; } resolve(out); }],
      print: () => {}, printErr: t => report("gs", t),
    }).catch(reject);
  });
}
function offerDownload(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.style.display = "none";
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
}
/* Plain text (the Generic / Text Only driver) becomes a PDF directly: one Courier page per form
   feed, 66 lines of 80 columns, written by hand since a text page needs no interpreter. */
function textToPdf(text) {
  const pages = text.replace(/\r/g, "").split("\f").filter((p, i, a) => p.trim() || a.length === 1);
  const esc = t => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7e]/g, "?");
  const objs = [];
  const add = body => (objs.push(body), objs.length);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const pageIds = [];
  const kids = [];
  const pagesId = objs.length + 1 + pages.length * 2;      // reserved: filled after the pages
  for (const p of pages) {
    const lines = p.split("\n").slice(0, 66);
    let content = "BT /F1 10 Tf 12 TL 36 756 Td\n";
    for (const ln of lines) content += `(${esc(ln.slice(0, 96))}) Tj T*\n`;
    content += "ET";
    const cid = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const pid = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${cid} 0 R >>`);
    kids.push(`${pid} 0 R`);
  }
  const realPagesId = add(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);
  let out = "%PDF-1.4\n", offsets = [];
  objs.forEach((b, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${b.replace(new RegExp(`/Parent ${pagesId} 0 R`, "g"), `/Parent ${realPagesId} 0 R`)}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

async function finishPrintJob(b64) {
  try {
    const bin = atob(b64); const ps = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) ps[i] = bin.charCodeAt(i);
    const isPostScript = bin.startsWith("%!") || bin.startsWith("\x04%!") || bin.startsWith("\x1b%-12345X");
    report("print", `job ${ps.length} bytes, ${isPostScript ? "PostScript" : "text"}`);
    let pdf = null;
    if (!isPostScript) pdf = textToPdf(bin);
    else try { pdf = await psToPdf(ps); } catch (e) { report("print", "ghostscript failed: " + (e && e.message || e)); }
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    if (pdf) offerDownload(pdf, `windows-${stamp}.pdf`, "application/pdf");
    else offerDownload(ps, `windows-${stamp}.ps`, "application/postscript");
  } catch (e) { report("print", "failed: " + e.message); }
}

/* Keyboard accessory bar: keys the phone keyboard lacks, sent as PS/2 scancodes. Ctrl and Alt are
   sticky for one key. The bar is only visible while the soft keyboard is up, docked to its top
   edge (the visual viewport's bottom), and it never takes the focus away from the hidden input. */
const KEYBAR = [
  ["Esc", [0x01]], ["Tab", [0x0F]],
  ["←", [0xE0, 0x4B], "arrow"], ["↑", [0xE0, 0x48], "arrow"], ["↓", [0xE0, 0x50], "arrow"], ["→", [0xE0, 0x4D], "arrow"],
  ["Ctrl", "ctrl"], ["Alt", "alt"], ["Del", [0xE0, 0x53]], null,
  ["F1", [0x3B]], ["F2", [0x3C]], ["F3", [0x3D]], ["F4", [0x3E]], ["F5", [0x3F]], ["F6", [0x40]], ["F7", [0x41]], ["F8", [0x42]], ["F9", [0x43]], ["F10", [0x44]], null,
  ["Home", [0xE0, 0x47]], ["End", [0xE0, 0x4F]], ["PgUp", [0xE0, 0x49]], ["PgDn", [0xE0, 0x51]], ["Ins", [0xE0, 0x52]],
  ["⌄", "hide"],
];
/* Modifier state: 0 off, 1 armed for the next key (one tap), 2 locked (a second tap; stays until
   tapped again). Shown on the bar as `.on` and `.lock`. */
const sticky = { ctrl: 0, alt: 0 };
function sendScancodes(codes, down) {
  // make: codes as given; break: last byte | 0x80 (E0 prefix kept)
  const seq = down ? codes : codes.map((c, i) => i === codes.length - 1 ? c | 0x80 : c);
  for (const c of seq) emulator.bus.send("keyboard-code", c);
}
function keybarPress(codes) {
  if (sticky.ctrl) sendScancodes([0x1D], true);
  if (sticky.alt) sendScancodes([0x38], true);
  sendScancodes(codes, true); sendScancodes(codes, false);
  if (sticky.alt) sendScancodes([0x38], false);
  if (sticky.ctrl) sendScancodes([0x1D], false);
  if (sticky.ctrl === 1) sticky.ctrl = 0;                   // armed modifiers are spent; locked ones stay
  if (sticky.alt === 1) sticky.alt = 0;
  noteInput(`key ${codes.map(c => c.toString(16)).join(" ")}`);
  updateKeybar();
}
/* The hide key: the user dismisses the keyboard, and the guest's next PVK 1 (a new focus) is what
   brings it back, not the focus that is already there. */
function hideKeyboard(reason) {
  keyboardHeld = false; wantKeyboard = false; kbdSuppressedUntil = performance.now() + 1500;
  clearTimeout(kbdBlurTimer);
  const inp = $("kbd");
  if (inp && document.activeElement === inp) inp.blur();
  kbdLog(`hide (${reason})`);
  setTimeout(updateKeybar, 100);
}
function buildKeybar() {
  const bar = $("keybar");
  if (!bar || bar.childElementCount) return;
  for (const k of KEYBAR) {
    if (!k) { const g = document.createElement("span"); g.className = "gap"; bar.appendChild(g); continue; }
    const b = document.createElement("button");
    b.textContent = k[0]; b.dataset.key = k[0];
    if (k[1] === "hide") b.className = "hide";
    if (k[2]) b.className = k[2];
    const act = ev => {
      ev.preventDefault();                                 // keep the hidden input focused
      if (k[1] === "hide") { keybarOpen = false; hideKeyboard("bar"); return; }
      if (typeof k[1] === "string") { sticky[k[1]] = (sticky[k[1]] + 1) % 3; updateKeybar(); }
      else keybarPress(k[1]);
    };
    // A key fires on the release of a tap, not on touchstart: a finger that moves is panning the
    // bar (it is wider than the screen), and preventDefault on touchstart would kill that pan.
    let t0 = null;
    b.addEventListener("touchstart", ev => { const t = ev.touches[0]; t0 = { x: t.clientX, y: t.clientY }; }, { passive: true });
    b.addEventListener("touchend", ev => {
      const t = ev.changedTouches[0];
      const moved = !t0 || Math.abs(t.clientX - t0.x) > 8 || Math.abs(t.clientY - t0.y) > 8;
      t0 = null;
      if (moved) return;                                   // a pan: let it scroll, keep focus untouched
      act(ev);
    }, { passive: false });
    b.addEventListener("mousedown", ev => { if (!("ontouchstart" in window)) act(ev); else ev.preventDefault(); });
    bar.appendChild(b);
  }
  // sticky modifiers also work with typed characters
  $("kbd").addEventListener("beforeinput", ev => {
    if (!(sticky.ctrl || sticky.alt) || !ev.data) return;
    ev.preventDefault();
    const code = charScancode(ev.data);
    if (code) keybarPress([code]);
  });
}
const CHAR_SCANCODES = { a:0x1E,b:0x30,c:0x2E,d:0x20,e:0x12,f:0x21,g:0x22,h:0x23,i:0x17,j:0x24,k:0x25,l:0x26,m:0x32,n:0x31,o:0x18,p:0x19,q:0x10,r:0x13,s:0x1F,t:0x14,u:0x16,v:0x2F,w:0x11,x:0x2D,y:0x15,z:0x2C,
  "1":0x02,"2":0x03,"3":0x04,"4":0x05,"5":0x06,"6":0x07,"7":0x08,"8":0x09,"9":0x0A,"0":0x0B," ":0x39,"-":0x0C,"=":0x0D,"[":0x1A,"]":0x1B,";":0x27,"'":0x28,",":0x33,".":0x34,"/":0x35,"\\":0x2B };
function charScancode(ch) { return CHAR_SCANCODES[ch.toLowerCase()] || 0; }
function updateKeybar() {
  const bar = $("keybar");
  if (!bar) return;
  for (const b of bar.querySelectorAll("button")) {
    const st = b.dataset.key === "Ctrl" ? sticky.ctrl : b.dataset.key === "Alt" ? sticky.alt : 0;
    b.classList.toggle("on", st === 1); b.classList.toggle("lock", st === 2);
  }
  const up = keyboardUp();
  // Folded by default: with the keyboard up only a small tab shows; tapping it opens the bar.
  const tab = $("keybartab");
  bar.classList.toggle("show", up && keybarOpen);
  if (tab) { tab.classList.toggle("show", up); tab.classList.toggle("open", keybarOpen); }
  if (up) {
    const vv = window.visualViewport;
    // dock to the bottom of the visible viewport, i.e. the top edge of the keyboard (on Chrome for
    // iOS that is the top of its own accessory row: it is part of the keyboard's height)
    const bottom = window.innerHeight - (vv.offsetTop + vv.height);
    bar.style.top = "auto";
    bar.style.bottom = bottom + "px";
    if (tab) tab.style.bottom = (bottom + (keybarOpen ? bar.offsetHeight : 0)) + "px";
    const r = bar.getBoundingClientRect();
    const line = `bar=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} vv=${Math.round(vv.offsetTop)}+${Math.round(vv.height)}/${innerHeight} scale=${vv.scale} shift=${keyboardShift()} guestRoom=${Math.round(r.top - safe.t)}px mode=${KBD_MODE}`;
    if (line !== keybarLogged) { keybarLogged = line; diag("keybar " + line); }
  } else keybarLogged = "";
}
let keybarLogged = "";
let keybarOpen = false;
let lateTapUntil = 0;
(function installKeybarTab() {
  const tab = $("keybartab");
  if (!tab) return;
  const flip = ev => { ev.preventDefault(); keybarOpen = !keybarOpen; updateKeybar(); pump && pump(); };
  tab.addEventListener("touchend", flip, { passive: false });
  tab.addEventListener("mousedown", ev => { if (!("ontouchstart" in window)) flip(ev); else ev.preventDefault(); });
})();
if (window.visualViewport) { window.visualViewport.addEventListener("resize", updateKeybar); window.visualViewport.addEventListener("scroll", updateKeybar); }
document.addEventListener("focusin", () => setTimeout(updateKeybar, 50));
document.addEventListener("focusout", () => setTimeout(updateKeybar, 50));
setInterval(updateKeybar, 1000);                       // belt and braces: keyboard geometry changes without events on some iOS versions

/* The soft keyboard follows the guest: when an edit control takes the focus the hidden input is
   focused, which summons the platform keyboard, and it is blurred when the focus leaves. iOS only
   lets a page focus an input inside a user gesture, so the touch handlers also call this at the
   end of a tap, by which time PVMON has usually reported the new focus. */
let wantKeyboard = false, keyboardHeld = false;
let kbdBlurTimer = 0, kbdSuppressedUntil = 0;
/* The element that summons the keyboard. Chrome for iOS stacks its own autofill accessory row
   (passwords, cards, location, dismiss) on top of any focused form field, about 70 px that we
   cannot draw over; Safari has its own ‹ › Done row. Which element kinds avoid it is a per-browser
   question, so the kind is selectable (?kbd=) and logged, and the default is the one most likely
   to be treated as "not a form field": a contenteditable element.
     ce      <div contenteditable>            (default)
     input   <input type=text autocomplete=off>
     otc     <input type=text autocomplete=one-time-code>   (hides password suggestions in Chrome)
     search  <input type=search inputmode=text>
     url     <input type=url inputmode=text>
     none    <input inputmode=none>           (no soft keyboard at all: hardware keyboards only)
   All of them raise input/beforeinput/keydown, so the typed-character path reads either .value or
   .textContent (kbdRead/kbdClear). */
const KBD_MODE = (params.get("kbd") || "ce").toLowerCase();
function kbdRead(el) { return el.isContentEditable ? el.textContent : (el.value || ""); }
function kbdClear(el) { if (el.isContentEditable) el.textContent = ""; else el.value = ""; }
(function makeKeyboardElement() {
  const old = document.getElementById("kbd");
  if (!old) return;
  let el;
  if (KBD_MODE === "ce") { el = document.createElement("div"); el.contentEditable = "true"; el.setAttribute("role", "textbox"); }
  else {
    el = document.createElement("input");
    el.type = KBD_MODE === "search" || KBD_MODE === "url" ? KBD_MODE : "text";
    el.setAttribute("autocomplete", KBD_MODE === "otc" ? "one-time-code" : "off");
  }
  el.setAttribute("inputmode", KBD_MODE === "none" ? "none" : "text");
  el.id = "kbd";
  for (const [k, v] of [["autocorrect", "off"], ["autocapitalize", "off"], ["spellcheck", "false"], ["enterkeyhint", "enter"], ["aria-label", "keyboard input"], ["data-mode", KBD_MODE]]) el.setAttribute(k, v);
  old.replaceWith(el);                                    // name-less on purpose: not an autofill target
  report("kbd", `mode=${KBD_MODE} tag=${el.tagName} ua=${navigator.userAgent}`);
})();
const kbdTrace = [];
function kbdLog(msg) {
  const vv = window.visualViewport;
  const line = `${msg} active=${document.activeElement && document.activeElement.id || document.activeElement && document.activeElement.tagName} vvh=${vv ? Math.round(vv.height) : "?"}/${innerHeight} scale=${view && view.scale ? view.scale.toFixed(3) : "?"} up=${keyboardUp()} want=${wantKeyboard} held=${keyboardHeld}`;
  kbdTrace.push(line); if (kbdTrace.length > 40) kbdTrace.shift();
  diag("kbd " + line);
}
function softKeyboardShowing() {
  const k = $("kbd");
  return !!(k && document.activeElement === k && window.visualViewport && window.visualViewport.height < window.innerHeight - 100);
}
function keyboardUp() {
  if (params.get("keybar") === "1") return true;                 // preview the bar on a desktop
  return softKeyboardShowing();
}
/* With the keyboard up, the layer that has the focus is shifted so it sits above it. */
function keyboardShift() {
  if (!keyboardUp()) return 0;
  const bar = $("keybar");
  const vv = window.visualViewport;
  // The room above our bar, in layout coordinates: the bar sits at the bottom of the visual
  // viewport (on top of the browser's own accessory row, which is inside the keyboard's height).
  const barTop = bar && bar.classList.contains("show") ? bar.getBoundingClientRect().top : vv.offsetTop + vv.height;
  const vh = Math.max(120, barTop - safe.t);
  const focused = placed.filter(w => w.kind === "W" || w.kind === "O").slice(-1)[0];
  if (!focused) return 0;
  // The host does not know where the caret is; the window's bottom edge (where a DOS box or a
  // Notepad file being typed into ends) is placed just above the bar, never past its own caption.
  const bottom = focused.y + focused.hh;
  return bottom > vh ? Math.min(focused.y, bottom - vh + 4) : 0;
}
/* Focus the hidden input. Only works on iOS inside a touch gesture handler (touchend of the tap),
   so the touch code calls this synchronously; calls from elsewhere are harmless no-ops there and
   still work on desktops. An input that is focused but whose keyboard the user dismissed with the
   keyboard's own key needs a blur first, or focus() does nothing. */
function focusKeyboard(reason) {
  const inp = $("kbd");
  if (!inp) return false;
  clearTimeout(kbdBlurTimer);
  const wasActive = document.activeElement === inp;
  if (wasActive && !keyboardUp() && touchDevice) inp.blur();
  kbdClear(inp);
  try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
  kbdLog(`focus try (${reason}) wasActive=${wasActive}`);
  setTimeout(() => kbdLog(`focus result (${reason})`), 350);
  setTimeout(updateKeybar, 100);
  return document.activeElement === inp;
}
/* The guest's word on whether it wants text (PVK). 1 keeps or refocuses; 0 releases after a short
   debounce, so a tap that moves the focus from one Edit into another does not flicker. A manual
   hold (caption long-press) overrides 0. */
function guestWantsKeyboard(want) {
  if (want) {
    wantKeyboard = true;
    clearTimeout(kbdBlurTimer);
    if (performance.now() < kbdSuppressedUntil) { kbdLog("PVK 1 (suppressed after hide)"); return; }
    kbdLog("PVK 1");
    if (performance.now() < lateTapUntil && document.activeElement !== $("kbd")) { lateTapUntil = 0; focusKeyboard("late"); return; }
    syncKeyboard();
  } else {
    wantKeyboard = false;
    if (keyboardHeld) { kbdLog("PVK 0 (held)"); return; }
    kbdLog("PVK 0");
    clearTimeout(kbdBlurTimer);
    kbdBlurTimer = setTimeout(() => { if (!wantKeyboard && !keyboardHeld) syncKeyboard(); }, 400);
  }
}
/* After a tap that focused the input speculatively (the guest had not asked yet): if the guest has
   still not asked once its reports have had time to arrive (the CBT hook reports focus changes at
   once, PVMON's per-program list within ~200 ms; a phone's guest is slower), let it go again. */
function speculativeRelease() {
  clearTimeout(kbdBlurTimer);
  kbdBlurTimer = setTimeout(() => {
    if (wantKeyboard || keyboardHeld) return;
    kbdLog("speculative focus released (no PVK 1)");
    syncKeyboard();
  }, 700);
}
function syncKeyboard() {
  const inp = $("kbd");
  if (!inp) return;
  if ((wantKeyboard || keyboardHeld) && document.activeElement !== inp) { kbdClear(inp); inp.focus({ preventScroll: true }); }
  else if (!wantKeyboard && !keyboardHeld && document.activeElement === inp) { inp.blur(); kbdLog("blur"); }
  setTimeout(updateKeybar, 100);
}

/* Audio unlock. iOS creates every AudioContext suspended until a user gesture resumes it, and
   only touchend/click count as the gesture (touchstart does not on Chrome for iOS); a context also
   goes "interrupted" when the app is backgrounded or a call comes in, and must be resumed again.
   The phone's ring/silent switch mutes Web Audio unless the page has also played a media element,
   so a silent <audio> loop is started in the same gesture. Nothing here is visible. */
let audioUnlocked = false, audioLogged = "", silentEl = null;
function audioCtx() { return emulator.speaker_adapter && emulator.speaker_adapter.audio_context || null; }
function audioLog(why) {
  const a = audioCtx();
  const line = `${why}: state=${a ? a.state : "none"} rate=${a ? a.sampleRate : "?"} unlocked=${audioUnlocked} silent=${silentEl ? (silentEl.paused ? "paused" : "playing") : "none"}`;
  if (line !== audioLogged) { audioLogged = line; report("audio", line); }
}
function unlockAudio(why) {
  const a = audioCtx();
  if (a) {
    if (a.state !== "running") a.resume().then(() => audioLog(why + " resumed"), e => report("audio", `resume failed: ${e && e.message}`));
    if (!a.onstatechange) a.onstatechange = () => audioLog("statechange");
  }
  if (!silentEl) {
    try {
      // 1 s of 8 kHz 8-bit silence as a WAV, looped; the media session this opens is what lets
      // Web Audio through the ring/silent switch on iPhones.
      const n = 8000, hdr = new Uint8Array(44 + n);
      const dv = new DataView(hdr.buffer);
      const str = (o, s) => { for (let i = 0; i < s.length; i++) hdr[o + i] = s.charCodeAt(i); };
      str(0, "RIFF"); dv.setUint32(4, 36 + n, true); str(8, "WAVEfmt "); dv.setUint32(16, 16, true);
      dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true);
      dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); str(36, "data"); dv.setUint32(40, n, true);
      hdr.fill(0x80, 44);
      silentEl = document.createElement("audio");
      silentEl.setAttribute("playsinline", ""); silentEl.loop = true; silentEl.volume = 0.01;
      silentEl.src = URL.createObjectURL(new Blob([hdr], { type: "audio/wav" }));
    } catch (e) { silentEl = null; }
  }
  if (silentEl && silentEl.paused) silentEl.play().then(() => { audioUnlocked = true; audioLog(why + " media"); }, e => report("audio", `silent media failed: ${e && e.name}`));
  audioLog(why);
}
for (const evn of ["touchend", "click", "keydown", "pointerup"])
  document.addEventListener(evn, () => unlockAudio(evn), { capture: true, passive: true });
document.addEventListener("visibilitychange", () => { if (!document.hidden) unlockAudio("visible"); });
window.addEventListener("focus", () => unlockAudio("focus"));
window.addEventListener("pageshow", () => unlockAudio("pageshow"));
const CMD_SCROLL = 7, CMD_CURSOR = 10;
const touchDevice = ("ontouchstart" in window) || (window.matchMedia && matchMedia("(pointer: coarse)").matches);

/* The guest pointer is hidden while the screen is being touched (an arrow under a finger means
   nothing and its save-under fights the repaints) and shown again the moment a real mouse moves.
   PVMON keeps the ShowCursor count where it was told (CMD_CURSOR 0/1); only transitions are sent. */
let guestCursorShown = true;
function setGuestCursor(show, force) {
  if (!desktopReady) return;
  if (!force && guestCursorShown === show) return;
  guestCursorShown = show;
  sendCommand(CMD_CURSOR, show ? 1 : 0);
  diag(`cursor ${show ? "shown" : "hidden"}`);
}

/* Per-surface policy for one finger on a window's client area.
     scroll  read-only / content surfaces: a drag scrolls the window (CMD_SCROLL, like two fingers)
     drag    draw and drag surfaces: a drag is a pointer drag (cards, brushes, DOS box selection)
   Keyed by the window title PVMON publishes (class names are not on the wire). Taps are clicks
   everywhere. Unknown titles get pointer drag, the behaviour every Windows program expects. */
const SURFACE_POLICY = [
  [/\bHelp\b/, "scroll"], [/^Write\b/, "scroll"], [/^Notepad\b/, "scroll"], [/^Cardfile\b/, "scroll"],
  [/^File Manager/, "scroll"], [/^Control Panel/, "scroll"], [/^Print Manager/, "scroll"], [/^Task List/, "scroll"],
  [/^Calendar\b/, "scroll"], [/^Character Map/, "scroll"], [/^Media Player/, "scroll"], [/^Clipboard/, "scroll"],
  [/^Solitaire/, "drag"], [/^Paintbrush/, "drag"], [/^Minesweeper/, "drag"], [/^Hearts/, "drag"], [/MS-DOS/, "drag"],
  [/^Terminal/, "drag"], [/^Reversi/, "drag"],
];
/* CMD_SCROLL's slot field for the shell: PVMON routes it to Program Manager's active MDI group
   window (WM_VSCROLL/WM_HSCROLL). Slot numbers 0..MAX_SLOTS-1 are application columns. */
const SHELL_SCROLL_SLOT = 15;
/* A desktop hit inside Program Manager's client area (the group windows), not the icon row or the
   desktop around it: a one-finger drag there scrolls the active group. */
function insideShellClient(h) {
  if (!h || h.kind !== "desktop") return false;
  const S = layers.find(L => L.kind === "S");
  return !!S && h.x >= S.gx && h.x < S.gx + S.gw && h.y >= S.gy && h.y < S.gy + S.gh;
}
function surfacePolicy(L) {
  if (!L || L.kind !== "W") return "drag";
  for (const [re, pol] of SURFACE_POLICY) if (re.test(L.title || "")) return pol;
  return "drag";
}
/* Programs that never take text: a tap there does not even try the keyboard speculatively, so the
   keyboard does not pop up for the guest to send away again on every card. */
const NO_KEYBOARD = /^(Solitaire|Hearts|Minesweeper|Paintbrush|Clock|Reversi)\b/;
const KEYBOARD_TITLES = /MS-DOS|^Notepad\b|^Write\b|^Terminal\b|^Cardfile\b|^Calendar\b|^Calculator\b/;

/* The shell column's height follows the visible viewport (browser toolbars come and go), so the
   desktop fills the phone with no letterbox. PVMON re-arranges Program Manager on request. */
const CMD_SHELLSIZE = 8;
let shellHeightSent = 0, shellHeightPending = 0, shellHeightTimer = 0;
function wantShellHeight(h) {
  if (!h || !desktopReady) return;
  h = Math.max(300, Math.min(SHELL_H, h & ~1));
  if (Math.abs(h - shellHeightSent) < 8 || h === shellHeightPending) return;
  shellHeightPending = h;
  clearTimeout(shellHeightTimer);
  shellHeightTimer = setTimeout(() => {
    shellHeightSent = shellHeightPending;
    sendCommand(CMD_SHELLSIZE, shellHeightSent);
  }, 400);
}

function layerKey(L) { return L.kind === "W" ? "s" + L.slot : L.kind + ":" + L.title; }
/* Host -> guest commands go through one register that PVMON polls every 40 ms and clears when it
   has taken the command. Two sends inside one poll interval used to overwrite each other (a
   CMD_CURSOR followed by a CMD_ACTIVATE lost the cursor command), so commands are queued and the
   next one goes out only once the guest has acknowledged the last; consecutive scroll steps for
   the same window and direction are merged. A guest that never acknowledges (hung) is not waited
   for beyond two seconds, so the queue cannot wedge the host. */
const cmdQueue = [];
let cmdSentAt = 0;
function guestBusy() { try { return emulator.v86.cpu.devices.vga.pv_cmd !== 0; } catch (e) { return false; } }
function pumpCommands() {
  if (!cmdQueue.length) return;
  if (guestBusy() && performance.now() - cmdSentAt < 2000) return;
  const c = cmdQueue.shift();
  if (c.str !== undefined) emulator.bus.send("pv-command-string", [c.cmd, c.str]);
  else emulator.bus.send("pv-command", [c.cmd, c.arg]);
  cmdSentAt = performance.now();
}
function sendCommand(cmd, arg) {
  if (cmd === CMD_SCROLL && cmdQueue.length) {
    const last = cmdQueue[cmdQueue.length - 1];
    if (last.cmd === CMD_SCROLL && (last.arg & 0xFFF) === (arg & 0xFFF)) {
      last.arg = (arg & 0xFFF) | Math.min(15, (last.arg >> 12) + (arg >> 12)) << 12;
      return;
    }
  }
  cmdQueue.push({ cmd, arg });
  pumpCommands();
}
function sendCommandString(cmd, str) { cmdQueue.push({ cmd, str }); pumpCommands(); }
setInterval(pumpCommands, 20);
window.pvCommandQueue = () => cmdQueue.slice();
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
  /* Portrait: the whole shell column fits the screen. Landscape: fitting the column's full
     height would make everything tiny, so the desktop is scaled to show its top 480 rows (caption,
     menu, the program groups) and the rest is simply below the fold; application layers scale to
     the wide viewport on their own. */
  const scale = vw > vh ? Math.min(vw / shell.w, vh / 480) : vw / shell.w;
  // While the soft keyboard is up the visible viewport is short; that must not re-arrange the
  // shell (it would thrash on every show/hide). Keep the column as it is and pan instead.
  // In either orientation the column is arranged to the rows the viewport shows at this scale,
  // so a rotation re-runs the shell sizing for the new geometry.
  if (!keyboardUp()) wantShellHeight(Math.round(vh / scale));
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
    if (L.kind === "S") {
      /* The shell takes part in z-order: when Program Manager is in front it is drawn again, on
         top of the applications, exactly where it already is in the desktop column. */
      const x = Math.round(view.ox + L.wx * c), y = Math.round(L.wy * c);
      const hw = Math.round(L.ww * c), hh = Math.round(L.wh * c);
      out.push({ ...L, key, s: c, c, cw: hw, ch: hh, hw, hh, x, y, hl: 0, ht: 0, hb: 0,
                 inset: { l: 0, t: 0, b: 0 }, capRow: 0, menuRow: 0, box: 0, shellCopy: true });
      return;
    }
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
      /* Shown as far as possible: anchored where it popped up, shifted up/left so the whole of it
         fits when it can. A popup taller or wider than the viewport (a long View menu, a combo
         drop-down) cannot scroll in the guest, so the user pans it instead: layerPos holds the pan,
         clamped so the layer's far edge can be brought into view and no further (never a gap). */
      x = hw > vw ? 0 : Math.max(0, Math.min(vw - hw, x));        // too wide: start at its left edge
      y = hh > vh ? 0 : Math.max(0, Math.min(vh - hh, y));        // too tall: start at its top, pan for the rest
      const pan = layerPos[key];
      if (pan) {
        x = hw > vw ? Math.max(vw - hw, Math.min(0, x + pan.dx)) : x;
        y = hh > vh ? Math.max(vh - hh, Math.min(0, y + pan.dy)) : y;
      }
      out.push({ ...L, key, s: c, c, cw: hw, ch: hh, hw, hh, x, y, hl: 0, ht: 0, hb: 0, ax: x - (pan ? pan.dx : 0), ay: y - (pan ? pan.dy : 0),
                 inset: { l: 0, t: 0, b: 0 }, capRow: 0, menuRow: 0, box: 0, transient: true });
      return;
    }
    /* An owned dialog that still overlaps its owner in guest VRAM (the hook could not place it
       below or beside the owner) is already part of the owner's capture. Drawing it as a second,
       larger layer showed two copies, and masking it out of the owner smeared a strip across the
       hole. Instead it is drawn coincident with its copy: whole window, at the owner's client scale,
       at exactly the spot where the owner shows it, so the two copies are one image. */
    if (L.kind === "O") {
      const owner = bySlot[L.slot];
      if (owner) {
        const ox0 = owner.gx + owner.px, oy0 = owner.gy + owner.py;
        const overlaps = L.wx < ox0 + owner.vw && L.wx + L.ww > ox0 && L.wy < oy0 + owner.vh && L.wy + L.wh > oy0;
        if (overlaps) {
          const zs = owner.zs;
          const hw = Math.round(L.ww * zs), hh = Math.round(L.wh * zs);
          const x = Math.round(owner.x + owner.hl + (L.wx - ox0) * zs);
          const y = Math.round(owner.y + owner.ht + (L.wy - oy0) * zs);
          out.push({ ...L, key, s: zs, c: zs, cw: hw, ch: hh, hw, hh, x, y, hl: 0, ht: 0, hb: 0,
                     inset: { l: 0, t: 0, b: 0 }, capRow: 0, menuRow: 0, box: 0, transient: true, coincident: true });
          return;
        }
      }
    }
    const inset = {                                  // frame thickness in guest pixels
      l: Math.max(0, L.gx - L.wx),
      t: Math.max(0, L.gy - L.wy),
      b: Math.max(0, (L.wy + L.wh) - (L.gy + L.gh)),
      r: Math.max(0, (L.wx + L.ww) - (L.gx + L.gw)),   // border + a vertical scrollbar (GetClientRect excludes it)
    };
    const capRow = Math.min(inset.t, inset.l + shell.cap);   // border plus caption
    const menuRow = inset.t - capRow;                        // menu bar, if the window has one
    const box = Math.max(12, shell.cap);                     // a caption box is square
    const hl = Math.round(inset.l * c), ht = Math.round(inset.t * c), hb = Math.round(inset.b * c);
    const hr = Math.round(inset.r * c);
    const availW = vw - hl - hr;                       // edge to edge: a layer may fill the width
    const availH = vh - ht - hb;
    const s = Math.min(c, availW / Math.max(1, L.gw), availH / Math.max(1, L.gh));
    const cw = Math.round(L.gw * s), ch = Math.round(L.gh * s);
    const hw = cw + hl + hr, hh = ch + ht + hb;
    let p = layerPos[key];
    if (!p) {
      const owner = L.kind === "O" ? bySlot[L.slot] : null;
      /* Default placement, no cascade: a new layer fills the width (x = 0 when it is as wide as
         the viewport, centred when it is narrower) and sits just under the shell's caption strip,
         so Program Manager's caption stays reachable behind it; a layer taller than that room is
         top-aligned. The user can still drag it anywhere, including off the edges. */
      const capStrip = Math.round(shell.cap * c) + Math.round(inset.l * c);
      if (owner) {
        // A dialog the guest placed clear of its owner goes below the owner here too, when there is
        // room, so the owner stays visible (a Save prompt with its document, an Open box with the
        // recorder); otherwise centred on the owner.
        const below = owner.y + owner.hh;
        p = layerPos[key] = below + hh <= vh
          ? { x: Math.max(0, Math.round(owner.x + (owner.hw - hw) / 2)), y: below }
          : { x: Math.round(owner.x + (owner.hw - hw) / 2), y: Math.round(owner.y + (owner.hh - hh) / 2) };
      } else {
        p = layerPos[key] = { x: Math.max(0, Math.round((vw - hw) / 2)), y: Math.max(0, Math.min(capStrip, vh - hh)) };
      }
    }
    // A window that fits stays entirely on screen; one that does not may hang off the edges, but
    // never so far that less than a thumb's width of it is left to grab.
    const x = Math.max(40 - hw, Math.min(vw - 40, p.x));   // at least a thumb's width stays on screen
    // a window taller than the viewport (a dialog on a short landscape screen) may be panned up
    // until its bottom edge shows, since the guest cannot scroll it; a shorter one keeps its caption on screen
    const y = Math.max(Math.min(0, vh - hh), Math.min(vh - Math.round(capRow * c), p.y));
    /* Pinch zoom: the frame keeps its fitted size and the client area inside it is shown at a
       larger scale, panned. z = 1 is "fit". */
    const zp = layerZoom[key] || { z: 1, px: 0, py: 0 };
    const zs = s * zp.z;
    const vis = { w: Math.min(L.gw, cw / zs), h: Math.min(L.gh, ch / zs) };   // guest px visible
    zp.px = Math.max(0, Math.min(L.gw - vis.w, zp.px));
    zp.py = Math.max(0, Math.min(L.gh - vis.h, zp.py));
    const w = { ...L, src: L, key, s, c, cw, ch, hw, hh, x, y, inset, capRow, menuRow, box, hl, ht, hb, hr,
                zs, px: zp.px, py: zp.py, vw: vis.w, vh: vis.h };
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
    if (w.shellCopy)
      return { kind: "desktop", win: w, x: Math.round(w.wx + dx / w.c), y: Math.round(w.wy + dy / w.c) };
    if (w.transient)
      return { kind: "chrome", win: w, x: Math.round(w.wx + dx / w.c), y: Math.round(w.wy + dy / w.c) };
    if (dy >= w.ht && dy < w.ht + w.ch && dx >= w.hl && dx < w.hl + w.cw) {
      return { kind: "client", win: w,
               x: Math.round(w.gx + w.px + (dx - w.hl) / w.zs),
               y: Math.round(w.gy + w.py + (dy - w.ht) / w.zs) };
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
  if (w.transient || w.shellCopy) {
    blit(g, src, w.wx, w.wy, w.ww, w.wh, w.x, w.y, w.hw, w.hh);
    return;
  }
  const { inset, capRow, menuRow, box, hl, ht, hb } = w;
  const capH = Math.round(capRow * c), menuH = ht - capH;
  const cornerL = Math.round((inset.l + box) * c), cornerR = Math.round((inset.l + 2 * box) * c);
  const midSrcW = w.ww - 2 * inset.l - 3 * box;       // the caption strip between the boxes
  const midDstW = w.hw - cornerL - cornerR;
  blit(g, src, w.wx, w.wy, inset.l + box, capRow, w.x, w.y, cornerL, capH);
  blit(g, src, w.wx + w.ww - inset.l - 2 * box, w.wy, inset.l + 2 * box, capRow,
              w.x + w.hw - cornerR, w.y, cornerR, capH);
  if (midSrcW > 0 && midDstW > 0) {
    const need = midDstW / c;                         // guest pixels that fit in the gap
    if (need <= midSrcW) {
      /* Cropped rather than squeezed: equal slivers of empty caption come off each side and the
         title, which Windows centres, stays centred, at its own size and perfectly crisp. */
      const cut = Math.floor((midSrcW - need) / 2);
      blit(g, src, w.wx + inset.l + box + cut, w.wy, Math.round(need), capRow,
                  w.x + cornerL, w.y, midDstW, capH);
    } else {                                          // wider on the host: pad, do not stretch
      const midH = Math.round(midSrcW * c), pad = midDstW - midH;
      blit(g, src, w.wx + inset.l + box, w.wy, 2, capRow, w.x + cornerL, w.y, pad, capH);
      blit(g, src, w.wx + inset.l + box, w.wy, midSrcW, capRow, w.x + cornerL + pad, w.y, midH, capH);
    }
  }
  if (menuRow > 0 && menuH > 0) {
    const innerW = w.hw - 2 * hl;                     // between the side borders, never over them
    const mwG = Math.min(w.ww - 2 * inset.l, Math.round(innerW / c)), mwH = Math.round(mwG * c);
    blit(g, src, w.wx + inset.l, w.wy + capRow, mwG, menuRow, w.x + hl, w.y + capH, mwH, menuH);
    if (innerW > mwH)                                 // pad with the menu bar's own background
      blit(g, src, w.wx + inset.l + mwG - 2, w.wy + capRow, 2, menuRow, w.x + hl + mwH, w.y + capH, innerW - mwH, menuH);
  }
  if (hl > 0) {                                       // side borders, stretched only lengthways, caption to bottom
    blit(g, src, w.wx, w.wy + capRow, inset.l, w.wh - capRow - inset.b, w.x, w.y + capH, hl, w.hh - capH - hb);
    { const hr = w.hr == null ? hl : w.hr, ir = w.inset.r == null ? inset.l : w.inset.r;
      blit(g, src, w.wx + w.ww - ir, w.wy + capRow, ir, w.wh - capRow - inset.b, w.x + w.hw - hr, w.y + capH, hr, w.hh - capH - hb); }
  }
  if (hb > 0)
    blit(g, src, w.wx, w.gy + w.gh, Math.min(w.ww, Math.round(w.hw / c)), inset.b,
                w.x, w.y + ht + w.ch, w.hw, hb);
  /* The client, at the scale that fits. An owned dialog or a menu that physically overlaps this
     window in guest VRAM is part of this capture too, and it is drawn again as its own layer: the
     overlapping rectangles are masked out of the client blit (clipped away, so whatever is behind
     the owner shows through until the child's own layer covers it), so a fallback placement never
     shows two copies of a dialog. */
  const holes = overlapsOf(w);
  if (holes.length) {
    g.save();
    g.beginPath();
    g.rect(w.x + hl, w.y + ht, Math.round(w.vw * w.zs), Math.round(w.vh * w.zs));
    for (const h of holes) {
      // guest rect -> host rect through this layer's client mapping, in the opposite winding
      const x0 = w.x + hl + (h.x - (w.gx + w.px)) * w.zs, y0 = w.y + ht + (h.y - (w.gy + w.py)) * w.zs;
      const x1 = x0 + h.w * w.zs, y1 = y0 + h.h * w.zs;
      g.moveTo(x0, y0); g.lineTo(x0, y1); g.lineTo(x1, y1); g.lineTo(x1, y0); g.closePath();
    }
    g.clip("evenodd");
  }
  blit(g, src, w.gx + w.px, w.gy + w.py, w.vw, w.vh, w.x + hl, w.y + ht,
       Math.round(w.vw * w.zs), Math.round(w.vh * w.zs));
  if (holes.length) g.restore();
}
/* Owned (PVO) and transient (PVT) windows that overlap layer `w`'s client area in guest screen
   space, as guest rects clipped to the visible part of the client. Only children that are drawn as
   their own layer count, so nothing is ever masked without a copy on top. */
function overlapsOf(w) {
  const out = [];
  const cx0 = w.gx + w.px, cy0 = w.gy + w.py, cx1 = cx0 + w.vw, cy1 = cy0 + w.vh;
  for (const L of layers) {
    if (L === w.src || (L.kind !== "O" && L.kind !== "T")) continue;
    if (L.kind === "O" && L.slot < 0) continue;                 // shell dialogs are not layers
    if (L.kind === "O" && w.kind === "W" && L.slot !== w.slot) continue;
    if (placed.some(p => p.src === L && p.coincident)) continue;   // drawn over its own copy: no hole
    const x0 = Math.max(cx0, L.wx), y0 = Math.max(cy0, L.wy);
    const x1 = Math.min(cx1, L.wx + L.ww), y1 = Math.min(cy1, L.wy + L.wh);
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

/* Microphone: the emulated Sound Blaster asks for capture the moment the guest issues a DMA
   input command (Sound Recorder's Record), so the browser's permission prompt is the only thing
   the user sees and only when they record. Audio is pulled from getUserMedia through a
   ScriptProcessor (an AudioWorklet would need a separate module file; this runs everywhere,
   iOS Safari included), downmixed to mono, and handed to the device, which resamples to the
   DSP's own rate. When there is no capture (denied, or not a secure context: getUserMedia is
   absent over plain http except on localhost) the device records silence at the right rate, so
   Record still runs and Stop still works. */
const mic = { stream: null, ctx: null, source: null, node: null, sink: null, active: false, starting: null, blocks: 0 };
window.micState = () => ({ active: mic.active, blocks: mic.blocks, have: !!mic.stream, secure: window.isSecureContext, gum: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) });
async function micOpen() {
  if (mic.stream) return true;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    report("mic", `unavailable: secure=${window.isSecureContext} mediaDevices=${!!navigator.mediaDevices}`);
    return false;
  }
  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }, video: false });
  } catch (e) { report("mic", `getUserMedia failed: ${e && e.name} ${e && e.message}`); return false; }
  const a = emulator.speaker_adapter && emulator.speaker_adapter.audio_context;
  mic.ctx = a || new (window.AudioContext || window.webkitAudioContext)();
  mic.source = mic.ctx.createMediaStreamSource(mic.stream);
  mic.node = mic.ctx.createScriptProcessor(1024, 1, 1);
  mic.sink = mic.ctx.createGain(); mic.sink.gain.value = 0;      // a ScriptProcessor only runs when routed to the destination
  mic.node.onaudioprocess = ev => {
    if (!mic.active) return;
    const inb = ev.inputBuffer;
    const out = new Float32Array(inb.length);
    for (let c = 0; c < inb.numberOfChannels; c++) { const d = inb.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i]; }
    if (inb.numberOfChannels > 1) for (let i = 0; i < out.length; i++) out[i] /= inb.numberOfChannels;
    mic.blocks++;
    emulator.bus.send("sb16-record-data", [out, inb.sampleRate]);
  };
  mic.source.connect(mic.node); mic.node.connect(mic.sink); mic.sink.connect(mic.ctx.destination);
  const tr = mic.stream.getAudioTracks()[0];
  tr.onended = () => micClose();
  report("mic", `capture open: ${mic.ctx.sampleRate} Hz, ${tr.label}`);
  return true;
}
function micClose() {
  try { mic.node && mic.node.disconnect(); mic.source && mic.source.disconnect(); mic.sink && mic.sink.disconnect(); } catch (e) {}
  try { mic.stream && mic.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  mic.stream = mic.source = mic.node = mic.sink = null;
}
emulator.bus.register("sb16-record-start", rate => {
  mic.active = true;
  try { if (mic.ctx && mic.ctx.state === "suspended") mic.ctx.resume(); } catch (e) {}
  if (!mic.starting) mic.starting = micOpen().finally(() => { mic.starting = null; });
});
emulator.bus.register("sb16-record-stop", () => { mic.active = false; });
/* The capture is kept open between recordings (one permission prompt per visit); it is released
   when the page is hidden, like the emulator's own state. */
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && !mic.active) micClose(); });

/* Errors and a heartbeat go to the dev server: phones have no console to read. */
let frames = 0, lastBeat = 0, lastIc = 0, lastBeatAt = 0;
function report(kind, detail) {
  try { fetch("/__log", { method: "POST", body: `${kind} ${detail}`, keepalive: true }); } catch (e) {}
}
window.addEventListener("error", ev => report("error", `${ev.message} @${ev.filename}:${ev.lineno} ${ev.error && ev.error.stack}`));
window.addEventListener("unhandledrejection", ev => report("rejection", String(ev.reason && (ev.reason.stack || ev.reason))));

function present() {
  try { presentOnce(); } catch (e) { report("present", e.stack || String(e)); }
  frames++;
  const now = performance.now();
  if (now - lastBeat > 15000) {
    lastBeat = now;
    let ic = 0; try { ic = emulator.get_instruction_counter() >>> 0; } catch (e) {}
    const mips = lastIc ? ((ic - lastIc) >>> 0) / (now - lastBeatAt) / 1000 : 0;
    lastIc = ic; lastBeatAt = now;
    report("beat", `frames=${frames} running=${emulator.is_running && emulator.is_running()} vp=${innerWidth}x${innerHeight} layers=${layers.map(l => l.kind + ":" + (l.title || "").slice(0, 14)).join("|")} ready=${desktopReady} mips=${mips.toFixed(1)} pvmon=${shell.ver || "?"}`);
  }
  requestAnimationFrame(present);
}

/* drawImage throws on an empty source rectangle; a window can legitimately have one (a zero-size
   client while it is being created), and one throw must never take the render loop down. */
function blit(g, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  g.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
}

/* Instant first paint: the last composited frame of the previous visit (guest pixels, kept in
   IndexedDB next to the snapshot) is shown until the restored guest has painted its desktop, so the
   page never opens on black while the 2 MB snapshot downloads and restores. Never drawn over a
   cold boot (that shows DOS and the logo, as it should). */
let firstFrame = null, firstFrameUntil = 0, firstFrameShown = false;
function drawFirstFrame(g, vw, vh) {
  const img = firstFrame;
  const sc = Math.min(vw / img.width, vh / img.height);
  const dw = Math.round(img.width * sc), dh = Math.round(img.height * sc);
  g.drawImage(img, Math.round((vw - dw) / 2), 0, dw, dh);
  if (!firstFrameShown) { firstFrameShown = true; report("firstframe", `shown ${img.width}x${img.height} at ${Math.round(performance.now() - pageStart)}ms`); }
}
function presentOnce() {
  const src = document.querySelector("#screen_container canvas");
  const pres = $("pres");
  if (!pres) return;
  const [fw, fh] = fullViewport();
  const [vw, vh] = viewport();
  const dpr = window.devicePixelRatio || 1;
  if (pres.width !== Math.round(fw * dpr) || pres.height !== Math.round(fh * dpr)) {
    pres.width = Math.round(fw * dpr); pres.height = Math.round(fh * dpr);
    pres.style.width = fw + "px"; pres.style.height = fh + "px";
  }
  const g = pres.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  const guestUp = src && src.width && (desktopReady || !firstFrame || performance.now() > firstFrameUntil);
  if (!guestUp && firstFrame) {
    g.fillStyle = "#000"; g.fillRect(0, 0, fw, fh);
    g.translate(safe.l, safe.t);
    drawFirstFrame(g, vw, vh);
    return;
  }
  if (src && src.width) {
    view = chooseView(src);
    g.fillStyle = "#000";
    g.fillRect(0, 0, fw, fh);                            // the safe areas stay black: nothing there
    g.translate(safe.l, safe.t);                         // everything else in the safe rectangle
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
      blit(g, src, view.x, view.y, view.w, view.h, view.ox, 0, Math.round(dw), Math.round(dh));
      placed = narrow() ? placeLayers(src) : [];
      const shift = keyboardShift();
      if (shift) g.translate(0, -shift);
      for (const w of placed) drawWindow(g, src, w);  // back to front
      if (shift) g.translate(0, shift);
    }
    // Did the composite change? A cheap signature of a few hundred source pixels is enough for the
    // watchdog to tell "the guest is painting" from "nothing has moved since the last input".
    if ((frames & 7) === 0) {
      try {
        const sg = src.getContext("2d");
        const step = Math.max(1, Math.floor(src.height / 24));
        let sig = 0;
        for (let y = 0; y < src.height; y += step) {
          const row = sg.getImageData(0, y, Math.min(src.width, 1024), 1).data;
          for (let i = 0; i < row.length; i += 64) sig = (sig * 31 + row[i] + row[i + 1] * 7 + row[i + 2] * 13) | 0;
        }
        if (sig !== wd.frameSig) { wd.frameSig = sig; wd.lastChange = performance.now(); }
      } catch (e) {}
    }
  }
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


/* Time-based waits run off the worker heartbeat (see the bottom of the file): a hidden tab throttles
   setTimeout to once a second or worse, which would stall pointer steering the moment the page is
   backgrounded. Falls back to setTimeout until the worker is up. */
const sleepers = [];
function sleep(ms) {
  return new Promise(r => {
    if (window.pvHeartbeat) sleepers.push({ at: performance.now() + ms, r });
    else setTimeout(r, ms);
  });
}
function runSleepers() {
  const now = performance.now();
  for (let i = sleepers.length - 1; i >= 0; i--) if (sleepers[i].at <= now) sleepers.splice(i, 1)[0].r();
}
const diag = params.get("diag") ? (m => report("diag", m)) : (() => {});

/* Steer the guest pointer to a point. The stock PS/2 driver is relative, so the whole distance
   is sent as one burst of packets (mouse acceleration is off, so mickeys are pixels), then the
   position the driver reports is checked and corrected a couple of times. Targets are coalesced:
   a drag that produces fifty moves steers towards the latest one, never queues them. */
let steerTarget = null, steering = null;

function steerTo(pt) {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return Promise.resolve();
  emulator.bus.send("pv-mouse-abs", null);              // relative motion from here on
  steerTarget = pt;
  if (!steering) steering = (async () => {
    try {
      for (let i = 0; i < 4 && steerTarget; i++) {
        if (!guestCursor) { emulator.bus.send("mouse-delta", [1, 0]); await sleep(20); continue; }
        const dx = Math.round(steerTarget.x - guestCursor.x), dy = Math.round(steerTarget.y - guestCursor.y);
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) break;
        let rx = dx, ry = dy, packets = 0;
        while ((rx || ry) && packets < 64) {   // a PS/2 packet carries one signed byte per axis
          const sx = Math.max(-100, Math.min(100, rx)), sy = Math.max(-100, Math.min(100, ry));
          emulator.bus.send("mouse-delta", [sx, -sy]);   // guest Y grows downwards
          rx -= sx; ry -= sy; packets++;
        }
        /* Wait for the driver to report where the pointer actually went before correcting.
           Re-sending the delta blindly while the guest was busy (dropping a card repaints the
           table) drove the pointer several screens away, which looked like it was stuck. */
        const seq = cursorSeq, t0 = performance.now();
        while (cursorSeq === seq && performance.now() - t0 < 900) await sleep(8);
        if (cursorSeq === seq) break;          // no report: leave it, do not compound the error
      }
    } finally { steering = null; steerTarget = null; }
  })();
  return steering;
}

/* A press goes to an exact point: PVMON puts the pointer there with SetCursorPos, and the driver's
   report of the new position is the cue that it has landed. Relative steering is kept for the
   motion of a drag, where it is the right tool. */
const CMD_SETPOS = 9;
/* Absolute pointing through the mouse driver (PVMOUSE.DRV): the target goes into the adapter's
   registers normalised to 0..65535, and a PS/2 packet raises the mouse interrupt; the driver
   reports SF_ABSOLUTE and USER puts the pointer there at interrupt time, however busy the
   applications are. If no report comes (an image without the driver), PVMON's SetCursorPos is
   the fallback. */
let absPointer = params.get("relmouse") ? false : true, absMisses = 0;
function screenSize() {
  const src = document.querySelector("#screen_container canvas");
  return src && src.width ? [src.width, src.height] : [SLOT_W * (1 + MAX_SLOTS), SHELL_H];
}
async function placePointer(pt) {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) { diag(`place: bad target ${JSON.stringify(pt)}`); return; }
  const seq = cursorSeq, t0 = performance.now();
  if (absPointer) {
    const [sw, sh] = screenSize();
    // USER maps x = norm * cxScreen / 65536, truncating: aim for the middle of the pixel
    const nx = Math.max(0, Math.min(65535, Math.round((pt.x + 0.5) * 65536 / sw)));
    const ny = Math.max(0, Math.min(65535, Math.round((pt.y + 0.5) * 65536 / sh)));
    emulator.bus.send("pv-mouse-abs", [nx, ny]);
    emulator.bus.send("mouse-delta", [1, 0]);          // any packet: raises the interrupt
    while (cursorSeq === seq && performance.now() - t0 < 300) await sleep(4);
    if (cursorSeq === seq) { absMisses++; if (absMisses >= 3) { absPointer = false; report("pointer", "no absolute reports: falling back to SetCursorPos"); } }
    else absMisses = 0;
  }
  if (cursorSeq === seq) {
    sendCommandString(CMD_SETPOS, `${Math.round(pt.x)},${Math.round(pt.y)}`);
    while (cursorSeq === seq && performance.now() - t0 < 800) await sleep(8);
  }
  const reported = cursorSeq !== seq;
  diag(`place ${pt.x},${pt.y} reported=${reported} after ${Math.round(performance.now() - t0)}ms cursor=${JSON.stringify(guestCursor)}`);
  // No report yet (nothing has moved the pointer since the restore) or off target: steer.
  if (!guestCursor || Math.abs(guestCursor.x - pt.x) > 1 || Math.abs(guestCursor.y - pt.y) > 1) {
    await steerTo(pt);
    diag(`steered -> ${JSON.stringify(guestCursor)}`);
  }
}

function button(down, right) { diag(`button ${down ? "down" : "up"}${right ? " right" : ""}`); emulator.bus.send("mouse-click", [down && !right, false, down && right]); }

/* A press is resolved against the composited layers: a title bar drags that window about, a dock
   entry restores an application, and anything else becomes a guest click at the pixel the user
   actually touched, even though each layer is drawn at its own scale and offset. */
function hostPoint(ev) {
  const r = $("pres").getBoundingClientRect();
  return { px: ev.clientX - r.left - safe.l, py: ev.clientY - r.top - safe.t + keyboardShift() };
}

/* The layer a press started in. While the finger is down every move is mapped through that same
   layer, even once the finger has left it: re-hit-testing mid-drag sent moves that drifted off a
   small Solitaire layer into the desktop mapping, the pointer shot into the shell column, and the
   card was dropped wherever that landed. */
let pressLayer = null;
function mapThrough(w, px, py) {
  const dx = px - w.x, dy = py - w.y;
  if (w.transient || w.shellCopy) return { x: Math.round(w.wx + dx / w.c), y: Math.round(w.wy + dy / w.c) };
  return { x: Math.round(w.gx + w.px + (dx - w.hl) / w.zs), y: Math.round(w.gy + w.py + (dy - w.ht) / w.zs) };
}
/* A desktop hit that lands inside a shell-owned dialog (drawn in the desktop column, not as a
   layer): its Edit controls are where text goes, so a tap there may summon the keyboard. */
function insideShellDialog(hit) {
  if (!hit || hit.kind !== "desktop") return false;
  return layers.some(L => L.kind === "O" && L.slot < 0 && hit.x >= L.wx && hit.x < L.wx + L.ww && hit.y >= L.wy && hit.y < L.wy + L.wh);
}
function canvasPoint(ev, startOfPress) {
  const { px, py } = hostPoint(ev);
  if (!startOfPress && pressLayer) return mapThrough(pressLayer, px, py);
  const h = hitTest(px, py);
  pressLayer = startOfPress ? (h.win && h.kind !== "desktop" ? h.win : null) : pressLayer;
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
    chromeDrag = { key: h.win.key, dx: px - p.x, dy: py - p.y, startX: px, startY: py, moved: false,
                   guest: mapThrough(h.win, px, py), timer: 0, toggled: false };
    // holding a caption still toggles the soft keyboard: a gesture, since the guest cannot always
    // tell us it wants text (Paintbrush's text tool, a DOS box)
    chromeDrag.timer = setTimeout(() => {
      if (chromeDrag && !chromeDrag.moved) { chromeDrag.toggled = true; wantKeyboard = !wantKeyboard; keyboardHeld = wantKeyboard; syncKeyboard(); }
    }, 600);
    return "drag";
  }
  /* A transient (menu, drop-down, switcher) or a dialog that does not fit the viewport is panned by
     one finger anywhere on it: the guest cannot scroll it, so the layer is moved instead, clamped
     in placeLayers so its clipped edge can be brought into view and no further. A finger that does
     not travel is still a click at the pixel under it. */
  const w = h.win;
  if (w && (w.transient || w.kind === "O") && !w.shellCopy) {
    const [vw, vh] = viewport();
    if (w.hw > vw || w.hh > vh) {
      const common = { startX: px, startY: py, moved: false, guest: mapThrough(w, px, py), timer: 0, toggled: false, fitW: w.hw <= vw, fitH: w.hh <= vh };
      if (w.coincident) {
        /* A dialog drawn coincident with its copy inside the owner's capture must stay coincident, so
           the owner layer is what pans, bounded so the dialog's clipped edge comes into view and no
           further (a wide Open box on a portrait phone). */
        const owner = placed.find(o => o.kind === "W" && o.slot === w.slot && !o.transient);
        if (!owner) return null;
        const offX = w.x - owner.x, offY = w.y - owner.y;
        chromeDrag = { ...common, key: owner.key, pan: "O", base: { x: owner.x, y: owner.y },
                       bounds: { minX: vw - w.hw - offX, maxX: -offX, minY: vh - w.hh - offY, maxY: -offY } };
      } else if (w.transient) {
        chromeDrag = { ...common, key: w.key, pan: "T", base: { ...(layerPos[w.key] || { dx: 0, dy: 0 }) } };
      } else {
        chromeDrag = { ...common, key: w.key, pan: "O", base: { x: w.x, y: w.y },
                       bounds: { minX: vw - w.hw, maxX: 0, minY: vh - w.hh, maxY: 0 } };
      }
      diag(`pan start ${w.kind}${w.coincident ? " (owner pans)" : ""} ${w.title} ${w.hw}x${w.hh} in ${vw}x${vh}`);
      return "drag";
    }
  }
  return null;
}

function dragMove(ev) {
  if (!chromeDrag) return false;
  const { px, py } = hostPoint(ev);
  if (Math.hypot(px - chromeDrag.startX, py - chromeDrag.startY) > 6) chromeDrag.moved = true;
  if (!chromeDrag.moved) return true;
  const mx = chromeDrag.fitW ? 0 : Math.round(px - chromeDrag.startX), my = chromeDrag.fitH ? 0 : Math.round(py - chromeDrag.startY);
  if (chromeDrag.pan === "T") layerPos[chromeDrag.key] = { dx: chromeDrag.base.dx + mx, dy: chromeDrag.base.dy + my };
  else if (chromeDrag.pan === "O") {
    const b = chromeDrag.bounds;
    let x = chromeDrag.base.x + mx, y = chromeDrag.base.y + my;
    if (!chromeDrag.fitW) x = Math.max(b.minX, Math.min(b.maxX, x)); else x = chromeDrag.base.x;
    if (!chromeDrag.fitH) y = Math.max(b.minY, Math.min(b.maxY, y)); else y = chromeDrag.base.y;
    layerPos[chromeDrag.key] = { x: Math.round(x), y: Math.round(y) };
  }
  else layerPos[chromeDrag.key] = { x: Math.round(px - chromeDrag.dx), y: Math.round(py - chromeDrag.dy) };
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
  let consumed = null, pressActive = false;

  /* One press = one pipeline: place the pointer, (maybe) press, follow the finger, release.
     Moves are never queued one by one: a slow guest (a phone runs the emulator at a fraction of
     desktop speed) would fall seconds behind a 0.4 s drag and the next gesture would queue up
     behind it. Instead the latest finger position is kept and a single loop steers towards it,
     one guest round-trip at a time; the release waits for the loop to catch up. */
  // Two fingers scroll whatever is under them (or zoom/pan a layer): each SCROLL_STEP of travel
  // is a line message to the guest window under the midpoint.
  const SCROLL_STEP = 24;
  let twoFinger = null;
  const mid = t => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const layerUnder = m => {
    const r = c.getBoundingClientRect();
    const h = hitTest(m.x - r.left - safe.l, m.y - r.top - safe.t + keyboardShift());
    return h.win && !h.win.transient && !h.win.shellCopy ? h.win : null;
  };

  let g = null;                                  // the current gesture; tasks close over their own
  let lastTap = null;
  const follow = async (G) => {
    let steered = null;
    for (;;) {
      const t = G.latest;
      // Absolute placement for drag motion too: on a phone the guest runs slowly enough that
      // relative PS/2 packets lag behind the release, while SetCursorPos through PVMON lands in
      // tens of milliseconds and Windows generates the WM_MOUSEMOVE for the dragging program.
      if (t && (!steered || steered.x !== t.x || steered.y !== t.y)) { await placePointer(t); steered = t; continue; }
      if (!G.active) break;
      await sleep(16);
    }
  };

  /* One finger on a content surface scrolls instead of dragging: the gesture starts as a possible
     tap, and once the finger has travelled further than a tap allows it becomes a scroll of the
     window the press started in (line messages through PVMON, like two fingers), never a pointer
     drag. A finger that never travels is still a click. */
  let oneScroll = null;
  const down = ev => {
    window.pvPhase = "down";
    consumed = pressStart(ev);
    if (consumed) { diag(`down consumed=${consumed}`); noteInput(`down ${consumed}`); return; }
    let pt = canvasPoint(ev, true);
    { const { px, py } = hostPoint(ev);
      const h0 = hitTest(px, py);
      let pol = "drag", slot = -1, title = "";
      if (pressLayer && !pressLayer.transient && !pressLayer.shellCopy && h0.kind === "client") { pol = surfacePolicy(pressLayer); slot = pressLayer.slot; title = pressLayer.title; }
      else if (insideShellClient(h0)) { pol = "scroll"; slot = SHELL_SCROLL_SLOT; title = "Program Manager"; }   // PVMON targets the active group
      oneScroll = pol === "scroll" ? { slot, startX: px, startY: py, lastX: px, lastY: py, accX: 0, accY: 0, scrolling: false, title } : null; }
    // A quick second tap near the first is a double-click: Windows 3.1 only pairs clicks a few
    // pixels apart, and fingers do not repeat to the pixel, so the second tap reuses the first
    // tap's exact point.
    // Only a tap (no drag) primes a double-click; a stroke in Paintbrush that starts near where the
    // previous stroke began must not be snapped onto it.
    const now = performance.now();
    if (lastTap && !lastTap.dragged && now - lastTap.t < 400) {
      const { px, py } = hostPoint(ev);
      if (Math.hypot(px - lastTap.px, py - lastTap.py) < 16) pt = lastTap.pt;
    }
    { const { px, py } = hostPoint(ev); lastTap = { t: now, px, py, pt, dragged: false }; }
    { const { px, py } = hostPoint(ev); const h = hitTest(px, py); diag(`down host=${Math.round(px)},${Math.round(py)} hit=${h.kind} guest=${pt.x},${pt.y} win=${h.win && h.win.title}${oneScroll ? " policy=scroll" : ""}`); noteInput(`down ${h.kind} ${pt.x},${pt.y} ${h.win && h.win.title || ""}`); }
    const G = g = { active: true, dragging: false, longFired: false, latest: null, timer: 0, hit: hitTest(hostPoint(ev).px, hostPoint(ev).py) };
    pressActive = true;
    queue(async () => {
      await placePointer(pt);
      if (!G.active || G.dragging) return;
      G.timer = setTimeout(() => queue(async () => {          // long press is the right button
        if (!G.active || G.dragging) return;
        G.longFired = true;
        button(true, true); await sleep(60); button(false, true);
      }), LONG_PRESS_MS);
    });
  };
  const move = ev => {
    window.pvPhase = "move";
    if (dragMove(ev)) return;
    const G = g;
    if (consumed || !G || G.longFired) return;
    clearTimeout(G.timer);
    if (oneScroll) {
      const { px, py } = hostPoint(ev);
      if (!oneScroll.scrolling && Math.hypot(px - oneScroll.startX, py - oneScroll.startY) > 8) {
        oneScroll.scrolling = true; G.scrolled = true;
        if (lastTap) lastTap.dragged = true;
        diag(`scroll start slot=${oneScroll.slot} ${oneScroll.title}`);
      }
      if (oneScroll.scrolling) {
        oneScroll.accX += px - oneScroll.lastX; oneScroll.accY += py - oneScroll.lastY;
        const ny = Math.trunc(oneScroll.accY / SCROLL_STEP), nx = Math.trunc(oneScroll.accX / SCROLL_STEP);
        const send = (dir, n) => { if (oneScroll.slot >= 0) sendCommand(CMD_SCROLL, oneScroll.slot | dir << 8 | Math.min(15, n) << 12); noteInput(`scroll ${dir} ${n}`); };
        if (ny) { send(ny > 0 ? 1 : 2, Math.abs(ny)); oneScroll.accY -= ny * SCROLL_STEP; }   // finger down = content up = line up
        if (nx) { send(nx > 0 ? 3 : 4, Math.abs(nx)); oneScroll.accX -= nx * SCROLL_STEP; }
      }
      oneScroll.lastX = px; oneScroll.lastY = py;
      return;
    }
    G.latest = canvasPoint(ev);
    if (!G.dragging) {
      G.dragging = true;
      if (lastTap) lastTap.dragged = true;
      queue(async () => {                       // after the pointer has been placed: press, then follow
        button(true, false); await sleep(30);
        await follow(G);
      });
    }
  };
  /* The keyboard decision at the end of a tap, made synchronously inside the gesture (iOS grants
     focus only there). The guest's last word (PVK) or a manual hold wins; otherwise the input is
     focused speculatively and released again if the guest does not ask within speculativeRelease's
     window. Programs that never take text are left alone; ?kbtest=1 focuses on every tap. */
  const tapKeyboard = (hit) => {
    const title = hit && hit.win ? hit.win.title || "" : "";
    const kbtest = params.get("kbtest") === "1";
    let why = null;
    if (kbtest) why = "kbtest";
    else if (wantKeyboard || keyboardHeld) why = "want";
    else if (hit && hit.kind === "desktop" && !insideShellDialog(hit)) why = null;          // icons, the desktop: never
    else if (hit && hit.win && NO_KEYBOARD.test(title)) why = null;
    else if (hit && hit.win && KEYBOARD_TITLES.test(title)) why = "title";
    else if (hit && (hit.kind === "client" || hit.kind === "desktop")) {
      /* No speculative focus: it flashed the keyboard up and down on every dialog tap. Instead the
         tap is remembered for a second; if the guest reports PVK 1 in that window (the click landed
         in an Edit), focus is tried then. iOS may refuse a focus outside the gesture — the result is
         logged so the phone tells us whether "late" focus works; if it does not, the next tap does. */
      lateTapUntil = performance.now() + 1000;
      kbdLog(`tap: deferred (${hit.kind} "${title.slice(0, 20)}")`);
      return;
    }
    if (!why) {
      // a tap on a program that does not want text while the keyboard is up: let the guest's PVK 0
      // (focus moved) take it down; nothing to do here
      kbdLog(`tap: no focus (${hit && hit.kind} "${title.slice(0, 20)}")`);
      return;
    }
    if (performance.now() < kbdSuppressedUntil && why !== "kbtest") { kbdLog("tap: suppressed after hide"); return; }
    focusKeyboard(`${why} "${title.slice(0, 20)}"`);
    // A known keyboard app (title match) keeps the keyboard until the guest says PVK 0: Write's
    // text area is not an Edit control, so the guest never says PVK 1 for it, and releasing on the
    // guest's silence showed the keyboard for 700 ms and took it down again.
  };
  const up = (ev) => {
    window.pvPhase = "up";
    pressActive = false;
    const G = g;
    const S = oneScroll; oneScroll = null;
    diag(`up dragging=${G && G.dragging} longFired=${G && G.longFired} scrolled=${!!(S && S.scrolling)} consumed=${consumed} cursor=${JSON.stringify(guestCursor)}`);
    noteInput(`up drag=${!!(G && G.dragging)} scroll=${!!(S && S.scrolling)} consumed=${consumed}`);
    if (G) { G.active = false; clearTimeout(G.timer); }
    if (consumed) {
      // a caption tap that did not turn into a drag is a click on the caption: it activates
      if (chromeDrag) clearTimeout(chromeDrag.timer);
      if (consumed === "drag" && chromeDrag && !chromeDrag.moved && !chromeDrag.toggled) {
        const pt = chromeDrag.guest;
        queue(async () => { await placePointer(pt); button(true, false); await sleep(60); button(false, false); });
        if (ev && ev.type === "touchend") tapKeyboard({ kind: "chrome", win: placed.find(w => w.key === chromeDrag.key) });
      } else if (chromeDrag && chromeDrag.toggled && ev && ev.type === "touchend") {
        // the long-press toggle fired in a timer, outside the gesture: the focus itself happens
        // here, on the release, which is still inside it
        if (keyboardHeld) focusKeyboard("hold"); else hideKeyboard("hold");
      }
      consumed = null; chromeDrag = null; return;
    }
    if (!G) return;
    if (S && S.scrolling) return;                       // a scroll ends with nothing pressed
    if (!G.dragging && !G.longFired && ev && ev.type === "touchend") tapKeyboard(G.hit);
    queue(async () => {
      if (G.dragging) { button(false, false); diag(`drag released at ${JSON.stringify(guestCursor)}`); return; }
      if (G.longFired) return;
      button(true, false); await sleep(60); button(false, false);   // tap is a left click
    });
  };

  c.addEventListener("touchstart", ev => {
    unlockAudio("touchstart");
    // The user dismissed the keyboard with the keyboard's own key: the input is still focused but
    // nothing shows, and iOS ignores focus() on an already-focused element. Blur now so the focus
    // on this tap's release is a fresh one and brings the keyboard back.
    { const k = $("kbd"); if (k && document.activeElement === k && !softKeyboardShowing()) { k.blur(); kbdLog("touchstart: blur stale focus"); } }
    setGuestCursor(false);
    if (ev.touches.length === 2) {
      noteInput("two-finger start");
      oneScroll = null;
      const G = g;
      if (G) { G.active = false; clearTimeout(G.timer); if (G.dragging) queue(async () => button(false, false)); g = null; }
      const m = mid(ev.touches);
      const win = layerUnder(m);
      twoFinger = { last: m, accX: 0, accY: 0, dist: dist(ev.touches), win,
                    slot: win && win.slot >= 0 ? win.slot : -1 };
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
      const d = dist(ev.touches);
      if (twoFinger.win) {
        const zp = layerZoom[twoFinger.win.key] || (layerZoom[twoFinger.win.key] = { z: 1, px: 0, py: 0 });
        if (Math.abs(d - twoFinger.dist) > 2) {                     // pinch: zoom the client area
          const maxZ = Math.max(1, (twoFinger.win.c * 1.5) / twoFinger.win.s);
          const nz = Math.max(1, Math.min(maxZ, zp.z * d / twoFinger.dist));
          // keep the guest pixel under the fingers where it is
          const r = c.getBoundingClientRect();
          const fx = (m.x - r.left - twoFinger.win.x - twoFinger.win.hl), fy = (m.y - r.top - twoFinger.win.y - twoFinger.win.ht);
          const gxBefore = zp.px + fx / (twoFinger.win.s * zp.z), gyBefore = zp.py + fy / (twoFinger.win.s * zp.z);
          zp.z = nz;
          zp.px = gxBefore - fx / (twoFinger.win.s * nz); zp.py = gyBefore - fy / (twoFinger.win.s * nz);
          twoFinger.dist = d;
        }
        if (zp.z > 1.01) {                                          // zoomed: two fingers pan
          zp.px -= (m.x - twoFinger.last.x) / (twoFinger.win.s * zp.z);
          zp.py -= (m.y - twoFinger.last.y) / (twoFinger.win.s * zp.z);
          twoFinger.last = m;
          return;
        }
      }
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
    if (ev.touches.length > 0) return;      // a finger is still down: nothing ends yet
    const wasTwo = !!twoFinger;
    twoFinger = null;
    // A two-finger gesture that began as a single-finger press must still release that press.
    // The keyboard decision happens inside up(), synchronously in this handler: iOS grants focus
    // only inside the gesture, not in a timer afterwards.
    if (!wasTwo || pressActive) up(ev);
    unlockAudio("touchend");
  };
  c.addEventListener("touchend", end, { passive: false });
  c.addEventListener("touchcancel", end, { passive: false });

  // The same gestures with a mouse, since the v86 canvas itself is off-screen in this mode. A real
  // mouse brings the guest pointer back (a finger hides it).
  let mouseDown = false;
  c.addEventListener("mousedown", ev => { ev.preventDefault(); mouseDown = true; setGuestCursor(true); down(ev); });
  window.addEventListener("mousemove", ev => { if (mouseDown) move(ev); });
  window.addEventListener("mouseup", ev => { if (!mouseDown) return; mouseDown = false; up(ev); });
  window.addEventListener("pointermove", ev => { if (ev.pointerType === "mouse") setGuestCursor(true); }, { passive: true });
  c.addEventListener("contextmenu", ev => ev.preventDefault());
}

/* ------------------------------------------------------------- on-screen keyboard (SPEC 2.5)
 * Windows 3.11 has no soft keyboard, so a hidden input is focused to summon the platform one.
 */
function installKeyboard() {
  const inp = $("kbd");
  buildKeybar(); updateKeybar();
  $("kbdbtn").onclick = () => { kbdClear(inp); inp.focus(); };
  inp.addEventListener("input", ev => {
    if (ev.isComposing) return;                          // wait for the composition to end
    const text = kbdRead(inp);
    for (const ch of text) if (ch !== "\n" && ch !== "\r") emulator.keyboard_send_text(ch);
    if (inp.isContentEditable && /\n/.test(text)) emulator.keyboard_send_text("\n");   // Enter in a contenteditable arrives as a newline
    kbdClear(inp);
  });
  inp.addEventListener("compositionend", () => { const t = kbdRead(inp); for (const ch of t) emulator.keyboard_send_text(ch); kbdClear(inp); });
  inp.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { emulator.keyboard_send_text("\n"); ev.preventDefault(); }
    if (ev.key === "Backspace") { emulator.bus.send("keyboard-code", 0x0E); emulator.bus.send("keyboard-code", 0x8E); ev.preventDefault(); }
  });
}

/* --------------------------------------------------------------------------------- session */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { saveFrame(); saveState(emulator); return; }
  // A hidden page can report a zero-size viewport, so the mode picked at load may be the
  // fallback rather than the real one. Re-evaluate as soon as we are on screen again.
  pump();
});

/* Rotation: the guest layout is fixed, so only the host changes. The shell column is re-arranged
   to the rows the new viewport shows (chooseView -> wantShellHeight), the safe areas are re-read,
   and the layers are placed afresh for the new width (their default placement rule, not the
   positions that fit the old orientation). */
let lastOrient = null;
function onOrientation() {
  const [w, h] = fullViewport();
  const o = w > h ? "landscape" : "portrait";
  readSafeInsets();
  if (lastOrient && o !== lastOrient) {
    for (const k of Object.keys(layerPos)) delete layerPos[k];
    for (const k of Object.keys(layerZoom)) delete layerZoom[k];
    shellHeightSent = 0;                                 // force the shell sizing to be re-sent
    report("orient", `${o} ${w}x${h} safe=${JSON.stringify(safe)}`);
  }
  lastOrient = o;
  pump();
}
window.addEventListener("orientationchange", () => { onOrientation(); setTimeout(onOrientation, 300); });
if (screen.orientation) screen.orientation.addEventListener("change", () => { onOrientation(); setTimeout(onOrientation, 300); });
window.addEventListener("resize", onOrientation);
onOrientation();

/* Watchdog (PLAN Fix 4). If the page is visible and the guest's heartbeat stops for 5 s, or input
   arrived and nothing on the screen changed for 5 s afterwards, one diagnostics bundle goes to the
   dev server: CPU state, idle counters, the protocol tail, the recent input, the layers, and a PNG
   of the composite. At most one bundle a minute. Until PVMON ships the heartbeat (`PVH`) only the
   input-without-change rule can fire. */
function cpuSnapshot() {
  try {
    const cpu = emulator.v86.cpu;
    const r = cpu.reg32, s = cpu.sreg;
    const hex = v => (v >>> 0).toString(16).padStart(8, "0");
    const idle = i => { try { return cpu.wm.exports.pv_idle_stat(i); } catch (e) { return "?"; } };
    return { eax: hex(r[0]), ecx: hex(r[1]), edx: hex(r[2]), ebx: hex(r[3]), esp: hex(r[4]), ebp: hex(r[5]), esi: hex(r[6]), edi: hex(r[7]),
             eip: hex(cpu.instruction_pointer[0]), prev_ip: hex(cpu.previous_ip[0]), cs: s[1].toString(16), ds: s[3].toString(16), ss: s[2].toString(16),
             flags: hex(cpu.flags[0]), IF: !!(cpu.flags[0] & 0x200), VM: !!(cpu.flags[0] & 0x20000), in_hlt: cpu.in_hlt[0],
             cr0: cpu.cr ? hex(cpu.cr[0]) : "?", idle_halted: idle(0), idle_passed: idle(1) };
  } catch (e) { return { error: String(e) }; }
}
let wdLastMipsIc = 0, wdLastMipsAt = 0, wdMips = 0;
function watchdog(force) {
  const now = performance.now();
  if ((document.hidden && !force) || !desktopReady) return;
  try { const ic = emulator.get_instruction_counter() >>> 0; if (wdLastMipsAt) wdMips = ((ic - wdLastMipsIc) >>> 0) / (now - wdLastMipsAt) / 1000; wdLastMipsIc = ic; wdLastMipsAt = now; } catch (e) {}
  const beatStale = wd.beats > 0 && now - wd.lastBeat > 5000;
  const inputStuck = wd.lastInput && now - wd.lastInput > 5000 && wd.lastChange < wd.lastInput && now - wd.lastInput < 20000;
  if (!beatStale && !inputStuck) return;
  if (now - wd.lastBundle < 60000) return;
  wd.lastBundle = now;
  const bundle = {
    why: beatStale ? `heartbeat silent ${Math.round(now - wd.lastBeat)}ms` : `input ${Math.round(now - wd.lastInput)}ms ago, no frame change since`,
    at: new Date().toISOString(), mips: +wdMips.toFixed(2), running: emulator.is_running && emulator.is_running(),
    cpu: cpuSnapshot(), protocol: pvLog.slice(-50), inputs: wd.inputs.slice(-20), kbd: kbdTrace.slice(-10),
    layers: layers.map(l => `${l.kind}${l.slot >= 0 ? l.slot : ""} ${l.wx},${l.wy} ${l.ww}x${l.wh} ${l.title}`),
    vp: fullViewport(), safe, keyboard: keyboardUp(), phase: window.pvPhase,
  };
  report("WATCHDOG", JSON.stringify(bundle));
  try { fetch("/__shot", { method: "POST", body: $("pres").toDataURL("image/png") }).then(r => r.text()).then(n => report("WATCHDOG", "shot " + n)).catch(() => {}); } catch (e) {}
}
setInterval(watchdog, 1000);
window.pvWatchdog = () => { wd.lastBundle = 0; wd.lastInput = performance.now() - 6000; wd.lastChange = 0; watchdog(true); };

// Browsers throttle timers in a hidden tab almost to a stop, which freezes the emulator.
// Opt in to a worker heartbeat (?keepalive=1) when a session must survive being backgrounded;
// the default is to let it idle and rely on the snapshot.
try {
  const src = URL.createObjectURL(new Blob([`
    let last = Date.now(), phase = "", told = false;
    onmessage = e => { last = Date.now(); phase = e.data; told = false; };
    setInterval(() => postMessage(0), 1);
    setInterval(() => {               // the main thread has been silent for 4 s: it is stuck somewhere
      if (!told && Date.now() - last > 4000) {
        told = true;
        fetch("/__log", { method: "POST", body: "stall main thread silent " + (Date.now() - last) + "ms, last phase: " + phase }).catch(() => {});
      }
    }, 1000);`], { type: "text/javascript" }));
  let lastPump = 0;
  const hb = new Worker(src);
  setInterval(() => hb.postMessage(window.pvPhase || ""), 1000);
  window.pvHeartbeat = true;
  hb.onmessage = () => {
    runSleepers();
    pumpCommands();
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


window.addEventListener("pagehide", () => { saveFrame(); saveState(emulator); });
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
// pooled connections after a server restart made every GET fail with ERR_FAILED). Registration
// needs a secure context, so over plain http on the LAN this rejects quietly and nothing changes.
// The scope is the site root so the clean paths (/solitaire) are controlled too; the server must
// send `Service-Worker-Allowed: /` for web/sw.js (the dev server does).
if ("serviceWorker" in navigator && location.protocol === "https:" &&
    !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  navigator.serviceWorker.register("sw.js", { scope: "/" })
    .catch(() => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
window.addEventListener("beforeinstallprompt", ev => ev.preventDefault());   // no install banner: nothing drawn by the host
