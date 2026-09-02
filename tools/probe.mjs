#!/usr/bin/env node
/* responsive-wfw311: headless guest probe. Boots v86 in node (cold from an image, or from a boot
 * snapshot), waits for the desktop, then runs a list of steps over the bus and prints what the
 * guest reports (PVMON/PVHOOK protocol lines, layer rects, the pointer). No browser pane needed.
 *
 *   node tools/probe.mjs [--image image/x.img] [--state boot.state.gz] [--save out.state.gz] [--log] steps...
 *
 * Steps (in order):
 *   run:NOTEPAD.EXE         WinExec through PVMON (CMD_RUN)
 *   until:W:^Notepad        wait (15 s) for a W layer whose title matches the regex; sets "current"
 *   untilO                  wait for an owned window of the current slot
 *   untilT                  wait for a transient (menu) layer
 *   wait:1500               milliseconds
 *   key:0x21  chord:alt,x  keys:alt-space,x   PS/2 scancodes; names: alt ctrl shift space enter esc tab f o n x r
 *   text:hello              keyboard_send_text
 *   dump                    print every layer (kind slot x,y,w,h client) once
 *   pix:x,y,w,h             colour histogram of a frame buffer rectangle (painted vs empty)
 *   png:x,y,w,h,file        the rectangle as a PNG (8 bpp through the DAC palette)
 *   cursor:1000,500         absolute pointer to x,y and print where the guest says it landed
 *   tap                     tap the middle of the current window's client area (absolute pointer)
 *   close                   CMD_CLOSE the current slot, wait for it to go (N to a save box)
 *   shellsize:700           CMD_SHELLSIZE
 *   republish               CMD_REPUBLISH
 *   dismiss                 Enter/Esc until only the shell is left
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
const steps = [];
for (let i = 0; i < args.length; i++) {
  if (["--image", "--state", "--save"].includes(args[i])) { i++; continue; }
  if (args[i].startsWith("--")) continue;
  steps.push(args[i]);
}

const { V86 } = await import(path.join(root, "v86/src/browser/starter.js"));
const { trackGuest } = await import(path.join(root, "web/selftest.js"));

let IMAGE = val("--image"), STATE = val("--state");
if (!IMAGE) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "image/current.json"), "utf8"));
  IMAGE = path.join(root, "image", manifest.image);
  if (STATE === null) STATE = path.join(root, "image", manifest.state);
}
if (STATE === "none") STATE = null;
if (STATE && !fs.existsSync(STATE)) { console.error("no state " + STATE + ", cold boot"); STATE = null; }

const SCREEN_W = 640 * 4, SCREEN_H = 970;
const SC = { esc: 0x01, tab: 0x0F, enter: 0x1C, ctrl: 0x1D, alt: 0x38, space: 0x39, shift: 0x2A, f: 0x21, o: 0x18, x: 0x2D, n: 0x31, r: 0x13, f4: 0x3E, s: 0x1F, a: 0x1E, h: 0x23, e: 0x12, down: 0x50, right: 0x4D, left: 0x4B, up: 0x48 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
const st = trackGuest(emulator);
const log = flag("--log");
emulator.bus.register("pv-debug", line => { if (log || /^(pvmon|pvhook):/.test(line)) if (!/^PVH /.test(line)) console.log("[guest] " + line); });
let cursor = null, cursorSeq = 0;
emulator.bus.register("pv-cursor", xy => { cursor = { x: xy[0], y: xy[1] }; cursorSeq++; });

const key = async (sc, down) => { emulator.bus.send("keyboard-code", down ? sc : sc | 0x80); await sleep(30); };
const press = async sc => { await key(sc, true); await key(sc, false); };
const code = n => /^0x/i.test(n) ? parseInt(n, 16) : SC[n] ?? (() => { throw new Error("key " + n); })();
async function place(x, y) {
  const seq = cursorSeq, t0 = performance.now();
  emulator.bus.send("pv-mouse-abs", [Math.round((x + 0.5) * 65536 / SCREEN_W) & 0xFFFF, Math.round((y + 0.5) * 65536 / SCREEN_H) & 0xFFFF]);
  emulator.bus.send("mouse-delta", [1, 0]);
  while (cursorSeq === seq && performance.now() - t0 < 1200) await sleep(5);
  if (cursorSeq === seq) { emulator.bus.send("pv-command-string", [9, `${x},${y}`]); while (cursorSeq === seq && performance.now() - t0 < 2000) await sleep(5); }
  return cursorSeq !== seq ? cursor : null;
}
const click = async down => emulator.bus.send("mouse-click", [down, false, false]);
const until = async (pred, timeout, step = 40) => { const s = performance.now(); for (;;) { const v = pred(); if (v) return v; if (performance.now() - s > timeout) return null; await sleep(step); } };
const fmt = L => `${L.kind}${L.slot} win ${L.wx},${L.wy} ${L.ww}x${L.wh} client ${L.gx},${L.gy} ${L.gw}x${L.gh} "${L.title}"`;
const dump = () => { for (const L of st.layers) console.log("  " + fmt(L)); };

await new Promise(res => emulator.add_listener("emulator-ready", res));
emulator.bus.send("pv-set-dpi", 120);
emulator.bus.send("sb16-dsp-version", [2, 1]);
emulator.bus.send("pv-request-mode", [SCREEN_W, SCREEN_H]);
const t0 = performance.now();
if (STATE) {
  const snap = zlib.gunzipSync(fs.readFileSync(STATE));
  await emulator.restore_state(snap.buffer.slice(snap.byteOffset, snap.byteOffset + snap.byteLength));
  emulator.run();
  await sleep(300);
  emulator.bus.send("pv-command", [6, 0]);
} else {
  emulator.run();
}
while (!st.desktopReady && performance.now() - t0 < 240000) await sleep(100);
if (!st.desktopReady) { console.error("desktop not ready"); process.exit(1); }
if (!st.shell.h) { emulator.bus.send("pv-command", [6, 0]); await until(() => st.shell.h, 5000); }
console.log(`desktop ready in ${Math.round(performance.now() - t0)} ms (${STATE ? "snapshot" : "cold"}); shell ${st.shell.w}x${st.shell.h} pvmon v${st.shell.ver}`);
if (val("--save")) {
  await sleep(1500);
  const raw = await emulator.save_state();
  fs.writeFileSync(val("--save"), zlib.gzipSync(Buffer.from(raw)));
  console.log(`saved ${val("--save")} (${fs.statSync(val("--save")).size} bytes)`);
}

let cur = null;                // current window layer (by slot + title)
const curWin = () => cur ? st.layers.find(L => L.kind === "W" && L.slot === cur.slot) : null;
for (const s of steps) {
  const [op, ...rest] = s.split(":"); const arg = rest.join(":");
  const ts = () => `[${((performance.now() - t0) / 1000).toFixed(1)}s]`;
  if (op === "run") { emulator.bus.send("pv-command-string", [5, arg]); console.log(`${ts()} run ${arg}`); }
  else if (op === "until") {
    const [kind, ...re] = arg.split(":"); const rx = new RegExp(re.join(":"));
    const L = await until(() => st.layers.find(L => L.kind === kind && rx.test(L.title)), 20000);
    if (!L) { console.log(`${ts()} until ${arg}: TIMEOUT`); dump(); continue; }
    if (kind === "W") cur = L;
    console.log(`${ts()} until ${arg}: ${fmt(L)}`);
  }
  else if (op === "untilO") { const L = await until(() => st.layers.find(L => L.kind === "O" && (!cur || L.slot === cur.slot || L.slot === -1)), 10000); console.log(`${ts()} untilO: ${L ? fmt(L) : "TIMEOUT"}`); }
  else if (op === "untilT") { const L = await until(() => st.layers.find(L => L.kind === "T"), 8000); console.log(`${ts()} untilT: ${L ? fmt(L) : "TIMEOUT"}`); }
  else if (op === "wait") await sleep(+arg);
  else if (op === "key") await press(code(arg));
  else if (op === "chord") { const ks = arg.split(","); const mods = ks.slice(0, -1).map(code); for (const m of mods) await key(m, true); await press(code(ks[ks.length - 1])); for (const m of mods.reverse()) await key(m, false); }
  else if (op === "keys") { for (const k of arg.split(",")) { if (k.includes("-")) { const ks = k.split("-").map(code); for (const m of ks.slice(0, -1)) await key(m, true); await press(ks[ks.length - 1]); for (const m of ks.slice(0, -1).reverse()) await key(m, false); } else await press(code(k)); await sleep(150); } }
  else if (op === "text") { const map = { a: 0x1E, b: 0x30, c: 0x2E, d: 0x20, e: 0x12, f: 0x21, g: 0x22, h: 0x23, i: 0x17, j: 0x24, k: 0x25, l: 0x26, m: 0x32, n: 0x31, o: 0x18, p: 0x19, q: 0x10, r: 0x13, s: 0x1F, t: 0x14, u: 0x16, v: 0x2F, w: 0x11, x: 0x2D, y: 0x15, z: 0x2C, " ": 0x39 }; for (const ch of arg) if (map[ch]) await press(map[ch]); }
  else if (op === "pix") {
    /* what the frame buffer holds in a rectangle: 8 bpp, pitch from the adapter; the colour
       histogram tells a painted window (many colours) from unpainted desktop (one) */
    const [x, y, w, h] = arg.split(",").map(Number);
    const v = emulator.v86.cpu.devices.vga, pitch = v.svga_pitch_px(), mem = v.svga_memory, off = v.svga_offset || 0;
    const hist = new Map();
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const c = mem[off + (y + j) * pitch + x + i]; hist.set(c, (hist.get(c) || 0) + 1); }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => `${c}:${(100 * n / (w * h)).toFixed(0)}%`);
    console.log(`${ts()} pix ${x},${y} ${w}x${h}: ${hist.size} colours, top ${top.join(" ")} (bpp ${v.svga_bpp} pitch ${pitch})`);
  }
  else if (op === "png") {
    /* the frame buffer rectangle as a PNG (8 bpp through the DAC palette), for looking at a game */
    const [x, y, w, h, file] = arg.split(","); const X = +x, Y = +y, W = +w, H = +h;
    const v = emulator.v86.cpu.devices.vga, pitch = v.svga_pitch_px(), mem = v.svga_memory, off = v.svga_offset || 0, pal = v.vga256_palette;
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let j = 0; j < H; j++) { raw[j * (W * 3 + 1)] = 0; for (let i = 0; i < W; i++) { const c = pal[mem[off + (Y + j) * pitch + X + i]]; const o = j * (W * 3 + 1) + 1 + i * 3; raw[o] = c & 255; raw[o + 1] = (c >> 8) & 255; raw[o + 2] = (c >> 16) & 255; } }
    const crcT = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c; }
    const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
    const chunk = (tag, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(tag), body]); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(tb)); return Buffer.concat([len, tb, cc]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
    console.log(`${ts()} png ${X},${Y} ${W}x${H} -> ${file}`);
  }
  else if (op === "dump") { console.log(`${ts()} layers:`); dump(); }
  else if (op === "cursor") { const [x, y] = arg.split(",").map(Number); const c = await place(x, y); console.log(`${ts()} cursor asked ${x},${y} -> ${c ? c.x + "," + c.y : "no report"}`); }
  else if (op === "tap") { const L = curWin() || cur; if (!L) { console.log("tap: no window"); continue; } const x = Math.round(L.gx + L.gw / 2), y = Math.round(L.gy + L.gh / 2); const c = await place(x, y); await click(true); await sleep(60); await click(false); await sleep(400); console.log(`${ts()} tap ${x},${y} -> ${c ? c.x + "," + c.y : "no report"}`); }
  else if (op === "close") {
    if (!cur) continue;
    const slot = cur.slot, title = cur.title;
    emulator.bus.send("pv-command", [3, slot]);
    const gone = () => !st.layers.some(L => L.kind === "W" && L.slot === slot && L.title === title);
    const s0 = performance.now();
    while (!gone() && performance.now() - s0 < 8000) { const d = st.layers.filter(L => L.kind === "O" && L.slot === slot); if (d.length) { await press(SC.n); await sleep(400); } else await sleep(80); }
    console.log(`${ts()} close slot ${slot}: ${gone() ? "gone" : "STILL THERE"}`);
    cur = null;
  }
  else if (op === "shellsize") { emulator.bus.send("pv-command", [8, +arg]); await sleep(800); console.log(`${ts()} shellsize ${arg} -> shell ${st.shell.w}x${st.shell.h}`); }
  else if (op === "republish") { emulator.bus.send("pv-command", [6, 0]); await sleep(600); }
  else if (op === "dismiss") { for (let i = 0; i < 6 && st.layers.some(L => L.kind !== "S"); i++) { await press(SC.enter); await sleep(600); if (st.layers.some(L => L.kind !== "S")) { await press(SC.esc); await sleep(600); } } console.log(`${ts()} dismiss: ${st.layers.filter(L => L.kind !== "S").length} left`); }
  else console.log("unknown step " + s);
}
await emulator.stop();
process.exit(0);
