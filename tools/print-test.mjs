#!/usr/bin/env node
/* responsive-wfw311: headless print test. Cold-boots an image (no snapshot, so any WIN.INI printer
   setup is exercised), prints from Paintbrush (a few strokes), Write
   (README.WRI) and Cardfile; save each job, convert with local Ghostscript, render page 1 to PNG.
   node tools/print-test.mjs [--image image/work-phone.img] [--apps PBRUSH,WRITE,CARDFILE,NOTEPAD] [--out shots/print-test]
   Needs v86/build/v86.wasm, v86/bios/*.bin and gs (Ghostscript) on the PATH. Exit 1 if a job did not arrive. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
globalThis.performance ??= performance;
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const IMAGE = path.resolve(val("--image", path.join(root, "image/work-phone.img")));
const APPS = val("--apps", "PBRUSH,WRITE,CARDFILE").split(",");
const OUT = val("--out", path.join(root, "shots", "print-test"));
fs.mkdirSync(OUT, { recursive: true });
const { V86 } = await import(path.join(root, "v86/src/browser/starter.js"));
const { trackGuest } = await import(path.join(root, "web/selftest.js"));
const glog = fs.createWriteStream(path.join(OUT, "guest.log"));
const orig = console.log; console.log = (...a) => { const s = String(a[0]); if (/^\[guest\]/.test(s)) glog.write(s + "\n"); else orig(...a); };
const emulator = new V86({
  wasm_path: path.join(root, "v86/build/v86.wasm"), memory_size: 32 * 1024 * 1024, vga_memory_size: 8 * 1024 * 1024,
  bios: { url: path.join(root, "v86/bios/seabios.bin") }, vga_bios: { url: path.join(root, "v86/bios/vgabios.bin") },
  hda: { url: IMAGE, async: true, fixed_chunk_size: 256 * 1024, heads: 16, sectors_per_track: 32 },
  boot_order: 0x132, autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
});
const st = trackGuest(emulator);
let job = null; const jobs = [];
emulator.bus.register("pv-debug", l => {
  if (/^PVP-BEGIN /.test(l)) job = [];
  else if (/^PVP /.test(l)) { if (job) job.push(l.slice(4)); }
  else if (/^PVP-END/.test(l)) { if (job) jobs.push(Buffer.from(job.join(""), "base64")); job = null; }
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCREEN_W = 640 * 4, SCREEN_H = 970;
let cursorSeq = 0; emulator.bus.register("pv-cursor", () => cursorSeq++);
await new Promise(res => emulator.add_listener("emulator-ready", res));
emulator.bus.send("pv-set-dpi", 120); emulator.bus.send("sb16-dsp-version", [2, 1]); emulator.bus.send("pv-request-mode", [SCREEN_W, SCREEN_H]);
emulator.run();
let t0 = performance.now();
while (!st.desktopReady && performance.now() - t0 < 180000) await sleep(100);
if (!st.desktopReady) { console.error("desktop not ready"); process.exit(1); }
console.log(`desktop ready; pvmon v${st.shell.ver}`);
await sleep(3000);
const bus = (n, v) => emulator.bus.send(n, v);
const key = async (sc, down) => { bus("keyboard-code", down ? sc : sc | 0x80); await sleep(40); };
const press = async sc => { await key(sc, true); await key(sc, false); await sleep(80); };
const chord = async (mod, sc) => { await key(mod, true); await press(sc); await key(mod, false); };
async function place(x, y) {
  const seq = cursorSeq, t = performance.now();
  bus("pv-mouse-abs", [Math.round((x + 0.5) * 65536 / SCREEN_W) & 0xFFFF, Math.round((y + 0.5) * 65536 / SCREEN_H) & 0xFFFF]);
  bus("mouse-delta", [1, 0]);
  while (cursorSeq === seq && performance.now() - t < 1200) await sleep(5);
}
const click = down => bus("mouse-click", [down, false, false]);
async function drag(x0, y0, x1, y1) {
  await place(x0, y0); await click(true); await sleep(80);
  for (let i = 1; i <= 12; i++) { await place(Math.round(x0 + (x1 - x0) * i / 12), Math.round(y0 + (y1 - y0) * i / 12)); await sleep(40); }
  await click(false); await sleep(300);
}
const layers = () => st.layers.map(L => `${L.kind}${L.slot}:${L.title}(${L.wx},${L.wy},${L.ww}x${L.wh} client ${L.gx},${L.gy},${L.gw}x${L.gh})`).join(" | ");
const winOf = re => st.layers.find(L => L.kind === "W" && re.test(L.title));
const until = async (pred, ms) => { const t = performance.now(); while (!pred() && performance.now() - t < ms) await sleep(100); return pred(); };
async function waitJob(n, ms) { const t = performance.now(); while (jobs.length < n && performance.now() - t < ms) await sleep(200); return jobs.length >= n; }
async function closeApp(slot) { bus("pv-command", [3, slot]); await sleep(1500); await press(0x31); /* N: don't save */ await sleep(1500); }

const results = [];
for (const app of APPS) {
  const n0 = jobs.length;
  let cmd = app + ".EXE", re = /./;
  if (app === "WRITE") { cmd = "WRITE.EXE C:\\WINDOWS\\README.WRI"; re = /Write/; }
  if (app === "PBRUSH") re = /Paintbrush/;
  if (app === "CARDFILE") re = /Cardfile/;
  if (app === "NOTEPAD") re = /Notepad/;
  bus("pv-command-string", [5, cmd]);
  if (!await until(() => winOf(re), 25000)) { console.log(`${app}: no window; ${layers()}`); results.push({ app, ok: false }); continue; }
  await sleep(3000);
  const W = winOf(re);
  console.log(`${app} up: ${layers()}`);
  if (app === "PBRUSH") {
    // a few strokes with the default brush inside the canvas (client area, below the tool/menu rows)
    const cx = W.gx + 40, cy = W.gy + 60, cw = W.gw - 60, ch = W.gh - 100;
    await drag(cx + 20, cy + 20, cx + cw - 20, cy + ch - 20);
    await drag(cx + cw - 20, cy + 20, cx + 20, cy + ch - 20);
    await drag(cx + 20, cy + ch / 2, cx + cw - 20, cy + ch / 2);
    await drag(cx + cw / 2, cy + 20, cx + cw / 2, cy + ch - 20);
    await sleep(500);
  }
  if (app === "CARDFILE") {
    // one card with some text: F7 = Add, type index line, Enter, type body
    await press(0x41); await sleep(1500); for (const c of [0x19, 0x20, 0x21]) await press(c); await press(0x1c); await sleep(1000);
    for (const c of [0x23, 0x12, 0x26, 0x26, 0x18, 0x39, 0x2e, 0x1e, 0x13, 0x20]) await press(c); await sleep(500);
  }
  await chord(0x38, 0x21); await sleep(1000);          // Alt+F
  await press(0x19); await sleep(2500);                 // P
  console.log(`${app} after Print: ${layers()}`);
  if (st.layers.some(L => L.kind === "O" && /Print/i.test(L.title))) { await press(0x1c); }  // OK the Print dialog
  const got = await waitJob(n0 + 1, 90000);
  console.log(`${app}: job ${got ? jobs[jobs.length - 1].length + " bytes" : "NOT received"}; ${layers()}`);
  if (got) {
    const ps = jobs[jobs.length - 1];
    const base = path.join(OUT, app.toLowerCase());
    fs.writeFileSync(base + ".ps", ps);
    try {
      execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite", "-sOutputFile=" + base + ".pdf", base + ".ps"], { stdio: "pipe" });
      execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=png16m", "-r50", "-dFirstPage=1", "-dLastPage=1", "-sOutputFile=" + base + ".png", base + ".pdf"], { stdio: "pipe" });
      console.log(`${app}: ${base}.pdf ${fs.statSync(base + ".pdf").size} bytes, ${base}.png`);
    } catch (e) { console.log(`${app}: ghostscript failed: ${e.stderr}`); }
  }
  results.push({ app, ok: got });
  await sleep(2000);
  const w = winOf(re); if (w) await closeApp(w.slot);
  await until(() => !winOf(re), 8000);
  console.log(`${app} closed: ${layers()}`);
}
console.log(JSON.stringify(results));
await emulator.stop();
process.exit(results.every(r => r.ok) ? 0 : 1);
