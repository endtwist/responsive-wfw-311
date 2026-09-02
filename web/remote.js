/* responsive-wfw311 - remote control for a parked phone (SPEC.md 2026-09-02).
 *
 * The phone sits on one URL (…/solitaire?remote=phone&diag=1) and this module long-polls the dev
 * server for commands, runs them in the page and posts the results back, so the device can be
 * driven from a terminal without anyone touching it. Invisible: nothing is drawn (the fallback
 * wake-lock video is a 1 px, near-transparent element). Loaded by app.js with
 *     if (params.get("remote")) import("./remote.js").then(m => m.run(params.get("remote")));
 * or by hand: import("/web/remote.js").then(m => m.run("phone")).
 *
 * Commands (POST /__cmd?device=phone, JSON {id, type, ...}):
 *   eval    {src}              async function body run in the page; `emulator`, `pvState`, `pvPresent`,
 *                              `sleep`, `tap`, `keys`, `type` in scope; returns a JSON-serialisable value
 *   shot    {}                 POST #pres as PNG to /__shot, returns the file name
 *   tour    {opts}             run web/selftest.js, returns its result (rows, pass, fail, ...)
 *   reload  {query}            location.reload, or navigate to the same path with a new query string
 *   tap     {x, y}             a real DOM TouchEvent pair on #pres at host CSS pixels
 *   type    {text}             emulator.keyboard_send_text per character (the same path as #kbd input)
 *   keys    {codes:[..]}       raw PS/2 scancodes over the bus, in order (make and break as given)
 *   ping    {}                 returns page state (visibility, viewport, wake lock, layers)
 * Results: POST /__result?device=phone {id, ok, value|error, t}. Commands older than 60 s are
 * dropped by the server; the page also refuses any it receives more than 60 s after they were made.
 */

let device = "phone", stopped = false, wake = { mode: "none" }, seq = 0;
const log = (...a) => { try { fetch("/__log", { method: "POST", body: `remote ${device} ${a.join(" ")}`, keepalive: true }); } catch (e) {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------------- staying awake
 * A phone that sleeps is a phone that cannot be driven. The Screen Wake Lock API needs a user
 * gesture the first time and is released on every hide, so it is (re)requested on the first touch
 * and on each visibilitychange; where it does not exist (older iOS) a muted, looping, 1x1 inline
 * video keeps the screen on. */
let wakeLock = null, video = null;
async function requestWake(why) {
  if (navigator.wakeLock && navigator.wakeLock.request) {
    try {
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { if (wake.mode === "wakeLock") wake = { mode: "released" }; });
      wake = { mode: "wakeLock", since: Date.now() };
      log(`wake lock acquired (${why})`);
      return;
    } catch (e) { log(`wake lock failed (${why}): ${e && e.name} ${e && e.message}`); }
  }
  if (!video) {
    video = document.createElement("video");
    video.setAttribute("playsinline", ""); video.muted = true; video.loop = true; video.playsInline = true;
    video.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:0";
    // a real 2-second, 16x16 black MP4 carried inline (TINY_MP4 below)
    video.src = "data:video/mp4;base64," + TINY_MP4;
    document.body.appendChild(video);
  }
  try { await video.play(); wake = { mode: "video", since: Date.now() }; log(`wake video playing (${why})`); }
  catch (e) { wake = { mode: "none", error: String(e && e.message || e) }; log(`wake video failed (${why}): ${e && e.message}`); }
}
/* 16x16, 2 frames, 2 s, no audio, 1515 bytes: ffmpeg -f lavfi -i color=black:s=16x16:r=1 -t 2 -pix_fmt yuv420p
   -profile:v baseline -level 1.0 -movflags +faststart -an tiny.mp4 */
const TINY_MP4 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMrbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMACDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAApAAAAAAAAAABhzdHRzAAAAAAAAAAEAAAACAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAAChgAAAAoAAAAUc3RjbwAAAAAAAAABAAADWwAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTIuMTAwAAAACGZyZWUAAAKYbWRhdAAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAOZYiEBb///w9FAAFPf4AAAAAGQZo4CvqA";

/* ------------------------------------------------------------------------- input
 * Real DOM touches on #pres (the phone's own input path), the bus for keys. */
function touch(type, x, y) {
  const pres = document.getElementById("pres");
  const r = pres.getBoundingClientRect();
  const t = new Touch({ identifier: 1, target: pres, clientX: r.left + x, clientY: r.top + y, pageX: r.left + x, pageY: r.top + y, screenX: r.left + x, screenY: r.top + y });
  const live = type === "touchend" ? [] : [t];
  pres.dispatchEvent(new TouchEvent(type, { touches: live, targetTouches: live, changedTouches: [t], bubbles: true, cancelable: true }));
}
async function tap(x, y) { touch("touchstart", x, y); await sleep(70); touch("touchend", x, y); await sleep(1200); }
async function keys(codes) { for (const c of codes) { window.emulator.bus.send("keyboard-code", c & 0xFF); await sleep(30); } }
async function type(text) { for (const ch of text) { window.emulator.keyboard_send_text(ch); await sleep(40); } }

async function shot() {
  const pres = document.getElementById("pres");
  const r = await fetch("/__shot", { method: "POST", body: pres.toDataURL("image/png") });
  return await r.text();
}
function ping() {
  const s = window.pvState ? window.pvState() : null;
  const vv = window.visualViewport;
  let ic = 0; try { ic = window.emulator.get_instruction_counter(); } catch (e) {}
  return { device, hidden: document.hidden, vis: document.visibilityState, vp: [innerWidth, innerHeight], vv: vv ? [Math.round(vv.width), Math.round(vv.height)] : null,
           dpr: devicePixelRatio, wake, ic, running: !!(window.emulator && window.emulator.is_running && window.emulator.is_running()),
           desktopReady: s && s.desktopReady, shell: s && s.shell, layers: s ? s.layers.map(l => `${l.kind}${l.slot}:${l.title}`) : null,
           active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), tour: !!window.tourRunning, href: location.href, ua: navigator.userAgent };
}

async function execute(cmd) {
  switch (cmd.type) {
    case "ping": return ping();
    case "eval": {
      const fn = new (Object.getPrototypeOf(async function () {}).constructor)("emulator", "pvState", "pvPresent", "sleep", "tap", "keys", "type", cmd.src || "");
      return await fn(window.emulator, window.pvState, window.pvPresent, sleep, tap, keys, type);
    }
    case "shot": return await shot();
    case "tour": {
      const m = await import("./selftest.js");
      return await m.run(cmd.opts || {});
    }
    case "reload": {
      const target = cmd.query !== undefined ? location.pathname + (cmd.query ? (cmd.query.startsWith("?") ? cmd.query : "?" + cmd.query) : "") : null;
      setTimeout(() => { if (target) location.href = target; else location.reload(); }, 300);
      return { reloading: target || location.href };
    }
    case "tap": await tap(+cmd.x, +cmd.y); return { tapped: [+cmd.x, +cmd.y] };
    case "type": await type(String(cmd.text || "")); return { typed: String(cmd.text || "").length };
    case "keys": await keys(cmd.codes || []); return { sent: (cmd.codes || []).length };
    default: throw new Error("unknown command type " + cmd.type);
  }
}

async function postResult(r) {
  for (let i = 0; i < 3; i++) {
    try { await fetch(`/__result?device=${encodeURIComponent(device)}`, { method: "POST", body: JSON.stringify(r), keepalive: true }); return; }
    catch (e) { await sleep(1000); }
  }
}

async function loop() {
  let backoff = 1000;
  while (!stopped) {
    let cmd = null;
    try {
      const r = await fetch(`/__cmd?device=${encodeURIComponent(device)}`, { cache: "no-store" });
      backoff = 1000;
      if (r.status === 200) cmd = await r.json();
    } catch (e) { await sleep(backoff); backoff = Math.min(15000, backoff * 2); continue; }
    if (!cmd) continue;
    if (cmd.at && Date.now() - cmd.at > 60000) { log(`ignored stale ${cmd.id} ${cmd.type}`); continue; }
    const t0 = performance.now();
    let result;
    try {
      const value = await execute(cmd);
      result = { id: cmd.id, ok: true, value: value === undefined ? null : value, t: Math.round(performance.now() - t0) };
    } catch (e) {
      result = { id: cmd.id, ok: false, error: String(e && (e.stack || e.message) || e), t: Math.round(performance.now() - t0) };
    }
    try { JSON.stringify(result); } catch (e) { result = { id: cmd.id, ok: false, error: "result not serialisable: " + e.message, t: result.t }; }
    await postResult(result);
    window.remoteLast = result;
  }
}

export async function run(name) {
  device = String(name || "phone").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "phone";
  const t0 = performance.now();
  while (!window.emulator) { if (performance.now() - t0 > 60000) break; await sleep(200); }
  document.addEventListener("touchstart", () => { if (wake.mode !== "wakeLock") requestWake("gesture"); }, { passive: true, capture: true });
  document.addEventListener("click", () => { if (wake.mode !== "wakeLock") requestWake("click"); }, { passive: true, capture: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) requestWake("visible"); });
  requestWake("load");                                   // may be refused without a gesture: retried on the first touch
  setInterval(() => { if (!document.hidden && wake.mode !== "wakeLock" && wake.mode !== "video") requestWake("retry"); }, 30000);
  log(`online ${location.href} ua=${navigator.userAgent}`);
  window.remoteState = () => ({ device, wake, stopped, last: window.remoteLast });
  window.remoteStop = () => { stopped = true; };
  loop();
  return { device };
}
