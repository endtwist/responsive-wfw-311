/* responsive-wfw311 - the browser side.
 *
 * Runs Windows for Workgroups 3.11 in v86 on a paravirtual display adapter whose mode follows
 * the viewport (SPEC.md 2.7, 2.8). Also handles touch, the on-screen keyboard, and snapshots.
 */
import { V86Worker } from "../v86/src/browser/worker_client.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const setText = (id, s) => { const el = $(id); if (el) el.textContent = s; };
/* The page draws nothing of its own (the rule: the host composites guest pixels and translates
   input). The old development toolbar (status, mode, zoom, save, fresh boot) exists only with
   ?dev=1, built here so index.html carries no chrome at all. */
if (params.get("dev") === "1") {
  const bar = document.createElement("div"); bar.id = "bar";
  bar.innerHTML = '<span id="status">loading</span><span id="mode"></span><span id="zoom"></span>' +
    '<button id="zoomout">&minus;</button><button id="zoomin">+</button><button id="zoomfit">fit</button>' +
    '<button id="kbdbtn">keyboard</button><button id="savebtn">save</button><button id="resetbtn">fresh boot</button>';
  document.body.appendChild(bar);
}
/* Which disk image and boot snapshot to use come from image/current.json, written by the image
   build, so a session always pairs a snapshot with the exact image it was made from. ?hda=
   overrides for development. */
const manifest = await fetch("../image/current.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null);
const IMAGE = params.get("hda") || (manifest && manifest.image ? "../image/" + manifest.image : "../image/work-live.img");
const SHIPPED_STATE = manifest && manifest.state ? "../image/" + manifest.state : "../image/boot.state.gz";
/* Deployed form of the image (tools/split-image.py, run by tools/deploy.sh): fixed 256 KB parts,
   each zstd-compressed, under image/parts/<stamp>/p-<start>-<end>.img.zst. v86 fetches whole
   parts instead of byte ranges, so the static host needs neither Range support nor a 245 MB file
   (Vercel's Hobby plan caps files at 100 MB), and the all-zero parts cost a few dozen bytes each.
   ?hda= keeps the plain Range-loaded whole image for development. */
const PARTS = !params.get("hda") && manifest && manifest.parts ? manifest.parts : null;
const HDA = PARTS
  ? { url: "../image/" + PARTS.dir + "/p.img.zst", use_parts: true, async: true, size: PARTS.size, fixed_chunk_size: PARTS.chunk, heads: 16, sectors_per_track: 32 }
  : { url: IMAGE, async: true, fixed_chunk_size: 256 * 1024, heads: 16, sectors_per_track: 32 };

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
  /* The simulated phone crops the live area to its frame. It replaces the insets rather than
     adding to them: a desktop browser window has none of its own, and if it did, the frame is
     inside them anyway. */
  const F = phoneFrame();
  if (F) safe = { l: F.l, t: F.t, r: F.r, b: F.b };
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
/* Four, not three: the first-run note takes one and a fixed-layout program wider than a column
   takes two, so a third program had no column left and opened as a caption-high stub in the
   staging area. Each column costs 640 x 970 x 4 bytes in the browser's pixel buffer. */
const MAX_SLOTS = 4;             // application columns (must match pvmon.c)
/* The guest screen is taller than the part composited here: the visible columns, and under them
   the tiles the hook parks popups and dialogs in (TILE_Y/DLG_Y in pvhook.c) so that neither ever
   paints over the window it belongs to. Below rather than beside, and no taller than the tiles
   need: every row is a row of the browser's pixel buffer (width x height x 4 bytes), and a phone
   kills a tab that asks for too much. */
const SCREEN_W = SLOT_W * (1 + MAX_SLOTS);   // 3200: the shell column and four application columns
const SCREEN_H = 970;                        // the visible rows only: tiles are off (PopupTiles in pvhook.c)
const WIN_MARGIN = 8;

/* A phone in either orientation. The guest layout is fixed (the boot snapshot bakes it in), so
   turning the phone must never re-mode the guest: only the host layout changes. */
function narrow() { const [vw, vh] = viewport(); return Math.min(vw, vh) < 600; }
const SHELL_H = 970;             // shell column height, fixed so the boot snapshot always fits

/* Desktop mode (SPEC 2026-09-02). A wide viewport gets Windows as the desktop it always was: the
   guest is re-moded to the viewport's size, shown 1:1 with no layers or slots, and PVMON is told
   (CMD_DESKTOP 1) to stop parking windows, to drop the hook's geometry clamps and to give Program
   Manager a normal window. The guest says which layout it is in with every PVD line (D or P), and
   the host asks for the other whenever the viewport disagrees: a browser window resized narrow,
   a tablet rotated, a phone's snapshot opened on a laptop. The boot snapshot is made in the
   phone layout (?mkstate=1 forces it, as does ?phone=1), so a desktop visit restores it and
   switches; the mode request for the viewport's size waits for the guest to report the switch,
   or the re-mode would find PVMON still parking windows in columns. */
const forcePhone = params.get("mkstate") === "1" || params.get("phone") === "1";
function wantDesktop() { return !narrow() && !forcePhone && !phoneSimOn(); }

/* ------------------------------------------------------------------ the phone, on a desktop
 * PHONE.EXE (a Windows program, like everything else that steers this machine) asks the host to
 * pretend the browser window is a phone: the live area is cropped to a phone-shaped frame in the
 * middle of the window, and the mouse is put through the gesture pipeline the fingers use.
 *
 * The frame is expressed as SAFE-AREA INSETS, which is why so little else has to change. Every
 * layout decision here already works inside the safe area -- viewport(), hit testing, the
 * compositor's translate, narrow() -- so cropping the safe box to a 9:16 rectangle makes the whole
 * host believe it is on a phone, without a single one of those places learning a new mode.
 *
 * Only on a desktop. On a real phone there is nothing to simulate, and the guard is on the true
 * viewport rather than narrow(), which by then is answering for the frame.
 */
let phoneAsked = false;
const PHONE_ASPECTS = [[9, 16], [9, 19.5]];
const phoneSim = { on: params.get("phonesim") === "1", aspect: 0 };
try {
  const saved = JSON.parse(localStorage.getItem("pvPhoneSim") || "null");
  if (saved && !params.has("phonesim")) { phoneSim.on = !!saved.on; phoneSim.aspect = saved.aspect | 0; }
} catch (e) {}
function narrowReal() { const [w, h] = fullViewport(); return Math.min(w, h) < 600; }
function phoneSimOn() { return phoneSim.on && !narrowReal(); }
/* The frame, in host pixels, or null when it is not running. */
function phoneFrame() {
  if (!phoneSimOn()) return null;
  const [w, h] = fullViewport();
  const [aw, ah] = PHONE_ASPECTS[phoneSim.aspect] || PHONE_ASPECTS[0];
  const m = Math.round(Math.min(w, h) * 0.04);
  let fh = h - 2 * m, fw = Math.round(fh * aw / ah);
  if (fw > w - 2 * m) { fw = w - 2 * m; fh = Math.round(fw * ah / aw); }
  const l = Math.floor((w - fw) / 2), t = Math.floor((h - fh) / 2);
  return { l, t, w: fw, h: fh, r: w - fw - l, b: h - fh - t };
}
function setPhoneSim(on, aspect) {
  const was = phoneSimOn();
  phoneSim.on = !!on;
  if (aspect !== undefined) phoneSim.aspect = aspect | 0;
  try { localStorage.setItem("pvPhoneSim", JSON.stringify(phoneSim)); } catch (e) {}
  readSafeInsets();
  document.documentElement.classList.toggle("phone", narrow());
  needFull = true;
  invalidate();
  requestMode(true);                       /* the guest re-modes to the frame, or back to the desktop */
  syncDesktopMode();
  report("phonesim", `${phoneSim.on ? "on" : "off"} aspect ${PHONE_ASPECTS[phoneSim.aspect] ? PHONE_ASPECTS[phoneSim.aspect].join(":") : "?"}${was === phoneSimOn() ? " (no change)" : ""}`);
}
window.pvPhoneSim = setPhoneSim;
let guestDesktop = null;         // the guest's layout per its last PVD: true desktop, false phone, null unknown
const CMD_DESKTOP = 11;
let desktopCmdAt = 0;
function syncDesktopMode() {
  if (guestDesktop === null || guestDesktop === wantDesktop()) return;
  if (performance.now() - desktopCmdAt < 3000) return;                 // one request in flight
  desktopCmdAt = performance.now();
  sendCommand(CMD_DESKTOP, wantDesktop() ? 1 : 0);
  report("mode", `guest is ${guestDesktop ? "desktop" : "phone"}, viewport wants ${wantDesktop() ? "desktop" : "phone"}: CMD_DESKTOP sent`);
}

function computeMode() {
  const [vw, vh] = viewport();
  // The phone layout, and a wide viewport until the guest has switched to desktop mode.
  if (!wantDesktop() || guestDesktop !== true) return { w: SCREEN_W, h: SCREEN_H, zoom: 1, shellH: SHELL_H };
  // Desktop: one guest pixel per CSS pixel (the canvas is painted nearest-neighbour at the device
  // pixel ratio, so it is crisp on HiDPI too), the size a multiple of 8 x 2 within the adapter's
  // limits. Windows 3.x wants at least 640 columns; a smaller window scales the screen down.
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.floor(vw / 8) * 8));
  const h = Math.max(MIN_H, Math.min(MAX_H, Math.floor(vh / 2) * 2));
  return { w, h, zoom: 1, shellH: 0 };
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
  // (with part files the whole image is not served: the first part stands in for it)
  fetch(PARTS ? HDA.url.replace(/p\.img\.zst$/, `p-0-${PARTS.chunk}.img.zst`) : IMAGE, { method: "HEAD" }).then(r => {
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
    // A snapshot of a guest that has not shown its desktop, or that the watchdog has just found
    // stuck, would restore straight back into the fault: never keep one of those.
    if (!desktopReady) { report("state", "not saved: desktop not ready"); return; }
    if (wd.activeSince && performance.now() - wd.activeSince < 30000 && wd.lastChange < wd.activeSince) { report("state", "not saved: watchdog condition active"); return; }
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
    /* Read it in chunks rather than as one blob: this is the long part of the wait, and it is the
       only part of it the boot screen can honestly measure. Content-Length is the compressed
       length; if the server also applied Content-Encoding the body arrives already inflated and
       the ratio would run past 1, hence the clamp. */
    let blob;
    const total = +(r.headers.get("content-length") || 0);
    if (r.body && r.body.getReader) {
      const reader = r.body.getReader(), parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        if (total) bootAt(0.10 + 0.60 * Math.min(1, got / total), "loading");
      }
      blob = new Blob(parts);
    } else {
      blob = await r.blob();
    }
    bootAt(0.70, "loading");
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
      tx.objectStore("state").put({ url, at: Date.now(), w: pres.width, h: pres.height, narrow: narrow() }, FRAME_KEY);
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
    /* Only a frame from this shape of window is worth showing. The saved composite is the phone's
       column, three times taller than it is wide; stretched across a desktop viewport it is a
       blurry picture of a layout this window is not even going to use. When the shapes disagree
       the page simply opens on the guest's own first paint. */
    const wasNarrow = rec.narrow !== undefined ? rec.narrow : rec.w < rec.h;
    if (wasNarrow !== narrow()) return;
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

/* ----------------------------------------------------------------------------------- boot
 * The emulator runs in a worker (SPEC 2026-09-03): the wasm CPU, the devices, the disk fetches and
 * the conversion of guest pixels all happen off this thread, so a busy guest cannot delay the
 * composite or the user's finger. `emulator` is a proxy with (almost) the same surface; the
 * speaker and v86's own keyboard/mouse adapters still live here, on the proxy bus.
 *
 * Guest pixels arrive either in shared memory (cross-origin isolated, so a secure context: the
 * https deploy and localhost) or as transferred ImageBitmaps of the rows that changed (the plain
 * http LAN dev server, where SharedArrayBuffer is unavailable). Both end up in the same canvas,
 * which is what the compositor draws its slices from. ?nosab=1 forces the transfer path.
 */
const abs = u => new URL(u, location.href).href;      // the worker resolves URLs against itself
const guestCanvas = document.querySelector("#screen_container canvas");
const emulator = new V86Worker({
  worker_url: abs("../v86/src/browser/worker.js"),
  canvas: guestCanvas,
  shared: params.get("nosab") === "1" ? false : undefined,
  wasm_path: abs("../v86/build/" + (params.get("wasm") || "v86.wasm")),   // ?wasm=v86-base.wasm for A/B
  memory_size: 32 * 1024 * 1024,
  vga_memory_size: 8 * 1024 * 1024,
  screen_container: $("screen_container"),
  bios: { url: abs("../v86/bios/seabios.bin") },
  vga_bios: { url: abs("../v86/bios/vgabios.bin") },
  hda: Object.assign({}, HDA, { url: abs(HDA.url) }),
  boot_order: 0x132,
  autostart: false,
  on_log: s => report("emu", s),
});
window.emulator = emulator;
report("emu", `pixels: ${emulator.pixels.path} (SharedArrayBuffer ${typeof SharedArrayBuffer === "function" ? "present" : "absent"}, crossOriginIsolated ${!!self.crossOriginIsolated}${params.get("nosab") === "1" ? ", forced off" : ""})`);
if (params.get("selftest")) import("./selftest.js").then(m => m.run());              // app tour (PLAN.md Fix 5)
if (params.get("remote")) import("./remote.js").then(m => m.run(params.get("remote"))); // parked-phone remote control

function status(msg) { boot.status = msg; setText("status", msg); }

/* Boot watchdog. A phone once sat on a black screen with the status stuck at "loading": the
   emulator never started (is_running() false, instruction counter 0) and nothing was logged; a
   ?reset=1 cured it, so the local snapshot / first-frame path was to blame. Every step of the boot
   is recorded here; 15 s after load with the emulator not running, or 40 s without the desktop
   after a snapshot restore, a BOOTFAIL bundle goes to the dev server, the local snapshot and frame
   are wiped and the page restarts from the shipped snapshot -- once (loop guard in the URL). */
const boot = { path: "none", localBytes: 0, shippedBytes: 0, errors: [], steps: [], retry: params.get("bootretry") === "1", status: "loading" };
function bootStep(s) { boot.steps.push(`${Math.round(performance.now())} ${s}`); }
window.addEventListener("unhandledrejection", ev => boot.errors.push("rejection: " + String(ev.reason && (ev.reason.stack || ev.reason)).slice(0, 300)));
window.addEventListener("error", ev => boot.errors.push(`error: ${ev.message} @${ev.filename}:${ev.lineno}`));
async function bootFail(why) {
  let running = false, ic = 0;
  try { running = !!(emulator.is_running && emulator.is_running()); ic = emulator.get_instruction_counter() >>> 0; } catch (e) {}
  const bundle = { why, status: boot.status, running, ic, path: boot.path, localBytes: boot.localBytes, shippedBytes: boot.shippedBytes,
                   restored, desktopReady, retry: boot.retry, errors: boot.errors.slice(-10), steps: boot.steps.slice(-20), protocol: pvLog.slice(-10),
                   vp: fullViewport(), hidden: document.hidden, ua: navigator.userAgent };
  report("BOOTFAIL", JSON.stringify(bundle));
  if (boot.retry) { status("boot failed twice; see log"); return; }      // loop guard: one automatic retry
  try { await withTimeout(clearLocalSnapshot(), 3000); } catch (e) {}
  const u = new URL(location.href);
  u.searchParams.delete("bootfailtest"); u.searchParams.set("bootretry", "1");
  status("restarting from the shipped snapshot");
  location.replace(u.toString());
}
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + ms + " ms")), ms))]); }
async function clearLocalSnapshot() {
  await clearState();
  const db = await idb();
  await new Promise(res => { const tx = db.transaction("state", "readwrite"); tx.objectStore("state").delete(FRAME_KEY); tx.oncomplete = tx.onerror = res; });
}
setTimeout(() => { let running = false; try { running = !!(emulator.is_running && emulator.is_running()); } catch (e) {} if (!running) bootFail("emulator not running 15 s after load"); }, 15000);
setTimeout(() => { if (restored && !desktopReady) bootFail("snapshot restored but no desktop after 40 s"); }, 40000);

emulator.add_listener("emulator-ready", async () => {
 try {
  bootStep("emulator-ready");
  bootAt(0.10, "loading");
  emulator.bus.send("pv-set-dpi", dpi);
  emulator.bus.send("sb16-dsp-version", [2, 1]);     // Windows 3.x's Sound Blaster driver wants a 2.x DSP
  requestMode(true);
  /* Order of preference: the visitor's own snapshot (saved on hide), then the shipped boot
     snapshot (the desktop already up, so a cold visit takes seconds instead of a minute), then a
     real boot. After any restore PVMON is asked to describe the layout again, since the host has
     no memory of it. */
  if (params.get("reset")) {
    /* Not deleteDatabase: with the page's own connection open (first frame, remote/selftest) the
       delete request blocked and never resolved on iOS Chrome, so the boot hung at "loading" with
       zero instructions. Clear the records instead, and never wait more than 3 s for IndexedDB. */
    try { await withTimeout(clearLocalSnapshot(), 3000); } catch (e) { boot.errors.push("reset: " + (e && e.message)); }
    bootStep("reset");
  }
  // IndexedDB itself can hang on iOS Chrome (the first boot after a blocked delete never returned
  // from the open): never let the boot wait on it for more than 3 s.
  let snap = null;
  if (!(params.get("fresh") || params.get("reset") || params.get("restart") || boot.retry)) {
    try { snap = await withTimeout(loadState(), 3000); } catch (e) { boot.errors.push("loadState: " + (e && e.message)); bootStep("local snapshot skipped: " + (e && e.message)); }
  }
  if (snap) { boot.path = "local"; boot.localBytes = snap.byteLength; bootStep(`local snapshot ${snap.byteLength}`); bootAt(0.70, "loading"); }
  if (!snap && !params.get("fresh") && !params.get("mkstate")) {
    snap = await loadShippedState();
    if (snap) { boot.path = "shipped"; boot.shippedBytes = snap.byteLength; }
    bootStep(`shipped snapshot ${snap ? snap.byteLength : "unavailable"}`);
    report("state", `shipped snapshot ${snap ? snap.byteLength + " bytes" : "unavailable"}`);
  }
  if (params.get("bootfailtest") === "1") throw new Error("bootfailtest: simulated failure before run()");
  if (snap) {
    try {
      bootAt(0.72, "restoring");
      await emulator.restore_state(snap);
      bootAt(0.90, "starting");
      splashCreepFrom = performance.now();
      status("restored");
      restored = true;
      bootStep("restored");
    } catch (e) { status("restore failed, cold boot"); firstFrameUntil = 0; splash.on = false; boot.errors.push("restore: " + (e && e.message)); bootStep("restore failed"); }
  } else {
    status("booting");
    boot.path = "cold";
    firstFrameUntil = 0;                                 // a cold boot shows its own DOS and logo
    splash.on = false;                                   // ...including the real one, so not this one
  }
  emulator.run();
  bootStep("run");
  // The snapshot restores the adapter's mode registers too (host size, generation): ask again.
  requestMode(true);
  if (restored) setTimeout(() => sendCommand(CMD_REPUBLISH, 0), 300);
 } catch (e) {
  boot.errors.push("boot: " + (e && (e.stack || e.message || e)));
  report("boot", "failed: " + (e && (e.stack || e.message || e)));
  status("boot failed");
 }
});

emulator.add_listener("screen-set-size", s => {
  /* Windows exited to DOS (text mode after the desktop was up). AUTOEXEC would run WIN again — a
     full boot with the logo flickering through at phone speed. Restarting from the shipped
     snapshot is the same result in two seconds, and the local snapshot must not be saved from
     this state (desktopReady is cleared so pagehide's saveState refuses). */
  if (desktopReady && s[2] === 0 && !params.get("noexitrestart")) {
    desktopReady = false;
    report("exit", "Windows exited to DOS; restarting from the shipped snapshot");
    status("Windows exited; restarting");
    const u = new URL(location.href); u.searchParams.set("restart", "1");
    setTimeout(() => location.replace(u.toString()), 400);
    return;
  }
  setText("mode", `${s[0]}x${s[1]}`);
  emulator.screen_set_scale(1, 1);
  invalidate();                        // a new screen size: every guest pixel is new
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
/* layer key -> guest px: how far the menu-bar strip is panned. A window wider than the viewport
   keeps its chrome at the desktop chrome scale (readable), so its menu bar does not fit: the strip
   is a window onto the full-width bar that one finger pans sideways. Reset with the placement. */
const menuPan = {};

/* ---------------------------------------------------------------- screen-reader access (?a11y=0)
 * The page is a canvas: VoiceOver and NVDA see one opaque picture and announce nothing about it.
 * But the guest already tells the host everything a screen reader would need -- the layer list
 * above (window titles, kinds, front-to-back order) and PVK's focused-control report below -- so
 * this rebuilds that into a plain, invisible DOM tree instead of asking the guest for anything
 * new. It is off-screen the same way #screen_container's own canvas is (position:absolute, far
 * left): never display:none or visibility:hidden, both of which remove a node from the
 * accessibility tree and would defeat the point. Nothing in it is focusable and it takes no
 * pointer, so it cannot steal focus from #kbd or intercept a touch.
 *
 * Kept cheap on purpose: the compositor runs at 60 fps and must not slow down for this. Nothing
 * here runs from the frame loop at all -- syncA11yWindows is called only where `layers`/`dock`
 * are replaced wholesale (the PVE handler below), and syncA11yFocus only where PVK changes
 * `guestFocus`, so a steady frame with nothing new to say touches no DOM.
 */
const A11Y_ON = params.get("a11y") !== "0";
let a11yEls = null;            // { root, status, list }, built lazily on first use
let a11yLayerSig = "";         // last layers+dock signature actually rendered
let a11yFocusSig = "";         // last guestFocus signature actually rendered
let a11yFrontLi = null;        // the <li> for the current front-most layer, patched in place on focus changes
let a11yFrontTitle = "";       // its title, so a front-window change can be told from a first paint
function a11yWindowKind(kind) {
  // The guest's four layer kinds (PVW/PVO/PVT/PVX above; PVS is the shell) in the words a screen
  // reader should say, matching the vocabulary the task calls for ("dialog", "menu", "minimised").
  return kind === "O" ? "dialog" : kind === "T" ? "menu" : kind === "S" ? "shell" : kind === "X" ? "window" : "application";
}
function a11yFocusText() {
  // PVK's flags (see guestWantsKeyboard below): e Edit, r readonly, c combo, t tty, n non-text.
  // Read as a short parenthetical rather than the raw letters, since that is what gets spoken.
  const f = guestFocus;
  if (!f || !f.cls || f.cls === "-") return "";
  const bits = [];
  if (/c/.test(f.flags)) bits.push("combo box"); else if (/e/.test(f.flags)) bits.push("edit box");
  if (/r/.test(f.flags)) bits.push("read-only");
  if (/t/.test(f.flags)) bits.push("terminal");
  if (/n/.test(f.flags)) bits.push("non-text");
  return bits.length ? `${f.cls} (${bits.join(", ")})` : f.cls;
}
function a11yLine(L, front) {
  let s = `${L.title || "(untitled)"} – ${a11yWindowKind(L.kind)}`;
  if (front) { s += ", front window"; const d = a11yFocusText(); if (d) s += `, focused control: ${d}`; }
  return s;
}
function ensureA11y() {
  if (a11yEls) return a11yEls;
  const root = document.createElement("div");
  root.id = "a11y";
  root.style.cssText = "position:absolute; left:-10000px; top:0; width:1px; height:1px; overflow:hidden; pointer-events:none;";
  const h = document.createElement("h2");
  h.textContent = "Windows for Workgroups 3.11 desktop";
  const p = document.createElement("p");
  p.textContent = "A screen-reader view of the Windows session running on this page. Windows are listed below, front to back.";
  const status = document.createElement("div");
  status.id = "a11y-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const list = document.createElement("ul");
  list.id = "a11y-windows";
  root.append(h, p, status, list);
  document.body.appendChild(root);
  a11yEls = { root, status, list };
  return a11yEls;
}
function a11yAnnounce(msg) {
  const els = ensureA11y();
  els.status.textContent = msg;
}
/* Called only from the PVE handler, once per layout change the guest reports -- never per frame.
   `layers` is already back-to-front, so the DOM list is built front-to-back per requirement (2)
   by walking it backwards. */
function syncA11yWindows() {
  if (!A11Y_ON) return;
  const sig = layers.map(L => `${L.kind}:${L.slot}:${L.title}`).join("|") + "#" + dock.map(d => `${d.slot}:${d.title}`).join(",");
  if (sig === a11yLayerSig) return;                         // nothing a screen reader could hear changed
  const wasFront = a11yFrontTitle, hadFront = a11yLayerSig !== "";
  a11yLayerSig = sig;
  const els = ensureA11y();
  els.list.textContent = "";
  a11yFrontLi = null;
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i], li = document.createElement("li"), front = i === layers.length - 1;
    li.textContent = a11yLine(L, front);
    if (front) a11yFrontLi = li;
    els.list.appendChild(li);
  }
  for (const d of dock) {
    const li = document.createElement("li");
    li.textContent = `${d.title || "Window"} – minimised`;
    els.list.appendChild(li);
  }
  const front = layers[layers.length - 1];
  a11yFrontTitle = front ? (front.title || a11yWindowKind(front.kind)) : "";
  if (front && (front.kind === "T" || front.kind === "O")) a11yAnnounce(`${a11yFrontTitle} ${a11yWindowKind(front.kind)} opened`);
  else if (hadFront && a11yFrontTitle !== wasFront) a11yAnnounce(a11yFrontTitle ? `${a11yFrontTitle} is now the front window` : "desktop");
}
/* Called only from guestWantsKeyboard, where PVK actually changes `guestFocus` -- patches just the
   front row's text in place rather than rebuilding the list, so a focus change costs one string
   compare and, at most, one textContent write. */
function syncA11yFocus() {
  if (!A11Y_ON) return;
  const sig = `${guestFocus.cls}|${guestFocus.flags}`;
  if (sig === a11yFocusSig) return;
  a11yFocusSig = sig;
  if (a11yFrontLi && layers.length) a11yFrontLi.textContent = a11yLine(layers[layers.length - 1], true);
}

const pvLog = [];
/* Watchdog bookkeeping: PVMON's heartbeat (`PVH <tick>`, once a second once the guest ships it),
   the last input event, and the last time the composite changed. See watchdog() below. */
const wd = { lastBeat: 0, beats: 0, lastInput: 0, lastChange: 0, lastBundle: 0, frameSig: 0, inputs: [] };
function noteInput(s) { wd.lastInput = performance.now(); wd.inputs.push(`${Math.round(wd.lastInput)} ${s}`); if (wd.inputs.length > 20) wd.inputs.shift(); }
window.pvState = () => ({ shell, layers, dock, placed, view, desktopReady, guestDesktop, wantDesktop: wantDesktop(), mode: lastReq,
                          log: pvLog.slice(-50), wd, wantKeyboard, keyboardHeld, kbd: kbdTrace.slice(-10),
                          guestFocus, learnedText: [...learnedText], kbdActive: !!($("kbd") && document.activeElement === $("kbd")),
                          firstFrame: !!firstFrame, firstFrameShown, safe, cursorShown: guestCursorShown, cmdQueue: cmdQueue.length });
/* Everything that waits for a usable desktop: the pointer's calibration, the screen controls, the
   dial-up line, the cursor, and any deep link in the URL. Reached from PVA in the phone layout and
   from the mode switch in desktop mode -- PVMON publishes a fresh PVA when it rearranges the phone
   column, but a switch to desktop mode is reported by PVD alone, and gating this on PVA left a
   desktop-mode page with no pointer calibration, no screen controls and no network at all. */
let guestReadyDone = false;
function guestIsReady() {
  if (guestReadyDone) return;
  guestReadyDone = true;
  desktopReady = true;
  setTimeout(() => calibratePointer("desktop ready"), 400);
  /* Ask the guest what the screen controls were left set to. LCD.EXE /report sends one PVLCD line
     and exits without a window; WIN.INI's run= cannot carry an argument (Windows reads the argument
     as a second program to launch and puts up "cannot find file"), so the host asks once the
     desktop is up instead. */
  /* Ask the guest what the screen controls were left set to -- or tell it, when the URL has already
     decided. ?lcd=1 with the Screen app's own box unticked is not a control panel. */
  if (!lcdAsked) {
    lcdAsked = true;
    const arg = lcdForced === null ? "/report" : lcdForced ? "/on" : "/off";
    setTimeout(() => sendCommandString(CMD_RUN, `LCD.EXE ${arg}`), 1200);
  }
  /* And what the phone frame was left set to, the same way. Only worth asking on a desktop: on a
     real phone PHONE.EXE has nothing to say and exits without a window. */
  if (!phoneAsked && !narrowReal()) {
    phoneAsked = true;
    setTimeout(() => sendCommandString(CMD_RUN, `PHONE.EXE ${params.has("phonesim") ? (phoneSim.on ? "/on" : "/off") : "/report"}`), 1500);
  }
  if (!slipNet) slipNet = initNet();                 // the PV socket's host half
  if (touchDevice) setTimeout(() => setGuestCursor(false, true), 500);   // an arrow means nothing to a finger
  /* The browser's pointer takes over from here (see applyCursorShape). PVMON resends PVC with
     every PVA, so the shape arrives right behind this. */
  applyCursorShape();
  if (params.get("mkstate") && !restored) { uploadBootState(); return; }
  launchFromUrl();
}

emulator.bus.register("pv-debug", line => {
  pvLog.push(line);
  if (pvLog.length > 200) pvLog.splice(0, pvLog.length - 150);
  let m = /^PVH/.exec(line);
  if (m) { wd.lastBeat = performance.now(); wd.beats++; return; }
  m = /^PVD (\d+) (\d+)(?: (\d+))?(?: v(\d+))?(?: ([DP]))?/.exec(line);
  if (m) {
    shell = { w: +m[1], h: +m[2], cap: +m[3] || 18, ver: m[4] ? +m[4] : 0 };
    if (m[5]) {                                     // PVMON v34+: which layout the guest is in
      const was = guestDesktop;
      guestDesktop = m[5] === "D";
      if (was !== guestDesktop) { report("mode", `guest reports ${guestDesktop ? "desktop" : "phone"} layout`); requestMode(true); }
      syncDesktopMode();
    }
    return;
  }
  /* The clipboard, guest to host. PVMON is a clipboard viewer and ships CF_TEXT as base64 when
     anything in Windows changes the clipboard. Writing to the system clipboard needs a user
     gesture on iOS, so the text is held and written on the next touch -- copy in Notepad, touch
     anything, and it is on the phone's clipboard. */
  /* LCD.EXE reporting its controls: on, brightness, contrast (0..100 each). */
  { const m2 = /^PVLCD (\d+) (\d+) (\d+)/.exec(line);
    if (m2) { lcdSettings(+m2[1], +m2[2], +m2[3]); return; } }
  /* PHONE.EXE reporting the simulated phone: on, and which aspect. */
  { const m3 = /^PVPHONE (\d+) (\d+)/.exec(line);
    if (m3) { setPhoneSim(+m3[1], +m3[2]); return; } }
  if (/^PVCB-BEGIN/.test(line)) { clipIn = []; return; }
  if (/^PVCB /.test(line)) { if (clipIn) clipIn.push(line.slice(5)); return; }
  if (/^PVCB-END/.test(line)) {
    if (clipIn) {
      try {
        const bytes = atob(clipIn.join(""));
        guestClip = bytes;                        // latin-1 bytes: CF_TEXT is ANSI
        clipPending = true;
        diag(`clipboard from the guest: ${bytes.length} bytes`);
        /* If this report is the answer to a copy the user just asked for with the keyboard, the
           gesture that asked is still recent enough for the browser to let us write it out. */
        offerClipboard(performance.now() < clipCopyWait ? "copy keys" : "guest copy");
      } catch (e) { diag(`clipboard from the guest: undecodable (${e.message})`); }
    }
    clipIn = null;
    return;
  }
  if (/^PVP-BEGIN /.test(line)) { printJob = []; return; }
  if (/^PVP /.test(line)) { if (printJob) printJob.push(line.slice(4)); return; }
  if (/^PVP-END/.test(line)) { if (printJob) finishPrintJob(printJob.join("")); printJob = null; return; }
  m = /^PVK (\d)(?: (\S+))?(?: (\S+))?/.exec(line);
  if (m) { guestWantsKeyboard(m[1] === "1", m[2] || "", m[3] || ""); return; }
  if (/^PVA/.test(line)) {
    // A wide viewport with the guest still in the phone layout: not ready yet. PVMON publishes
    // PVA again once it has switched and arranged the desktop (finish_mode_switch).
    if (wantDesktop() && shell.ver >= 34 && guestDesktop !== true) { syncDesktopMode(); return; }
    shellHeightSent = 0;                            // the shell rearranged: tell it its height again
    guestIsReady();
    return;
  }
  /* A top-level window is being destroyed, reported from the hook BEFORE Windows erases the area
     to the desktop colour. The shell's next publish is ~200 ms behind that erase, which is exactly
     the grey flash on a close, so the compositor keeps showing what it last had for that rectangle
     until the guest paints it again (or a short deadline passes). */
  if (/^PVZ /.test(line)) {
    const [x, y, w, h] = line.slice(4).split(" ").map(Number);
    if (w > 0 && h > 0) holdRegion(x, y, w, h);
    return;
  }
  /* PVC <name>: the shape Windows currently wants, classified by PVMON from GetCursor (v39). */
  m = /^PVC (\S+)/.exec(line);
  if (m) { guestCursorName = m[1]; applyCursorShape(); return; }
  if (/^PVB /.test(line)) { pendingLayers = []; pendingDock = []; return; }
  m = /^PV([WOTXS]) (-?\d+) (-?\d+) (-?\d+) (\d+) (\d+) (-?\d+) (-?\d+) (\d+) (\d+) ?(.*)$/.exec(line);
  if (m && pendingLayers) {
    pendingLayers.push({
      kind: m[1], slot: +m[2], wx: +m[3], wy: +m[4], ww: +m[5], wh: +m[6],
      gx: +m[7], gy: +m[8], gw: +m[9], gh: +m[10], title: m[11] || "",
    });
    /* A popup painted in an off-screen tile carries the place it would have popped up as
       "@x,y" after its class (PVHOOK's popup tiles). The layer is drawn from the tile and
       placed at the anchor, so the pixels are wherever they are and the menu is where the
       user pointed. */
    { const a = /@(-?\d+),(-?\d+)\s*$/.exec(m[11] || "");
      if (a) { const L = pendingLayers[pendingLayers.length - 1]; L.ax = +a[1]; L.ay = +a[2]; L.title = L.title.slice(0, a.index).trim(); } }
    return;
  }
  m = /^PVI (-?\d+) ?(.*)$/.exec(line);
  if (m && pendingDock) { pendingDock.push({ slot: +m[1], title: m[2] || "Window" }); return; }
  if (/^PVE/.test(line) && pendingLayers) {
    layers = pendingLayers; dock = pendingDock; pendingLayers = pendingDock = null;
    dropSampleCache();                 // the sampled background points belong to the old layout
    invalidate();                      // a new layout: the next composite is a full one
    holdTransients();                  // a popup that is about to be moved is not drawn twice
    const live = new Set(layers.map(layerKey));
    for (const k of Object.keys(layerPos)) if (!live.has(k)) delete layerPos[k];
    for (const k of Object.keys(menuPan)) if (!live.has(k)) delete menuPan[k];
    for (const k of Object.keys(layerZoom)) if (!live.has(k)) delete layerZoom[k];
    resetAim(layers.map(L => L.title));   // JezzBall gone: the next one starts vertical again
    syncA11yWindows();                    // tell a screen reader what just changed, if anything did
    /* A finished publish is the honest "PVMON is idle" signal, and in desktop mode it is the only
       one: PVMON republishes PVA when it rearranges the phone column, but a switch to desktop mode
       is reported by PVD alone. Waiting for the publish matters -- asking for the pointer probes
       and LCD.EXE while PVMON was still inside its mode switch killed it with a UAE. */
    if (!guestReadyDone && (shell.ver < 34 || guestDesktop === wantDesktop())) guestIsReady();
  }
});

/* Applications by URL: /solitaire opens Solitaire. The path (or ?run=) names an entry in this
   table; the command line is handed to the guest the moment the desktop is ready.

   Only a name from this table. ?run= used to accept any command line that looked like one and
   hand it straight to WinExec, which made every link to this page a link that could start any
   program on the disk. The guest is a sandbox and the disk is a fresh copy per visit, so the
   worst case was small, but a URL should only be able to name things that were deliberately put
   on offer. An arbitrary command is still one line away at the console (window.pvRun), which
   takes a person at the keyboard rather than a link someone was sent. */
const APPS = {
  about: "ABOUT.EXE /show", readme: "ABOUT.EXE /show",
  solitaire: "SOL.EXE", sol: "SOL.EXE", hearts: "MSHEARTS.EXE", minesweeper: "WINMINE.EXE",
  paintbrush: "PBRUSH.EXE", paint: "PBRUSH.EXE", write: "WRITE.EXE", notepad: "NOTEPAD.EXE",
  calc: "CALC.EXE", calculator: "CALC.EXE", clock: "CLOCK.EXE", cardfile: "CARDFILE.EXE",
  calendar: "CALENDAR.EXE", terminal: "TERMINAL.EXE", recorder: "RECORDER.EXE",
  filemanager: "WINFILE.EXE", files: "WINFILE.EXE", controlpanel: "CONTROL.EXE",
  charmap: "CHARMAP.EXE", pifedit: "PIFEDIT.EXE", setup: "SETUP.EXE", winver: "WINVER.EXE",
  chat: "WINCHAT.EXE", mail: "MSMAIL.EXE", schedule: "SCHDPLUS.EXE", help: "WINHELP.EXE",
  soundrecorder: "SOUNDREC.EXE", soundrec: "SOUNDREC.EXE", mediaplayer: "MPLAYER.EXE",
  skifree: "C:\\GAMES\\SKI.EXE", ski: "C:\\GAMES\\SKI.EXE",
  /* Best of Microsoft Entertainment Pack (SPEC 2026-09-03) */
  jezzball: "C:\\GAMES\\JEZZBALL.EXE", jezz: "C:\\GAMES\\JEZZBALL.EXE",
  tetris: "C:\\GAMES\\TETRIS.EXE", tetravex: "C:\\GAMES\\TETRAVEX.EXE",
  tripeaks: "C:\\GAMES\\TRIPEAKS.EXE", tutstomb: "C:\\GAMES\\TUTSTOMB.EXE",
  freecell: "C:\\GAMES\\FREECELL.EXE", golf: "C:\\GAMES\\GOLF.EXE",
  chips: "C:\\GAMES\\CHIPS.EXE", chipschallenge: "C:\\GAMES\\CHIPS.EXE",
  rodent: "C:\\GAMES\\RODENT.EXE", pipedream: "C:\\GAMES\\PIPE.EXE", pipe: "C:\\GAMES\\PIPE.EXE",
  taipei: "C:\\GAMES\\TP.EXE", blackjack: "C:\\GAMES\\BLAKJAK.EXE",
};
let launched = false;
function launchFromUrl() {
  if (launched) return;
  launched = true;
  const q = new URLSearchParams(location.search).get("run");
  const seg = location.pathname.split("/").filter(Boolean).pop() || "";
  const key = (q || (/^[a-z]+$/i.test(seg) && !/\./.test(seg) ? seg : "")).toLowerCase();
  const cmd = APPS[key] || null;
  if (cmd) sendCommandString(CMD_RUN, cmd);
  else if (q) report("url", `?run=${q}: not a name in APPS, ignored`);
}
window.pvRun = cmd => sendCommandString(CMD_RUN, cmd);      // diagnostics: launch without a reload

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
/* The @jspawn build is MODULARIZE + noInitialRun: the module promise resolves with the runtime up
   and nothing run; the job is a synchronous callMain on a fresh instance (the wasm is cached by
   the browser after the first job). It returns the exit status instead of exiting the page. */
async function psToPdf(psBytes) {
  const createModule = await loadGhostscript();
  const errs = [];
  const m = await createModule({
    locateFile: f => "https://cdn.jsdelivr.net/npm/@jspawn/ghostscript-wasm@0.0.2/" + f,   // the glue looks next to the page otherwise
    print: () => {}, printErr: t => { errs.push(t); report("gs", t); },
  });
  m.FS.writeFile("/in.ps", psBytes);
  const rc = m.callMain(["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite", "-sOutputFile=/out.pdf", "/in.ps"]);
  let out = null;
  try { out = m.FS.readFile("/out.pdf"); } catch (e) {}
  if (!out || !out.length) throw new Error(`ghostscript exit ${rc}: ${errs.slice(-3).join(" | ")}`);
  return out;
}
/* A finished print goes to the platform's share sheet where there is one, and falls back to a
   download where there is not. On a phone a download is a dead end -- iOS drops the file into
   Files and says nothing -- whereas the share sheet is how everything else on the phone hands a
   document to Mail, Messages, Books or a printer, which is what "printing" should feel like.
   navigator.share must be called inside a user gesture, and a print finishes whenever the guest
   finishes it, so the file waits for the next touch: `pvShare` holds it and the touch handler
   offers it. A share the user cancels is not an error and leaves the file on offer. */
let pendingShare = null;
async function shareFile(bytes, name, type) {
  const file = new File([bytes], name, { type });
  if (!navigator.canShare || !navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title: name });
    report("print", `shared ${name}`);
    return true;
  } catch (e) {
    if (e && e.name === "AbortError") { report("print", "share cancelled"); return true; }
    report("print", `share refused: ${e && e.name}`);
    return false;
  }
}
async function offerShareOrDownload(bytes, name, type) {
  const file = new File([bytes], name, { type });
  /* The Web Share API only exists in a secure context, so on the plain-http LAN dev server -- the
     origin the phone is parked on -- navigator.share is not there at all and a print can only be a
     download. Say so rather than silently falling back, because "the share sheet did not open" on
     that origin is the platform, not this code. */
  if (!navigator.canShare) {
    report("print", `no share sheet here (secure context: ${window.isSecureContext}); downloading ${name}`);
    offerDownload(bytes, name, type);
    return;
  }
  if (navigator.canShare({ files: [file] })) {
    pendingShare = { bytes, name, type };
    diag(`print: ${name} waiting for a touch to reach the share sheet`);
    /* Try immediately as well: on the desktop a print often follows a click closely enough that
       the gesture is still live, and there the share sheet is a nicety rather than the only way. */
    if (await shareFile(bytes, name, type)) { pendingShare = null; return; }
    return;
  }
  offerDownload(bytes, name, type);
}
/* Called from the touch handler: the gesture the share sheet needs. */
async function flushPendingShare() {
  if (!pendingShare) return;
  const p = pendingShare; pendingShare = null;
  if (!(await shareFile(p.bytes, p.name, p.type))) offerDownload(p.bytes, p.name, p.type);
}
window.pvShare = () => (pendingShare ? { name: pendingShare.name, bytes: pendingShare.bytes.length } : null);

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
    const out = pdf ? { bytes: pdf, name: `windows-${stamp}.pdf`, type: "application/pdf" }
                    : { bytes: ps, name: `windows-${stamp}.ps`, type: "application/postscript" };
    window.pvLastPrint = out;                                      // for tooling: the last job's output
    report("print", `${out.name} ${out.bytes.length} bytes`);
    if (params.get("diag")) {                                      // keep a copy on the dev server (shots/print-*.pdf)
      try { fetch("/__print?ext=" + out.name.split(".").pop(), { method: "POST", body: out.bytes }); } catch (e) {}
    }
    await offerShareOrDownload(out.bytes, out.name, out.type);
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
  ["Home", [0xE0, 0x47]], ["End", [0xE0, 0x4F]], ["PgUp", [0xE0, 0x49]], ["PgDn", [0xE0, 0x51]], ["Ins", [0xE0, 0x52]], null,
  /* Copy and paste, because a phone has no Ctrl+Insert and iOS's own paste callout needs a visible
     text field, which this page does not have and is not allowed to grow. These two do the whole
     job in one tap each -- read or write the phone's clipboard, and press the keys Windows 3.1
     listens for -- and the bar is the one piece of host chrome the rule allows. */
  ["Copy", "copy"], ["Paste", "paste"], null,
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
/* Diagnostics, alongside window.pvState: drive the guest from a console or a test harness the way
   the accessory bar does. pvKeys([[0x01]]) presses Esc; pvText("hi") types through v86's keyboard. */
window.pvKeys = seq => { for (const codes of seq) { sendScancodes(codes, true); sendScancodes(codes, false); } };
window.pvText = s => { for (const ch of s) emulator.keyboard_send_text(ch); };
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
/* The bar's Copy: press the keys Windows copies with, then hand what the guest reports to the
   phone. The write has to happen inside this gesture, and PVMON's report is a moment behind the
   keys, so the report itself does the writing (offerClipboard, with clipCopyWait still open). */
function keybarCopy() {
  sendChord([0x1D], [0x52]);                               // Ctrl+Insert
  clipCopyWait = performance.now() + 1500;
  diag("keybar: copy");
  if (!navigator.clipboard) report("kbd", `copy: no clipboard here (secure context: ${window.isSecureContext})`);
}
/* And Paste: read the phone's clipboard -- iOS asks the user the first time, which is why this is
   a deliberate tap rather than something that happens behind their back -- put it on the guest's
   clipboard, then press Shift+Insert where the focus is. */
async function keybarPaste() {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    report("kbd", `paste: no clipboard here (secure context: ${window.isSecureContext})`);
    return;
  }
  let text = "";
  try { text = await navigator.clipboard.readText(); }
  catch (e) { report("kbd", `paste refused: ${e && e.name}`); return; }
  if (!text) { diag("keybar: paste, but the clipboard is empty"); return; }
  pasteToGuest(text);
  queue(async () => { await sleep(120); sendChord(CLIP_KEYS.v[0], CLIP_KEYS.v[1]); });
  diag(`keybar: paste ${text.length} chars`);
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
      if (k[1] === "copy") { keybarCopy(); return; }
      if (k[1] === "paste") { keybarPaste(); return; }
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
/* Characters that need Shift, and the unshifted key they live on. v86 can type these itself, but
   it presses Shift, the key and releases Shift with no gap at all, and a DOS box samples the
   shift state on its own schedule: "?" arrived as "/". We send them ourselves with a beat between
   the shift and the key. */
const SHIFT_CHARS = { "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8",
  "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", ":": ";", '"': "'", "<": ",", ">": ".",
  "?": "/", "|": "\\", "~": "`" };
const SHIFT_SCAN = 0x2A;
async function typeChar(ch) {
  const upper = ch >= "A" && ch <= "Z";
  const base = upper ? ch.toLowerCase() : SHIFT_CHARS[ch];
  const code = charScancode(base != null ? base : ch);
  if (!code) { emulator.keyboard_send_text(ch); return; }        // anything unmapped: v86's own path
  const shift = upper || SHIFT_CHARS[ch] !== undefined;
  if (shift) { emulator.bus.send("keyboard-code", SHIFT_SCAN); await sleep(8); }
  emulator.bus.send("keyboard-code", code);
  await sleep(4);
  emulator.bus.send("keyboard-code", code | 0x80);
  if (shift) { await sleep(8); emulator.bus.send("keyboard-code", SHIFT_SCAN | 0x80); }
}
function updateKeybar() {
  const bar = $("keybar");
  if (!bar) return;
  for (const b of bar.querySelectorAll("button")) {
    const st = b.dataset.key === "Ctrl" ? sticky.ctrl : b.dataset.key === "Alt" ? sticky.alt : 0;
    b.classList.toggle("on", st === 1); b.classList.toggle("lock", st === 2);
  }
  /* Games played with the arrow keys (Tetris, Chip's Challenge, Rodent's Revenge) need keys but no
     typing, and the soft keyboard would eat half the screen. When one of them is in front the
     accessory bar shows on its own, docked at the bottom of the viewport. */
  const front = layers.filter(l => l.kind === "W" || l.kind === "O").slice(-1)[0];
  const keysOnly = narrow() && !!(front && ARROW_GAMES.test(front.title || "")) && !keyboardUp();
  const up = keyboardUp() || keysOnly;
  // Folded by default: with the keyboard up only a small tab shows; tapping it opens the bar.
  const tab = $("keybartab");
  const phone = narrow();                       // desktop has a real keyboard: no bar, no tab
  bar.classList.toggle("show", phone && up && keybarOpen);
  if (tab) { tab.classList.toggle("show", phone && up); tab.classList.toggle("open", keybarOpen); }
  if (up) {
    const vv = window.visualViewport;
    // dock to the bottom of the visible viewport, i.e. the top edge of the keyboard (on Chrome for
    // iOS that is the top of its own accessory row: it is part of the keyboard's height)
    const bottom = keysOnly ? Math.max(0, innerHeight - (vv.offsetTop + vv.height)) : window.innerHeight - (vv.offsetTop + vv.height);
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
/* What the guest last said has the focus: `PVK <0|1> <class> <flags>` (see guest/pvhook/pvhook.c).
   This replaced a regex over window titles plus a per-app veto list -- the host no longer knows or
   cares which program is in front, only what kind of window owns the focus. */
let guestFocus = { want: false, cls: "", flags: "" };
/* Classes the guest could not classify but the user has summoned the keyboard for by hand (the
   caption hold): a Visual Basic text box, a game's own input box. Remembered by class name, so the
   next window of that class raises the keyboard on its own. This is the mechanism that replaces
   the title table: nothing is hardcoded, the host learns. */
const LEARNED_KEY = "pv.textclasses";
let learnedText = new Set();
try { learnedText = new Set(JSON.parse(localStorage.getItem(LEARNED_KEY) || "[]")); } catch (e) {}
/* ?forget=1 empties the learned set, ?forget=Solitaire drops one class: a stray hold teaches a
   class that then raises the keyboard on every tap, and the page has to be able to take it back. */
if (params.get("forget")) {
  const f = params.get("forget");
  if (f === "1") learnedText.clear(); else learnedText.delete(f);
  try { localStorage.setItem(LEARNED_KEY, JSON.stringify([...learnedText])); } catch (e) {}
}
function learnTextClass(cls, flags) {
  /* Never learn a class Windows itself says takes no text (Button, ListBox, a #NNNNN system class,
     Progman ...): a hold over one of those is the user asking for the keyboard once, not forever. */
  if (!cls || cls === "-" || /n/.test(flags || "") || learnedText.has(cls)) return false;
  learnedText.add(cls);
  try { localStorage.setItem(LEARNED_KEY, JSON.stringify([...learnedText])); } catch (e) {}
  kbdLog(`learned "${cls}" takes text (flags=${flags || "-"}); known: ${[...learnedText].join(",")}`);
  report("kbd", `learned class ${cls}`);
  return true;
}
/* ...and unlearn it when the user dismisses the keyboard over that same class. A hold is easy to
   fire by accident on a caption, and the class it taught stayed taught: after one stray hold on
   Solitaire's title bar, every tap on the cards raised the keyboard. Dismissing the keyboard is
   the plainest statement that this class does not want one. */
function unlearnTextClass(cls) {
  if (!cls || !learnedText.has(cls)) return false;
  learnedText.delete(cls);
  try { localStorage.setItem(LEARNED_KEY, JSON.stringify([...learnedText])); } catch (e) {}
  kbdLog(`unlearned "${cls}": the keyboard was dismissed over it; known: ${[...learnedText].join(",") || "none"}`);
  report("kbd", `unlearned class ${cls}`);
  return true;
}
/* Is the focus, as the guest last described it, text-capable? */
function guestTextFocus() {
  if (guestFocus.want) return true;
  return learnedText.has(guestFocus.cls) && !/n/.test(guestFocus.flags);
}
/* The guest's word on whether it wants text (PVK). 1 keeps or refocuses; 0 releases after a short
   debounce, so a tap that moves the focus from one Edit into another does not flicker. A manual
   hold (caption long-press) overrides 0. */
function guestWantsKeyboard(want, cls, flags) {
  if (cls !== undefined) { guestFocus = { want, cls: cls || "", flags: flags || "" }; syncA11yFocus(); }
  if (!want && guestTextFocus()) { kbdLog(`PVK 0 ${cls} ${flags} -> learned class takes text`); want = true; }
  /* A device with a real keyboard needs no hidden input: v86's own keyboard adapter takes the
     page's key events (scancodes, so Esc, arrows and F-keys work as they do on a PC); focusing the
     contenteditable as well would deliver every character twice. */
  if (!touchDevice) { kbdLog(`PVK ${want ? 1 : 0} (hardware keyboard: ignored)`); return; }
  if (want) {
    wantKeyboard = true;
    clearTimeout(kbdBlurTimer);
    if (performance.now() < kbdSuppressedUntil) { kbdLog("PVK 1 (suppressed after hide)"); return; }
    kbdLog(`PVK 1 ${guestFocus.cls} ${guestFocus.flags}`);
    if (performance.now() < lateTapUntil && document.activeElement !== $("kbd")) { lateTapUntil = 0; focusKeyboard("late"); return; }
    syncKeyboard();
  } else {
    wantKeyboard = false;
    if (keyboardHeld) { kbdLog(`PVK 0 ${guestFocus.cls} (held)`); return; }
    kbdLog(`PVK 0 ${guestFocus.cls} ${guestFocus.flags}`);
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
for (const evn of ["touchend", "click"])
  window.addEventListener(evn, () => flushPendingShare(), { passive: true });
for (const evn of ["touchend", "click", "keydown", "pointerup"])
  document.addEventListener(evn, () => unlockAudio(evn), { capture: true, passive: true });
/* Nothing composites while the page is hidden (the worker's pixel conversion stops with it), so
   what the guest painted meanwhile is not in the dirty ring frame by frame: come back with a full
   composite rather than trusting the last generation. */
document.addEventListener("visibilitychange", () => { if (!document.hidden) { unlockAudio("visible"); invalidate(); } });
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

/* ------------------------------------------------------------------- the pointer, on a desktop
 * On a wide viewport the visible pointer is the *browser's own*: it is the real mouse, so it moves
 * with zero latency, and the guest's drawn one is hidden (CMD_CURSOR 0). What makes that honest is
 * the shape: PVMON classifies whatever Windows currently wants (PVC, see pvmon.c) and the CSS
 * cursor on #pres is set from the name, so the two agree without the host guessing from geometry.
 *
 * `app` is a program's own cursor -- Paintbrush's brush and its tool cursors, a game's pointer,
 * File Manager's drag glyph. CSS has nothing equivalent, so for those the guest's own drawn cursor
 * comes back and the browser's goes away: correct rather than approximately right.
 * `none` is Windows itself wanting no pointer (an application drawing with a NULL cursor), and is
 * honoured as a deliberate absence.
 *
 * The order of a handover is chosen so there is never a moment with *no* pointer: the guest is
 * asked to show its cursor first and the browser's is only taken away once that command can have
 * landed (the command register is read on PVMON's poll). Going the other way the CSS shape appears
 * at once and the guest's is dismissed. Both cursors sit at the same guest point, so the brief
 * overlap is two arrows on top of each other, not two pointers in two places.
 *
 * The phone is untouched by all of this: applyCursorShape() does nothing on a narrow viewport,
 * where the finger is the pointer and #pres keeps the stylesheet's `cursor:none`. */
const CURSOR_CSS = {
  arrow: "default", ibeam: "text", wait: "wait", cross: "crosshair",
  sizens: "ns-resize", sizewe: "ew-resize", sizenwse: "nwse-resize", sizenesw: "nesw-resize",
  sizeall: "move", uparrow: "n-resize", no: "not-allowed", none: "none",
};
const CURSOR_HANDOVER = 300;     // ms: PVMON's poll is the 55 ms tick, plus the guest's own repaint
let guestCursorName = "arrow";
let cursorHandover = 0, cursorApplied = null;
/* Called on every PVC line and from pump() sixty times a second, so it must do nothing at all when
   nothing has changed: a repeated call would otherwise clear the handover timer before it fires. */
function applyCursorShape() {
  const el = $("pres");
  if (!el) return;
  const want = `${narrow() ? "phone" : "desktop"}:${guestCursorName}:${desktopReady ? 1 : 0}`;
  if (want === cursorApplied) return;
  cursorApplied = want;
  clearTimeout(cursorHandover);
  /* Phone: back to the stylesheet's cursor:none and to the guest drawing its own pointer, which on
     a touch screen the first touch hides again. Coming back from the desktop is the only way to
     get here with the guest's cursor hidden, and a mouse would otherwise have no pointer at all
     until it moved. */
  if (narrow()) { el.style.cursor = ""; if (!touchDevice) setGuestCursor(true); return; }
  const own = guestCursorName === "app";                     // the guest must draw this one itself
  const css = own ? "none" : (CURSOR_CSS[guestCursorName] || "default");
  setGuestCursor(own);
  if (own) cursorHandover = setTimeout(() => { if (guestCursorName === "app") el.style.cursor = "none"; }, CURSOR_HANDOVER);
  else el.style.cursor = css;
  diag(`cursor shape ${guestCursorName} -> css ${css}`);
}
window.pvCursor = () => ({ name: guestCursorName, css: $("pres") ? $("pres").style.cursor : null, guestShown: guestCursorShown });

/* Per-surface policy for one finger on a window's client area.
     scroll  read-only / content surfaces: a drag scrolls the window (CMD_SCROLL, like two fingers)
     drag    draw and drag surfaces: a drag is a pointer drag (cards, brushes, DOS box selection)
   Keyed by the window title PVMON publishes (class names are not on the wire). Taps are clicks
   everywhere. Unknown titles get pointer drag, the behaviour every Windows program expects. */
const SURFACE_POLICY = [
  [/^About$/, "scroll"], [/^Welcome to Windows/, "scroll"],            // the read-me's note scrolls
  [/^Page$/, "scroll"],                                                // the page reader is all scroll
  [/\bHelp\b/, "scroll"], [/^Write\b/, "scroll"], [/^Notepad\b/, "scroll"], [/^Cardfile\b/, "scroll"],
  [/^File Manager/, "scroll"], [/^Control Panel/, "scroll"], [/^Print Manager/, "scroll"], [/^Task List/, "scroll"],
  [/^Calendar\b/, "scroll"], [/^Character Map/, "scroll"], [/^Media Player/, "scroll"], [/^Clipboard/, "scroll"],
  [/^Solitaire/, "drag"], [/^Paintbrush/, "drag"], [/^Minesweeper/, "drag"], [/^Hearts/, "drag"], [/MS-DOS/, "drag"],
  [/^Terminal/, "drag"], [/^Reversi/, "drag"], [/^SkiFree/, "hover"],   // hover: the skier follows the pointer; a swipe moves it without pressing
  /* "keys": games played on the keyboard, where a tap on the play area does nothing at all in the
     guest. A swipe becomes the arrow key it looks like and a double-tap becomes the drop key, so
     the game is playable with a thumb; the key bar is still there for anything else. */
  [/^TETRIS/i, "keys"], [/^Chip's Challenge/i, "keys"], [/^CHIPS/i, "keys"], [/^Rodent's Revenge/i, "keys"],
  /* Entertainment Pack: every one is a pointer surface (JezzBall draws a wall from the tap, the
     card games and Rodent's Revenge drag, Pipe Dream / Taipei / TetraVex place a piece per tap).
     "drag" is also the fallback, so these lines are the record, not a behaviour change. */
  [/^JezzBall/, "aim"],                                               // the swipe direction is the wall
  [/^TETRIS/, "drag"], [/^TetraVex/, "drag"], [/^TriPeaks/, "drag"],
  [/^Tut's Tomb/, "drag"], [/^FreeCell/, "drag"], [/^Golf/, "drag"], [/^Chip's Challenge/, "drag"],
  [/^Rodent's Revenge/, "drag"], [/^Pipe Dream/, "drag"], [/^Taipei/, "drag"], [/^Dr\. Black Jack/, "drag"],
];
/* CMD_SCROLL's slot field for the shell: PVMON routes it to Program Manager's active MDI group
   window (WM_VSCROLL/WM_HSCROLL). Slot numbers 0..MAX_SLOTS-1 are application columns. */
const SHELL_SCROLL_SLOT = 15;
/* A desktop hit inside Program Manager's client area (the group windows), not the icon row or the
   desktop around it: a one-finger drag there scrolls the active group. */
function insideShellClient(h) {
  if (!h || h.kind !== "desktop") return false;
  const S = layers.find(L => L.kind === "S");
  if (!S || S.ww <= 64 || S.wh <= 64) return false;      // an iconic shell has no client to scroll: its icon drags
  return h.x >= S.gx && h.x < S.gx + S.gw && h.y >= S.gy && h.y < S.gy + S.gh;
}
function surfacePolicy(L) {
  if (!L || L.kind !== "W") return "drag";
  for (const [re, pol] of SURFACE_POLICY) if (re.test(L.title || "")) return pol;
  return "drag";
}
/* What a swipe means in a "keys" game. Arrows are the E0-prefixed set the key bar already sends;
   `drop` is the double-tap. Tetris rotates with Up, so an up-swipe rotates and a down-swipe drops
   slowly, which is how the game itself is keyed. */
const KEY_GAMES = [
  [/^TETRIS/i,             { left: [0xE0, 0x4B], right: [0xE0, 0x4D], up: [0xE0, 0x48], down: [0xE0, 0x50], drop: [0x39] }],
  [/^Chip's Challenge/i,   { left: [0xE0, 0x4B], right: [0xE0, 0x4D], up: [0xE0, 0x48], down: [0xE0, 0x50], drop: null }],
  [/^CHIPS/i,              { left: [0xE0, 0x4B], right: [0xE0, 0x4D], up: [0xE0, 0x48], down: [0xE0, 0x50], drop: null }],
  [/^Rodent's Revenge/i,   { left: [0xE0, 0x4B], right: [0xE0, 0x4D], up: [0xE0, 0x48], down: [0xE0, 0x50], drop: null }],
];
function keyGame(title) { for (const [re, map] of KEY_GAMES) if (re.test(title || "")) return map; return null; }
/* Games driven by the arrow keys: the accessory bar appears for them without the soft keyboard.
   This is the accessory bar's own rule and has nothing to do with the keyboard decision, which is
   made entirely from the guest's PVK report (see guestTextFocus) -- the title tables that used to
   live here (KEYBOARD_TITLES, NO_KEYBOARD) are gone. */
/* JezzBall builds a vertical or a horizontal wall depending on a mode the right button toggles.
   On a phone the natural gesture is to draw the wall you want, so a swipe sets the mode: we hold
   which way the game is pointing (we are the only thing that toggles it), right-click if the swipe
   disagrees, then click where the finger went down. The game starts in vertical mode; a wrong
   guess costs one wall, and the next swipe is right again because the toggle is tracked. */
let jezzVertical = true;
function resetAim(titles) { if (!titles.some(t => /^JezzBall/.test(t || ""))) jezzVertical = true; }
const ARROW_GAMES = /^(TETRIS|Chip's Challenge|Rodent's Revenge|CHIPS|JezzBall)/i;

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

/* Menus do not always appear where they end up. Windows creates a popup at the point it was asked
   for and, if that would run off the screen, moves it — two publishes, milliseconds apart, and a
   compositor that draws every publish faithfully shows the menu in both places: a flicker on
   exactly the gesture the phone uses most. So a transient is held out of the composite until its
   rectangle has survived one frame: a popup that appears where it stays is one frame (16 ms) late,
   which nobody can see, and a popup that jumps is only ever drawn where it settles. The hold is
   capped in time as well as in frames, so a program that moves a popup continuously (a dragged
   drop-down) is never held out for good. It is held out of `placed`, not merely undrawn, so hit
   testing agrees with what is on the screen. */
const T_HOLD_MS = 80;
const tHold = new Map();               // transient key -> { rect, until (frame), deadline }
let frameNo = 0;
function holdTransients() {
  const live = new Set();
  for (const L of layers) {
    if (L.kind !== "T") continue;
    const key = layerKey(L);
    live.add(key);
    const rect = `${L.wx},${L.wy},${L.ww},${L.wh}`;
    const had = tHold.get(key);
    if (had && had.rect === rect) continue;                 // published again unmoved: it has settled
    tHold.set(key, { rect, until: frameNo + 1, deadline: performance.now() + T_HOLD_MS });
  }
  for (const k of tHold.keys()) if (!live.has(k)) tHold.delete(k);
}
function transientHeld(key) {
  const h = tHold.get(key);
  if (!h) return false;
  if (frameNo >= h.until || performance.now() > h.deadline) { h.until = -1; return false; }
  return true;
}
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
let scrollDrops = 0;
function sendCommand(cmd, arg) {
  if (cmd === CMD_SCROLL && cmdQueue.length) {
    const last = cmdQueue[cmdQueue.length - 1];
    if (last.cmd === CMD_SCROLL && (last.arg & 0xFFF) === (arg & 0xFFF)) {
      last.arg = (arg & 0xFFF) | Math.min(15, (last.arg >> 12) + (arg >> 12)) << 12;
      return;
    }
    /* A finger, and much more a glide, can ask for scroll faster than the guest can deliver it:
       PVMON has to reach the window, scroll it and let it repaint before it takes the next
       command, and a program group full of icons repaints slowly. Once the merge above has
       stopped absorbing them (it only merges into the tail, and only to fifteen lines), further
       commands are not scrolling -- they are a backlog the user sits through after lifting the
       finger, which is what "everything freezes for a minute" was. Beyond a few queued scrolls
       the newest ones are dropped: the scroll stops where the guest got to, which is the
       behaviour a slow list has on any touch device. */
    let queued = 0;
    for (const c of cmdQueue) if (c.cmd === CMD_SCROLL) queued++;
    if (queued >= 3) {
      if (++scrollDrops % 30 === 1) diag(`scroll dropped, ${queued} already queued (guest behind)`);
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
const CMD_FASTPOLL = 13;
const CMD_CLIP = 14;

/* A scroll command used to sit in the register until PVMON's timer came round. Windows 3.x rounds
   SetTimer up to the 18.2 Hz PC tick, so "every 40 ms" is really every 55 ms and a line of scroll
   waited that long (measured: 54 ms median) before the guest even looked. The host now says when a
   gesture is running: PVMON stops blocking in GetMessage for as long as it is armed and reads the
   register between yields (measured: 1 ms median). It is a busy loop in the guest — it keeps the
   system VM out of its INT 2F idle, which the emulator uses to throttle — so it is armed only from
   the touch that starts a scroll, re-armed while the finger keeps moving, and cancelled on the
   release; PVMON's own box (3 s) is the backstop if the page goes away mid-gesture. */
const FASTPOLL_MS = 1200;
let fastPollArmed = false, fastPollSentAt = 0;
function armFastPoll() {
  if (!desktopReady || (shell.ver && shell.ver < 36)) return;      // older PVMON ignores the command
  const now = performance.now();
  if (fastPollArmed && now - fastPollSentAt < FASTPOLL_MS / 2) return;
  const again = fastPollArmed;
  fastPollArmed = true; fastPollSentAt = now;
  sendCommand(CMD_FASTPOLL, FASTPOLL_MS);
  diag(`fastpoll ${again ? "re-armed" : "armed"} ${FASTPOLL_MS} ms`);
}
function releaseFastPoll() {
  if (!fastPollArmed) return;
  fastPollArmed = false;
  sendCommand(CMD_FASTPOLL, 0);
  diag("fastpoll released");
}

/* Shell-owned dialogs (About Program Manager, Run, Exit Windows: PVO with slot -1) are drawn inside
   the desktop column, not as layers. One taller than the visible column would have no reachable
   bottom, so the column itself pans vertically: a one-finger drag that starts on such a dialog moves
   view.y within [0, dialogBottom - view.h]; the pan returns to 0 when the dialog goes away. */
let shellPanY = 0;
function tallShellDialogBottom(viewH) {
  let bottom = 0;
  for (const L of layers) if (L.kind === "O" && L.slot < 0 && L.wy + L.wh > viewH) bottom = Math.max(bottom, L.wy + L.wh);
  return Math.min(bottom, SHELL_H);                      // the column's VRAM ends at SHELL_H rows
}
function shellPanClamp(viewH) {
  const max = Math.max(0, tallShellDialogBottom(viewH) - viewH);
  if (!max) { shellPanY = 0; return 0; }
  shellPanY = Math.round(Math.max(0, Math.min(max, shellPanY)));   // whole guest rows: no resampling
  return shellPanY;
}
/* The desktop view: which slice of the guest screen is the background, and at what scale. */
let view = { x: 0, y: 0, w: 0, h: 0, scale: 1, ox: 0 };
let placed = [];                     // the composited windows, as drawn, front-most last

let oversizeSince = 0;
function chooseView(src) {
  const [vw, vh] = viewport();
  if (!narrow() || !shell.h) {
    /* Desktop mode: the whole screen, 1:1, centred (the mode is the viewport rounded down to 8 x 2,
       so a few columns at the edges are left over and take the desktop's own colour).

       While a browser window is being dragged smaller the guest screen is still the old, larger
       one for as long as the resize takes to settle. Scaling it down to fit made the whole desktop
       shrink and swim inside black bars for the length of the drag, which is nothing a desktop
       does. It is cropped instead: the window covers the desktop as it narrows and uncovers it as
       it widens, exactly as a window over a desktop behaves, and when the guest re-modes a moment
       later the crop is already the whole screen. */
    const over = src.width > vw + 1 || src.height > vh + 1;
    oversizeSince = over ? (oversizeSince || performance.now()) : 0;
    /* The crop is only meant to cover the moment before the guest re-modes. If the guest has not
       followed within a couple of seconds -- it is busy, or it refused the mode -- fall back to
       scaling the whole screen down, so nothing can be left permanently off the edge. */
    if (oversizeSince && performance.now() - oversizeSince > 2000) {
      const scale = Math.min(1, vw / src.width, vh / src.height);
      return { x: 0, y: 0, w: src.width, h: src.height, scale, ox: Math.max(0, Math.floor((vw - src.width * scale) / 2)) };
    }
    const w = Math.min(src.width, Math.max(1, Math.ceil(vw)));
    const h = Math.min(src.height, Math.max(1, Math.ceil(vh)));
    return { x: 0, y: 0, w, h, scale: 1, ox: Math.max(0, Math.floor((vw - w) / 2)) };
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
  return { x: 0, y: shellPanClamp(shell.h), w: shell.w, h: shell.h, scale,
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
    let holeCentre = null;
    const key = layerKey(L);
    // A dialog owned by the shell already shows in the desktop column at desktop scale, and
    // PVMON reflows it to fit there; a second copy as a layer would be a double image.
    if (L.kind === "O" && L.slot < 0) {
      /* A dialog parked in a tile has no copy in the column to be, so it is always its own layer;
         without an anchor (an older guest) a narrow one is still the copy in the column. */
      if (L.ax == null && L.ww <= shell.w) return;
      /* A shell dialog wider than the column (About Program Manager 505 wide, Run un-reflowed) has
         its right part, OK included, off the column and unreachable. It becomes its own layer:
         the whole window scaled to fit the viewport, placed over its copy in the column (the copy
         is masked in presentOnce), hit-tested transient-style so every control maps to guest pixels. */
      const s = Math.min(c, vw / L.ww, vh / L.wh);
      const hw = Math.round(L.ww * s), hh = Math.round(L.wh * s);
      const ax = L.ax != null ? L.ax : L.wx, ay = L.ay != null ? L.ay : L.wy;
      let x = Math.round(view.ox + (ax - view.x) * c), y = Math.round((ay - view.y) * c);
      x = Math.max(0, Math.min(vw - hw, x));
      y = Math.max(0, Math.min(vh - hh, y));
      out.push({ ...L, src: L, key, s, c: s, cw: hw, ch: hh, hw, hh, x, y, hl: 0, ht: 0, hb: 0,
                 inset: { l: 0, t: 0, b: 0 }, capRow: 0, menuRow: 0, box: 0, transient: true, shellDialog: true });
      return;
    }
    if (L.kind === "S") {
      /* The shell takes part in z-order: when Program Manager is in front it is drawn again, on
         top of the applications, exactly where it already is in the desktop column. */
      const x = Math.round(view.ox + L.wx * c), y = Math.round((L.wy - view.y) * c);
      const hw = Math.round(L.ww * c), hh = Math.round(L.wh * c);
      out.push({ ...L, key, s: c, c, cw: hw, ch: hh, hw, hh, x, y, hl: 0, ht: 0, hb: 0,
                 inset: { l: 0, t: 0, b: 0 }, capRow: 0, menuRow: 0, box: 0, shellCopy: true });
      return;
    }
    if (L.kind === "T") {
      if (transientHeld(key)) return;                  // published this frame and may still move
      const hw = Math.round(L.ww * c), hh = Math.round(L.wh * c);
      let x, y;
      /* Where the popup belongs on screen. A popup in an off-screen tile publishes that place as
         its anchor; one still painted where it popped up is its own anchor. The rectangle it is
         drawn FROM stays L.wx/L.wy either way. */
      const ax = L.ax != null ? L.ax : L.wx, ay = L.ay != null ? L.ay : L.wy;
      const centred = Math.abs(ax + L.ww / 2 - screenW / 2) < 8;        // the Alt+Tab switcher
      const col = Math.floor(ax / SLOT_W);
      /* The window the popup belongs to. Usually the slot's application (bySlot), but an owned
         window can own menus of its own — Rodent's Revenge's whole game window is an owned
         window — and anchoring those to the slot's application put the menu somewhere else
         entirely, with a masked grey hole where it should have been. Prefer the front-most
         already-placed layer whose rect contains the popup's origin. */
      let owner = col >= 1 ? bySlot[col - 1] : null;
      for (let i = out.length - 1; i >= 0; i--) {
        const q = out[i];
        if (q.transient || q.shellCopy || q.src == null) continue;
        if (ax >= q.wx - 2 && ax <= q.wx + q.ww + 2 && ay >= q.wy - 2 && ay <= q.wy + q.wh + 2) { owner = q; break; }
      }
      if (centred) { x = Math.round((vw - hw) / 2); y = Math.round((vh - hh) / 2); }
      else if (owner) {
        if (ay < owner.gy) {                                              // hangs off the chrome (a menu)
          // chrome scale, through the menu strip's pan, so it hangs off the item that opened it
          x = Math.round(owner.x + owner.hl + (ax - owner.wx - owner.inset.l - (owner.mpan || 0)) * c);
          y = Math.round(owner.y + (ay - owner.wy) * c);
        } else {
          x = Math.round(owner.x + owner.hl + (ax - owner.gx) * owner.s);
          y = Math.round(owner.y + owner.ht + (ay - owner.gy) * owner.s);
        }
      } else { x = Math.round(view.ox + ax * c); y = Math.round((ay - view.y) * c); }
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
        // Coincident only when the owner is shown near 1:1; a dialog inside a 0.3x-scaled owner
        // (Paintbrush's save prompt in a 1280-wide window) would be unreadable, so it is drawn as
        // its own layer centred on its copy instead; the owner's clip hole stays under it.
        // …and only if the dialog fits the viewport at that scale; a 600-wide Control Panel dialog
        // drawn coincident at 1:1 had to be panned to reach its buttons.
        if (overlaps && owner.zs >= 0.8 && L.ww * owner.zs <= vw && L.wh * owner.zs <= vh) {
          const zs = owner.zs;
          const hw = Math.round(L.ww * zs), hh = Math.round(L.wh * zs);
          const x = Math.round(owner.x + owner.hl + (L.wx - ox0) * zs);
          const y = Math.round(owner.y + owner.ht + (L.wy - oy0) * zs);
          out.push({ ...L, key, s: zs, c: zs, cw: hw, ch: hh, hw, hh, x, y, hl: 0, ht: 0, hb: 0,
                     inset: { l: 0, t: 0, b: 0 }, capRow: 0, menuRow: 0, box: 0, transient: true, coincident: true });
          return;
        }
        if (overlaps) {
          // centre of the dialog's copy inside the scaled owner, in host pixels
          holeCentre = { x: owner.x + owner.hl + (L.wx + L.ww / 2 - ox0) * owner.zs,
                         y: owner.y + owner.ht + (L.wy + L.wh / 2 - oy0) * owner.zs };
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
    let menuVis = 0, menuMax = 0;                      // guest px of menu bar that fit, and the pan limit
    const availW = vw - hl - hr;                       // edge to edge: a layer may fill the width
    const availH = vh - ht - hb;
    const s = Math.min(c, availW / Math.max(1, L.gw), availH / Math.max(1, L.gh));
    const cw = Math.round(L.gw * s), ch = Math.round(L.gh * s);
    const hw = cw + hl + hr, hh = ch + ht + hb;
    let p = layerPos[key];
    if (!p) {
      delete menuPan[key];                             // a fresh placement starts with the menu bar at its left end
      const owner = L.kind === "O" ? bySlot[L.slot] : null;
      /* Default placement, no cascade: a new layer fills the width (x = 0 when it is as wide as
         the viewport, centred when it is narrower) and sits just under the shell's caption strip,
         so Program Manager's caption stays reachable behind it; a layer taller than that room is
         top-aligned. The user can still drag it anywhere, including off the edges. */
      const capStrip = Math.round(shell.cap * c) + Math.round(inset.l * c);
      if (owner && holeCentre) {
        p = layerPos[key] = { x: Math.max(0, Math.min(vw - hw, Math.round(holeCentre.x - hw / 2))),
                              y: Math.max(0, Math.min(vh - hh, Math.round(holeCentre.y - hh / 2))) };
      } else if (owner) {
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
    if (menuRow > 0) {
      menuVis = Math.min(L.ww - 2 * inset.l, Math.round((hw - 2 * hl) / c));
      menuMax = Math.max(0, L.ww - 2 * inset.l - menuVis);
      if (menuPan[key] === undefined) menuPan[key] = 0;
      menuPan[key] = Math.max(0, Math.min(menuMax, menuPan[key]));
    }
    const w = { ...L, src: L, key, s, c, cw, ch, hw, hh, x, y, inset, capRow, menuRow, box, hl, ht, hb, hr, menuVis, menuMax, mpan: menuPan[key] || 0,
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
    if (dy < w.ht)                                    // menu row: drawn from its pan offset
      return { kind: "chrome", menu: true, win: w, x: Math.round(w.wx + dx / w.c + (w.mpan || 0)), y: Math.round(w.wy + dy / w.c) };
    return { kind: "drag", win: w };                  // the frame itself drags, like the caption
  }
  return { kind: "desktop",
           x: Math.round(view.x + (px - view.ox) / view.scale),
           y: Math.round(view.y + py / view.scale) };
}

/* A shell dialog drawn as its own layer leaves its copy in the column: the part of that copy inside
   the column is covered with one solid colour, the background of Program Manager's own client next
   to the copy, so the layer is the only dialog on screen. Applied after the desktop blit and again
   after the shell copy (Program Manager in front re-blits the same pixels).

   This used to stretch the one guest row next to the copy over the whole hole. That is fine as long
   as the row is uniform background, which it is in the Main group (three rows of icons, nothing
   beside the dialog) -- and it is not in the Games group, where the row below the dialog runs
   through the "Rodent's Revenge / Pipe Dream / Taipei" labels: each black text pixel became a tall
   black column and the hole filled with vertical streaks (2026-09-03). Same rule as the owned-dialog
   holes in drawWindow: one solid colour, never a stretched strip. */
function maskShellDialogCopies(g, src) {
  for (const w of placed) if (w.shellDialog) {
    const cx0 = Math.max(view.x, w.wx), cx1 = Math.min(view.x + view.w, w.wx + w.ww);
    const cy0 = Math.max(view.y, w.wy), cy1 = Math.min(view.y + view.h, w.wy + w.wh);
    if (cx1 > cx0 && cy1 > cy0) {
      g.fillStyle = shellClientBackground(src, w);
      g.fillRect(view.ox + (cx0 - view.x) * view.scale, (cy0 - view.y) * view.scale,
                 (cx1 - cx0) * view.scale, (cy1 - cy0) * view.scale);
    }
  }
}
/* The background colour of Program Manager's client beside a shell dialog's copy: the most common
   colour along one row of the client, taken just below the copy (the dialog sits over the client,
   so that row is client, not the menu bar and the frame's grey corners) and just above it when the
   copy reaches the bottom. A row and not a single pixel because that one pixel can land on an icon
   or its label, and a row's *mode* is the background even when the row crosses a whole icon row. */
function shellClientBackground(src, w) {
  const S = layers.find(L => L.kind === "S");
  const cx0 = S ? S.gx : 0, cx1 = S ? S.gx + S.gw : src.width;
  const cy0 = S ? S.gy : 0, cy1 = S ? S.gy + S.gh : src.height;
  let y = w.wy + w.wh + 1;
  if (y >= cy1) y = w.wy - 2;
  y = Math.max(0, Math.min(src.height - 1, Math.max(cy0, Math.min(cy1 - 1, y))));
  const x = Math.max(0, Math.min(src.width - 1, cx0));
  const width = Math.max(1, Math.min(cx1, src.width) - x);
  return dominantColour(src, x, y, width);
}
/* `meets(x, y, w, h)` says whether a piece of this window is inside the damage being repainted.
   Everything drawn here is clipped to the damage anyway, so skipping a piece changes no pixel; it
   saves the call. A window repainting its client is the case that matters: the nine-sliced caption,
   the menu strip and the borders are then not touched at all. */
function drawWindow(g, src, w, meets) {
  const c = w.c;
  if (!meets) meets = () => true;
  if (w.transient || w.shellCopy) {
    blit(g, src, w.wx, w.wy, w.ww, w.wh, w.x, w.y, w.hw, w.hh);
    if (w.shellCopy) maskShellDialogCopies(g, src);
    return;
  }
  const { inset, capRow, menuRow, box, hl, ht, hb } = w;
  const capH = Math.round(capRow * c), menuH = ht - capH;
  const cornerL = Math.round((inset.l + box) * c), cornerR = Math.round((inset.l + 2 * box) * c);
  const midSrcW = w.ww - 2 * inset.l - 3 * box;       // the caption strip between the boxes
  const midDstW = w.hw - cornerL - cornerR;
  const capDirty = meets(w.x, w.y, w.hw, capH);
  if (capDirty) {
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
  }
  if (menuRow > 0 && menuH > 0 && meets(w.x + hl, w.y + capH, w.hw - 2 * hl, menuH)) {
    const innerW = w.hw - 2 * hl;                     // between the side borders, never over them
    const mwG = Math.min(w.ww - 2 * inset.l, Math.round(innerW / c)), mwH = Math.round(mwG * c);
    const mp = w.mpan || 0;                           // panned: the strip is a window onto the full-width bar
    blit(g, src, w.wx + inset.l + mp, w.wy + capRow, mwG, menuRow, w.x + hl, w.y + capH, mwH, menuH);
    // a child dialog whose top overlaps the menu bar leaves its caption in this strip: fill it with
    // the menu bar's own colour (sampled at the strip's left end)
    const mx0 = w.wx + inset.l, my0 = w.wy + capRow;
    for (const h of overlapsOf(w, { x0: mx0, y0: my0, x1: mx0 + mwG, y1: my0 + menuRow })) {
      g.fillStyle = sampleColour(src, mx0 + mwG - 3, my0 + 2);   // the empty right end of the menu bar, not the frame line
      g.fillRect(w.x + hl + (h.x - mx0) * c, w.y + capH + (h.y - my0) * c, h.w * c, h.h * c);
    }
    if (innerW > mwH)                                 // pad with the menu bar's own background
      blit(g, src, w.wx + inset.l + mwG - 2, w.wy + capRow, 2, menuRow, w.x + hl + mwH, w.y + capH, innerW - mwH, menuH);
  }
  if (hl > 0) {                                       // side borders, stretched only lengthways, caption to bottom
    if (meets(w.x, w.y + capH, hl, w.hh - capH - hb))
      blit(g, src, w.wx, w.wy + capRow, inset.l, w.wh - capRow - inset.b, w.x, w.y + capH, hl, w.hh - capH - hb);
    { const hr = w.hr == null ? hl : w.hr, ir = w.inset.r == null ? inset.l : w.inset.r;
      if (meets(w.x + w.hw - hr, w.y + capH, hr, w.hh - capH - hb))
        blit(g, src, w.wx + w.ww - ir, w.wy + capRow, ir, w.wh - capRow - inset.b, w.x + w.hw - hr, w.y + capH, hr, w.hh - capH - hb); }
  }
  if (hb > 0 && meets(w.x, w.y + ht + w.ch, w.hw, hb))
    blit(g, src, w.wx, w.gy + w.gh, Math.min(w.ww, Math.round(w.hw / c)), inset.b,
                w.x, w.y + ht + w.ch, w.hw, hb);
  /* The client, at the scale that fits. An owned dialog or a menu that physically overlaps this
     window in guest VRAM is part of this capture too, and it is drawn again as its own layer: the
     overlapping rectangles are masked out of the client blit (clipped away, so whatever is behind
     the owner shows through until the child's own layer covers it), so a fallback placement never
     shows two copies of a dialog. */
  if (!meets(w.x + hl, w.y + ht, Math.round(w.vw * w.zs), Math.round(w.vh * w.zs))) return;
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
  if (holes.length) {
    g.restore();
    /* The hole is filled with one solid colour sampled from the owner's client next to it (its
       background), not with a stretched strip (streaks) and not left open (the desktop showed
       through where the child's own layer is smaller than the hole). */
    const cx0 = w.gx + w.px, cy0 = w.gy + w.py;
    for (const h of holes) {
      const sx = h.x - 1 >= cx0 ? h.x - 1 : Math.min(h.x + h.w, cx0 + w.vw - 1);
      const sy = h.y - 1 >= cy0 ? h.y - 1 : Math.min(h.y + h.h, cy0 + w.vh - 1);
      g.fillStyle = sampleColour(src, sx, sy);
      g.fillRect(w.x + hl + (h.x - cx0) * w.zs, w.y + ht + (h.y - cy0) * w.zs, h.w * w.zs, h.h * w.zs);
    }
  }
}
/* Owned (PVO) and transient (PVT) windows that overlap layer `w`'s client area in guest screen
   space, as guest rects clipped to the visible part of the client. Only children that are drawn as
   their own layer count, so nothing is ever masked without a copy on top. */
function overlapsOf(w, rect) {
  const out = [];
  const cx0 = rect ? rect.x0 : w.gx + w.px, cy0 = rect ? rect.y0 : w.gy + w.py;
  const cx1 = rect ? rect.x1 : cx0 + w.vw, cy1 = rect ? rect.y1 : cy0 + w.vh;
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

/* FM synthesis (MIDI). v86's SB16 now has a real OPL3 (v86/src/opl3.js), which renders at its own
   49716 Hz whenever an envelope is running and pushes stereo blocks over the bus. It does not go
   through the wave DAC: that one is a pull-model queue whose sampling rate follows whatever DMA
   playback is programmed, and MIDI has to be able to sound at the same time as a .WAV without the
   two arguing about a rate. So the page owns a second output node here.

   A ScriptProcessor (not an AudioWorklet: a worklet needs its own module file, and this runs
   everywhere including iOS Safari) drains a ring buffer, resampling from 49716 Hz to whatever the
   AudioContext runs at. The device paces its blocks on the wall clock, so the ring absorbs the
   jitter; PREROLL keeps a cushion so a busy guest does not tick, and a ring that drifts too far
   ahead is caught up rather than allowed to add latency. Under-run plays silence. */
const opl = { rate: 49716, ring: null, size: 1 << 16, w: 0, r: 0, node: null, sink: null, ctx: null,
              blocks: 0, samples: 0, under: 0, skips: 0, playing: false, preroll: true };
const OPL_PREROLL = 2048;                     // ~41 ms of cushion before the node starts draining
const OPL_MAX_AHEAD = 24000;                  // ~480 ms: beyond this the read position jumps forward
window.oplState = () => ({ blocks: opl.blocks, samples: opl.samples, queued: Math.round(opl.w - opl.r),
                           under: opl.under, skips: opl.skips, playing: opl.playing, rate: opl.rate,
                           ctx: opl.ctx ? opl.ctx.state : "none" });
emulator.bus.register("opl-tell-sampling-rate", r => { if (r > 0) opl.rate = r; });
emulator.bus.register("opl-idle", () => { opl.playing = false; });
emulator.bus.register("opl-send-data", data => {
  const l = data[0], r = data[1], n = l.length;
  if (!oplOpen()) return;
  if (!opl.playing) { opl.playing = true; opl.preroll = true; opl.r = opl.w; }
  const ring = opl.ring, size = opl.size;
  for (let i = 0; i < n; i++) {
    const p = ((opl.w + i) % (size >> 1)) << 1;
    ring[p] = l[i]; ring[p + 1] = r[i];
  }
  opl.w += n;
  opl.blocks++; opl.samples += n;
  if (opl.w - opl.r > OPL_MAX_AHEAD) { opl.r = opl.w - OPL_PREROLL; opl.skips++; }
  if (opl.preroll && opl.w - opl.r >= OPL_PREROLL) opl.preroll = false;
});
function oplOpen() {
  if (opl.node) return true;
  const ctx = audioCtx();
  if (!ctx) return false;                     // no speaker adapter (headless probe): nothing to play into
  opl.ctx = ctx;
  opl.ring = new Float32Array(opl.size);      // interleaved stereo, so size >> 1 frames
  opl.node = ctx.createScriptProcessor(1024, 0, 2);
  // Same 3x the speaker adapter gives its own DAC source: the chip's 13-bit sum is scaled by
  // 1/32768 in the device, which leaves a single loud voice around -14 dBFS.
  opl.sink = ctx.createGain(); opl.sink.gain.value = 3;
  const step = opl.rate / ctx.sampleRate;     // 49716 Hz in, the context's rate out
  opl.node.onaudioprocess = ev => {
    const ob = ev.outputBuffer, L = ob.getChannelData(0), R = ob.getChannelData(1);
    const frames = ob.length, size = opl.size >> 1;
    if (opl.preroll || opl.r >= opl.w) { L.fill(0); R.fill(0); if (opl.playing && !opl.preroll) opl.under++; return; }
    for (let i = 0; i < frames; i++) {
      const pos = opl.r + i * step;
      if (pos >= opl.w) { L[i] = 0; R[i] = 0; continue; }
      const i0 = Math.floor(pos), f = pos - i0;
      const a = (i0 % size) << 1, b = ((i0 + 1) % size) << 1;
      L[i] = opl.ring[a] * (1 - f) + opl.ring[b] * f;
      R[i] = opl.ring[a + 1] * (1 - f) + opl.ring[b + 1] * f;
    }
    opl.r += frames * step;
    if (opl.r > opl.w) opl.r = opl.w;
  };
  opl.node.connect(opl.sink); opl.sink.connect(ctx.destination);
  report("opl", `output open: ${opl.rate} Hz in, ${ctx.sampleRate} Hz out, ctx ${ctx.state}`);
  return true;
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
var logEndpointGone = false;                          // var: hoisted, report() runs during module evaluation before this line
function report(kind, detail) {
  if (logEndpointGone) return;                          // production has no dev server: stop after the first 404
  try { fetch("/__log", { method: "POST", body: `${kind} ${detail}`, keepalive: true }).then(r => { if (r.status === 404) logEndpointGone = true; }).catch(() => {}); } catch (e) {}
}
window.addEventListener("error", ev => report("error", `${ev.message} @${ev.filename}:${ev.lineno} ${ev.error && ev.error.stack}`));
window.addEventListener("unhandledrejection", ev => report("rejection", String(ev.reason && (ev.reason.stack || ev.reason))));

/* Composite frame accounting, so "60 fps while the guest is busy" is a number rather than an
   impression: the interval between composites, the time spent taking guest pixels across, and the
   time spent drawing. window.pvPerf() reads and resets it. */
const perf = { last: 0, iv: new Float32Array(600), draw: new Float32Array(600), n: 0, syncCost: 0 };
window.pvPerf = reset => {
  const n = Math.min(perf.n, 600);
  const iv = Array.from(perf.iv.subarray(0, n)).sort((a, b) => a - b);
  const dr = Array.from(perf.draw.subarray(0, n)).sort((a, b) => a - b);
  const q = (a, p) => a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2) : 0;
  const out = { frames: perf.n, fps: iv.length ? +(1000 / (iv.reduce((x, y) => x + y, 0) / iv.length)).toFixed(1) : 0,
                iv_p50: q(iv, 0.5), iv_p95: q(iv, 0.95), iv_max: q(iv, 1),
                draw_p50: q(dr, 0.5), draw_p95: q(dr, 0.95), draw_max: q(dr, 1),
                /* Composite time per frame, averaged over the window, and the total: the honest
                   comparison when most frames draw nothing at all and percentiles are measuring
                   two different populations. */
                draw_mean: dr.length ? +(dr.reduce((x, y) => x + y, 0) / dr.length).toFixed(3) : 0,
                draw_sum: +dr.reduce((x, y) => x + y, 0).toFixed(1),
                sync_ms: +perf.syncCost.toFixed(2), path: emulator.pixels.path, guestFrames: emulator.pixels.frames };
  if (reset !== false) { perf.n = 0; perf.syncCost = 0; emulator.pixels.cost = 0; }
  return out;
};
function present() {
  const t0 = performance.now();
  try { presentOnce(); } catch (e) { report("present", e.stack || String(e)); }
  const t1 = performance.now();
  if (perf.last) { const i = perf.n++ % 600; perf.iv[i] = t0 - perf.last; perf.draw[i] = t1 - t0; }
  perf.last = t0;
  perf.syncCost = emulator.pixels.cost;
  frames++;
  const now = performance.now();
  if (now - lastBeat > 15000) {
    lastBeat = now;
    let ic = 0; try { ic = emulator.get_instruction_counter() >>> 0; } catch (e) {}
    const mips = lastIc ? ((ic - lastIc) >>> 0) / (now - lastBeatAt) / 1000 : 0;
    lastIc = ic; lastBeatAt = now;
    report("beat", `frames=${frames} running=${emulator.is_running && emulator.is_running()} vp=${innerWidth}x${innerHeight} mode=${guestDesktop === null ? "?" : guestDesktop ? "D" : "P"}${lastReq ? ` ${lastReq.w}x${lastReq.h}` : ""} layers=${layers.map(l => l.kind + ":" + (l.title || "").slice(0, 14)).join("|")} ready=${desktopReady} mips=${mips.toFixed(1)} pvmon=${shell.ver || "?"} pixels=${emulator.pixels.path} composite=${JSON.stringify(window.pvPerf())}`);
  }
  requestAnimationFrame(present);
}

/* What the guest painted, in guest pixels. The worker reports the rectangle it filled with every
   frame it converts; `guestDirty` is the current composite's rectangle (null when nothing changed)
   and `dirtyGen` counts the composites that carried pixels. The last few hundred rectangles are
   kept with their generation, so anything cached per set of guest pixels can ask "has this
   rectangle changed since generation N" instead of having to be thrown away wholesale.
     pvRectDirty(x,y,w,h)             new pixels in this rectangle in the composite being drawn
     pvRectDirtySince(gen,x,y,w,h)    ... at any point since that generation
   which is what lets a layer whose client area has not changed be skipped instead of re-blitted
   (the drawWindow/placeLayers side of that belongs to the gesture pass; this is the information). */
let guestDirty = null, dirtyGen = 0;
const DIRTY_LOG = 256;
const dirtyLog = new Array(DIRTY_LOG).fill(null);
let dirtyLogAt = 0;
function noteDirty(d) {
  dirtyGen++;
  guestDirty = d;
  dirtyLog[dirtyLogAt++ % DIRTY_LOG] = { gen: dirtyGen, x: d.x, y: d.y, w: d.w, h: d.h };
}
const hits = (r, x, y, w, h) => r.x < x + w && x < r.x + r.w && r.y < y + h && y < r.y + r.h;
function rectDirty(x, y, w, h) { return !!guestDirty && hits(guestDirty, x, y, w, h); }
function rectDirtySince(gen, x, y, w, h) {
  if (gen >= dirtyGen) return false;
  if (dirtyGen - gen > DIRTY_LOG) return true;             // older than the log: assume changed
  for (let i = 1; i <= DIRTY_LOG; i++) {
    const r = dirtyLog[(dirtyLogAt - i + DIRTY_LOG * 2) % DIRTY_LOG];
    if (!r || r.gen <= gen) break;
    if (hits(r, x, y, w, h)) return true;
  }
  return false;
}
/* The rectangles themselves, newest first, for a caller that wants to repaint them rather than
   just ask whether something changed. `all` means "assume the whole screen": either the caller's
   generation has fallen off the end of the ring, or so many rectangles have accumulated that their
   bounding box is the cheaper answer. */
const DIRTY_MAX_RECTS = 24;
function dirtyRectsSince(gen) {
  if (gen >= dirtyGen) return null;                         // nothing new since the caller looked
  if (dirtyGen - gen > DIRTY_LOG) return "all";
  const out = [];
  for (let i = 1; i <= DIRTY_LOG; i++) {
    const r = dirtyLog[(dirtyLogAt - i + DIRTY_LOG * 2) % DIRTY_LOG];
    if (!r || r.gen <= gen) break;
    out.push(r);
    if (out.length > DIRTY_MAX_RECTS) {                     // coalesce: one box beats thirty clips
      let x0 = out[0].x, y0 = out[0].y, x1 = x0 + out[0].w, y1 = y0 + out[0].h;
      for (const q of out) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x + q.w); y1 = Math.max(y1, q.y + q.h); }
      return [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }];
    }
  }
  return out.length ? out : null;
}
window.pvRectDirty = rectDirty;
window.pvRectDirtySince = rectDirtySince;
window.pvDirtyRectsSince = dirtyRectsSince;
window.pvDirty = () => ({ rect: guestDirty, gen: dirtyGen, path: emulator.pixels.path,
                          changes: emulator.pixels.change_count, cost: emulator.pixels.cost });

/* The dialog hole fill and the menu strip's fill sample one guest pixel each. A readback
   (drawImage + getImageData) is the most expensive thing the compositor does, and these points are
   the background of a window that is not repainting: sampled once and remembered until the guest
   paints over that very pixel (the dirty log above), so nothing is read 60 times a second and a
   program that does change its background is still followed exactly. The cache is also dropped
   whenever the guest publishes a new layout, since a dialog that came or went moves the points. */
let sampleCanvas = null;
const sampleCache = new Map();
function dropSampleCache() { sampleCache.clear(); rowCache.clear(); }
function sampleColour(src, x, y) {
  x = Math.round(x); y = Math.round(y);
  const key = (x << 12) ^ y;
  const had = sampleCache.get(key);
  if (had !== undefined && !rectDirtySince(had.gen, x, y, 1, 1)) return had.c;
  if (!sampleCanvas) { sampleCanvas = document.createElement("canvas"); sampleCanvas.width = sampleCanvas.height = 1; }
  const sg = sampleCanvas.getContext("2d", { willReadFrequently: true });
  sg.drawImage(src, x, y, 1, 1, 0, 0, 1, 1);
  const d = sg.getImageData(0, 0, 1, 1).data;
  const col = `rgb(${d[0]},${d[1]},${d[2]})`;
  if (sampleCache.size > 512) sampleCache.clear();
  sampleCache.set(key, { c: col, gen: dirtyGen });
  return col;
}
/* The most common colour along one guest row: the background of a client whose row crosses icons
   and text. One readback of the row, cached exactly like sampleColour above (a handful of rows at
   most, and only while a shell dialog is up). The cache rides on the dirty log where there is one;
   without it the row is read per composite, which is what sampleColour did before the log landed. */
let rowCanvas = null;
const rowCache = new Map();
function dominantColour(src, x, y, w) {
  x = Math.round(x); y = Math.round(y); w = Math.max(1, Math.round(w));
  const key = x + ":" + y + ":" + w;
  const cacheable = typeof rectDirtySince === "function";
  const had = cacheable ? rowCache.get(key) : undefined;
  if (had !== undefined && !rectDirtySince(had.gen, x, y, w, 1)) return had.c;
  if (!rowCanvas) rowCanvas = document.createElement("canvas");
  if (rowCanvas.width < w) rowCanvas.width = w;
  rowCanvas.height = 1;
  const rg = rowCanvas.getContext("2d", { willReadFrequently: true });
  let col = "rgb(255,255,255)";
  try {
    rg.drawImage(src, x, y, w, 1, 0, 0, w, 1);
    const d = rg.getImageData(0, 0, w, 1).data;
    const count = new Map();
    let best = -1, bestN = 0;
    for (let i = 0; i < w; i++) {
      const v = (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];
      const n = (count.get(v) || 0) + 1;
      count.set(v, n);
      if (n > bestN) { bestN = n; best = v; }
    }
    if (best >= 0) col = `rgb(${best >> 16 & 255},${best >> 8 & 255},${best & 255})`;
  } catch (e) { /* empty source rect: keep the default */ }
  if (cacheable) {
    if (rowCache.size > 64) rowCache.clear();
    rowCache.set(key, { c: col, gen: dirtyGen });
  }
  return col;
}
/* drawImage throws on an empty source rectangle; a window can legitimately have one (a zero-size
   client while it is being created), and one throw must never take the render loop down. */
function blit(g, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  g.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
}

/* ------------------------------------------------------------------------- the boot screen
 * This machine does not boot: it restores a 2 MB snapshot of a desktop that was already up. But
 * the restore takes a moment, and a moment of black is the one part of the illusion that says
 * "web page loading" rather than "computer starting". So the host paints a boot screen over it --
 * the logo Windows would have shown, and a progress bar of the kind its own installer used.
 *
 * Host-drawn, and it has to be: there is no guest yet to draw it. It goes on #pres like everything
 * else, so it is inside the safe areas, it is pixel-doubled like the desktop, and with ?lcd=1 it
 * comes up through the same shader -- the boot screen glows and bleeds exactly as the desktop
 * behind it will. A cold boot (?fresh=1) never shows it: that one has a real logo of its own.
 *
 * The bar is Windows 3.1's: a raised outer frame, a sunken well, and square chunks with a gap
 * between them, filling left to right. Nothing is animated for its own sake -- every chunk stands
 * for bytes that have actually arrived. */
const splash = { img: null, tall: null, on: !(params.get("fresh") || params.get("mkstate") || params.get("nosplash")),
                 p: 0, phase: "starting",
                 /* ?splash=1 keeps it up and runs the bar on a loop: the boot screen is over in
                    two seconds on a warm visit, which is no way to look at one you are drawing. */
                 hold: params.get("splash") === "1", doneAt: 0 };
/* Two cuts of the artwork: the 3:4 panel, and a 9:19-ish one drawn for a phone. Both are loaded,
   and the one whose proportions are closer to the viewport's is the one that gets drawn -- a ratio
   comparison rather than a breakpoint, so a tablet in portrait, a phone in landscape and a desktop
   window each get whichever actually fills their shape. */
for (const [key, src] of [["img", "boot-splash.webp"], ["tall", "boot-splash-tall.webp"]]) {
  const img = new Image();
  img.onload = () => { splash[key] = img; };
  img.src = src;
}
function splashArt(vw, vh) {
  const a = splash.img, b = splash.tall;
  if (!a) return b || null;
  if (!b) return a;
  const fit = im => Math.abs(Math.log((im.height / im.width) / (vh / vw)));
  return fit(b) < fit(a) ? b : a;
}
/* Progress only ever goes forward: the phases below overlap in time (a local snapshot arrives
   while the shipped one is still being fetched) and a bar that went backwards would be worse than
   no bar at all. */
function bootAt(p, phase) {
  if (p > splash.p) splash.p = Math.min(1, p);
  if (phase) splash.phase = phase;
}
/* The last stretch has nothing to measure: the guest is running and the host is waiting for PVMON
   to say the desktop is arranged. Creep towards 0.99 over the couple of seconds that usually
   takes, and let desktopReady snap it to full. */
let splashCreepFrom = 0;
function splashProgress() {
  if (splash.hold) return ((performance.now() - pageStart) % 6000) / 6000;
  if (desktopReady) return 1;
  if (splash.p >= 0.9 && splashCreepFrom) {
    const t = Math.min(1, (performance.now() - splashCreepFrom) / 2500);
    return Math.min(0.99, 0.9 + 0.09 * t);
  }
  return splash.p;
}

function drawChunkBar(g, x, y, w, h, p) {
  const u = Math.max(1, Math.round(h / 26));            // the frame's line weight, at this size
  const R = (xx, yy, ww, hh, c) => { g.fillStyle = c; g.fillRect(xx, yy, ww, hh); };
  const BLACK = "#000", WHITE = "#fff", FACE = "#c0c0c0", SHADOW = "#808080", BLUE = "#0000ff";
  R(x, y, w, h, FACE);
  R(x, y, w, u, BLACK); R(x, y, u, h, BLACK);                                   // outer rule
  R(x, y + h - u, w, u, BLACK); R(x + w - u, y, u, h, BLACK);
  let i = x + u, j = y + u, iw = w - 2 * u, ih = h - 2 * u;
  R(i, j, iw, u, WHITE); R(i, j, u, ih, WHITE);                                 // raised
  R(i, j + ih - u, iw, u, SHADOW); R(i + iw - u, j, u, ih, SHADOW);
  i += u; j += u; iw -= 2 * u; ih -= 2 * u;
  R(i, j, iw, u, SHADOW); R(i, j, u, ih, SHADOW);                               // sunken well
  R(i, j + ih - u, iw, u, WHITE); R(i + iw - u, j, u, ih, WHITE);
  i += u; j += u; iw -= 2 * u; ih -= 2 * u;
  R(i, j, iw, ih, FACE);
  /* Chunks. The control this is copied from makes them a little over a third of their height;
     these are half again as wide as that, which reads better at the size the boot screen uses.
     The gap is off the well's height rather than the chunk's, so widening the chunks packs the
     bar rather than spreading it. */
  const cw = Math.max(2, Math.round(ih * 0.585)), gap = Math.max(1, Math.round(ih * 0.12));
  const n = Math.max(1, Math.floor((iw + gap) / (cw + gap)));
  const filled = Math.round(p * n);
  for (let k = 0; k < filled; k++) R(i + k * (cw + gap), j, cw, ih, BLUE);
}

function drawBootSplash(g, vw, vh) {
  /* Black around the artwork, not the artwork's own blue: the panel is a picture on the screen,
     and the screen is off apart from it. */
  g.fillStyle = "#000";
  g.fillRect(0, 0, vw, vh);
  const img = splashArt(vw, vh);
  if (!img) return;                                     // still decoding: the field alone, not black
  const pad = Math.round(Math.min(vw, vh) * 0.05);
  /* The bar belongs to the panel above it, not to the window. Sized off the viewport it collapsed
     to a hairline on anything wide and short -- the artwork is fitted to the HEIGHT there, so the
     panel is small while the viewport is not, and a bar scaled to the viewport had chunks two
     pixels wide. Sized off the artwork's own drawn width it keeps its weight at every shape.
     Two passes, because the artwork's size depends on the room the bar leaves and the bar's size
     depends on the artwork; one round trip is enough to settle it. */
  let barH = Math.max(14, Math.round(Math.min(vw, vh) * 0.05)), dw = 0, dh = 0;
  for (let pass = 0; pass < 2; pass++) {
    const availW = vw - 2 * pad, availH = vh - 2 * pad - Math.round(barH * 1.4) - barH;
    const sc = Math.min(availW / img.width, availH / img.height);
    dw = Math.round(img.width * sc); dh = Math.round(img.height * sc);
    barH = Math.max(14, Math.min(36, Math.round(dw * 0.075)));
  }
  const gapH = Math.round(barH * 1.4);
  const top = Math.round((vh - (dh + gapH + barH)) / 2);
  g.drawImage(img, Math.round((vw - dw) / 2), top, dw, dh);
  drawChunkBar(g, Math.round((vw - dw) / 2), top + dh + gapH, dw, barH, splashProgress());
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
/* ------------------------------------------------------------- composite only what changed */
/* The compositor is a stack: the desktop column, then every layer back to front, and until now
   all of it was re-blitted on every one of the 60 frames a second whether anything had moved or
   not. The worker says exactly which guest pixels changed (the dirty ring above), so a frame can
   instead repaint only the regions that need it.
 *
 * Structure: the visible canvas IS the persistent composite. A 2D canvas keeps its pixels between
 * frames (only a resize clears the backing store), so the frame that repaints nothing draws
 * nothing; whatever is on screen is already right. An offscreen canvas holding the composite,
 * blitted to the visible one each frame, was the other candidate and was rejected: it would add a
 * full-viewport copy — 1125x2436 = 2.7 M pixels at the phone's dpr 3 — to every frame, which is
 * several times the entire composite it is meant to save, and it buys nothing, because the visible
 * canvas already has exactly the retention an offscreen one would provide.
 *
 * Per-layer skipping alone (draw a layer only when its own pixels changed) is NOT correct, because
 * layers overlap: a repaint of a layer underneath would show through the one above it. So the unit
 * is a damage region, not a layer:
 *
 *   1. Every frame still runs chooseView() and placeLayers() — they are pure arithmetic plus the
 *      side effects the rest of the page relies on (shell sizing, pan clamps, first placements).
 *   2. Damage is accumulated in host pixels from: the guest rectangles that changed since each
 *      piece was last drawn, mapped through that piece's own mapping (the desktop's view, a
 *      layer's chrome bands, a layer's client at its zoom); a layer whose placement signature
 *      changed (moved, resized, re-scaled, zoomed, panned, its masked holes moved) damages both
 *      where it was and where it now is; and anything structural — the viewport, the safe areas,
 *      the shell column's pan, the keyboard shift, the layer set or its z-order, a canvas resize,
 *      a mode change — damages the whole viewport, which is the old behaviour for that one frame.
 *   3. The damage rectangles become the clip, and the stack is redrawn inside it, bottom up: the
 *      desktop slice (per damage rectangle, so the blit is small), the shell-dialog masks, then
 *      every layer whose rectangle meets the damage. Rebuilding the stack from the bottom is what
 *      makes it correct — nothing has to reason about what covers or uncovers what, because the
 *      region is composited from scratch exactly as a full frame would have been.
 *   4. A layer whose rectangle does not meet the damage is not drawn at all: that is the "skip"
 *      the dirty rectangles were published for, and chrome and client are separate sources, so a
 *      client-only repaint costs one small client blit and no nine-slice work.
 *
 * An idle desktop therefore costs nothing but the dirty-ring lookups, and a repainting window
 * costs its own client area rather than every window on screen.
 */
const comp = { frames: 0, empty: 0, full: 0, dmgPx: 0, viewPx: 0, draws: 0, skips: 0, bg: 0, pieces: 0, pieceSkips: 0, planMs: 0 };
window.pvComposite = reset => {
  const f = Math.max(1, comp.frames);
  const out = { frames: comp.frames, empty: comp.empty, empty_pct: +(100 * comp.empty / f).toFixed(1),
                full: comp.full, damage_pct: +(100 * comp.dmgPx / Math.max(1, comp.viewPx)).toFixed(1),
                skipped: +(100 * comp.skips / Math.max(1, comp.skips + comp.draws)).toFixed(1),
                pieces_skipped: +(100 * comp.pieceSkips / Math.max(1, comp.pieces)).toFixed(1),
                blits_per_frame: +((comp.draws + comp.bg) / f).toFixed(2),
                plan_ms: +(comp.planMs / f).toFixed(4) };
  if (reset !== false) { comp.frames = comp.empty = comp.full = comp.dmgPx = comp.viewPx = comp.draws = comp.skips = comp.bg = comp.pieces = comp.pieceSkips = comp.planMs = 0; }
  return out;
};
/* A closing window's rectangle, held out of the composite until something real paints there.
   Windows erases to the desktop colour first and repaints from behind ~200 ms later; drawing the
   erase is the flash. While a hold is live the region is composited from the pixels of the frame
   before the erase, which the visible canvas still has, so the window appears to stay until its
   replacement is ready. Deadline so a hold can never wedge the composite. */
const holds = [];
const CLOSE_HOLD_MS = 400;
function holdRegion(gx, gy, gw, gh) {
  holds.push({ gx, gy, gw, gh, until: performance.now() + CLOSE_HOLD_MS, gen: dirtyGen });
  diag(`hold ${gw}x${gh} at ${gx},${gy} (closing window)`);
}
/* A hold ends when its deadline passes or when the guest has painted inside it since it started
   — that paint is the window behind coming back, which is what we were waiting for. */
function liveHolds() {
  const now = performance.now();
  for (let i = holds.length - 1; i >= 0; i--) {
    const H = holds[i];
    if (now > H.until || rectDirtySince(H.gen, H.gx, H.gy, H.gw, H.gh)) holds.splice(i, 1);
  }
  return holds;
}
/* Anything the compositor cannot see for itself says so here: the next frame is a full one. */
let needFull = true;
function invalidate() { needFull = true; }
window.pvInvalidate = invalidate;
window.pvPlanSums = () => [planA, planB, needFull];
const layerGen = new Map();             // layer key -> the dirty generation it was last drawn at
let lastBgGen = -1, lastPlanA = NaN, lastPlanB = NaN;

/* Whether anything about the layout has moved since the last frame, as two running numbers rather
   than a signature string per layer: at 60 Hz on a phone, formatting thirty numbers per layer per
   frame costs more than the blits the whole exercise is meant to save. Every host-side placement
   input (a drag, a pinch, a menu pan, the shell pan, a new guest layout) calls invalidate() as
   well, so this is the backstop that catches anything that forgets to — a changed sum means a full
   frame, which is exactly what the compositor did before this pass. */
function planSums(vw, vh, shift) {
  /* Not every layer carries every field (a transient has no client scale, the shell copy no
     insets), and one `undefined` would make the whole sum NaN — which never compares equal, so
     every frame would be a full one. Missing means zero here. */
  const n = v => (v || 0);
  let a = vw + 3 * vh + 5 * n(safe.l) + 7 * n(safe.t) + 11 * n(shift) + 13 * placed.length;
  let b = n(view.x) + 3 * n(view.y) + 5 * n(view.w) + 7 * n(view.h) + 11 * n(view.scale) + 13 * n(view.ox);
  for (let i = 0; i < placed.length; i++) {
    const w = placed[i], k = i + 2;
    a += k * (n(w.x) + 3 * n(w.y) + 5 * n(w.hw) + 7 * n(w.hh) + 11 * n(w.wx) + 13 * n(w.wy) + 17 * n(w.ww) + 19 * n(w.wh));
    b += k * (n(w.gx) + 3 * n(w.gy) + 5 * n(w.gw) + 7 * n(w.gh) + 11 * n(w.zs) + 13 * n(w.px) + 17 * n(w.py) +
              19 * n(w.mpan) + 23 * n(w.c) + 29 * n(w.hl) + 31 * n(w.ht) + 37 * n(w.hb) + 41 * n(w.hr) +
              43 * n(w.capRow) + 47 * n(w.menuRow) + 53 * n(w.vw) + 59 * n(w.vh));
  }
  planA = a; planB = b;
}
let planA = 0, planB = 0;
/* The pieces of a window's frame, each with the guest rectangle it comes from: a repaint inside
   the client area must not drag the nine-sliced chrome through drawWindow again, and a caption
   that redraws (a title change, an activation) must not repaint the client. Written into a reused
   array of six slots, since this runs for every layer of every frame that carries new pixels. */
const BANDS = [];
for (let i = 0; i < 6; i++) BANDS.push({ sx: 0, sy: 0, sw: 0, sh: 0, x: 0, y: 0, w: 0, h: 0 });
function chromeBands(w, y0) {
  const { inset, capRow, menuRow, hl, ht, hb } = w;
  const c = w.c, capH = Math.round(capRow * c), hr = w.hr == null ? hl : w.hr, ir = inset.r == null ? inset.l : inset.r;
  let n = 0;
  const put = (sx, sy, sw, sh, x, y, ww, hh) => { const b = BANDS[n++]; b.sx = sx; b.sy = sy; b.sw = sw; b.sh = sh; b.x = x; b.y = y; b.w = ww; b.h = hh; };
  put(w.wx, w.wy, w.ww, capRow, w.x, y0, w.hw, capH);
  if (menuRow > 0 && ht - capH > 0)
    put(w.wx + inset.l, w.wy + capRow, Math.max(1, w.ww - 2 * inset.l), menuRow, w.x + hl, y0 + capH, w.hw - 2 * hl, ht - capH);
  if (hl > 0) {
    put(w.wx, w.wy + capRow, inset.l, Math.max(1, w.wh - capRow - inset.b), w.x, y0 + capH, hl, w.hh - capH - hb);
    put(w.wx + w.ww - ir, w.wy + capRow, Math.max(1, ir), Math.max(1, w.wh - capRow - inset.b), w.x + w.hw - hr, y0 + capH, hr, w.hh - capH - hb);
  }
  if (hb > 0)
    put(w.wx, w.gy + w.gh, w.ww, Math.max(1, inset.b), w.x, y0 + ht + w.ch, w.hw, hb);
  return n;
}
/* The damage for this frame, in host pixels inside the safe rectangle (layers already shifted by
   the keyboard pan). null means "nothing to draw"; `full` means "everything", the old behaviour. */
const dmgRects = [];
const rectsByGen = new Map();                 // this frame's dirtyRectsSince answers, by generation
function planDamage(vw, vh, shift) {
  const rects = dmgRects;
  rects.length = 0;
  const add = (x, y, w, h) => {
    const x0 = Math.max(0, Math.floor(x) - 1), y0 = Math.max(0, Math.floor(y) - 1);
    const x1 = Math.min(vw, Math.ceil(x + w) + 1), y1 = Math.min(vh, Math.ceil(y + h) + 1);
    if (x1 > x0 && y1 > y0 && !inHold(x0, y0, x1 - x0, y1 - y0)) rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  };
  const mapInto = (src, sx, sy, sw, sh, dx, dy, kx, ky) => {
    for (const r of src) {
      const x0 = Math.max(sx, r.x), y0 = Math.max(sy, r.y);
      const x1 = Math.min(sx + sw, r.x + r.w), y1 = Math.min(sy + sh, r.y + r.h);
      if (x1 > x0 && y1 > y0) add(dx + (x0 - sx) * kx, dy + (y0 - sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
    }
  };
  const since = gen => {                      // layers drawn together share a generation
    if (rectsByGen.has(gen)) return rectsByGen.get(gen);
    const r = dirtyRectsSince(gen);
    rectsByGen.set(gen, r);
    return r;
  };
  /* A closing window's rectangle is held: the guest is erasing it to the desktop colour and the
     window behind will not repaint for another ~200 ms, so we keep what is already on the canvas
     there rather than compositing the erase. `add` drops anything inside a live hold. */
  const held = liveHolds();
  const heldHost = held.length ? held.map(H => {
    const x = view.ox + (H.gx - view.x) * view.scale, y = (H.gy - view.y) * view.scale;
    return { x, y, w: H.gw * view.scale, h: H.gh * view.scale };
  }) : null;
  const inHold = (x, y, w, h) => heldHost && heldHost.some(r =>
    x >= r.x - 1 && y >= r.y - 1 && x + w <= r.x + r.w + 1 && y + h <= r.y + r.h + 1);
  planSums(vw, vh, shift);
  const moved = planA !== lastPlanA || planB !== lastPlanB;
  lastPlanA = planA; lastPlanB = planB;
  if (needFull || moved) { comp.full++; return { rects: [{ x: 0, y: 0, w: vw, h: vh }], full: true }; }
  if (dirtyGen === lastBgGen) return null;    // nothing moved and the guest painted nothing

  rectsByGen.clear();
  // the desktop column: the guest's own pixels under everything
  const bg = since(lastBgGen);
  if (bg === "all") { comp.full++; return { rects: [{ x: 0, y: 0, w: vw, h: vh }], full: true }; }
  if (bg) {
    mapInto(bg, view.x, view.y, view.w, view.h, view.ox, 0, view.scale, view.scale);
    // a shell dialog drawn as a layer is masked out of the column with a stretched desktop row;
    // that fill moves with the column's pixels, so any change inside the column repaints it
    for (const w of placed) if (w.shellDialog) add(view.ox + (w.wx - view.x) * view.scale, (w.wy - view.y) * view.scale,
                                                   w.ww * view.scale, w.wh * view.scale);
  }
  for (let i = 0; i < placed.length; i++) {
    const w = placed[i], y0 = w.y - shift;
    const gen = layerGen.get(w.key);
    if (gen === undefined) { add(w.x, y0, w.hw, w.hh); continue; }      // never drawn before
    const src = since(gen);
    if (src === "all") { add(w.x, y0, w.hw, w.hh); continue; }
    if (!src) continue;                                                // its own pixels are untouched
    if (w.transient || w.shellCopy) {                                  // one blit of the whole window
      mapInto(src, w.wx, w.wy, w.ww, w.wh, w.x, y0, w.hw / Math.max(1, w.ww), w.hh / Math.max(1, w.wh));
      continue;
    }
    const n = chromeBands(w, y0);
    for (let j = 0; j < n; j++) {
      const b = BANDS[j];
      for (const r of src) if (hits(r, b.sx, b.sy, b.sw, b.sh)) { add(b.x, b.y, b.w, b.h); break; }
    }
    mapInto(src, w.gx + w.px, w.gy + w.py, w.vw, w.vh, w.x + w.hl, y0 + w.ht, w.zs, w.zs);
  }
  if (!rects.length) return null;
  let area = 0;
  for (const r of rects) area += r.w * r.h;
  // many small pieces, or so much of the screen that the clip is not paying for itself: one box
  if (rects.length > 12 || area > 0.6 * vw * vh) {
    let x0 = rects[0].x, y0 = rects[0].y, x1 = x0 + rects[0].w, y1 = y0 + rects[0].h;
    for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    return { rects: [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }], full: false };
  }
  return { rects, full: false };
}

/* ------------------------------------------------------------------- app switcher (SPEC iOS) */
/* An iOS-style card switcher, entered by a swipe up from the bottom edge (bottomStart/bottomMove,
   with the touch pipeline below). Every card is a live scaled copy of a window's own pixels --
   its real frame and client, straight out of the guest frame buffer -- so the switcher never asks
   the guest to draw anything it would not have drawn anyway, and never draws a pixel of its own.
   `pos` is a float card index eased toward `target` once a frame (see the `if (switcher)` branch
   in presentOnce below); it is set equal to `target` while a finger is actively panning, so the
   easing only shows once a drag lets go and the strip settles onto the nearest card. */
let switcher = null;   // { cards, pos, target, drag } while open, null otherwise

/* Every real window, reversed so the front-most one -- the one an ordinary edge swipe would have
   raised -- is card 0, under the finger where the switcher opened. The shell has no "W" layer of
   its own but is always represented, addressed the same way the right-edge cycle addresses it:
   SHELL_SCROLL_SLOT. */
function switcherCards() {
  return layers.filter(L => (L.kind === "W" || L.kind === "S") && L.ww > 0 && L.wh > 0)
               .map(L => ({ L, slot: L.kind === "S" ? SHELL_SCROLL_SLOT : L.slot, title: L.title, lift: 0 }))
               .reverse();
}

function switcherBox(vw, vh) { return { boxW: Math.round(vw * 0.72), boxH: Math.round(vh * 0.58) }; }

/* Where every card sits this frame. Cards are not all the same width -- each one is its own
   window scaled to fit the box, and a tall narrow window comes out much narrower than a squat one
   -- so a fixed pitch either overlapped two wide cards or left a chasm between two narrow ones.
   The strip is laid out from the cards' real widths instead, each separated from the next by
   SW_GAP, and `pos` interpolates between card centres: card 0 centred is pos 0, and half way
   between cards 0 and 1 is pos 0.5, whatever the two of them measure. */
const SW_GAP = 22;
function switcherLayout(vw, vh) {
  const { boxW, boxH } = switcherBox(vw, vh);
  const out = switcher.cards.map(card => {
    const s = Math.min(1, boxW / card.L.ww, boxH / card.L.wh);
    return { card, dw: Math.round(card.L.ww * s), dh: Math.round(card.L.wh * s), strip: 0, cx: 0 };
  });
  let x = 0;
  for (const e of out) { e.strip = x + e.dw / 2; x += e.dw + SW_GAP; }
  if (!out.length) return out;
  const p = Math.max(0, Math.min(out.length - 1, switcher.pos));
  const i0 = Math.floor(p), i1 = Math.min(out.length - 1, i0 + 1);
  const focus = out[i0].strip + (out[i1].strip - out[i0].strip) * (p - i0);
  for (const e of out) e.cx = vw / 2 + e.strip - focus;
  return out;
}
/* How many host pixels a finger drags for one card of travel, at the strip's current position:
   the distance between the two cards the pan is between. */
function switcherPitch(vw, vh) {
  const L = switcherLayout(vw, vh);
  if (L.length < 2) return Math.max(1, switcherBox(vw, vh).boxW);
  const i0 = Math.max(0, Math.min(L.length - 2, Math.floor(switcher.pos)));
  return Math.max(1, L[i0 + 1].strip - L[i0].strip);
}

/* Which card, if any, sits under a host point: used on the way down to decide whether a
   subsequent drag lifts a particular card or just pans the strip. The slots overlap, so a point
   can fall in two of them; the nearer one to the centre wins, which is the one drawn on top. */
function switcherCardAt(px, py, vw, vh) {
  const L = switcherLayout(vw, vh);
  let best = -1;
  for (let i = 0; i < L.length; i++) {
    const e = L[i], top = vh / 2 - e.dh / 2 - e.card.lift;
    if (px >= e.cx - e.dw / 2 && px <= e.cx + e.dw / 2 && py >= top && py <= top + e.dh)
      if (best < 0 || Math.abs(i - switcher.pos) < Math.abs(best - switcher.pos)) best = i;
  }
  return best;
}

/* Draws the desktop exactly as presentOnce always has, then every card on top of it, back to
   front so the centred card -- the one nearest `pos`, which a tap or a release lands on -- is
   drawn last. A card is its window's own frame and client scaled to fit the box, never magnified
   past 1: blowing a window's pixels up past their own size would be the host inventing detail the
   guest never painted. */
/* The cards are re-read from the layer list every frame: a program that repaints, resizes, or
   closes itself while the switcher is open would otherwise be drawn from the rectangle it had
   when the switcher opened -- live pixels at a stale address. A card keeps its lift (a finger is
   flicking it away) and the strip keeps its position when nothing has come or gone. */
function refreshCards() {
  const now = switcherCards();
  if (now.length === switcher.cards.length && now.every((c, i) => c.slot === switcher.cards[i].slot)) {
    for (let i = 0; i < now.length; i++) now[i].lift = switcher.cards[i].lift;
  } else if (!now.length) { closeSwitcher(); return false; }
  else switcher.target = Math.max(0, Math.min(now.length - 1, Math.round(switcher.target)));
  switcher.cards = now;
  return true;
}

function drawSwitcher(g, src, vw, vh) {
  /* Behind the cards, the desktop's own colour and nothing else. Drawing the desktop slice itself
     showed Program Manager twice -- once as the backdrop, once as its own card -- which read as
     the shell being missing from the switcher. The colour is sampled from a bare corner of the
     guest desktop, the same way a masked hole is filled, so the backdrop is still a colour
     Windows chose. */
  g.fillStyle = sampleColour(src, src.width - 6, src.height - 6);
  g.fillRect(0, 0, vw, vh);
  const L = switcherLayout(vw, vh);
  const order = L.map((e, i) => i)
    .sort((a, b) => Math.abs(b - switcher.pos) - Math.abs(a - switcher.pos));   // farthest first, centred card last
  for (const i of order) {
    const e = L[i], card = e.card;
    if (e.cx + e.dw / 2 < 0 || e.cx - e.dw / 2 > vw) continue;   // fully off-screen: nothing to draw
    const dx = Math.round(e.cx - e.dw / 2), dy = Math.round(vh / 2 - e.dh / 2 - card.lift);
    blit(g, src, card.L.wx, card.L.wy, card.L.ww, card.L.wh, dx, dy, e.dw, e.dh);
  }
}

/* Leaving the switcher always costs a full repaint: none of the ordinary compositor's per-layer
   damage bookkeeping applies to a stack of scaled snapshots that were never really layers. */
function closeSwitcher() {
  switcher = null;
  needFull = true;
  diag("switcher closed");
}

function presentOnce() {
  /* One place where guest pixels reach this thread: the rows the worker says changed are copied
     out of shared memory (or drawn from the ImageBitmaps it transferred) into the source canvas.
     Everything below draws slices of that canvas. */
  const dirty = emulator.pixels.sync();
  guestDirty = null;
  if (dirty) { wd.lastChange = performance.now(); wd.frameSig = emulator.pixels.change_count; noteDirty(dirty); }
  const src = guestCanvas;
  const pres = $("pres");
  if (!pres) return;
  const [fw, fh] = fullViewport();
  const [vw, vh] = viewport();
  const dpr = window.devicePixelRatio || 1;
  if (pres.width !== Math.round(fw * dpr) || pres.height !== Math.round(fh * dpr)) {
    pres.width = Math.round(fw * dpr); pres.height = Math.round(fh * dpr);
    pres.style.width = fw + "px"; pres.style.height = fh + "px";
    needFull = true;                                     // a resize clears the backing store
  }
  const g = pres.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  /* The simulated phone's bezel: a hairline around the live area so the frame reads as a device
     sitting on the desk rather than a window that failed to fill its space. Drawn every frame and
     outside the safe box, so no composite can paint over it and no partial repaint can lose it. */
  const PF = phoneFrame();
  if (PF) {
    g.strokeStyle = "#3a3a3c";
    g.lineWidth = 1;
    g.strokeRect(PF.l - 0.5, PF.t - 0.5, PF.w + 1, PF.h + 1);
    g.strokeStyle = "#111";
    g.strokeRect(PF.l - 4.5, PF.t - 4.5, PF.w + 9, PF.h + 9);
  }
  /* The boot screen owns the frame until PVMON says the desktop is arranged, and then for a
     fifth of a second longer -- long enough for the last chunks to land, so the bar is seen full
     rather than cut away at ninety-something. The timeout is the escape hatch: a guest that never
     reports in should show whatever it has rather than a bar that never fills. */
  if (splash.on) {
    if (desktopReady && !splash.doneAt) splash.doneAt = performance.now();
    const now = performance.now();
    const keep = splash.hold ||
                 (now - pageStart < 25000 && (!splash.doneAt || now - splash.doneAt < 200));
    if (keep) {
      g.fillStyle = "#000"; g.fillRect(0, 0, fw, fh);
      g.translate(safe.l, safe.t);
      drawBootSplash(g, vw, vh);
      needFull = true;
      lcdFrame(true);
      return;
    }
    splash.on = false;
    needFull = true;                                   /* the whole viewport is the boot screen's */
    report("splash", `boot screen shown for ${Math.round(now - pageStart)}ms`);
  }
  const guestUp = src && src.width && (desktopReady || !firstFrame || performance.now() > firstFrameUntil);
  if (!guestUp && firstFrame) {
    g.fillStyle = "#000"; g.fillRect(0, 0, fw, fh);
    g.translate(safe.l, safe.t);
    drawFirstFrame(g, vw, vh);
    needFull = true;                                     // the guest's own first frame is a full one
    return;
  }
  if (src && src.width) {
    view = chooseView(src);
    /* The switcher owns the whole frame while it is open: draw it here and return before any of
       the ordinary per-layer damage planning runs, since a stack of scaled card snapshots is not
       the layer stack that planning reasons about. */
    if (switcher) {
      if (!refreshCards()) { needFull = true; return; }
      switcher.pos += (switcher.target - switcher.pos) * 0.25;
      g.fillStyle = "#000"; g.fillRect(0, 0, fw, fh);
      g.save();
      g.translate(safe.l, safe.t);
      drawSwitcher(g, src, vw, vh);
      g.restore();
      needFull = true;
      return;
    }
    /* Until the shell has been arranged, show the whole guest screen (DOS, the Windows logo)
       rather than the desktop column: the user should not watch Program Manager being resized,
       and nothing drawn here is ever the host's own. A long timeout guards a guest that never
       reports in. */
    if (narrow() && !desktopReady && performance.now() - pageStart < 90000) {
      const sc = Math.min(vw / src.width, vh / src.height);
      view = { x: 0, y: 0, w: src.width, h: src.height, scale: sc, ox: Math.round((vw - src.width * sc) / 2) };
    }
    placed = narrow() ? placeLayers(src) : [];
    const shift = keyboardShift();
    frameNo++;
    const tPlan = performance.now();
    const dmg = planDamage(vw, vh, shift);
    comp.planMs += performance.now() - tPlan;
    comp.frames++;
    comp.viewPx += vw * vh;
    if (!dmg) { comp.empty++; lcdFrame(false); return; }   // nothing changed: the canvas is already right
    for (const r of dmg.rects) comp.dmgPx += r.w * r.h;
    /* Safe areas and letterbox. On the desktop the leftovers are the few columns the mode
       rounding leaves and whatever a half-finished resize has uncovered, and next to a Windows
       desktop black reads as a fault: they take the desktop's own colour instead. */
    if (dmg.full) {
      g.fillStyle = narrow() ? "#000" : sampleColour(src, src.width - 6, src.height - 6);
      g.fillRect(0, 0, fw, fh);
    }
    g.save();
    g.translate(safe.l, safe.t);                         // everything else in the safe rectangle
    /* A full frame takes no clip at all: it is the old compositor exactly, and a clip that covers
       everything is cost without a saving. */
    if (!dmg.full) {
      g.beginPath();
      for (const r of dmg.rects) g.rect(r.x, r.y, r.w, r.h);
      g.clip();
    }
    /* The desktop. The whole slice is handed to drawImage exactly as it always was, and the clip
       does the trimming: the rasterizer only fills the damaged part, and every pixel lands on the
       same sample it would have in a full frame. Blitting a sub-rectangle instead would be
       cheaper to describe but not pixel-identical — a nearest-neighbour source rectangle rounded
       to whole guest pixels shifts the sampling grid by a fraction of a pixel, which on the
       desktop's dithered background is a visible difference against the region beside it. */
    const dw = view.w * view.scale, dh = view.h * view.scale;
    blit(g, src, view.x, view.y, view.w, view.h, view.ox, 0, Math.round(dw), Math.round(dh));
    comp.bg++;
    maskShellDialogCopies(g, src);
    /* Damage test in the layers' own coordinates (the keyboard pan is a translate, so a piece at
       host y is compared at y - shift). drawWindow uses it per piece of chrome. */
    const meets = dmg.full ? null : (x, y, ww, hh) => {
      const y0 = y - shift;
      comp.pieces++;
      for (const r of dmg.rects) if (r.x < x + ww && x < r.x + r.w && r.y < y0 + hh && y0 < r.y + r.h) return true;
      comp.pieceSkips++;
      return false;
    };
    if (shift) g.translate(0, -shift);
    for (let i = 0; i < placed.length; i++) {             // back to front, damage only
      const w = placed[i];
      if (meets && !meets(w.x, w.y, w.hw, w.hh)) { comp.skips++; continue; }   // its generation stands
      drawWindow(g, src, w, meets);
      comp.draws++;
      layerGen.set(w.key, dirtyGen);
    }
    if (shift) g.translate(0, shift);
    g.restore();
    /* Everything the guest had painted is now on the canvas, so the next frame's questions start
       from this generation. A drawn layer is complete: every dirty rectangle of its own was part
       of the damage, so nothing of it was left behind the clip. */
    lastBgGen = dirtyGen;
    needFull = false;
    composeForGuest(vw, vh);
    lcdFrame(true);
    for (const k of layerGen.keys()) if (!placed.some(w => w.key === k)) layerGen.delete(k);
    /* "Has the guest painted?" used to be a per-frame getImageData of two dozen source rows.
       The worker now says exactly which rows changed, so the signature is its running count of
       dirty regions (set above, in sync()) and the readback is gone. */
  }
}
requestAnimationFrame(present);
window.pvPresent = present;
window.pvSplash = splash;
window.pvGuestCursor = () => guestCursor;

/* The composite for the guest (?compose=1). The frame buffer stopped being a picture of the
   screen when windows moved into tiles: what the user sees is this arrangement of them, and it
   exists only on the canvas, where nothing inside the guest can reach it. So the same arrangement
   is sent to the adapter, which blits it into video memory past the visible screen -- somewhere
   Windows never paints -- for anything in the guest that wants to read the screen back: a capture,
   a thumbnail, a program composing its own view. Each layer is one blit of its whole window
   rectangle, so the composite is very slightly coarser than the canvas, where chrome and client
   are drawn at their own scales.

   Off by default: nothing in the guest reads it yet, and it costs a message and a few blits per
   changed frame. */
const composeWanted = params.get("compose") === "1";
let composeSized = 0;
function composeForGuest(vw, vh) {
  if (!composeWanted || !placed.length) return;
  const key = vw * 65536 + vh;
  if (composeSized !== key) { emulator.bus.send("pv-composite-size", [Math.round(vw), Math.round(vh)]); composeSized = key; }
  const list = [{ sx: view.x, sy: view.y, sw: view.w, sh: view.h,
                  dx: Math.round(view.ox), dy: 0,
                  dw: Math.round(view.w * view.scale), dh: Math.round(view.h * view.scale) }];
  for (const w of placed) {
    if (w.shellCopy) continue;                      // the column is already the background above
    list.push({ sx: w.wx, sy: w.wy, sw: w.ww, sh: w.wh, dx: w.x, dy: w.y, dw: w.hw, dh: w.hh });
  }
  emulator.bus.send("pv-compose", list);
}

/* ------------------------------------------------------------------------- the modem ------
   The guest's internet arrives down COM1 (web/net.js explains the whole arrangement): the guest
   runs a Winsock over SLIP, the host is the terminal server at the other end of the cable, and
   the real request is made off-device by /api/fetch, which can do TLS and is not subject to the
   other site's CORS policy the way this page is.

   ?net=0 leaves the port silent, which is what a guest with no Winsock installed should see. */
let slipNet = null, slipBytes = { in: 0, out: 0 }, slipReqs = 0;
function initNet() {
  if (params.get("net") === "0") return null;
  /* The PV socket's host half, and the fast path. A handle opened on a URL is fetched at once; a
     handle opened on a host:port waits for the guest to send a request and is fetched once that
     request is complete -- HTTP/1.0's own rule for where a request ends. Either way the host does
     the DNS, the TCP and the TLS, and the reply becomes the handle's read stream, so a program
     that knows about the device and a Winsock program that does not are served by the same code. */
  const pvSocks = [];
  const pvFetch = async (handle, url) => {
    slipReqs++;
    const full = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    diag(`net: pvsock ${full}`);
    report("net", `pvsock ${full}`);
    let head, body;
    try {
      const r = await fetch(`/api/fetch?url=${encodeURIComponent(full)}`);
      body = new Uint8Array(await r.arrayBuffer());
      const status = r.headers.get("x-upstream-status") || String(r.status);
      const type = r.headers.get("content-type") || "text/html";
      head = `HTTP/1.0 ${status} ${r.ok ? "OK" : "Error"}\r\nContent-Type: ${type}\r\n` +
             `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    } catch (e) {
      body = Uint8Array.from(`${url}: ${e && e.message}`, c => c.charCodeAt(0) & 0xFF);
      head = `HTTP/1.0 502 Gateway\r\nContent-Type: text/plain\r\n\r\n`;
    }
    const out = new Uint8Array(head.length + body.length);
    for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i) & 0xFF;
    out.set(body, head.length);
    slipBytes.out += out.length;
    emulator.bus.send("pv-sock-data", { handle, bytes: out, done: true });
  };
  emulator.bus.register("pv-sock-open", d => {
    const h = d.handle | 0;
    /* A target that starts with "/" is this site's own: the guest has no idea what host it is
       being served from (and must not -- a preview deployment and production are the same disk
       image), so the host resolves its own origin. Anything else is a URL or a host:port and is
       treated exactly as before. */
    let target = d.target || "";
    if (target.charAt(0) === "/") target = location.origin + target;
    pvSocks[h] = { target, req: "", sent: false };
    if (/:\/\//.test(target)) { pvSocks[h].sent = true; pvFetch(h, target); }
  });
  emulator.bus.register("pv-sock-send", d => {
    const h = d.handle | 0, k = pvSocks[h];
    if (!k || k.sent) return;
    k.req += String.fromCharCode(...d.bytes);
    if (!k.req.includes("\r\n\r\n") && !k.req.includes("\n\n")) return;
    k.sent = true;
    const m = /^([A-Z]+) (\S+)/.exec(k.req);
    const hostHdr = /host:\s*(\S+)/i.exec(k.req);
    const host = (hostHdr && hostHdr[1]) || k.target.split(":")[0];
    const path = m ? m[2] : "/";
    pvFetch(h, /^https?:\/\//i.test(path) ? path : `http://${host}${path.startsWith("/") ? "" : "/"}${path}`);
  });
  emulator.bus.register("pv-sock-close", d => { pvSocks[d.handle | 0] = null; });
  report("net", "the PV socket is the host's network");
  return { pv: true };
}
window.pvNet = () => ({ on: !!slipNet, bytes: slipBytes, requests: slipReqs });

/* --------------------------------------------------------------------- clipboard bridge ---
   Windows' clipboard and the phone's, kept in step. Out: PVMON reports CF_TEXT, we write it to
   the system clipboard -- which iOS only permits inside a user gesture, so the text waits for the
   next touch. In: a paste anywhere on the page goes to the guest as CMD_CLIP, and PVMON puts it
   on the clipboard where Notepad's Edit > Paste will find it. No visible UI either way. */
let clipIn = null, guestClip = "", clipPending = false, clipLast = "", clipCopyWait = 0;
async function offerClipboard(why) {
  if (!clipPending || !guestClip || guestClip === clipLast) return;
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;
  try {
    await navigator.clipboard.writeText(guestClip);
    clipLast = guestClip; clipPending = false;
    diag(`clipboard -> system (${guestClip.length} bytes, ${why})`);
  } catch (e) {
    diag(`clipboard -> system refused (${why}): ${e.name}`);   // no gesture yet: try again on the next touch
  }
}
function pasteToGuest(text) {
  if (!text) return;
  const clipped = text.length > 4096 ? text.slice(0, 4096) : text;   // CLIP_MAX in pvmon.c
  /* CF_TEXT is ANSI and lines end CRLF; anything outside Latin-1 has no representation in a
     Windows 3.1 code page, so it becomes a question mark rather than a random byte. */
  const ansi = clipped.replace(/\r\n|\n|\r/g, "\r\n").replace(/[^\x09\x0a\x0d\x20-\xff]/g, "?");
  clipLast = ansi;                                  // do not bounce it straight back at us
  sendCommandString(CMD_CLIP, ansi);
  diag(`clipboard -> guest (${ansi.length} bytes)`);
}
/* A physical keyboard's own clipboard keys. v86's keyboard adapter takes every keydown on the
   window and calls preventDefault, so Cmd/Ctrl+C never produced a `copy` and Cmd/Ctrl+V never
   produced a `paste` -- which is why nothing crossed in either direction from a Mac. These run in
   the capture phase, before the adapter sees them.

   Windows 3.1's own clipboard keys are Ctrl+Insert, Shift+Insert and Shift+Delete: Ctrl+C/V/X did
   not become standard until later, and Notepad and Write here only listen for the old ones. So the
   host translates. */
/* Insert twice over: the keypad's 0x52 is Insert only while Shift is up -- held down it is the
   digit 0, which is why Shift+Insert pasted nothing while Ctrl+Insert copied fine. The paste
   chord uses the extended Insert (E0 52), the grey key, which keeps its meaning under Shift. */
const CLIP_KEYS = { c: [[0x1D], [0x52]], x: [[0x2A], [0xE0, 0x53]], v: [[0x2A], [0xE0, 0x52]] };
function sendChord(mod, key) {
  sendScancodes(mod, true); sendScancodes(key, true);
  sendScancodes(key, false); sendScancodes(mod, false);
}
window.addEventListener("keydown", ev => {
  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
  const k = (ev.key || "").toLowerCase();
  if (k !== "c" && k !== "x" && k !== "v") return;
  const [mod, key] = CLIP_KEYS[k];
  ev.stopImmediatePropagation();                  // the emulator's adapter must not swallow it
  if (k === "v") {
    /* Left to the browser on purpose: not calling preventDefault is what makes the `paste` event
       fire, and the handler below has the text. */
    return;
  }
  ev.preventDefault();
  sendChord(mod, key);                            // Ctrl+Insert / Shift+Delete, inside the guest
  clipCopyWait = performance.now() + 1200;        // PVMON's report is a moment behind the keys
  diag(`clipboard: ${k === "c" ? "copy" : "cut"} keys sent to the guest`);
}, true);

window.addEventListener("paste", ev => {
  const t = ev.clipboardData && ev.clipboardData.getData("text");
  if (!t) return;
  ev.preventDefault();
  pasteToGuest(t);
  /* ...and then tell the guest to paste it where the focus is, with the keys Windows 3.1 listens
     for. The clipboard has to be set first, so this waits for the command to be acknowledged. */
  queue(async () => { await sleep(120); sendChord(CLIP_KEYS.v[0], CLIP_KEYS.v[1]); diag("clipboard: paste keys sent to the guest"); });
});

/* --------------------------------------------------------------------------- LCD filter ---
   A 1992 passive-matrix panel, as a post-process over the finished composite (?lcd=1). Josh's
   photograph of ProSell Professional on a laptop of that era is the reference: no colour at all,
   blacks lifted to a warm grey, a cyan-white bloom along the edge the backlight tube runs down, a
   visible pixel grid, and the smear a slow panel leaves behind anything that moves.

   It is purely a display. `#pres` stays the input surface underneath, so the composite geometry,
   the hit testing and the pointer are untouched, and nothing about the guest changes.

   Two passes. The first computes the panel's *drive level* -- luminance through a lifted-black
   curve -- and lags it towards the previous frame's level asymmetrically: a pixel going dark
   lags more than one going light, which is what a passive matrix does and what makes this read
   as an LCD rather than a grey CRT. That level is kept in a texture and ping-ponged. The second
   pass turns the level into what you see: the panel's green-grey tint, the grid, the backlight,
   the vignette. Keeping them apart matters -- run the cosmetics through the trail and the grid
   smears too, which looks like a broken compositor rather than a screen. */
/* On, and how bright and how contrasty, are the guest's to decide: LCD.EXE (guest/lcd) is a plain
   Windows program with a check box and two scroll bars, and it reports "PVLCD <on> <bright>
   <contrast>" on the debug channel whenever the user moves anything. The URL's ?lcd=1 is only the
   initial state for a page that has never been told otherwise; what the guest last said is kept
   here so a reload comes up the way it was left, and the guest keeps its own copy in WIN.INI. */
/* ?lcd=1 turns the filter on and ?lcd=0 turns it off, ahead of anything left in localStorage, and
   the setting is pushed into the guest at startup (LCD.EXE /on or /off) so the Screen app's own
   checkbox agrees with it. From there the Screen app is in charge: unticking the box turns the
   effect off, whatever the URL said. With no parameter the guest decides from the start, which is
   the normal case. */
const lcdForced = params.get("lcd") === "1" ? true : params.get("lcd") === "0" ? false : null;
let lcdOn = lcdForced === true;
let lcdBright = 0.5, lcdContrast = 0.5;
try {
  const saved = JSON.parse(localStorage.getItem("pv.lcd") || "null");
  if (saved) { if (lcdForced === null) lcdOn = !!saved.on; lcdBright = saved.bright; lcdContrast = saved.contrast; }
} catch (e) {}
function lcdSettings(on, bright, contrast) {
  const was = lcdOn;
  lcdOn = !!on;                     // the Screen app has the last word, including over ?lcd=
  lcdBright = Math.max(0, Math.min(1, bright / 100));
  lcdContrast = Math.max(0, Math.min(1, contrast / 100));
  try { localStorage.setItem("pv.lcd", JSON.stringify({ on: lcdOn, bright: lcdBright, contrast: lcdContrast })); } catch (e) {}
  if (!lcdOn && was) { lcdOff(); needFull = true; invalidate(); }   // the composite underneath is intact
  if (lcdOn) needFull = true;
  diag(`lcd: ${lcdOn ? "on" : "off"} bright=${lcdBright.toFixed(2)} contrast=${lcdContrast.toFixed(2)}`);
}
let lcd = null, lcdAsked = false;

const LCD_VERT = `attribute vec2 p; varying vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

/* Pass 1: drive level, with the panel's lag. */
const LCD_LAG = `precision mediump float;
varying vec2 uv;
uniform sampler2D src, prev;
uniform vec2 res;
uniform float seed;          // 1.0 on the first frame: no history to lag towards
void main() {
  /* A mild horizontal bleed first: the column drivers are analogue and neighbouring pixels pull
     on each other, which is why text on these panels looks softer across than down. */
  float dx = 1.0 / res.x;
  vec3 c0 = texture2D(src, uv).rgb;
  vec3 cl = texture2D(src, uv - vec2(dx, 0.0)).rgb;
  vec3 cr = texture2D(src, uv + vec2(dx, 0.0)).rgb;
  vec3 c = c0 * 0.7 + (cl + cr) * 0.15;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  /* Lifted black, compressed white: nothing in the photograph is near black or near white. */
  float target = mix(0.02, 1.0, pow(l, 1.15));
  float was = texture2D(prev, uv).r;
  /* Asymmetric response: rising (going lighter) settles faster than falling. */
  float k = target > was ? 0.55 : 0.28;
  float now = mix(was, target, k);
  gl_FragColor = vec4(mix(now, target, seed), 0.0, 0.0, 1.0);
}`;

/* Pass 2: what the eye gets. */
/* Pass 1b: the row wash. A dark run of cells drags the drive for the whole line it is on, so the
   rows carrying text are greyer right across the panel -- that is the band in Josh's photograph,
   tens of cells past the last character in both directions. Point taps cannot make it: eight
   samples at 6, 15, 32... cells back give eight legible ghost copies of the text marching across
   the row, which is what the first attempt looked like. So it is built properly, as a separable
   box blur along x only, run twice at different scales: eight taps at one cell, then eight taps at
   eight cells on the result, which is a smooth 64-cell average for sixteen texture reads. */
const LCD_ROW = `precision mediump float;
varying vec2 uv;
uniform sampler2D src;
uniform vec2 step;           // how far apart the taps are, in uv
void main() {
  float a = 0.0;
  for (int i = -4; i <= 3; i++) a += texture2D(src, uv + step * (float(i) + 0.5)).r;
  gl_FragColor = vec4(a * 0.125, 0.0, 0.0, 1.0);
}`;

const LCD_LOOK = `precision mediump float;
varying vec2 uv;
uniform sampler2D lvl, row;
uniform vec2 res, pitch;     // canvas pixels, and the size of one guest pixel in them
uniform float t, bright, contrast;   // the guest's own two scroll bars, 0..1, 0.5 = as shipped
void main() {
  float l = texture2D(lvl, uv).r;

  /* "Run": the smear a passive matrix leaves along its own wiring, and it is not the same in the
     two axes -- which is the whole character of it in Josh's photograph of the 9800NB.
     Short range, both axes: a dark glyph doubles into the cell after it along the row and the cell
     below it, which is what gives the text its embossed look in the photograph. A little bleeds
     backwards too.
     Long range, along the row only: a row is driven as a whole line, and a dark run of cells drags
     the drive for everything else on that line, so the rows carrying text stay greyer for the full
     width of the panel. That comes from the blurred row texture, not from taps at points.
     Down the column there is no long range: column coupling is cell to cell, and below a block of
     text the panel goes clean again. (A long vertical wash was tried first and is plainly wrong --
     it hung a grey shadow under Solitaire halfway down the screen.)
     Taps are in guest pixels, the panel's real cells, and only the darkening half is kept:
     crosstalk pulls a cell towards the drive of its neighbours, and it is the dark that shows. */
  vec2 cell = max(pitch, vec2(1.0)) / res;
  float near = 0.0;
  near += 0.34 * texture2D(lvl, uv - vec2(cell.x, 0.0)).r;          // one cell behind, along the row
  near += 0.18 * texture2D(lvl, uv - vec2(cell.x * 2.0, 0.0)).r;
  near += 0.28 * texture2D(lvl, uv - vec2(0.0, cell.y)).r;          // one cell up: the glyph doubles
  near += 0.12 * texture2D(lvl, uv - vec2(0.0, cell.y * 2.0)).r;
  near += 0.08 * texture2D(lvl, uv + vec2(cell.x, 0.0)).r;          // a little bleeds backwards too
  float wash = texture2D(row, uv - vec2(cell.x * 6.0, 0.0)).r;      // the band, biased after the run
  l = min(l, mix(l, near, 0.45));
  l = min(l, mix(l, wash, 0.20));

  /* Contrast pivots about mid grey so neither end runs away, and brightness is the backlight's
     own knob -- these panels had a wheel on the bezel for each, and this is what those did. */
  l = clamp(0.5 + (l - 0.5) * (0.55 + 1.9 * contrast), 0.0, 1.0);
  l = clamp(l * (0.55 + 0.9 * bright), 0.0, 1.0);
  /* The panel is not neutral grey: it is a green-grey, warmer in the shadows than the highlights.
     These two are sampled from the photograph -- #4a4f48 at its darkest, #c8ccc0 at its lightest. */
  vec3 dark = vec3(0.075, 0.090, 0.070);
  vec3 light = vec3(0.985, 1.000, 0.945);
  vec3 c = mix(dark, light, l);

  /* The grid, at the real guest-pixel pitch so it lands on pixel boundaries rather than beating
     against them, and only when a guest pixel is big enough on this display to have a visible
     gap: at two device pixels a one-pixel gap is half the cell, which reads as a dark screen
     rather than a grid. */
  vec2 px = uv * res;
  vec2 f = fract(px / max(pitch, vec2(1.0)));
  float on = step(2.5, pitch.x);
  float gx = mix(1.0, f.x > 1.0 - 1.0 / max(pitch.x, 2.0) ? 0.965 : 1.0, on);
  float gy = mix(1.0, f.y > 1.0 - 1.0 / max(pitch.y, 2.0) ? 0.975 : 1.0, on);
  c *= gx * gy;

  /* The backlight, and it is not even. One thin tube down the RIGHT edge (Josh's machine) lights
     the whole panel through a diffuser that never worked properly: brightest along that edge,
     falling off across, and blotchy everywhere -- a few broad lobes of light and shade that are a
     property of the panel, so they do not move. Then the corner falloff every one of these had. */
  float edge = exp(-(1.0 - uv.x) * 2.6);          // the tube lights well across the panel
  float blotch = sin(uv.x * 3.1 + 1.7) * sin(uv.y * 2.3 + 0.4)
               + 0.60 * sin(uv.x * 6.7 + 2.9) * sin(uv.y * 5.1 + 1.2)
               + 0.35 * sin(uv.x * 11.3 + 0.8) * sin(uv.y * 9.7 + 2.4);
  blotch /= 1.95;
  /* Where an uneven backlight actually shows is in the darks. Light leaking through the panel
     lifts black towards milky grey wherever the tube and the diffuser put more of it, and does
     nothing at all to white -- white is already the panel wide open. So the unevenness is applied
     as a lift weighted by how dark the pixel is, which keeps the whites bright (Josh: "lights need
     to be brighter") while making the gradient and the blotches plainly visible. */
  float glow = 0.10 + 0.80 * edge + 0.30 * blotch;
  c += vec3(0.26, 0.30, 0.28) * glow * (1.0 - l);
  /* And across everything, hard enough to see: the far side of one of these panels is dim, the
     tube side is hot, and the diffuser puts broad patches between them. */
  /* Toned down from where it was: on a phone column the unevenness reads as character, on a whole
     desktop it reads as a stain (Josh, on the MS-DOS Prompt over Program Manager). The tube edge
     stays; the broad patches lost about half their strength. */
  c *= 0.88 + 0.24 * edge + 0.09 * blotch;
  vec2 v = uv - 0.5;
  c *= 1.0 - 0.30 * dot(v, v);

  /* And the tube's own flicker: half a percent, at a rate that is not a multiple of any frame
     rate, so it never sits still and never strobes. */
  c *= 1.0 + 0.005 * sin(t * 43.7);

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function lcdCompile(gl, type, src, what) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    report("lcd", `${what} failed to compile: ${gl.getShaderInfoLog(sh)}`);
    return null;
  }
  return sh;
}
function lcdProgram(gl, frag, what) {
  const v = lcdCompile(gl, gl.VERTEX_SHADER, LCD_VERT, "vertex shader");
  const f = lcdCompile(gl, gl.FRAGMENT_SHADER, frag, what);
  if (!v || !f) return null;
  const p = gl.createProgram();
  gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    report("lcd", `${what} failed to link: ${gl.getProgramInfoLog(p)}`);
    return null;
  }
  return p;
}
function lcdTexture(gl, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return t;
}
function initLcd() {
  const cv = $("lcd"), src = $("pres");
  if (!cv || !src) return null;
  const gl = cv.getContext("webgl", { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false });
  if (!gl) { report("lcd", "no webgl: the filter stays off"); return null; }
  const lag = lcdProgram(gl, LCD_LAG, "lag pass"), look = lcdProgram(gl, LCD_LOOK, "look pass");
  const rowp = lcdProgram(gl, LCD_ROW, "row pass");
  if (!lag || !look || !rowp) return null;
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const st = {
    gl, cv, lag, look, rowp, quad, tex: lcdTexture(gl, 0, 0),
    fbo: [gl.createFramebuffer(), gl.createFramebuffer()],
    lvl: [null, null], cur: 0, w: 0, h: 0, seed: 1, settle: 0, gen: -1,
    /* the row wash: two half-width buffers, blurred along x and ping-ponged between */
    rowFbo: [gl.createFramebuffer(), gl.createFramebuffer()], rowTex: [null, null],
  };
  cv.classList.add("on");
  report("lcd", "filter on");
  return st;
}
/* Sized to the composite, in its device pixels: one texel per composite pixel, so the grid can
   sit on guest-pixel boundaries instead of interfering with them. */
function lcdResize(st, w, h) {
  if (st.w === w && st.h === h) return;
  const { gl } = st;
  st.w = w; st.h = h;
  st.cv.width = w; st.cv.height = h;
  /* ...and the CSS size follows the composite's, not the backing store's: the compositor sizes
     #pres in CSS pixels every frame and this has to sit exactly on top of it. */
  const src2 = $("pres");
  if (src2 && src2.style.width) { st.cv.style.width = src2.style.width; st.cv.style.height = src2.style.height; }
  for (let i = 0; i < 2; i++) {
    if (st.lvl[i]) gl.deleteTexture(st.lvl[i]);
    st.lvl[i] = lcdTexture(gl, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.fbo[i]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, st.lvl[i], 0);
  }
  for (let i = 0; i < 2; i++) {
    if (st.rowTex[i]) gl.deleteTexture(st.rowTex[i]);
    st.rowTex[i] = lcdTexture(gl, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.rowFbo[i]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, st.rowTex[i], 0);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  st.seed = 1;                              // no history at this size
}
function lcdBind(st, prog) {
  const { gl } = st;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, st.quad);
  const p = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(p);
  gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
}
/* One filtered frame. `changed` says whether the composite moved; when it has not, the trail is
   still settling for a few frames and then this stops drawing entirely, which is what keeps the
   compositor's "most frames cost nothing" property mostly intact. */
function lcdFrame(changed) {
  if (!lcdOn) return;
  if (!lcd) { lcd = initLcd(); if (!lcd) { lcdOn = false; lcdOff(); return; } }
  const st = lcd, { gl } = st, src = $("pres");
  if (!src || !src.width) return;
  if (changed) st.settle = 22;              // the lag needs this many frames to land within 1/255
  else if (st.settle > 0) st.settle--;
  else return;
  lcdResize(st, src.width, src.height);
  const prev = st.cur, next = 1 - st.cur;

  gl.bindTexture(gl.TEXTURE_2D, st.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);

  // pass 1: the panel's drive level, lagged
  gl.bindFramebuffer(gl.FRAMEBUFFER, st.fbo[next]);
  gl.viewport(0, 0, st.w, st.h);
  lcdBind(st, st.lag);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.tex);
  gl.uniform1i(gl.getUniformLocation(st.lag, "src"), 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, st.lvl[prev]);
  gl.uniform1i(gl.getUniformLocation(st.lag, "prev"), 1);
  gl.uniform2f(gl.getUniformLocation(st.lag, "res"), st.w, st.h);
  gl.uniform1f(gl.getUniformLocation(st.lag, "seed"), st.seed);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  st.seed = 0;

  /* pass 1b: the row wash -- the level blurred along x only, twice, so a dark run of cells greys
     its whole line instead of leaving a row of legible ghosts behind it. */
  const cellPx = Math.max(1, (view && view.scale ? view.scale : 1) * (window.devicePixelRatio || 1));
  for (let i = 0; i < 2; i++) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.rowFbo[i]);
    gl.viewport(0, 0, st.w, st.h);
    lcdBind(st, st.rowp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, i === 0 ? st.lvl[next] : st.rowTex[0]);
    gl.uniform1i(gl.getUniformLocation(st.rowp, "src"), 0);
    /* one cell apart, then eight cells apart on the result: a smooth 64-cell average */
    gl.uniform2f(gl.getUniformLocation(st.rowp, "step"), (i === 0 ? cellPx : cellPx * 8) / st.w, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // pass 2: the look
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, st.w, st.h);
  lcdBind(st, st.look);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.lvl[next]);
  gl.uniform1i(gl.getUniformLocation(st.look, "lvl"), 0);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, st.rowTex[1]);
  gl.uniform1i(gl.getUniformLocation(st.look, "row"), 2);
  gl.uniform2f(gl.getUniformLocation(st.look, "res"), st.w, st.h);
  const dpr = window.devicePixelRatio || 1;
  const pitch = Math.max(1, (view && view.scale ? view.scale : 1) * dpr);
  gl.uniform2f(gl.getUniformLocation(st.look, "pitch"), pitch, pitch);
  gl.uniform1f(gl.getUniformLocation(st.look, "t"), performance.now() / 1000);
  gl.uniform1f(gl.getUniformLocation(st.look, "bright"), lcdBright);
  gl.uniform1f(gl.getUniformLocation(st.look, "contrast"), lcdContrast);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  st.cur = next;
}
function lcdOff() {
  const cv = $("lcd");
  if (cv) cv.classList.remove("on");
  lcd = null;
}
window.pvLcd = () => ({ on: lcdOn, bright: lcdBright, contrast: lcdContrast, live: !!lcd, w: lcd ? lcd.w : 0, h: lcd ? lcd.h : 0, settle: lcd ? lcd.settle : 0 });

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
  invalidate();
  holdLastFrame();
  emulator.bus.send("pv-request-mode", [w, h]);
  setText("zoom", scale === 1 ? "" : `scale ${scale.toFixed(2)}`);
  fitCanvas();
}
// The debounce deliberately avoids setTimeout: a hidden page throttles timers almost to a
// stop, so a resize while backgrounded would never be acted on. Everything time-based here is
// driven from the pump below, which also runs off a worker heartbeat.
let pending = null, pendingSince = 0;
function pump() {
  fitCanvas();
  document.documentElement.classList.toggle("phone", narrow());
  syncDesktopMode();                                   // the viewport crossed the phone/desktop line
  applyCursorShape();                                  // and with it, which pointer is the visible one
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
  setText("zoom", zoom === 1 ? "" : zoom.toFixed(1) + "x");
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
/* A function declaration, not a const: the frame loop below starts during this module's own
   evaluation, and on the desktop its first pump reports a cursor shape -- which reached this
   binding before the declaration had run and threw for every desktop visitor. `report` is
   hoisted too, so the early call works. */
var diagWanted;                       // var: hoisted as undefined, so an early call cannot throw
function diag(m) {
  if (diagWanted === undefined) diagWanted = !!params.get("diag");
  if (diagWanted) report("diag", m);
}

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
        if (hiddenReport(guestCursor)) break;           // no position to correct against
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
/* The size USER scales an absolute (normalised) mouse position by. Measured (tools/desktop-probe.mjs):
   it is the screen Windows started at, not the current mode. USER keeps its own copy for the mouse
   that neither the live re-mode's metric patching nor FakeScreen reaches, so after a re-mode to
   1280x800 a position normalised to 1280x800 landed at twice the x. Windows always starts in the
   phone layout here (the host requests that mode until the guest reports the switch), so in
   desktop mode the base is the phone screen; in the phone layout the canvas is that screen. */
function screenSize() {
  if (guestDesktop === true) return [SCREEN_W, SCREEN_H];
  const src = document.querySelector("#screen_container canvas");
  return src && src.width ? [src.width, src.height] : [SCREEN_W, SCREEN_H];
}
/* The driver reports (-1,-1) when USER has no cursor to show (an application drawing with a NULL
   cursor: Paintbrush painting) or has clamped the pointer away: it is not a position. */
const hiddenReport = c => !!c && c.x === 65535 && c.y === 65535;
/* The size USER scales an absolute (normalised) mouse position by is NOT necessarily the screen
   this page asked for: USER keeps its own copy that neither the live re-mode nor FakeScreen
   reaches, so a screen that changes size leaves the host normalising against the wrong number and
   every placement lands somewhere else. That was the whole of 2026-09-03's bad afternoon: taps
   hundreds of pixels from the finger, drags that never confirmed and retried instead, a card in
   Solitaire lagging behind. So the host measures it instead of assuming: put the pointer at a
   known fraction of the screen, read back where the guest says it went, and divide. Re-measured
   whenever the guest reports a new layout. */
let mouseBase = null;
async function calibratePointer(why) {
  if (!absPointer) return null;
  /* Two probes, not one, and the base comes from the DIFFERENCE between them. A single probe
     divides one reported position by one fraction, which trusts that the report belongs to this
     probe and that USER adds no offset of its own; a stale report then yields a plausible-looking
     base that is wrong by the view scale, which is exactly what the first version of this did.
     Two probes cancel any fixed offset, and a report that has not moved between them fails the
     sanity check instead of being believed. */
  const probe = async n => {
    const seq = cursorSeq, t0 = performance.now();
    emulator.bus.send("pv-mouse-abs", [n, n]);
    emulator.bus.send("mouse-delta", [1, 0]);
    while (cursorSeq === seq && performance.now() - t0 < 500) await sleep(4);
    if (cursorSeq === seq || !guestCursor || guestCursor.x < 0) return null;
    return { x: guestCursor.x, y: guestCursor.y };
  };
  const lo = 0x2000, hi = 0x6000;                        // an eighth and three eighths across
  const a = await probe(lo);
  const b = await probe(hi);
  if (!a || !b) { diag(`pointer base: no report (${why})`); return null; }
  const w = Math.round((b.x - a.x) * 65536 / (hi - lo)), h = Math.round((b.y - a.y) * 65536 / (hi - lo));
  if (w < 320 || h < 200 || w > 8192 || h > 8192) {
    diag(`pointer base: ${w}x${h} from ${a.x},${a.y} -> ${b.x},${b.y} is nonsense (${why})`);
    return null;
  }
  /* And then it is checked before it is trusted: place the pointer at a known point using the
     measured base and see whether the guest lands there. This is the path whose silent failure
     misplaced every tap and drag on 2026-09-04; it does not get to fail silently again. */
  const was = mouseBase;
  mouseBase = { w, h };
  const target = { x: Math.round(w / 3), y: Math.round(h / 3) };
  const seq = cursorSeq, t0 = performance.now();
  emulator.bus.send("pv-mouse-abs", [Math.round((target.x + 0.5) * 65536 / w), Math.round((target.y + 0.5) * 65536 / h)]);
  emulator.bus.send("mouse-delta", [1, 0]);
  while (cursorSeq === seq && performance.now() - t0 < 500) await sleep(4);
  const off = guestCursor ? Math.max(Math.abs(guestCursor.x - target.x), Math.abs(guestCursor.y - target.y)) : 9999;
  if (cursorSeq === seq || off > 2) {
    mouseBase = was;
    diag(`pointer base ${w}x${h} rejected (${why}): asked ${target.x},${target.y}, got ${JSON.stringify(guestCursor)}`);
    report("pointer", `base ${w}x${h} rejected, off by ${off}`);
    return null;
  }
  diag(`pointer base ${w}x${h} verified (${why}); host screen ${screenSize().join("x")}`);
  report("pointer", `base ${w}x${h} (${why})`);
  return mouseBase;
}
function pointerBase() { return mouseBase ? [mouseBase.w, mouseBase.h] : screenSize(); }

async function placePointer(pt) {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) { diag(`place: bad target ${JSON.stringify(pt)}`); return; }
  const seq = cursorSeq, t0 = performance.now();
  { // a finger can leave the mapped layer: the guest pointer stays on the screen
    const [sw, sh] = screenSize();
    pt = { x: Math.max(0, Math.min(sw - 1, Math.round(pt.x))), y: Math.max(0, Math.min(sh - 1, Math.round(pt.y))) };
  }
  if (absPointer) {
    const [sw, sh] = pointerBase();
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
  /* A report is the end of it, wherever the pointer was put: USER clamps the pointer to the screen
     and to the application's ClipCursor rectangle, and (-1,-1) means it has no cursor to show at
     all (Paintbrush painting). Correcting such a report with relative packets drove the pointer
     to (0,0) with the button held (a 65535 "miss" became 64 packets of -100 a round, four rounds,
     each waited on) -- every Paintbrush stroke ended in the top-left corner, dragging whatever
     was there, ~900 ms per finger point. Relative steering is only for a guest that never
     reports (an image without the PV mouse driver or PVMON). */
  if (!reported && (!guestCursor || Math.abs(guestCursor.x - pt.x) > 1 || Math.abs(guestCursor.y - pt.y) > 1)) {
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
  if (dy < w.ht) return { x: Math.round(w.wx + dx / w.c + (w.mpan || 0)), y: Math.round(w.wy + dy / w.c) };   // chrome (menu rows) through the pan
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

/* The caption hold that toggles the keyboard. 600 ms was hard to feel; at 350 it is the same beat
   as hold-to-drag, and a caption drag still wins because any movement cancels it. */
const CAPTION_HOLD_MS = 350;
function pressStart(ev) {
  const { px, py } = hostPoint(ev);
  const h = hitTest(px, py);
  if (h.kind === "chrome" && h.menu && h.win.menuMax > 0) {
    chromeDrag = { key: h.win.key, pan: "menu", base: h.win.mpan || 0, startX: px, startY: py, moved: false,
                   guest: { x: h.x, y: h.y }, timer: 0, toggled: false, fitW: false, fitH: true, c: h.win.c, max: h.win.menuMax };
    diag(`menu pan armed ${h.win.title} pan=${chromeDrag.base}/${chromeDrag.max}`);
    return "drag";
  }
  if (h.kind === "drag") {
    const p = layerPos[h.win.key];
    chromeDrag = { key: h.win.key, dx: px - p.x, dy: py - p.y, startX: px, startY: py, moved: false,
                   guest: mapThrough(h.win, px, py), timer: 0, toggled: false };
    // holding a caption still toggles the soft keyboard: a gesture, since the guest cannot always
    // tell us it wants text (Paintbrush's text tool, a DOS box)
    chromeDrag.timer = setTimeout(() => {
      if (chromeDrag && !chromeDrag.moved) {
        chromeDrag.toggled = true;
        keyboardHeld = !keyboardHeld;
        if (!keyboardHeld) wantKeyboard = false;             // toggled off: the guest's stale request must not keep it up
        diag(`caption hold: keyboard ${keyboardHeld ? "held" : "released"}`);
        syncKeyboard();
      }
    }, CAPTION_HOLD_MS);
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
  if (chromeDrag.pan === "menu") { menuPan[chromeDrag.key] = Math.round(Math.max(0, Math.min(chromeDrag.max, chromeDrag.base - (px - chromeDrag.startX) / chromeDrag.c))); return true; }
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
/* On a one-finger-scroll surface a plain drag scrolls; a finger held still this long first and
   then moved is a guest left-button drag instead (hold to move: a group window by its caption, an
   icon, a selection). A hold released without moving is the right button, as everywhere else. */
const HOLD_MS = 350;
let touchInstalled = false;
function installTouch() {
  const c = $("pres");
  if (!c || touchInstalled) return;
  touchInstalled = true;
  // Button events are serialised behind the pointer: a press that lands while the pointer is
  // still moving would drag whatever is under it.
  let chain = Promise.resolve(), queued = 0;
  const queue = fn => { queued++; chain = chain.then(fn).catch(() => {}).then(() => { queued--; }); };
  let consumed = null, pressActive = false;

  /* One press = one pipeline: place the pointer, (maybe) press, follow the finger, release.
     Moves are never queued one by one: a slow guest (a phone runs the emulator at a fraction of
     desktop speed) would fall seconds behind a 0.4 s drag and the next gesture would queue up
     behind it. Instead the latest finger position is kept and a single loop steers towards it,
     one guest round-trip at a time; the release waits for the loop to catch up. */
  // Two fingers scroll whatever is under them (or zoom/pan a layer): each SCROLL_STEP of travel
  // is a line message to the guest window under the midpoint.
  const SCROLL_STEP = 24;
  /* Momentum. A scroll that ends with the finger still moving keeps going, decaying, the way a
     phone list does. Windows scrolls by whole lines, so the glide is a decaying stream of line
     commands rather than a smooth offset — with the driver's block copy a scrolled line is cheap
     enough that it reads as a glide. It stops when the velocity falls below a line's worth, when
     the guest stops changing (the end of a list: nothing to scroll), on any new touch, or after a
     second and a half, so it can never run away. */
  let glide = null;
  /* Velocity from the last ~120 ms of movement rather than the gap between two events: touch
     moves can arrive in a burst with no time between them (and synthetic ones always do), which
     makes a per-event velocity either zero or nonsense. */
  const noteFlick = (G, x, y) => {
    (G.hist || (G.hist = [])).push({ t: performance.now(), x, y });
    if (G.hist.length > 8) G.hist.shift();
  };
  const flickVelocity = G => {
    const h = G && G.hist;
    if (!h || h.length < 2) return { vx: 0, vy: 0 };
    const last = h[h.length - 1];
    let first = h[0];
    for (const p of h) if (last.t - p.t <= 120) { first = p; break; }
    const dt = last.t - first.t;
    if (dt < 8) return { vx: 0, vy: 0 };                  // no usable time base
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  };
  const stopGlide = () => { if (glide) { cancelAnimationFrame(glide.raf); glide = null; } };
  const startGlide = (slot, vx, vy) => {
    stopGlide();
    if (slot < 0 || Math.max(Math.abs(vx), Math.abs(vy)) < 0.25) { diag(`glide declined slot=${slot} v=${vx.toFixed(2)},${vy.toFixed(2)}`); return; }   // a slow lift just stops
    /* A flick throws the list further than the finger was moving, and it keeps going for a while:
       the first version decayed 6% a frame from the release velocity and was over in well under a
       second, which reads as a list that does not want to move. 1.4x off the finger, 2.5% a frame,
       and up to three seconds. */
    vx *= 1.4; vy *= 1.4;
    const g0 = { slot, vx, vy, accX: 0, accY: 0, t: performance.now(), until: performance.now() + 3000, gen: dirtyGen, still: 0, raf: 0 };
    glide = g0;
    const step = () => {
      if (glide !== g0) return;
      const now = performance.now(), dt = Math.min(50, now - g0.t);
      g0.t = now;
      const decay = Math.pow(0.975, dt / 16);             // ~2.5% per frame: a long, unhurried glide
      g0.vx *= decay; g0.vy *= decay;
      g0.accX += g0.vx * dt; g0.accY += g0.vy * dt;
      const ny = Math.trunc(g0.accY / SCROLL_STEP), nx = Math.trunc(g0.accX / SCROLL_STEP);
      if (ny) { armFastPoll(); sendCommand(CMD_SCROLL, g0.slot | (ny > 0 ? 1 : 2) << 8 | Math.min(15, Math.abs(ny)) << 12); g0.accY -= ny * SCROLL_STEP; }
      if (nx) { armFastPoll(); sendCommand(CMD_SCROLL, g0.slot | (nx > 0 ? 3 : 4) << 8 | Math.min(15, Math.abs(nx)) << 12); g0.accX -= nx * SCROLL_STEP; }
      // nothing painted for a quarter of a second while we are asking it to scroll: it has hit the end
      if (ny || nx) { g0.still = rectDirtySince(g0.gen, 0, 0, 2560, 970) ? 0 : g0.still + 1; g0.gen = dirtyGen; }
      const behind = cmdQueue.reduce((n, c) => n + (c.cmd === CMD_SCROLL ? 1 : 0), 0) >= 3;
      if (behind) { g0.vx *= 0.9; g0.vy *= 0.9; }          // the guest cannot keep up: coast down, do not pile up
      if (Math.max(Math.abs(g0.vx), Math.abs(g0.vy)) < 0.04 || now > g0.until || g0.still > 15) {
        diag(`glide ended after ${Math.round(now - (g0.until - 3000))} ms`);
        releaseFastPoll(); glide = null; return;
      }
      g0.raf = requestAnimationFrame(step);
    };
    diag(`glide start slot ${slot} v=${vy.toFixed(2)}`);
    g0.raf = requestAnimationFrame(step);
  };
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
    const started = performance.now();
    let lastPoint = started;
    for (;;) {
      // A gesture whose end was never delivered (a touchcancel the page missed, the tab hidden
      // mid-drag) used to leave this loop running and the input queue blocked behind it.
      if (performance.now() - lastPoint > 5000) { diag("follow: abandoned, no movement for 5 s"); break; }
      // Walk the finger's path in order rather than jumping to the latest point: a freehand
      // stroke in Paintbrush is drawn from the WM_MOUSEMOVEs it receives, so skipping points turns
      // a curve into a few straight segments. Points closer than 3 guest px are coalesced; when
      // the guest falls behind, the path is thinned but its shape kept (every other point).
      let t = null;
      if (G.path && G.path.length) {
        if (G.path.length > 24) G.path = G.path.filter((_, i) => i % 2 === 0 || i === G.path.length - 1);
        t = G.path.shift();
        if (steered && G.path.length && Math.hypot(t.x - steered.x, t.y - steered.y) < 3) continue;
      } else t = G.latest;
      // Absolute placement for drag motion too: on a phone the guest runs slowly enough that
      // relative PS/2 packets lag behind the release, while SetCursorPos through PVMON lands in
      // tens of milliseconds and Windows generates the WM_MOUSEMOVE for the dragging program.
      if (t && (!steered || steered.x !== t.x || steered.y !== t.y)) { lastPoint = performance.now(); await placePointer(t); steered = t; continue; }
      if (!G.active) break;
      await sleep(16);
    }
  };

  /* One finger on a content surface scrolls instead of dragging: the gesture starts as a possible
     tap, and once the finger has travelled further than a tap allows it becomes a scroll of the
     window the press started in (line messages through PVMON, like two fingers), never a pointer
     drag. A finger that never travels is still a click. */
  let oneScroll = null, shellPan = null;
  const clearHold = () => { if (oneScroll && oneScroll.holdTimer) { clearTimeout(oneScroll.holdTimer); oneScroll.holdTimer = 0; } };
let hoverSurface = false;
let keySwipe = null, lastKeyTap = 0, aimSwipe = null;

  /* Swipe in from the right edge: the window at the back of the z-order comes to the front
     (CMD_ACTIVATE), so a repeated swipe cycles through what is open, front to back. The right
     edge only — iOS owns the left one for its own back gesture — and it must start within a thin
     margin, travel left, and stay level, which is what tells it from a window drag (those start on
     the caption or the frame: `hitTest` says "drag") and from a menu-bar pan (the menu row says
     "chrome"), neither of which arms this. A finger that starts there and goes up or down instead
     is handed to the ordinary pipeline the moment it is clear it is not a swipe, so scrolling with
     a thumb near the right edge (where the scroll bar is) still works, and a tap that never
     travels is still the click it would have been. The switch itself is not animated: the guest
     brings the window forward and the next frame shows it, which is the whole point. */
  const EDGE_W = 24;            // host px from the right edge in which a swipe may start
  const EDGE_TRAVEL = 44;       // px of leftward travel that commits the switch
  const EDGE_SLOP = 30;         // px of vertical wander before it is not an edge swipe at all
  let edgeSwipe = null;
  const cycleWindows = () => {
    /* The shell takes part in the cycle in its real z-order position (PVMON publishes it there),
       not pinned to the back: pinning it meant that once Program Manager was in front, every
       further swipe re-activated the shell and nothing moved. Published back to front, so the
       first entry is the one furthest back — activate that. */
    const ws = layers.filter(L => L.kind === "W" || L.kind === "S")
                     .map(L => ({ slot: L.kind === "S" ? SHELL_SCROLL_SLOT : L.slot, title: L.title }));
    if (ws.length < 2) { diag(`edge swipe: ${ws.length} window(s), nothing to cycle`); return false; }
    const back = ws[0];
    sendCommand(CMD_ACTIVATE, back.slot);
    diag(`edge swipe: activate slot ${back.slot} "${back.title}" (of ${ws.map(L => L.slot).join(",")})`);
    noteInput(`edge swipe -> ${back.title}`);
    return true;
  };
  const edgeStart = t => {
    if (switcher || !narrow() || !desktopReady) return false;   // the switcher owns input while it is open
    const { px, py } = hostPoint(t);
    const [vw] = viewport();
    if (px < vw - EDGE_W) return false;
    const h = hitTest(px, py);
    /* Over a window's client area, its frame, or the desktop. Not over chrome that clicks
       (the caption boxes, the menu row: those keep their own gestures, and the menu row is
       panned by exactly this motion) and not over a popup, which must not be dismissed by a
       swipe. The frame counts because a full-width window's right border is what lies under the
       edge margin — a level leftward swipe from there switches windows, anything else is the
       ordinary frame drag, handed over below. */
    if (h.kind !== "client" && h.kind !== "desktop" && h.kind !== "drag") return false;
    if (h.win && (h.win.transient || h.win.shellDialog)) return false;
    // the touch point is kept as a plain pair: touchend carries no touches to replay a tap from
    edgeSwipe = { startX: px, startY: py, t0: performance.now(), fired: false, tap: { clientX: t.clientX, clientY: t.clientY } };
    diag(`edge swipe armed at ${Math.round(px)},${Math.round(py)} over ${h.kind} ${h.win ? `"${h.win.title}"` : ""}`);
    return true;
  };
  /* Returns true while the gesture is still the edge's; false once it has been handed over. */
  const edgeMove = t => {
    const { px, py } = hostPoint(t);
    const dx = px - edgeSwipe.startX, dy = py - edgeSwipe.startY;
    if (Math.hypot(dx, dy) > 8) edgeSwipe.tap = null;              // travelled: no longer a tap
    if (edgeSwipe.fired) return true;                              // switched already: ignore the rest
    if (Math.abs(dy) > EDGE_SLOP) {                                // not level: an ordinary gesture
      diag(`edge swipe handed over (dy=${Math.round(dy)})`);
      edgeSwipe = null;
      down(t); move(t);
      return false;
    }
    if (dx <= -EDGE_TRAVEL) { edgeSwipe.fired = true; cycleWindows(); }
    return true;
  };

  /* Swipe up from the bottom edge: the iOS-style app switcher (drawSwitcher, above). Mirrors the
     right-edge cycle swipe exactly -- a thin arming margin, a travel threshold that commits, and a
     wander limit that hands the gesture back to the ordinary pipeline the moment it looks like
     something else (a scroll started near the bottom chrome, a drag on a window docked there) --
     except that what it commits to is not animated by the guest at all: opening the switcher is
     purely a host-side state change, so the frame after `fired` draws the switcher itself. */
  /* Taller than the right edge's margin: iOS keeps the bottom strip for its own home-indicator
     gesture, so a swipe that starts on the last few pixels is often eaten before the page sees
     it. Arming higher up gives the finger somewhere to start that is still unmistakably "the
     bottom edge". */
  const BOTTOM_H = 44;          // host px from the bottom edge in which a swipe may start
  const BOTTOM_TRAVEL = 60;     // px of upward travel that commits to opening the switcher
  const BOTTOM_SLOP = 40;       // px of horizontal wander before it is not this swipe at all
  let bottomSwipe = null;
  const openSwitcher = () => {
    const cards = switcherCards();
    if (!cards.length) { diag("bottom swipe: no windows to switch"); return false; }
    switcher = { cards, pos: 0, target: 0, drag: null };
    needFull = true;
    diag(`switcher open: ${cards.length} card(s)`);
    noteInput("switcher open");
    return true;
  };
  const bottomStart = t => {
    if (switcher || !narrow() || !desktopReady || keyboardUp()) return false;
    const { px, py } = hostPoint(t);
    const [, vh] = viewport();
    if (py < vh - BOTTOM_H) return false;
    const h = hitTest(px, py);
    if (h.win && h.win.transient) return false;          // a popup must not be dismissed by this swipe
    bottomSwipe = { startX: px, startY: py, t0: performance.now(), fired: false, tap: { clientX: t.clientX, clientY: t.clientY } };
    diag(`bottom swipe armed at ${Math.round(px)},${Math.round(py)} over ${h.kind}`);
    return true;
  };
  /* Returns true while the gesture is still the bottom edge's; false once it has been handed over. */
  const bottomMove = t => {
    const { px, py } = hostPoint(t);
    const dx = px - bottomSwipe.startX, dy = py - bottomSwipe.startY;
    if (Math.hypot(dx, dy) > 8) bottomSwipe.tap = null;             // travelled: no longer a tap
    if (bottomSwipe.fired) return true;                             // opened already: ignore the rest
    if (Math.abs(dx) > BOTTOM_SLOP) {                               // too much sideways wander: not this swipe
      diag(`bottom swipe handed over (dx=${Math.round(dx)})`);
      bottomSwipe = null;
      down(t); move(t);
      return false;
    }
    if (dy <= -BOTTOM_TRAVEL) { bottomSwipe.fired = true; openSwitcher(); }
    return true;
  };
  const down = ev => {
    window.pvPhase = "down";
    /* The switcher is modal: while it is open every touch is its own, panning or lifting cards,
       never the guest's. */
    if (switcher) {
      const { px, py } = hostPoint(ev);
      const [vw, vh] = viewport();
      const cardIndex = switcherCardAt(px, py, vw, vh);
      switcher.drag = { startX: px, startY: py, startPos: switcher.pos, cardIndex, mode: null, moved: false, dx: 0, dy: 0, t0: performance.now() };
      diag(`switcher down at ${Math.round(px)},${Math.round(py)} card=${cardIndex}`);
      return;
    }
    consumed = pressStart(ev);
    if (consumed) { diag(`down consumed=${consumed}`); noteInput(`down ${consumed}`); return; }
    let pt = canvasPoint(ev, true);
    { const { px, py } = hostPoint(ev);
      const h0 = hitTest(px, py);
      let pol = "drag", slot = -1, title = "";
      // Scroll and pan surfaces are the phone layout's: on the desktop every drag is a pointer drag.
      if (!narrow()) pol = "drag";
      else if (pressLayer && !pressLayer.transient && !pressLayer.shellCopy && h0.kind === "client") {
        pol = surfacePolicy(pressLayer); slot = pressLayer.slot; title = pressLayer.title;
        /* A window's scroll bars are child controls inside its reported client rectangle, so they
           look like client to the hit test. On a surface where one finger scrolls, a finger on the
           bar was therefore sending line messages to the window instead of dragging the thumb --
           "I can't touch-drag scrollbars". The strip along the client's right and bottom edges is
           a pointer drag, which is what a scroll bar wants. */
        if (pol === "scroll" && onScrollbar(h0)) { pol = "drag"; slot = -1; }
      }
      else if (insideShellDialog(h0) && tallShellDialogBottom(view.h) > view.h) { pol = "pan"; title = "shell dialog"; }   // a tall shell dialog: pan the column
      else if (insideShellClient(h0)) { pol = "scroll"; slot = SHELL_SCROLL_SLOT; title = "Program Manager"; }   // PVMON targets the active group
      shellPan = pol === "pan" ? { startY: py, base: shellPanY, panning: false } : null;
      hoverSurface = pol === "hover";
      keySwipe = pol === "keys" ? { startX: px, startY: py, map: keyGame(title), title, fired: 0, t0: performance.now() } : null;
      aimSwipe = pol === "aim" ? { startX: px, startY: py, guest: h0 && (h0.kind === "client") ? { x: h0.x, y: h0.y } : null, decided: false } : null;
      oneScroll = pol === "scroll" ? { slot, startX: px, startY: py, lastX: px, lastY: py, accX: 0, accY: 0, scrolling: false, title, layer: pressLayer, t0: performance.now(), holdTimer: 0 } : null;
      // The finger is on a surface a drag would scroll: tell the guest to watch the command
      // register closely, so the first line of scroll is not 55 ms behind the finger.
      if (oneScroll && oneScroll.slot >= 0) armFastPoll(); }
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
    // A real mouse has buttons of its own: its right button is the right button, a held left
    // button is a held left button (never a long-press right click).
    const G = g = { active: true, dragging: false, longFired: false, latest: null, timer: 0, hit: hitTest(hostPoint(ev).px, hostPoint(ev).py), scrollSurface: !!oneScroll, hover: hoverSurface, t0: performance.now(),
                    mouse: ev.type === "mousedown", right: ev.type === "mousedown" && ev.button === 2 };
    pressActive = true;
    /* Hold still on a scrolling surface, then move: the gesture becomes a guest left-button drag,
       which inside an Edit control is a text selection. The button goes down at the hold itself,
       not at the first movement, so the caret jumps to the finger the moment the hold takes --
       the guest's own version of the cue iOS gives with its magnifier. */
    if (oneScroll) {
      const S = oneScroll, PT = pt, L = S.layer;
      S.holdTimer = setTimeout(() => {
        if (oneScroll !== S || S.scrolling || !G.active || G.dragging) return;
        oneScroll = null;
        G.dragging = true; G.selecting = true; G.latest = PT; G.path = [PT];
        if (lastTap) lastTap.dragged = true;
        diag(`hold-select start at ${PT.x},${PT.y} in "${S.title}"`);
        noteInput("hold-select");
        queue(async () => { await placePointer(PT); button(true, false); await follow(G); });
        // A selection dragged to the edge of the text has to keep scrolling: an Edit only scrolls
        // on a mouse move, so while the finger sits in the edge band we keep feeding it points
        // just past the edge.
        G.edge = setInterval(() => {
          if (!G.active || !G.dragging) { clearInterval(G.edge); G.edge = 0; return; }
          const t = G.latest;
          if (!t || !L || L.gh == null) return;
          const top = t.y <= L.gy + 24, bot = t.y >= L.gy + L.gh - 24;
          if (top || bot) (G.path || (G.path = [])).push({ x: t.x, y: t.y + (bot ? 8 : -8) });
        }, 120);
      }, HOLD_MS);
    }
    queue(async () => {
      await placePointer(pt);
      if (!G.active || G.dragging) return;
      return;   // the hold is decided on the release for every surface: a still hold released = right click, a hold that moves = drag (a right-click firing mid-stroke erased Paintbrush strokes and swallowed the rest of the drag)
      G.timer = setTimeout(() => queue(async () => {          // long press is the right button
        if (!G.active || G.dragging) return;
        G.longFired = true;
        button(true, true); await sleep(60); button(false, true);
      }), LONG_PRESS_MS);
    });
  };
  const move = ev => {
    window.pvPhase = "move";
    if (switcher) {
      const D = switcher.drag;
      if (!D) return;
      const [vw, vh] = viewport();
      const pitch = switcherPitch(vw, vh);
      const { px, py } = hostPoint(ev);
      const dx = px - D.startX, dy = py - D.startY;
      D.dx = dx; D.dy = dy;
      if (!D.moved && Math.hypot(dx, dy) > 8) D.moved = true;
      if (!D.mode && D.moved) {
        if (Math.abs(dx) >= Math.abs(dy)) D.mode = "pan";
        else if (dy < 0 && D.cardIndex >= 0) D.mode = "lift";
        else if (dy > 0) D.mode = "dismiss";
        else D.mode = "none";
      }
      if (D.mode === "pan") switcher.pos = switcher.target = D.startPos - dx / pitch;
      else if (D.mode === "lift") switcher.cards[D.cardIndex].lift = Math.max(0, -dy);
      return;
    }
    if (dragMove(ev)) return;
    if (aimSwipe && !aimSwipe.decided) {
      const { px, py } = hostPoint(ev);
      const dx = px - aimSwipe.startX, dy = py - aimSwipe.startY;
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= 18) { aimSwipe.decided = true; aimSwipe.vertical = Math.abs(dy) > Math.abs(dx); }
      return;
    }
    if (aimSwipe) return;
    /* A "keys" game: a swipe is the arrow key it looks like, repeated as the finger keeps going,
       so holding a drag to the left walks the piece left. No pointer, no button. */
    if (keySwipe && keySwipe.map) {
      const { px, py } = hostPoint(ev);
      const dx = px - keySwipe.startX, dy = py - keySwipe.startY;
      const STEP = 26;
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= STEP) {
        const horiz = Math.abs(dx) >= Math.abs(dy);
        const code = horiz ? (dx > 0 ? keySwipe.map.right : keySwipe.map.left)
                           : (dy > 0 ? keySwipe.map.down : keySwipe.map.up);
        if (code) { sendScancodes(code, true); sendScancodes(code, false); keySwipe.fired++; noteInput(`key swipe ${horiz ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up")}`); }
        keySwipe.startX = px; keySwipe.startY = py;
      }
      return;
    }
    const G = g;
    if (consumed || !G || G.longFired) return;
    clearTimeout(G.timer);
    if (shellPan) {
      const { py } = hostPoint(ev);
      if (!shellPan.panning && Math.abs(py - shellPan.startY) > 8) {
        shellPan.panning = true; G.scrolled = true;
        if (lastTap) lastTap.dragged = true;
        diag(`shell pan start base=${shellPan.base} max=${tallShellDialogBottom(view.h) - view.h}`);
      }
      if (shellPan.panning) { shellPanY = shellPan.base - (py - shellPan.startY) / view.scale; shellPanClamp(view.h); }
      return;
    }
    if (oneScroll) {
      const { px, py } = hostPoint(ev);
      if (!oneScroll.scrolling && Math.hypot(px - oneScroll.startX, py - oneScroll.startY) > 8) {
        if (performance.now() - oneScroll.t0 >= HOLD_MS) {
          // held still first, then moved: a guest left-button drag from the hold point
          diag(`hold-drag start slot=${oneScroll.slot} ${oneScroll.title} after ${Math.round(performance.now() - oneScroll.t0)}ms`);
          noteInput("hold-drag");
          clearHold(); oneScroll = null;
        } else {
          clearHold();
          oneScroll.scrolling = true; G.scrolled = true;
          if (lastTap) lastTap.dragged = true;
          diag(`scroll start slot=${oneScroll.slot} ${oneScroll.title}`);
        }
      }
      if (oneScroll && oneScroll.scrolling) {
        noteFlick(oneScroll, px, py);
        oneScroll.accX += px - oneScroll.lastX; oneScroll.accY += py - oneScroll.lastY;
        const ny = Math.trunc(oneScroll.accY / SCROLL_STEP), nx = Math.trunc(oneScroll.accX / SCROLL_STEP);
        const send = (dir, n) => { if (oneScroll.slot >= 0) { armFastPoll(); sendCommand(CMD_SCROLL, oneScroll.slot | dir << 8 | Math.min(15, n) << 12); } noteInput(`scroll ${dir} ${n}`); };
        if (ny) { send(ny > 0 ? 1 : 2, Math.abs(ny)); oneScroll.accY -= ny * SCROLL_STEP; }   // finger down = content up = line up
        if (nx) { send(nx > 0 ? 3 : 4, Math.abs(nx)); oneScroll.accX -= nx * SCROLL_STEP; }
      }
      if (oneScroll) { oneScroll.lastX = px; oneScroll.lastY = py; return; }
    }
    G.latest = canvasPoint(ev);
    (G.path || (G.path = [])).push(G.latest);
    if (!G.dragging) {
      G.dragging = true;
      if (lastTap) lastTap.dragged = true;
      queue(async () => {                       // after the pointer has been placed: press, then follow
        if (!G.hover) { button(true, G.right); await sleep(30); }   // a hover surface (SkiFree) just moves the pointer
        await follow(G);
      });
    }
  };
  /* The keyboard decision at the end of a tap, made synchronously inside the gesture (iOS grants
     focus only there), from the guest's description of the focused window (PVK <want> <class>
     <flags>) or a manual hold -- never from the window's title. If the guest's last word is that
     something text-capable has the focus, the tap focuses; if not, the tap is remembered for a
     second and the focus is tried when the guest's report for this tap's click arrives (a dialog's
     Edit takes focus only after the click reaches the guest). ?kbtest=1 focuses on every tap. */
  /* Write's (and others') scrollbars are child controls inside the reported client rect, so a
     scrollbar tap looks like a client tap; the strip along the client's right and bottom edges,
     one scrollbar wide (SM_CXVSCROLL at 120 dpi is about 20 px), is treated as chrome here. */
  const onScrollbar = (hit) => {
    const w = hit.win;
    if (!w || w.gw == null) return false;
    return hit.x >= w.gx + w.gw - 24 || hit.y >= w.gy + w.gh - 24;
  };
  const tapKeyboard = (hit) => {
    const title = hit && hit.win ? hit.win.title || "" : "";
    const kbtest = params.get("kbtest") === "1";
    let why = null;
    if (kbtest) why = "kbtest";
    else if (keyboardHeld) why = "hold";                    // the caption-hold toggle, until it is toggled off
    else if (keyboardUp() && guestTextFocus()) why = "want"; // the guest still has text focus and the keyboard is up: keep it

    else if (hit && hit.kind === "desktop" && !insideShellDialog(hit)) why = null;          // icons, the desktop: never
    /* The guest says a text control has the focus (an Edit, a ComboBox, the DOS grabber's tty, a
       window that owns a caret, or a class the user taught us) — so this tap belongs to it. A
       dialog's whole window counts, because its Edit already has the focus before the tap; inside
       an app only the client outside the scrollbar strip does. */
    else if (guestTextFocus() && hit && hit.win && (hit.win.kind === "O" || (hit.kind === "client" && !onScrollbar(hit)))) why = `guest ${guestFocus.cls}/${guestFocus.flags}`;
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
    // The keyboard then stays until the guest says the focus has left a text control (PVK 0),
    // which is also how it comes down: no title, and no per-app veto, is involved.
  };
  const up = (ev) => {
    window.pvPhase = "up";
    if (switcher) {
      const D = switcher.drag; switcher.drag = null;
      if (!D) return;
      const dx = D.dx || 0, dy = D.dy || 0;
      const isTap = !D.moved && performance.now() - D.t0 < 400;
      if (isTap) {
        if (D.cardIndex >= 0) {
          const card = switcher.cards[D.cardIndex];
          sendCommand(CMD_ACTIVATE, card.slot);
          diag(`switcher activate slot ${card.slot} "${card.title}"`);
          noteInput(`switcher activate ${card.title}`);
        } else diag("switcher tap missed every card: closing");
        closeSwitcher();
        return;
      }
      if (D.mode === "lift" && D.cardIndex >= 0 && -dy > 100) {
        const card = switcher.cards[D.cardIndex];
        sendCommand(CMD_CLOSE, card.slot);
        diag(`switcher close slot ${card.slot} "${card.title}"`);
        noteInput(`switcher close ${card.title}`);
        switcher.cards.splice(D.cardIndex, 1);
        if (!switcher.cards.length) { closeSwitcher(); return; }
        let want = switcher.pos;
        if (D.cardIndex < want) want -= 1;               // the removed card shifted everything after it down by one
        switcher.target = Math.max(0, Math.min(switcher.cards.length - 1, Math.round(want)));
        return;
      }
      if (D.mode === "dismiss" && dy > 80) { diag("switcher dismissed (swipe down)"); closeSwitcher(); return; }
      if (D.mode === "lift" && D.cardIndex >= 0) switcher.cards[D.cardIndex].lift = 0;   // released without closing: settle back
      // an ordinary pan (or anything else) release: snap to the nearest card
      switcher.target = Math.max(0, Math.min(switcher.cards.length - 1, Math.round(switcher.target)));
      return;
    }
    pressActive = false;
    releaseFastPoll();
    const G = g;
    const S = oneScroll; clearHold(); oneScroll = null;
    const P = shellPan; shellPan = null;
    if (P && P.panning) { if (G) { G.active = false; clearTimeout(G.timer); } noteInput(`shell pan -> ${Math.round(shellPanY)}`); return; }   // a pan ends with nothing pressed
    diag(`up dragging=${G && G.dragging} longFired=${G && G.longFired} scrolled=${!!(S && S.scrolling)} consumed=${consumed} cursor=${JSON.stringify(guestCursor)}`);
    noteInput(`up drag=${!!(G && G.dragging)} scroll=${!!(S && S.scrolling)} consumed=${consumed}`);
    if (G) { G.active = false; clearTimeout(G.timer); if (G.edge) { clearInterval(G.edge); G.edge = 0; } }
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
        if (keyboardHeld) {
          /* The user asking for the keyboard by hand is the one fact the guest could not supply:
             remember the class that has the focus so the next window of that class raises it. */
          learnTextClass(guestFocus.cls, guestFocus.flags);
          focusKeyboard("hold");
        } else hideKeyboard("hold");
      }
      consumed = null; chromeDrag = null; return;
    }
    if (!G) return;
    if (S && S.scrolling) { const v = flickVelocity(S); startGlide(S.slot, v.vx, v.vy); return; }   // a scroll ends with nothing pressed, and glides
    if (!G.dragging && !G.longFired && !G.mouse && ev && ev.type === "touchend" && performance.now() - G.t0 >= LONG_PRESS_MS) {   // a hold released still: right button
      queue(async () => { button(true, true); await sleep(60); button(false, true); });
      return;
    }
    if (aimSwipe) {
      const A = aimSwipe; aimSwipe = null;
      if (A.guest && ev && ev.type === "touchend") {
        const want = A.decided ? A.vertical : jezzVertical;      // a plain tap keeps the current wall
        (async () => {
          if (want !== jezzVertical) {                            // flip the mode with a right click first
            await placePointer(A.guest); button(true, true); await sleep(60); button(false, true);
            jezzVertical = want; await sleep(80);
            diag(`aim: flipped to ${want ? "vertical" : "horizontal"}`);
          }
          await placePointer(A.guest); button(true, false); await sleep(60); button(false, false);
          noteInput(`aim ${want ? "vertical" : "horizontal"} at ${A.guest.x},${A.guest.y}`);
        })();
      }
      return;
    }
    if (keySwipe) {
      const K = keySwipe; keySwipe = null;
      if (!K.fired && ev && ev.type === "touchend") {
        // a tap: the second of a quick pair is the drop key (Tetris' space), a single tap is nothing
        const now = performance.now();
        if (K.map && K.map.drop && lastKeyTap && now - lastKeyTap < 400) { sendScancodes(K.map.drop, true); sendScancodes(K.map.drop, false); noteInput("key double-tap drop"); lastKeyTap = 0; }
        else lastKeyTap = now;
      }
      return;
    }
    if (!G.dragging && !G.longFired && ev && ev.type === "touchend") tapKeyboard(G.hit);
    queue(async () => {
      if (G.dragging) { if (!G.hover) button(false, G.right); diag(`drag released at ${JSON.stringify(guestCursor)}`); return; }
      if (G.longFired) return;
      button(true, G.right); await sleep(60); button(false, G.right);   // tap is a left click (a mouse: its own button)
    });
  };

  c.addEventListener("touchstart", ev => {
    unlockAudio("touchstart");
    offerClipboard("touch");                            // iOS only lets us write inside a gesture
    flushPendingShare();                                // ...and a finished print needs one too
    stopGlide();                                          // a finger down stops the glide, as it should
    // The user dismissed the keyboard with the keyboard's own key: the input is still focused but
    // nothing shows, and iOS ignores focus() on an already-focused element. Blur now so the focus
    // on this tap's release is a fresh one and brings the keyboard back.
    { const k = $("kbd"); if (k && document.activeElement === k && !softKeyboardShowing()) { k.blur(); kbdLog("touchstart: blur stale focus"); } }
    /* The caption hold latches the keyboard on (keyboardHeld) so it survives taps that the guest
       would otherwise take as "nothing text-capable has the focus". Dismissing the keyboard with
       its own key does not go through us, so the latch stayed on and every following tap brought
       it back -- "dismissing it is transient". A keyboard that is not showing when a new gesture
       starts has been dismissed, and the latch goes with it. */
    if (keyboardHeld && !softKeyboardShowing()) {
      keyboardHeld = false;
      unlearnTextClass(guestFocus.cls);
      kbdLog("touchstart: hold cleared, the keyboard was dismissed");
    }
    setGuestCursor(false);
    if (switcher && ev.touches.length !== 1) { ev.preventDefault(); return; }   // modal: no pinch/scroll behind it
    if (ev.touches.length === 2) {
      noteInput("two-finger start");
      clearHold(); oneScroll = null;
      const G = g;
      if (G) { G.active = false; clearTimeout(G.timer); if (G.dragging && !G.hover) queue(async () => button(false, false)); g = null; }
      const m = mid(ev.touches);
      const win = layerUnder(m);
      let slot = win && win.slot >= 0 ? win.slot : -1;
      if (!win) {                                          // Program Manager's groups scroll too (slot 15 = the shell)
        const r = c.getBoundingClientRect();
        if (insideShellClient(hitTest(m.x - r.left - safe.l, m.y - r.top - safe.t + keyboardShift()))) slot = SHELL_SCROLL_SLOT;
      }
      twoFinger = { last: m, accX: 0, accY: 0, dist: dist(ev.touches), win, slot,
                    t0: performance.now(), start: m, moved: false, guest: null };
      /* A two-finger TAP is a right click, the trackpad convention: no hold, so games that flip a
         mode with the right button (JezzBall's wall orientation) are playable. The guest point is
         taken now, at the midpoint, because the release has no touches left to hit-test. */
      { const r = c.getBoundingClientRect();
        const h = hitTest(m.x - r.left - safe.l, m.y - r.top - safe.t + keyboardShift());
        if (h && (h.kind === "client" || h.kind === "chrome" || h.kind === "desktop")) twoFinger.guest = { x: h.x, y: h.y }; }
      if (slot >= 0) armFastPoll();
      ev.preventDefault();
      return;
    }
    if (ev.touches.length !== 1) { clearTimeout(pressTimer); return; }
    ev.preventDefault();
    if (bottomStart(ev.touches[0])) return;             // bottom edge: the app switcher, decided on the move
    if (edgeStart(ev.touches[0])) return;              // right edge: a window switch, decided on the move
    down(ev.touches[0]);
  }, { passive: false });
  c.addEventListener("touchmove", ev => {
    if (switcher && ev.touches.length !== 1) { ev.preventDefault(); return; }   // modal: no pinch/scroll behind it
    if (twoFinger && ev.touches.length === 2) {
      ev.preventDefault();
      const m = mid(ev.touches);
      const d = dist(ev.touches);
      if (twoFinger.win) {
        const zp = layerZoom[twoFinger.win.key] || (layerZoom[twoFinger.win.key] = { z: 1, px: 0, py: 0 });
        if (Math.abs(d - twoFinger.dist) > 2) {                     // pinch: zoom the client area
          twoFinger.zoomed = true;
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
      noteFlick(twoFinger, m.x, m.y);
      twoFinger.accX += m.x - twoFinger.last.x; twoFinger.accY += m.y - twoFinger.last.y;
      twoFinger.last = m;
      const send = (dir, n) => { twoFinger.scrolled = true; if (twoFinger.slot >= 0) { armFastPoll(); sendCommand(CMD_SCROLL, twoFinger.slot | dir << 8 | Math.min(15, n) << 12); } };
      const ny = Math.trunc(twoFinger.accY / SCROLL_STEP), nx = Math.trunc(twoFinger.accX / SCROLL_STEP);
      if (ny) { send(ny > 0 ? 1 : 2, Math.abs(ny)); twoFinger.accY -= ny * SCROLL_STEP; }   // finger down = content up = line up
      if (nx) { send(nx > 0 ? 3 : 4, Math.abs(nx)); twoFinger.accX -= nx * SCROLL_STEP; }
      return;
    }
    if (ev.touches.length !== 1) return;
    ev.preventDefault();
    if (bottomSwipe && bottomMove(ev.touches[0])) return;
    if (edgeSwipe && edgeMove(ev.touches[0])) return;
    move(ev.touches[0]);
  }, { passive: false });
  /* The end of an edge gesture, from a finger or from the simulated phone's mouse. Armed but
     never a swipe means it was a tap in the margin (a scroll-bar arrow, a taskbar icon, a button
     docked against an edge): play it back as the click it would have been. */
  const endEdgeGesture = ev => {
    const tapOk = !!(ev && (ev.type === "touchend" || ev.type === "mouseup"));
    for (const which of ["bottom", "edge"]) {
      const S = which === "bottom" ? bottomSwipe : edgeSwipe;
      if (!S) continue;
      if (which === "bottom") bottomSwipe = null; else edgeSwipe = null;
      if (!S.fired && tapOk && S.tap) { down(S.tap); up({ type: ev.type }); }
      else if (!S.fired) diag(`${which} swipe cancelled`);
      unlockAudio("touchend");
      return true;
    }
    return false;
  };
  const end = ev => {
    ev.preventDefault();
    if (ev.touches.length > 0) return;      // a finger is still down: nothing ends yet
    releaseFastPoll();                      // the gesture is over: the guest goes back to its timer
    if (endEdgeGesture(ev)) return;
    const wasTwo = !!twoFinger;
    const T = twoFinger;
    if (T && T.scrolled && T.slot >= 0) { const v = flickVelocity(T); startGlide(T.slot, v.vx, v.vy); }
    twoFinger = null;
    /* Two fingers down that neither scrolled nor pinched: a right click where they landed.
       Immediate, unlike the hold-and-lift right click, which made JezzBall's wall flip awkward.
       The test is what the gesture DID, not how still the fingers were — real fingers wobble and
       land unevenly, and a 10 px / 500 ms tolerance rejected most genuine taps. */
    if (T && !T.scrolled && !T.zoomed && T.guest && ev.type === "touchend" && performance.now() - T.t0 < 1200) {
      diag(`two-finger tap: right click at ${T.guest.x},${T.guest.y}`);
      { const f = layers.filter(l => l.kind === "W" || l.kind === "O").slice(-1)[0];
        if (f && /^JezzBall/.test(f.title || "")) jezzVertical = !jezzVertical; }   // it toggles the wall too
      noteInput("two-finger right click");
      /* Straight through, not via the shared queue: a right click is atomic, and a queue still
         draining an earlier gesture (a follow loop that outlived its finger) swallowed it. */
      (async () => { await placePointer(T.guest); button(true, true); await sleep(60); button(false, true); })();
      unlockAudio("touchend");
      return;
    }
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
  /* A real mouse brings the guest's pointer back only on the phone (where a finger hid it). On a
     desktop the browser's own pointer is the visible one and the guest's stays hidden: bringing it
     back here would be the second pointer this whole exercise removes. */
  /* Inside the simulated phone the mouse is a finger: the same down/move/up pipeline the touches
     use runs already (it is the same three functions), but the two gestures that begin at an edge
     are only armed from touchstart, so they are armed here too. Everything else -- the surface
     policy, the momentum, the keyboard bar -- follows from narrow() being true inside the frame. */
  let simEdge = null;
  c.addEventListener("mousedown", ev => {
    if (ev.button !== 0 && ev.button !== 2) return;
    ev.preventDefault();
    mouseDown = true;
    if (narrow()) setGuestCursor(true);
    simEdge = null;
    if (phoneSimOn() && ev.button === 0) {
      if (bottomStart(ev)) { simEdge = "bottom"; return; }
      if (edgeStart(ev)) { simEdge = "edge"; return; }
    }
    down(ev);
  });
  /* Desktop mode: the guest pointer follows the mouse while no button is down (menus highlight,
     the cursor takes the shape of what it is over), through the same absolute placement a press
     uses, coalesced so a fast sweep never queues up behind the guest. Never while a press pipeline
     is still running: a click must land where it was pressed. */
  let hoverTarget = null, hovering = null;
  const hover = ev => {
    if (narrow() || mouseDown || pressActive || queued || !desktopReady) return;
    const { px, py } = hostPoint(ev);
    const h = hitTest(px, py);
    hoverTarget = { x: h.x, y: h.y };
    if (hovering) return;
    hovering = (async () => {
      try { while (hoverTarget && !mouseDown && !queued) { const t = hoverTarget; hoverTarget = null; await placePointer(t); } }
      finally { hovering = null; hoverTarget = null; }
    })();
  };
  window.addEventListener("mousemove", ev => {
    if (!mouseDown) { if (ev.target === c) hover(ev); return; }
    if (simEdge === "bottom" && bottomSwipe) { if (bottomMove(ev)) return; simEdge = null; }
    else if (simEdge === "edge" && edgeSwipe) { if (edgeMove(ev)) return; simEdge = null; }
    move(ev);
  });
  window.addEventListener("mouseup", ev => {
    if (!mouseDown) return;
    mouseDown = false;
    if (simEdge) { simEdge = null; endEdgeGesture(ev); return; }
    up(ev);
  });
  window.addEventListener("pointermove", ev => { if (ev.pointerType === "mouse" && narrow()) setGuestCursor(true); }, { passive: true });
  c.addEventListener("contextmenu", ev => ev.preventDefault());

  /* The wheel scrolls whatever is under the pointer, in either mode: the window under it if there
     is one, otherwise Program Manager's active group (slot 15). Windows scrolls by lines, so the
     wheel's pixels are accumulated into line steps; a trackpad's fine deltas therefore behave. */
  let wheelAcc = 0, wheelAccX = 0;
  c.addEventListener("wheel", ev => {
    ev.preventDefault();
    const { px, py } = hostPoint(ev);
    const win = layerUnder({ x: ev.clientX, y: ev.clientY });
    let slot = win && win.slot >= 0 ? win.slot : -1;
    /* On the desktop there are no placed layers -- the whole guest screen is shown as it is -- so
       hitTest can only ever answer "desktop" and the wheel scrolled Program Manager's group
       wherever the pointer was. The window under the pointer has to be found in the guest's own
       coordinates instead, front to back through the published list. */
    if (slot < 0 && !narrow()) {
      const h = hitTest(px, py);
      for (let i = layers.length - 1; i >= 0; i--) {
        const L = layers[i];
        if (L.kind !== "W" && L.kind !== "S" && L.kind !== "O") continue;
        if (h.x < L.wx || h.x >= L.wx + L.ww || h.y < L.wy || h.y >= L.wy + L.wh) continue;
        slot = L.kind === "S" ? SHELL_SCROLL_SLOT : L.slot;
        break;
      }
    }
    if (slot < 0) {
      const h = hitTest(px, py);
      if (h && (h.kind === "desktop" || h.kind === "client")) slot = h.win && h.win.slot >= 0 ? h.win.slot : SHELL_SCROLL_SLOT;
    }
    if (slot < 0) return;
    const step = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 320 : 1;   // lines / pages / pixels
    wheelAcc += ev.deltaY * step; wheelAccX += ev.deltaX * step;
    const ny = Math.trunc(wheelAcc / 40), nx = Math.trunc(wheelAccX / 40);
    /* A wheel is not a finger. A finger moving down drags the content down, so it scrolls the
       window up; a positive wheel delta means "scroll down" in every browser, so it scrolls the
       window down -- the opposite direction from the same sign in the touch path above. */
    if (ny) { armFastPoll(); sendCommand(CMD_SCROLL, slot | (ny > 0 ? 2 : 1) << 8 | Math.min(15, Math.abs(ny)) << 12); wheelAcc -= ny * 40; }
    if (nx) { armFastPoll(); sendCommand(CMD_SCROLL, slot | (nx > 0 ? 4 : 3) << 8 | Math.min(15, Math.abs(nx)) << 12); wheelAccX -= nx * 40; }
  }, { passive: false });
}

/* ------------------------------------------------------------- on-screen keyboard (SPEC 2.5)
 * Windows 3.11 has no soft keyboard, so a hidden input is focused to summon the platform one.
 */
function installKeyboard() {
  const inp = $("kbd");
  buildKeybar(); updateKeybar();
  if ($("kbdbtn")) $("kbdbtn").onclick = () => { kbdClear(inp); inp.focus(); };
  inp.addEventListener("input", ev => {
    if (ev.isComposing) return;                          // wait for the composition to end
    const text = kbdRead(inp);
    for (const ch of text) if (ch !== "\n" && ch !== "\r") queue(() => typeChar(ch));
    kbdClear(inp);                                       // newlines: handled once, in beforeinput
  });
  /* Enter and Backspace in the contenteditable: exactly one source. iOS fires keydown (sometimes
     twice, keyCode 229 then Enter) AND beforeinput/input for the same key, and preventDefault on
     the keydown does not stop the insertion, so Enter went to the guest two or three times. */
  inp.addEventListener("beforeinput", ev => {
    if (!inp.isContentEditable) return;
    const t = ev.inputType || "";
    if (t === "insertParagraph" || t === "insertLineBreak") { ev.preventDefault(); emulator.keyboard_send_text("\n"); }
    else if (t === "deleteContentBackward") { ev.preventDefault(); emulator.bus.send("keyboard-code", 0x0E); emulator.bus.send("keyboard-code", 0x8E); }
  });
  inp.addEventListener("compositionend", () => { const t = kbdRead(inp); for (const ch of t) queue(() => typeChar(ch)); kbdClear(inp); });
  inp.addEventListener("keydown", ev => {
    if (inp.isContentEditable) return;                   // handled in beforeinput
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
/* The registers live in the worker, so they cannot be read synchronously any more: the worker
   formats the same bundle (v86/src/browser/worker.js cpu_snapshot) and the watchdog keeps the
   last answer, refreshed every second alongside its other polling. */
let cpuCache = { pending: false };
function refreshCpuSnapshot() {
  if (cpuCache.pending) return;
  cpuCache.pending = true;
  emulator.cpu_snapshot().then(s => { cpuCache = Object.assign({ at: Date.now() }, s); }).catch(e => { cpuCache = { error: String(e) }; });
}
function cpuSnapshot() { const c = Object.assign({}, cpuCache); delete c.pending; return c; }
let wdLastMipsIc = 0, wdLastMipsAt = 0, wdMips = 0;
function watchdog(force) {
  const now = performance.now();
  if ((document.hidden && !force) || !desktopReady) return;
  refreshCpuSnapshot();
  try { const ic = emulator.get_instruction_counter() >>> 0; if (wdLastMipsAt) wdMips = ((ic - wdLastMipsIc) >>> 0) / (now - wdLastMipsAt) / 1000; wdLastMipsIc = ic; wdLastMipsAt = now; } catch (e) {}
  const beatStale = wd.beats > 0 && now - wd.lastBeat > 5000;
  const inputStuck = wd.lastInput && now - wd.lastInput > 5000 && wd.lastChange < wd.lastInput && now - wd.lastInput < 20000;
  if (!beatStale && !inputStuck) return;
  if (now - wd.lastBundle < 60000) return;
  wd.lastBundle = now; wd.activeSince = now;
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

if ($("bar")) {                                        // ?dev=1 only
  $("zoomin").onclick = () => setZoom(zoom * 1.25);
  $("zoomout").onclick = () => setZoom(zoom / 1.25);
  $("zoomfit").onclick = () => { setZoom(1); autoZoom = true; const b = $("screen_container"); b.scrollLeft = 0; b.scrollTop = 0; };
  $("savebtn").onclick = () => saveState(emulator);
  $("resetbtn").onclick = async () => { await clearState(); location.search = "?fresh=1&dev=1"; };
}

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
