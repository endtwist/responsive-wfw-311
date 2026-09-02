#!/usr/bin/env node
/* responsive-wfw311: where does redraw time go? Boots v86 headless from image/current.json (like
 * tools/probe.mjs), then times repaint operations and reports, per operation:
 *   - guest instructions, emulator busy time (sum of main_loop slices that did not end halted),
 *   - A000 window accesses seen by JS (vga_memory_write/read) and taken by the rust planar fast
 *     path (pv_planar_stat), DISPI bank-register writes (READ/WRITE_BANK, 16-bit pairs or the
 *     32-bit atomic form), #GP/#PF counts from the wasm (pv_exc_stat),
 *   - a CS:IP sample per slice weighted by slice wall time, attributed to guest modules by byte
 *     matching against the module files (extracted from the image with mcopy) and to PVDISP.DRV
 *     symbols from guest/driver/build/PVDISP.MAP,
 *   - an FNV hash of the visible frame buffer, to compare two runs for pixel-exactness.
 *
 *   node tools/redraw-bench.mjs [--ops progman,notepad,winfile,sol,pbrush] [--nofast] [--json out] [--log]
 *   --nofast keeps every A000 write in JS (vga.pv_planar_disabled), for A/B against the rust path.
 *
 * Caveat: the CS:IP sample is taken where a main_loop slice ends, which is biased towards places
 * where the JIT exits (exception handlers, far calls), so "hot" is indicative; the counters are exact.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
globalThis.performance ??= performance;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const flag = n => args.includes(n);
const OPS = (val("--ops") || "progman,notepad,winfile,sol").split(",");
const imageDir = path.join(root, "image");
const DRV = val("--drv") || path.join(imageDir, "changes/system/PVDISP.DRV");
const MAP = val("--map") || path.join(root, "guest/driver/build/PVDISP.MAP");

const { V86 } = await import(path.join(root, "v86/src/browser/starter.js"));
const { trackGuest } = await import(path.join(root, "web/selftest.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(imageDir, "current.json"), "utf8"));
const IMAGE = val("--image") || path.join(imageDir, manifest.image);
const STATE = val("--state") || path.join(imageDir, manifest.state);
for (const f of [IMAGE, STATE, path.join(root, "v86/build/v86.wasm"), path.join(root, "v86/bios/seabios.bin")])
  if (!fs.existsSync(f)) { console.error("missing " + f); process.exit(2); }
const SCREEN_W = 2560, SCREEN_H = 970;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* module files for attribution: extracted from the image (mcopy from mtools), else CS numbers only */
let modsDir = val("--mods");
if (!modsDir) {
  modsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfw-mods-"));
  const files = ["WINDOWS/SYSTEM/GDI.EXE", "WINDOWS/SYSTEM/USER.EXE", "WINDOWS/SYSTEM/KRNL386.EXE", "WINDOWS/SYSTEM/PVDISP.DRV", "WINDOWS/SYSTEM/COMMDLG.DLL", "WINDOWS/SYSTEM/SHELL.DLL", "WINDOWS/PROGMAN.EXE", "WINDOWS/PVMON.EXE", "WINDOWS/PVHOOK.DLL", "WINDOWS/SOL.EXE", "WINDOWS/WINFILE.EXE", "WINDOWS/NOTEPAD.EXE", "WINDOWS/PBRUSH.EXE"];
  try { execFileSync("mcopy", ["-n", "-i", IMAGE + "@@16384", ...files.map(f => "::/" + f), modsDir + "/"], { stdio: "ignore" }); }
  catch (e) { console.error("mcopy failed (" + e.message.split("\n")[0] + "); modules will be named by selector only"); }
}

const emulator = new V86({
  wasm_path: val("--wasm") || path.join(root, "v86/build/v86.wasm"),
  memory_size: 32 * 1024 * 1024, vga_memory_size: 8 * 1024 * 1024,
  bios: { url: path.join(root, "v86/bios/seabios.bin") }, vga_bios: { url: path.join(root, "v86/bios/vgabios.bin") },
  hda: { url: IMAGE, async: true, fixed_chunk_size: 256 * 1024, heads: 16, sectors_per_track: 32 },
  boot_order: 0x132, autostart: false, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
});
const st = trackGuest(emulator);
if (flag("--log")) emulator.bus.register("pv-debug", line => console.log("[guest] " + line));
await new Promise(res => emulator.add_listener("emulator-ready", res));
const cpu = emulator.v86.cpu, vga = cpu.devices.vga;
if (flag("--nofast")) { vga.pv_planar_disabled = true; vga.pv_planar_sync(); }
const wexp = n => { try { return cpu.wm.exports[n](...[].slice.call(arguments, 1)) >>> 0; } catch (e) { return 0; } };
const excStat = i => { try { return cpu.wm.exports.pv_exc_stat(i) >>> 0; } catch (e) { return 0; } };
const planarStat = () => { try { return cpu.wm.exports.pv_planar_stat() >>> 0; } catch (e) { return 0; } };
const fbhash = () => { const m = vga.svga_mem ? vga.svga_mem() : vga.svga_memory; let h = 0x811c9dc5; for (let y = 0; y < SCREEN_H; y++) { const row = y * 4096; for (let x = 0; x < SCREEN_W; x++) { h ^= m[row + x]; h = Math.imul(h, 0x01000193); } } return (h >>> 0).toString(16); };

/* ---- counters ---- */
const C = { a000w: 0, a000r: 0, dispiIdx: 0, dispiData: 0, bank: 0, bankSame: 0, cursorReg: 0, other: 0 };
const lastBank = { 0x18: -1, 0x19: -1 };
const blk = 0xA0000 >>> 17;
const ow = cpu.memory_map_write8[blk], orr = cpu.memory_map_read8[blk];
const writeSites = new Map(); let sampleEvery = 0;
cpu.memory_map_write8[blk] = (a, v) => {
  C.a000w++;
  if (sampleEvery && (C.a000w % sampleEvery) === 0) { const k = cpu.sreg[1] * 65536 + ((cpu.instruction_pointer[0] - cpu.segment_offsets[1]) & 0xFFFF); writeSites.set(k, (writeSites.get(k) || 0) + 1); }
  ow(a, v);
};
cpu.memory_map_read8[blk] = a => { C.a000r++; return orr(a); };
const countData = (i, d) => { C.dispiData++; if (i === 0x18 || i === 0x19) { C.bank++; if (lastBank[i] === d) C.bankSame++; lastBank[i] = d; } else if (i === 0x14 || i === 0x15) C.cursorReg++; else C.other++; };
const P = cpu.io.ports;
for (const [port, name] of [[0x1CE, "idx"], [0x1CF, "data"]]) {
  for (const w of ["write8", "write16", "write32"]) {
    const o = P[port][w]; if (!o) continue;
    P[port][w] = name === "idx"
      ? function (v) { if (w === "write32") countData(v & 0xFFFF, v >>> 16); else C.dispiIdx++; return o.call(this, v); }
      : function (v) { countData(vga.dispi_index, v); return o.call(this, v); };
  }
}
/* slice profiler */
const prof = { on: false, samples: new Map(), t: 0, instr: 0, slices: 0, byRing: [0, 0, 0, 0], haltT: 0 };
const origLoop = cpu.main_loop;
cpu.main_loop = function () {
  const t0 = performance.now(), i0 = cpu.instruction_counter[0] >>> 0;
  const r = origLoop.call(this);
  if (prof.on) {
    const dt = performance.now() - t0, di = ((cpu.instruction_counter[0] >>> 0) - i0) >>> 0;
    if (cpu.in_hlt[0]) { prof.haltT += dt; return r; }
    prof.t += dt; prof.instr += di; prof.slices++;
    const cs = cpu.sreg[1], ip = (cpu.instruction_pointer[0] - cpu.segment_offsets[1]) >>> 0, cpl = cpu.cpl[0];
    const k = `${cpl}:${cs.toString(16)}:${(ip >>> 4).toString(16)}`;
    const e = prof.samples.get(k) || { t: 0, n: 0, instr: 0, cs, ip, cpl };
    e.t += dt; e.n++; e.instr += di; prof.samples.set(k, e);
    prof.byRing[cpl] += dt;
  }
  return r;
};

/* ---- attribution ---- */
const mods = {};
for (const f of fs.readdirSync(modsDir)) mods[f] = fs.readFileSync(path.join(modsDir, f));
function neSegments(buf) {
  const ne = buf.readUInt16LE(0x3C), cseg = buf.readUInt16LE(ne + 0x1C), segtab = buf.readUInt16LE(ne + 0x22), shift = buf.readUInt16LE(ne + 0x32);
  const out = [];
  for (let i = 0; i < cseg; i++) { const off = buf.readUInt16LE(ne + segtab + i * 8) << shift; const len = buf.readUInt16LE(ne + segtab + i * 8 + 2) || 0x10000; out.push({ n: i + 1, data: buf.subarray(off, off + len) }); }
  return out;
}
const drvSegs = fs.existsSync(DRV) ? neSegments(fs.readFileSync(DRV)) : [];
const mapSyms = [];
if (fs.existsSync(MAP)) for (const line of fs.readFileSync(MAP, "utf8").split(/\r?\n/)) { const m = /^\s*([0-9A-F]{4}):([0-9A-F]{4})\s+(\S+)/.exec(line); if (m) mapSyms.push({ seg: parseInt(m[1], 16), off: parseInt(m[2], 16), name: m[3] }); }
mapSyms.sort((a, b) => a.seg - b.seg || a.off - b.off);
function symbolize(seg, off) {
  let best = null; for (const s of mapSyms) { if (s.seg === seg && s.off <= off) best = s; else if (s.seg > seg) break; }
  return best ? `${best.name}+${(off - best.off).toString(16)}` : `seg${seg}:${off.toString(16)}`;
}
function descBase(sel) {
  try {
    let tbase, tlimit;
    if (sel & 4) { tbase = cpu.segment_offsets[7]; tlimit = cpu.segment_limits[7]; } else { tbase = cpu.gdtr_offset[0]; tlimit = cpu.gdtr_size[0]; }
    const off = sel & ~7; if (off > tlimit) return null;
    const p = cpu.translate_address_system_read(tbase + off);
    const b = i => cpu.read8(p + i);
    return b(2) | b(3) << 8 | b(4) << 16 | b(7) << 24;
  } catch (e) { return null; }
}
function readLinear(lin, n) {
  const out = Buffer.alloc(n);
  try { for (let i = 0; i < n; i++) out[i] = cpu.read8(cpu.translate_address_system_read(lin + i)); } catch (e) { return null; }
  return out;
}
const csCache = new Map();
function attribute(cs, ip, cpl) {
  if (cpl === 0) return { mod: "ring0(VMM/VxD)" };
  if (csCache.has(cs)) return csCache.get(cs);
  const base = descBase(cs); const r = { mod: `cs${cs.toString(16)}` };
  if (base !== null) {
    const probes = [0, 0x40, 0x100, 0x200, ip & ~0xF, (ip & ~0xF) + 0x30];
    const votes = {};
    for (const o of probes) { const bytes = readLinear(base + o, 24); if (!bytes) continue; for (const [m, buf] of Object.entries(mods)) if (buf.indexOf(bytes) >= 0) votes[m] = (votes[m] || 0) + 1; }
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    if (best) {
      r.mod = best[0].replace(/\.(EXE|DRV|DLL)$/, "") + `(cs${cs.toString(16)})`;
      if (best[0] === "PVDISP.DRV") for (const o of probes) { const bytes = readLinear(base + o, 24); if (!bytes) continue; const seg = drvSegs.find(s => s.data.indexOf(bytes) === o); if (seg) { r.seg = seg.n; r.mod = `PVDISP.seg${seg.n}`; break; } }
    }
  }
  csCache.set(cs, r); return r;
}
const where = (cs, ip, cpl) => { const a = attribute(cs, ip, cpl); return a.seg ? `PVDISP!${symbolize(a.seg, ip)}` : `${a.mod}:${ip.toString(16)}`; };

/* ---- boot ---- */
emulator.bus.send("pv-set-dpi", 120); emulator.bus.send("sb16-dsp-version", [2, 1]); emulator.bus.send("pv-request-mode", [SCREEN_W, SCREEN_H]);
const snap = zlib.gunzipSync(fs.readFileSync(STATE));
await emulator.restore_state(snap.buffer.slice(snap.byteOffset, snap.byteOffset + snap.byteLength));
emulator.run(); await sleep(300); emulator.bus.send("pv-command", [6, 0]);
const tb = performance.now();
while (!st.desktopReady && performance.now() - tb < 60000) await sleep(100);
if (!st.desktopReady) { console.error("desktop not ready"); process.exit(1); }
console.log(`desktop ready; shell ${st.shell.w}x${st.shell.h} pvmon v${st.shell.ver}; wasm counters: exc ${cpu.wm.exports.pv_exc_stat ? "yes" : "no"}, planar ${cpu.wm.exports.pv_planar_stat ? "yes" : "no"}${flag("--nofast") ? " (fast path disabled)" : ""}`);
const until = async (pred, timeout, step = 20) => { const s = performance.now(); for (;;) { const v = pred(); if (v) return v; if (performance.now() - s > timeout) return null; await sleep(step); } };

/* idle: the guest is halted (INT 2F idle hook) at >= 90% of 10 ms polls over 400 ms; returns when the quiet period began */
async function waitIdle(maxMs = 25000) {
  const t0 = performance.now(); const hist = [];
  while (performance.now() - t0 < maxMs) {
    await sleep(10);
    const now = performance.now(); hist.push([now, cpu.in_hlt[0] ? 1 : 0]);
    while (hist.length && hist[0][0] < now - 400) hist.shift();
    if (hist.length >= 30 && hist.reduce((a, x) => a + x[1], 0) >= hist.length * 0.9) return hist[0][0];
  }
  return performance.now();
}
const snapC = () => ({ ...C, gp: excStat(13), pf: excStat(14), irq: excStat(32), fast: planarStat() });
const diffC = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, b[k] - a[k]]));
const results = [];
async function measure(name, fn) {
  await waitIdle(); await sleep(150);
  const c0 = snapC(), i0 = cpu.instruction_counter[0] >>> 0, t0 = performance.now();
  Object.assign(prof, { on: true, samples: new Map(), t: 0, instr: 0, slices: 0, byRing: [0, 0, 0, 0], haltT: 0 }); writeSites.clear(); sampleEvery = 97;
  await fn();
  const quietAt = await waitIdle();
  prof.on = false; sampleEvery = 0;
  const wall = quietAt - t0, instr = ((cpu.instruction_counter[0] >>> 0) - i0) >>> 0, d = diffC(c0, snapC());
  const row = { name, instr, wall: Math.round(wall), busy: Math.round(prof.t), mips: +(prof.instr / Math.max(1, prof.t) / 1000).toFixed(1), ...d, byRing: prof.byRing.map(x => Math.round(x)), fb: fbhash() };
  const top = [...prof.samples.values()].sort((a, b) => b.t - a.t);
  const byMod = new Map();
  for (const e of top) { const m = attribute(e.cs, e.ip, e.cpl).mod; const x = byMod.get(m) || { t: 0, instr: 0 }; x.t += e.t; x.instr += e.instr; byMod.set(m, x); }
  row.mods = [...byMod.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, 8).map(([m, x]) => `${m} ${(100 * x.t / prof.t).toFixed(0)}%t/${(100 * x.instr / Math.max(1, prof.instr)).toFixed(0)}%i`);
  row.hot = top.slice(0, 8).map(e => `${where(e.cs, e.ip, e.cpl)} ${(100 * e.t / prof.t).toFixed(1)}%`);
  row.writeSites = [...writeSites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${where(Math.floor(k / 65536), k % 65536, 3)} ${n}`);
  results.push(row);
  console.log(`\n== ${name}: ${instr} instr, busy ${row.busy} ms (${row.mips} MIPS) of ${row.wall} ms to idle; fb ${row.fb}; A000 w=${d.a000w} JS +${d.fast} rust, r=${d.a000r}; DISPI bank reg writes=${d.bank} (unchanged ${d.bankSame}) cursor=${d.cursorReg} other=${d.other} idx16=${d.dispiIdx}; #GP=${d.gp} #PF=${d.pf} irq/other=${d.irq}; ring time ms ${row.byRing.join("/")}`);
  console.log("  modules: " + row.mods.join(" | "));
  console.log("  hot: " + row.hot.join(" | "));
  console.log("  JS A000 write sites (1/97): " + row.writeSites.join(" | "));
  return row;
}
const shellSlot = () => (st.layers.find(L => L.kind === "S") || { slot: 0 }).slot;
const winOf = rx => st.layers.find(L => L.kind === "W" && rx.test(L.title));
async function closeWin(rx) { const L = winOf(rx); if (!L) return; emulator.bus.send("pv-command", [3, L.slot]); await until(() => !winOf(rx), 8000); await waitIdle(); }
async function minRestore(name, slot) {
  emulator.bus.send("pv-command", [4, slot]); await sleep(300); await waitIdle();
  return measure(name, async () => { emulator.bus.send("pv-command", [2, slot]); await sleep(50); });
}
async function openApp(exe, rx, label) {
  await measure(`${label} open`, async () => { emulator.bus.send("pv-command-string", [5, exe]); await until(() => winOf(rx), 15000); });
  const L = winOf(rx); if (L) await minRestore(`${label} restore (repaint)`, L.slot);
  await closeWin(rx);
}
for (const op of OPS) {
  if (op === "progman") await minRestore("progman restore (repaint)", shellSlot());
  else if (op === "notepad") await openApp("NOTEPAD.EXE", /Notepad/, "notepad");
  else if (op === "winfile") await openApp("WINFILE.EXE", /File Manager/, "winfile");
  else if (op === "sol") await openApp("SOL.EXE", /Solitaire/, "solitaire");
  else if (op === "pbrush") await openApp("PBRUSH.EXE", /Paintbrush/, "paintbrush");
  else console.log("unknown op " + op);
}
console.log("\n| operation | instr (M) | busy ms | node MIPS | A000 writes JS | A000 writes rust | A000 reads | bank reg writes | #GP | #PF | ring0 ms | fb |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) console.log(`| ${r.name} | ${(r.instr / 1e6).toFixed(2)} | ${r.busy} | ${r.mips} | ${r.a000w} | ${r.fast} | ${r.a000r} | ${r.bank} | ${r.gp} | ${r.pf} | ${r.byRing[0]} | ${r.fb} |`);
if (val("--json")) fs.writeFileSync(val("--json"), JSON.stringify(results, null, 1));
await emulator.stop(); process.exit(0);
