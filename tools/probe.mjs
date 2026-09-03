#!/usr/bin/env node
/* responsive-wfw311: headless guest probe. Boots v86 in node (cold from an image, or from a boot
 * snapshot), waits for the desktop, then runs a list of steps over the bus and prints what the
 * guest reports (PVMON/PVHOOK protocol lines, layer rects, the pointer). No browser pane needed.
 *
 *   node tools/probe.mjs [--image image/x.img] [--state boot.state.gz] [--save out.state.gz] [--log]
 *                        [--audio-trace] steps...
 *
 * --save writes the snapshot after the steps have run, so the steps decide what state is saved.
 * That is how the shipped boot snapshot is warmed for first-open latency (SPEC 2026-09-03).
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
 *   clickwin:dx,dy          click dx,dy from the current window's top-left corner
 *   down[:ms] / up[:ms]     left button (then wait ms, default 40)
 *   rdown[:ms] / rup[:ms]   right button — what the host's long-press-then-release sends
 *                           (web/app.js LONG_PRESS_MS): JezzBall's wall-orientation toggle
 *   hide / show             CMD_CURSOR 0 / 1 (the host hides the pointer during touch)
 *   delta:dx,dy             one relative PS/2 packet, print the report
 *   sine:x0,y0,x1,y1,n,amp[,pace]   n absolute placements along the segment displaced by amp*sin (a
 *                           freehand stroke, like web/app.js follow()); line:... is amp 0; pace = ms per point
 *   check:x0,y0,x1,y1,amp   how many samples along that sine (and along the straight chord) are painted
 *   probe[:1]               PVMON CMD_PROBE: metrics, cursor clip, pointer, capture, children of the window
 *                           under the pointer; :1 = the ClipCursor experiment
 *   beats                   PVMON heartbeat (PVH) gaps so far
 *   audio[:out.wav]         what reached the host's audio since the last `audio` step: the wave
 *                           DAC (enable/disable transitions, rates, blocks, peak), the FM
 *                           synthesiser (blocks, register writes, peak, rms) and the PC speaker.
 *                           With a file, the FM output as a 16-bit stereo WAV to listen to.
 *   close                   CMD_CLOSE the current slot, wait for it to go (N to a save box)
 *   shellsize:700           CMD_SHELLSIZE
 *   republish               CMD_REPUBLISH
 *   fast:1500               CMD_FASTPOLL: PVMON polls the command register fast for that many ms
 *   slat:slot,n[,dir,pace]  command delivery latency: n CMD_SCROLLs, ms from the send to the ack
 *   mips:1000               instructions per second over that window (the idle check)
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
/* PVMON heartbeat cadence (PVH about once a second): the gaps tell a stalled PVMON from a busy one */
const beats = [];
emulator.bus.register("pv-debug", line => { if (/^PVH /.test(line)) beats.push(performance.now()); });
const beatGaps = () => { const g = []; for (let i = 1; i < beats.length; i++) g.push(Math.round(beats[i] - beats[i - 1])); return g; };
/* Display mode changes. bpp 0 is a text mode: Windows exited (or a full-screen DOS session took
   the display), which is what the page turns into a restart from the snapshot (web/app.js). */
emulator.add_listener("screen-set-size", s => console.log(`[mode] ${s[0]}x${s[1]} bpp ${s[2]}`));
let cursor = null, cursorSeq = 0;
emulator.bus.register("pv-cursor", xy => { cursor = { x: xy[0], y: xy[1] }; cursorSeq++; });
/* Sound: with disable_speaker there is no consumer asking for samples, but the SB16 still
   announces every playback the guest starts (dac-enable) and the rate it set. */
/* ... and a headless stand-in for browser/speaker.js: pull samples on a timer the way the
   AudioWorklet does and measure them, so "did that tap play a sound?" has an answer with no
   audio device. Peak is the loudest |sample| since the last `audio` step. */
/* The FM synthesiser (v86/src/opl3.js) is a second channel: it renders at its own 49716 Hz and
   pushes blocks, so nothing has to pull it. MIDI arrives here, wave playback on the DAC above.
   The blocks are kept so the `audio` step can write them out as a WAV to listen to. The PC
   speaker is counted too, so an event sound that fell back to a bare beep is not mistaken for a
   wave that played. */
const audio = { enable: 0, disable: 0, rates: [], blocks: 0, samples: 0, peak: 0,
                opl: 0, oplSamples: 0, oplRate: 49716, keep: [], beeps: 0, beepHz: 0 };
emulator.bus.register("dac-enable", () => audio.enable++);
emulator.bus.register("dac-disable", () => audio.disable++);
emulator.bus.register("dac-tell-sampling-rate", r => { if (!audio.rates.includes(r)) audio.rates.push(r); });
emulator.bus.register("dac-send-data", d => {
  const ch = d[0]; if (!ch || !ch.length) return;
  audio.blocks++; audio.samples += ch.length;
  for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > audio.peak) audio.peak = v; }
});
setInterval(() => emulator.bus.send("dac-request-data"), 20).unref?.();
emulator.bus.register("opl-tell-sampling-rate", r => { if (r > 0) audio.oplRate = r; });
emulator.bus.register("opl-send-data", d => {
  audio.opl++; audio.oplSamples += d[0].length;
  if (audio.keep.length < 4000) audio.keep.push([d[0], d[1]]);
});
emulator.bus.register("pcspeaker-enable", () => { audio.beeps++; });
emulator.bus.register("pcspeaker-update", d => { audio.beepHz = d && d[1] ? Math.round(1193182 / d[1]) : 0; });

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
const rclick = async down => emulator.bus.send("mouse-click", [false, false, down]);
const until = async (pred, timeout, step = 40) => { const s = performance.now(); for (;;) { const v = pred(); if (v) return v; if (performance.now() - s > timeout) return null; await sleep(step); } };
const fmt = L => `${L.kind}${L.slot} win ${L.wx},${L.wy} ${L.ww}x${L.wh} client ${L.gx},${L.gy} ${L.gw}x${L.gh} "${L.title}"`;
const dump = () => { for (const L of st.layers) console.log("  " + fmt(L)); };

await new Promise(res => emulator.add_listener("emulator-ready", res));
emulator.bus.send("pv-set-dpi", 120);
emulator.bus.send("sb16-dsp-version", [2, 1]);
if (flag("--audio-trace")) emulator.bus.send("sb16-trace", true);   // DSP/DMA/IRQ and OPL register writes
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
  /* gesture pieces, for driving a program the way web/app.js does (absolute placement per point) */
  else if (op === "hide") { emulator.bus.send("pv-command", [10, 0]); await sleep(300); console.log(`${ts()} cursor hidden (CMD_CURSOR 0)`); }
  else if (op === "show") { emulator.bus.send("pv-command", [10, 1]); await sleep(300); console.log(`${ts()} cursor shown (CMD_CURSOR 1)`); }
  else if (op === "down" || op === "up") { await click(op === "down"); await sleep(+arg || 40); console.log(`${ts()} button ${op}`); }
  else if (op === "rdown" || op === "rup") { await rclick(op === "rdown"); await sleep(+arg || 40); console.log(`${ts()} right button ${op.slice(1)}`); }
  else if (op === "delta") { const [dx, dy] = arg.split(",").map(Number); const seq = cursorSeq; emulator.bus.send("mouse-delta", [dx, -dy]); await until(() => cursorSeq !== seq, 900, 5); console.log(`${ts()} delta ${dx},${dy} -> ${cursorSeq !== seq ? cursor.x + "," + cursor.y : "no report"}`); }
  else if (op === "sine" || op === "line") {
    /* x0,y0,x1,y1,n[,amp]: n absolute placements along the segment, displaced by amp*sin along the way */
    const [x0, y0, x1, y1, n, amp, pace] = arg.split(",").map(Number);
    const L = Math.hypot(x1 - x0, y1 - y0), nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
    const reps = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n, s = op === "sine" ? (amp || 0) * Math.sin(2 * Math.PI * t) : 0;
      const x = Math.round(x0 + (x1 - x0) * t + nx * s), y = Math.round(y0 + (y1 - y0) * t + ny * s);
      const c = await place(x, y);
      reps.push(c ? (c.x === x && c.y === y ? "ok" : `${c.x},${c.y}`) : "none");
      if (pace) await sleep(pace);            // ms between points (a finger moves at ~60 points/s)
    }
    console.log(`${ts()} ${op} ${n} points: reports ${reps.join(" ")}`);
  }
  else if (op === "check") {
    /* x0,y0,x1,y1,amp[,step]: how much of the sine path (and of the straight chord) is painted,
       i.e. differs from the canvas colour sampled at the segment's start corner; prints both */
    const [x0, y0, x1, y1, amp, step] = arg.split(",").map(Number);
    const v = emulator.v86.cpu.devices.vga, pitch = v.svga_pitch_px(), mem = v.svga_mem ? v.svga_mem() : v.svga_memory, off = v.svga_offset || 0;
    const px = (x, y) => mem[off + y * pitch + x];
    const L = Math.hypot(x1 - x0, y1 - y0), nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
    const bg = px(x0 + Math.round(nx * amp * 2), y0 + Math.round(ny * amp * 2));   // off the curve: the canvas
    const painted = (x, y, r = 2) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (px(x + i, y + j) !== bg) return true; return false; };
    let onCurve = 0, onChord = 0, N = 0;
    for (let d = 0; d <= L; d += step || 4) {
      const t = d / L, s = amp * Math.sin(2 * Math.PI * t);
      if (painted(Math.round(x0 + (x1 - x0) * t + nx * s), Math.round(y0 + (y1 - y0) * t + ny * s))) onCurve++;
      if (painted(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t))) onChord++;
      N++;
    }
    console.log(`${ts()} check: ${onCurve}/${N} samples painted along the sine, ${onChord}/${N} along the straight chord (bg colour ${bg})`);
  }
  else if (op === "probe") { emulator.bus.send("pv-command", [12, +arg || 0]); await sleep(400); }   // PVMON CMD_PROBE: metrics, clip, pointer, capture, children (printed as pvmon: lines)
  else if (op === "audio") {
    /* audio[:file.wav]: what has reached the host's audio since the last `audio` step - the wave
       DAC (Media Player, Windows' event sounds), the FM synthesiser (MIDI) and the PC speaker.
       With a file, the FM output is written out as a 16-bit stereo WAV to listen to or measure. */
    const file = arg && arg !== "reset" ? arg : null;
    const opl = emulator.v86.cpu.devices.sb16 ? emulator.v86.cpu.devices.sb16.opl : null;
    let fmPeak = 0, sum = 0, n = 0;
    for (const [l, r] of audio.keep) for (let i = 0; i < l.length; i++) {
      const v = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      if (v > fmPeak) fmPeak = v;
      sum += l[i] * l[i] + r[i] * r[i]; n += 2;
    }
    console.log(`${ts()} audio: dac-enable=${audio.enable} dac-disable=${audio.disable} rates=${audio.rates.join(",") || "-"}` +
      ` blocks=${audio.blocks} samples=${audio.samples} peak=${audio.peak.toFixed(3)};` +
      ` fm blocks=${audio.opl} samples=${audio.oplSamples} @${audio.oplRate}Hz` +
      (opl ? ` regwrites=${opl.writes}` : "") +
      (n ? ` peak=${fmPeak.toFixed(3)} rms=${Math.sqrt(sum / n).toFixed(4)}` : "") +
      `; beeps=${audio.beeps}${audio.beepHz ? " (" + audio.beepHz + " Hz)" : ""}`);
    if (file && audio.keep.length) {
      let total = 0; for (const [l] of audio.keep) total += l.length;
      const buf = Buffer.alloc(44 + total * 4);
      buf.write("RIFF", 0); buf.writeUInt32LE(36 + total * 4, 4); buf.write("WAVEfmt ", 8);
      buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
      buf.writeUInt32LE(audio.oplRate, 24); buf.writeUInt32LE(audio.oplRate * 4, 28);
      buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36);
      buf.writeUInt32LE(total * 4, 40);
      let o = 44;
      for (const [l, r] of audio.keep) for (let i = 0; i < l.length; i++) {
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))), o); o += 2;
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))), o); o += 2;
      }
      fs.writeFileSync(file, buf);
      console.log(`${ts()} audio: ${total} fm frames -> ${file}`);
    }
    audio.blocks = 0; audio.samples = 0; audio.peak = 0;
    audio.opl = 0; audio.oplSamples = 0; audio.beeps = 0; audio.keep.length = 0;
  }
  else if (op === "beats") { const g = beatGaps(); console.log(`${ts()} heartbeat gaps (ms): ${g.slice(-40).join(" ")}${g.length ? ` max ${Math.max(...g)}` : " none"}`); }
  /* clickwin:dx,dy - click at an offset from the current window's top-left, for a control the
     tour cannot name (Media Player's Play button is 40,163 from its origin). Survives the window
     landing in a different slot, which a fixed screen coordinate does not. */
  else if (op === "clickwin") {
    const L = curWin() || cur;
    if (!L) { console.log(`${ts()} clickwin: no window`); continue; }
    const [dx, dy] = arg.split(",").map(Number);
    const x = L.wx + dx, y = L.wy + dy;
    const c = await place(x, y);
    await click(true); await sleep(60); await click(false); await sleep(300);
    console.log(`${ts()} clickwin +${dx},${dy} -> ${x},${y} (${c ? c.x + "," + c.y : "no report"}) in "${L.title}"`);
  }
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
  /* Command delivery latency: the register is single-slot and PVMON clears it the moment it sees
     it, so the time from the send to `pv_cmd === 0` is exactly how long the command sat waiting
     for a poll. `fast:<ms>` arms PVMON's fast poll (CMD_FASTPOLL, v36+) for that many ms. */
  else if (op === "fast") { emulator.bus.send("pv-command", [13, +arg || 0]); await sleep(120); console.log(`${ts()} fastpoll ${+arg || 0} ms`); }
  /* Instructions per second over a window: the idle check. A guest in its INT 2F idle executes a
     fraction of what a spinning one does, so this tells whether the fast poll has been left on. */
  else if (op === "mips") {
    const ms = +arg || 1000, i0 = emulator.get_instruction_counter() >>> 0, t = performance.now();
    await sleep(ms);
    const d = ((emulator.get_instruction_counter() >>> 0) - i0) >>> 0;
    console.log(`${ts()} mips over ${Math.round(performance.now() - t)} ms: ${(d / (performance.now() - t) / 1000).toFixed(1)}`);
  }
  else if (op === "slat") {
    const [slotn, n, dirn, pace] = arg.split(",").map(Number);
    const vga = emulator.v86.cpu.devices.vga;
    const dir = dirn || 2, N = n || 10, ms = [];
    for (let i = 0; i < N; i++) {
      while (vga.pv_cmd !== 0) await sleep(1);
      const t = performance.now();
      emulator.bus.send("pv-command", [7, (slotn & 0xFF) | dir << 8 | 1 << 12]);
      while (vga.pv_cmd !== 0 && performance.now() - t < 1000) await sleep(1);
      ms.push(Math.round(performance.now() - t));
      if (pace) await sleep(pace);
    }
    const sorted = [...ms].sort((a, b) => a - b);
    console.log(`${ts()} slat slot=${slotn} dir=${dir} n=${N}: ${ms.join(" ")} ms  min=${sorted[0]} median=${sorted[Math.floor(N / 2)]} max=${sorted[N - 1]} mean=${(ms.reduce((a, b) => a + b, 0) / N).toFixed(1)}`);
  }
  else if (op === "dismiss") { for (let i = 0; i < 6 && st.layers.some(L => L.kind !== "S"); i++) { await press(SC.enter); await sleep(600); if (st.layers.some(L => L.kind !== "S")) { await press(SC.esc); await sleep(600); } } console.log(`${ts()} dismiss: ${st.layers.filter(L => L.kind !== "S").length} left`); }
  else console.log("unknown step " + s);
}
/* --save runs AFTER the steps, so a snapshot can be taken in a state the steps put the guest in.
   With no steps this is the plain "boot and save" it has always been; with steps it is how the
   shipped boot snapshot is warmed (SPEC 2026-09-03, first-open latency): opening and closing the
   programs the shell offers leaves them in Windows' own file cache, which is part of the saved
   RAM, so a visitor's first tap needs no disk at all. */
if (val("--save")) {
  await sleep(1500);
  const raw = await emulator.save_state();
  fs.writeFileSync(val("--save"), zlib.gzipSync(Buffer.from(raw)));
  console.log(`saved ${val("--save")} (${fs.statSync(val("--save")).size} bytes)`);
}
await emulator.stop();
process.exit(0);
