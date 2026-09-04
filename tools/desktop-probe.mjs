#!/usr/bin/env node
/* responsive-wfw311: headless desktop-mode probe (SPEC 2026-09-02, desktop mode).
 *
 * Restores the boot snapshot (phone layout) in node, then does what web/app.js does on a wide
 * viewport: CMD_REPUBLISH, CMD_DESKTOP 1 once the guest has reported its layout, the mode request
 * for the viewport's size once the guest reports desktop mode, and waits for PVA. Every layer is
 * dumped after each step and the frame buffer is written as a PNG (shots/desk-*.png), so the
 * switch can be checked without a browser pane. Then the reverse (CMD_DESKTOP 0, the phone mode)
 * is checked the same way.
 *
 *   node tools/desktop-probe.mjs [--size 1280x800] [--run SOL.EXE] [--log] [--no-back]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
globalThis.performance ??= performance;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const flag = n => args.includes(n);
const [DW, DH] = (val("--size") || "1280x800").split("x").map(Number);
const RUN = val("--run") || "SOL.EXE";

const { V86 } = await import(path.join(root, "v86/src/browser/starter.js"));
const { trackGuest } = await import(path.join(root, "web/selftest.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "image/current.json"), "utf8"));
const IMAGE = path.join(root, "image", manifest.image), STATE = path.join(root, "image", manifest.state);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCREEN_W = 3200, SCREEN_H = 970;   // the phone layout the image ships: four application columns

const emulator = new V86({
  wasm_path: path.join(root, "v86/build/v86.wasm"),
  memory_size: 32 * 1024 * 1024, vga_memory_size: 8 * 1024 * 1024,
  bios: { url: path.join(root, "v86/bios/seabios.bin") }, vga_bios: { url: path.join(root, "v86/bios/vgabios.bin") },
  hda: { url: IMAGE, async: true, fixed_chunk_size: 256 * 1024, heads: 16, sectors_per_track: 32 },
  boot_order: 0x132, autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
});
const st = trackGuest(emulator);
let mode = null, pvd = 0, pva = 0, cursor = null, cursorSeq = 0;
emulator.bus.register("pv-debug", line => {
  const m = /^PVD (\d+) (\d+)(?: (\d+))?(?: v(\d+))?(?: ([DP]))?/.exec(line);
  if (m) { pvd++; if (m[5]) mode = m[5]; }
  if (/^PVA/.test(line)) pva++;
  if (flag("--log") ? !/^PVH /.test(line) : /^(pvmon|pvhook):|^PVD|^PVA/.test(line)) console.log("[guest] " + line);
});
emulator.bus.register("pv-cursor", xy => { cursor = { x: xy[0], y: xy[1] }; cursorSeq++; });
emulator.add_listener("screen-set-size", s => console.log(`[screen] ${s[0]}x${s[1]} bpp ${s[2]}`));
const until = async (pred, timeout, step = 40) => { const s = performance.now(); for (;;) { const v = pred(); if (v) return v; if (performance.now() - s > timeout) return null; await sleep(step); } };
const fmt = L => `${L.kind}${L.slot} win ${L.wx},${L.wy} ${L.ww}x${L.wh} client ${L.gx},${L.gy} ${L.gw}x${L.gh} "${L.title}"`;
const dump = () => { for (const L of st.layers) console.log("  " + fmt(L)); };
const t0 = performance.now();
const ts = () => `[${((performance.now() - t0) / 1000).toFixed(1)}s]`;

/* The frame buffer as a PNG: 8 bpp indices through the DAC palette. */
function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function shot(name) {
  const v = emulator.v86.cpu.devices.vga, pitch = v.svga_pitch_px(), mem = v.svga_memory, off = v.svga_offset || 0;
  const w = v.svga_width, h = v.svga_height, pal = v.vga256_palette;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const c = pal[mem[off + y * pitch + x]] | 0; const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = c & 0xFF; raw[o + 1] = (c >> 8) & 0xFF; raw[o + 2] = (c >> 16) & 0xFF; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  const p = path.join(root, "shots", name); fs.writeFileSync(p, png);
  console.log(`${ts()} shot ${p} (${w}x${h})`);
}
function pix(x, y, w, h) {
  const v = emulator.v86.cpu.devices.vga, pitch = v.svga_pitch_px(), mem = v.svga_memory, off = v.svga_offset || 0;
  const hist = new Map();
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const c = mem[off + (y + j) * pitch + x + i]; hist.set(c, (hist.get(c) || 0) + 1); }
  return hist.size;
}
async function place(x, y, sw, sh) {
  const seq = cursorSeq, s0 = performance.now();
  emulator.bus.send("pv-mouse-abs", [Math.round((x + 0.5) * 65536 / sw) & 0xFFFF, Math.round((y + 0.5) * 65536 / sh) & 0xFFFF]);
  emulator.bus.send("mouse-delta", [1, 0]);
  while (cursorSeq === seq && performance.now() - s0 < 1500) await sleep(5);
  return cursorSeq !== seq ? cursor : null;
}
const click = async () => { emulator.bus.send("mouse-click", [true, false, false]); await sleep(60); emulator.bus.send("mouse-click", [false, false, false]); };

await new Promise(res => emulator.add_listener("emulator-ready", res));
emulator.bus.send("pv-set-dpi", 120);
emulator.bus.send("sb16-dsp-version", [2, 1]);
emulator.bus.send("pv-request-mode", [SCREEN_W, SCREEN_H]);
const snap = zlib.gunzipSync(fs.readFileSync(STATE));
await emulator.restore_state(snap.buffer.slice(snap.byteOffset, snap.byteOffset + snap.byteLength));
emulator.run();
emulator.bus.send("pv-request-mode", [SCREEN_W, SCREEN_H]);        // restored registers: ask again, as app.js does
await sleep(300);
emulator.bus.send("pv-command", [6, 0]);                             // CMD_REPUBLISH
if (!await until(() => mode, 8000)) { console.error("no PVD with a mode letter: PVMON < v34 in the snapshot?"); process.exit(1); }
console.log(`${ts()} restored: guest layout ${mode}, shell ${st.shell.w}x${st.shell.h} pvmon v${st.shell.ver}`);
dump();

/* --- to desktop mode, then the mode request, then wait for PVA --- */
let pva0 = pva;
emulator.bus.send("pv-command", [11, 1]);                            // CMD_DESKTOP 1
if (!await until(() => mode === "D", 8000)) { console.error("guest did not report desktop mode"); dump(); process.exit(1); }
console.log(`${ts()} guest reports desktop mode; requesting ${DW}x${DH}`);
emulator.bus.send("pv-request-mode", [DW, DH]);
if (!await until(() => pva > pva0, 20000)) { console.error("no PVA after the switch"); dump(); process.exit(1); }
await sleep(1500);
emulator.bus.send("pv-command", [6, 0]);
await until(() => st.pubSeq, 3000); await sleep(600);
console.log(`${ts()} desktop arranged: screen ${emulator.v86.cpu.devices.vga.svga_width}x${emulator.v86.cpu.devices.vga.svga_height}`);
dump();
shot(`desk-${DW}x${DH}-shell.png`);
{ const S = st.layers.find(L => L.kind === "S");
  const ok = S && S.wx >= 0 && S.wy >= 0 && S.wx + S.ww <= DW && S.wy + S.wh <= DH && S.ww > 400 && S.wh > 300;
  console.log(`${ts()} CHECK shell is a normal window inside ${DW}x${DH}: ${ok ? "PASS" : "FAIL"} ${S ? fmt(S) : "no shell"}`); }

/* --- a program: born where Windows puts it, no slot, no clamp --- */
if (RUN !== "none") {
  const pub = st.pubSeq;
  emulator.bus.send("pv-command-string", [5, RUN]);
  const W = await until(() => st.layers.find(L => L.kind === "W"), 20000);
  await sleep(2500);
  console.log(`${ts()} after run ${RUN}:`); dump();
  shot(`desk-${DW}x${DH}-app.png`);
  if (W) {
    const L = st.layers.find(l => l.kind === "W") || W;
    const ok = L.wx >= 0 && L.wy >= 0 && L.wx + L.ww <= DW && L.wy + L.wh <= DH;
    console.log(`${ts()} CHECK ${RUN} on the desktop screen (not in a slot column at x>=640 with a 352 clamp): ${ok ? "PASS" : "FAIL"} ${fmt(L)}`);
    // a click 1:1: the pointer lands where asked on the desktop-sized screen
    const x = Math.round(L.gx + L.gw / 2), y = Math.round(L.gy + 12);
    let c = await place(x, y, DW, DH);
    console.log(`${ts()} pointer to ${x},${y} normalised to the ${DW}x${DH} screen -> ${c ? c.x + "," + c.y : "no report"}`);
    c = await place(x, y, SCREEN_W, SCREEN_H);
    console.log(`${ts()} CHECK pointer to ${x},${y} normalised to the boot screen ${SCREEN_W}x${SCREEN_H}: ${c && Math.abs(c.x - x) <= 1 && Math.abs(c.y - y) <= 1 ? "PASS" : "FAIL"} -> ${c ? c.x + "," + c.y : "no report"}`);
    await click(); await sleep(300);
  }
}

/* --- a desktop resize: re-mode, windows stay --- */
{
  const w2 = DW - 160, h2 = DH - 100;
  emulator.bus.send("pv-request-mode", [w2, h2]);
  const ok = await until(() => emulator.v86.cpu.devices.vga.svga_width === w2, 10000);
  await sleep(1500);
  console.log(`${ts()} CHECK resize to ${w2}x${h2}: ${ok ? "PASS" : "FAIL"} screen ${emulator.v86.cpu.devices.vga.svga_width}x${emulator.v86.cpu.devices.vga.svga_height}, guest layout ${mode}`);
  dump();
  shot(`desk-${w2}x${h2}-resized.png`);
  emulator.bus.send("pv-request-mode", [DW, DH]);
  await until(() => emulator.v86.cpu.devices.vga.svga_width === DW, 10000); await sleep(1000);
}

/* --- and back to the phone layout --- */
if (!flag("--no-back")) {
  pva0 = pva;
  emulator.bus.send("pv-command", [11, 0]);                          // CMD_DESKTOP 0
  if (!await until(() => mode === "P", 8000)) { console.error("guest did not report phone mode"); dump(); process.exit(1); }
  emulator.bus.send("pv-request-mode", [SCREEN_W, SCREEN_H]);
  if (!await until(() => pva > pva0, 20000)) { console.error("no PVA after switching back"); dump(); process.exit(1); }
  await sleep(2500);
  emulator.bus.send("pv-command", [6, 0]); await sleep(800);
  console.log(`${ts()} phone layout again: screen ${emulator.v86.cpu.devices.vga.svga_width}x${emulator.v86.cpu.devices.vga.svga_height}`);
  dump();
  shot(`desk-back-phone.png`);
  const S = st.layers.find(L => L.kind === "S"), W = st.layers.find(L => L.kind === "W");
  const okS = S && S.wx === 0 && S.ww <= st.shell.w && S.wh <= st.shell.h;
  const okW = !W || (W.wx >= 640 && W.wx % 640 === 0 && W.ww <= 1280);
  console.log(`${ts()} CHECK shell back in its column: ${okS ? "PASS" : "FAIL"}; program parked in a slot: ${okW ? "PASS" : "FAIL"}`);
}
await emulator.stop();
process.exit(0);
