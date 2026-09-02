#!/usr/bin/env node
/* responsive-wfw311: the app tour, headless (PLAN.md Fix 5).
 *
 * Boots v86 in node from image/current.json (image + boot snapshot), waits for the desktop and runs
 * web/selftest.js's tour over the bus: every stock app launched, geometry invariant checked, a tap
 * through the absolute pointer, one dialog where cheap, close, guest alive. No DOM: the host-layer
 * scale, DOM keyboard focus and pixel checks are skipped. Prints the table, exits 1 on failures.
 *
 *   node tools/tour.mjs                      # everything
 *   node tools/tour.mjs --apps NOTEPAD,CALC  # a subset
 *   node tools/tour.mjs --lenient            # dialog/owner overlap is informational (before Fix 2)
 *   node tools/tour.mjs --log                # echo the guest's protocol lines
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
globalThis.performance ??= performance;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const { V86 } = await import(path.join(root, "v86/src/browser/starter.js"));
const { tour, trackGuest, table } = await import(path.join(root, "web/selftest.js"));

const manifest = JSON.parse(fs.readFileSync(path.join(root, "image/current.json"), "utf8"));
const IMAGE = path.join(root, "image", manifest.image);
const STATE = path.join(root, "image", manifest.state);
for (const f of [IMAGE, STATE, path.join(root, "v86/build/v86.wasm")])
  if (!fs.existsSync(f)) { console.error("missing " + f + " (copy it from the main checkout's image/ or v86/build/)"); process.exit(2); }

if (!flag("--log")) { const orig = console.log; console.log = (...a) => { if (!/^\[guest\]/.test(String(a[0]))) orig(...a); }; }

const emulator = new V86({
  wasm_path: path.join(root, "v86/build/v86.wasm"),
  memory_size: 32 * 1024 * 1024,
  vga_memory_size: 8 * 1024 * 1024,
  bios: { url: path.join(root, "v86/bios/seabios.bin") },
  vga_bios: { url: path.join(root, "v86/bios/vgabios.bin") },
  hda: { url: IMAGE, async: true, fixed_chunk_size: 256 * 1024, heads: 16, sectors_per_track: 32 },
  boot_order: 0x132,
  autostart: false,
  disable_keyboard: true, disable_mouse: true, disable_speaker: true,
});

const state = trackGuest(emulator);        // registered before anything is published
let cursor = null, cursorSeq = 0;
emulator.bus.register("pv-cursor", xy => { cursor = { x: xy[0], y: xy[1] }; cursorSeq++; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCREEN_W = 640 * 4, SCREEN_H = 970;   // the snapshot's mode (app.js: SLOT_W * (1 + MAX_SLOTS) x SHELL_H)

/* The absolute pointer path a tap takes on the phone (PVMOUSE.DRV): position in the adapter
   registers, any PS/2 packet raises the interrupt, the driver reports where it landed. */
async function place(x, y) {
  const seq = cursorSeq, t0 = performance.now();
  emulator.bus.send("pv-mouse-abs", [Math.round((x + 0.5) * 65536 / SCREEN_W) & 0xFFFF, Math.round((y + 0.5) * 65536 / SCREEN_H) & 0xFFFF]);
  emulator.bus.send("mouse-delta", [1, 0]);
  while (cursorSeq === seq && performance.now() - t0 < 1200) await sleep(5);
  if (cursorSeq === seq) { emulator.bus.send("pv-command-string", [9, `${x},${y}`]); while (cursorSeq === seq && performance.now() - t0 < 2000) await sleep(5); }
}
const click = async (down) => emulator.bus.send("mouse-click", [down, false, false]);
const env = {
  emulator, dom: false, ua: `node/${process.versions.node} ${process.platform}`, state,
  post: line => console.log(line),
  tapGuest: async (x, y) => { await place(x, y); await click(true); await sleep(60); await click(false); await sleep(400); },
  dragGuest: async (x0, y0, x1, y1) => {
    await place(x0, y0); await click(true); await sleep(60);
    for (let i = 1; i <= 6; i++) { await place(Math.round(x0 + (x1 - x0) * i / 6), Math.round(y0 + (y1 - y0) * i / 6)); await sleep(30); }
    await click(false); await sleep(400);
  },
};

const ready = new Promise(res => emulator.add_listener("emulator-ready", res));
await ready;
emulator.bus.send("pv-set-dpi", 120);
emulator.bus.send("sb16-dsp-version", [2, 1]);
emulator.bus.send("pv-request-mode", [SCREEN_W, SCREEN_H]);
const snap = zlib.gunzipSync(fs.readFileSync(STATE));
await emulator.restore_state(snap.buffer.slice(snap.byteOffset, snap.byteOffset + snap.byteLength));
emulator.run();
await sleep(300);
emulator.bus.send("pv-command", [6, 0]);    // CMD_REPUBLISH: PVD, PVA, then the layout
const t0 = performance.now();
while (!state.desktopReady && performance.now() - t0 < 60000) await sleep(100);
if (!state.desktopReady) { console.error("desktop not ready after restore"); process.exit(1); }
console.error(`desktop ready in ${Math.round(performance.now() - t0)} ms; shell ${state.shell.w}x${state.shell.h} pvmon v${state.shell.ver}`);

const opts = {};
if (val("--apps")) opts.apps = val("--apps").split(",").map(s => s.trim().toUpperCase());
if (flag("--lenient")) opts.strictDialogs = false;
const result = await tour(env, opts);
console.log("\n" + table(result));
if (val("--json")) fs.writeFileSync(val("--json"), JSON.stringify(result, null, 1));
await emulator.stop();
process.exit(result.fail ? 1 : 0);
