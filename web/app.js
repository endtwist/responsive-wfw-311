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
const MIN_W = 640, MIN_H = 400, MAX_W = 2560, MAX_H = 1600;

function viewport() {
  const vv = window.visualViewport;
  let w = vv ? vv.width : window.innerWidth;
  let h = vv ? vv.height : window.innerHeight;
  if (!(w > 0) || !(h > 0)) { w = 1024; h = 768; }
  return [w, h];
}

function computeMode() {
  const [vw, vh] = viewport();
  let zoom = Math.max(1, MIN_W / vw, MIN_H / vh);
  zoom = Math.min(zoom, MAX_W / vw, MAX_H / vh);
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.floor(vw * zoom / 8) * 8));
  const h = Math.max(MIN_H, Math.min(MAX_H, Math.floor(vh * zoom / 2) * 2));
  return { w, h, zoom };
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
});

/* The guest reports where it thinks the pointer is, which is what lets a tap become the right
   relative motion for the stock PS/2 mouse driver (SPEC 2.5). */
let guestCursor = null;
emulator.bus.register("pv-cursor", xy => { guestCursor = { x: xy[0], y: xy[1] }; });
window.pvGuestCursor = () => guestCursor;

/* ------------------------------------------------------------------------- mode controller */
let lastReq = null;
function requestMode(force) {
  const { w, h, zoom } = computeMode();
  if (!force && lastReq && Math.abs(lastReq.w - w) < 8 && Math.abs(lastReq.h - h) < 8) return;
  lastReq = { w, h };
  emulator.bus.send("pv-request-mode", [w, h]);
  $("zoom").textContent = zoom === 1 ? "" : `scale ${zoom.toFixed(2)}`;
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

/* The canvas is the emulated screen; CSS-scale it to fill the viewport when the emulated mode
   had to be larger than the viewport (small screens). */
function fitCanvas() {
  const c = document.querySelector("#screen_container canvas");
  if (!c || !c.width) return;
  const [vw, vh] = viewport();
  const scale = Math.min(vw / c.width, vh / c.height);
  const w = Math.round(c.width * scale), h = Math.round(c.height * scale);
  if (c.style.width === w + "px" && c.style.height === h + "px") return;
  c.style.width = w + "px";
  c.style.height = h + "px";
  c.style.imageRendering = Number.isInteger(scale) ? "pixelated" : "auto";
}

/* ------------------------------------------------------------------------ touch (SPEC 2.5)
 * PS/2 is relative, so pointing is done by steering the guest cursor towards the target using
 * the position the driver reports, correcting a few times to absorb any scaling.
 */
const LONG_PRESS_MS = 500;

function canvasPoint(ev) {
  const c = document.querySelector("#screen_container canvas");
  const r = c.getBoundingClientRect();
  return {
    x: Math.round((ev.clientX - r.left) / r.width * c.width),
    y: Math.round((ev.clientY - r.top) / r.height * c.height),
  };
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
  const c = document.querySelector("#screen_container canvas");
  if (!c || touchInstalled) return;
  touchInstalled = true;
  // Steering the pointer takes several packets, so the gesture handlers are serialised: a
  // press that lands while the pointer is still moving would drag whatever is under it.
  let chain = Promise.resolve();
  const queue = fn => (chain = chain.then(fn).catch(() => {}));
  let pressTimer = 0, longFired = false, dragging = false;

  c.addEventListener("touchstart", ev => {
    if (ev.touches.length !== 1) return;
    ev.preventDefault();
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
    if (ev.touches.length !== 1) return;
    ev.preventDefault();
    clearTimeout(pressTimer);
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
    queue(async () => {
      if (dragging) { button(false, false); dragging = false; return; }
      if (longFired) { longFired = false; return; }
      button(true, false); await sleep(60); button(false, false);   // tap is a left click
    });
  }, { passive: false });
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
$("savebtn").onclick = () => saveState(emulator);
$("resetbtn").onclick = async () => { await clearState(); location.search = "?fresh=1"; };

emulator.add_listener("emulator-started", () => { installTouch(); installKeyboard(); fitCanvas(); });
setTimeout(() => { installTouch(); installKeyboard(); }, 3000);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
