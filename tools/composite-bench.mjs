#!/usr/bin/env node
/* responsive-wfw311: how smooth is the page, and how long does a finger wait?
 *
 * Loads the real page in a headless Chromium at a phone viewport and measures, over a window of
 * seconds:
 *   - the composite cadence (requestAnimationFrame interval percentiles and the time presentOnce
 *     itself takes),
 *   - input queueing delay: performance.now() at the head of the touch handler minus the event's
 *     own timeStamp, i.e. how long the event sat waiting for this thread,
 *   - input to pixel: from the touch event to the first composite that carried new guest pixels.
 *
 * Each is measured with the guest idle and with the guest deliberately busy, which is the case
 * that used to cost frames: before this change the emulator, the pixel conversion and the
 * composite all ran on the page's one thread.
 *
 *   node tools/composite-bench.mjs [--port 8420] [--size 375x812] [--dpr 3] [--url /web/index.html]
 *                                  [--busy winfile|dos|repaint] [--seconds 5] [--nosab] [--label after]
 * Needs puppeteer (global install is fine: NODE_PATH=$(npm root -g)).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_PATH || "puppeteer");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has = n => args.includes(n);
const PORT = val("--port", "8420");
const [W, H] = val("--size", "375x812").split("x").map(Number);
const DPR = Number(val("--dpr", "3"));
const SECONDS = Number(val("--seconds", "5"));
const BUSY = val("--busy", "winfile");
const LABEL = val("--label", "run");
const URLPATH = val("--url", "/web/index.html");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now(); const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
           "--disable-backgrounding-occluded-windows", "--autoplay-policy=no-user-gesture-required",
           `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR, hasTouch: true, isMobile: true });
page.on("pageerror", e => console.log("  PAGEERROR " + e.message));
/* --throttle N slows every thread down by N (CDP CPU throttling), which is how a laptop stands in
   for the phone: SPEC has the iPhone running the guest 5-10x slower than node on this Mac. */
const THROTTLE = Number(val("--throttle", "1"));
if (THROTTLE > 1) { const cdp = await page.createCDPSession(); await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE }); }
page.on("console", m => { const t = m.text(); if (/^emu |PAGEERROR|error/i.test(t)) console.log("  " + t); });

const q = `${URLPATH}${URLPATH.includes("?") ? "&" : "?"}diag=1${has("--nosab") ? "&nosab=1" : ""}`;
console.log(`${ts()} loading http://localhost:${PORT}${q}  (${W}x${H} @${DPR}x, busy=${BUSY}, throttle=${THROTTLE}x)`);
await page.goto(`http://localhost:${PORT}${q}`, { waitUntil: "domcontentloaded" });

const state = () => page.evaluate(() => window.pvState ? ({ ready: window.pvState().desktopReady,
    layers: window.pvState().layers.map(l => l.kind + (l.slot >= 0 ? l.slot : "") + ":" + (l.title || "").slice(0, 18)),
    path: window.pvDirty ? window.pvDirty().path : "main-thread" }) : null);
const until = async (pred, timeout) => { const s = Date.now(); for (;;) { const st = await state(); if (st && pred(st)) return st; if (Date.now() - s > timeout) return st; await sleep(250); } };

let st = await until(s => s.ready, 120000);
if (!st || !st.ready) { console.log(`${ts()} FAIL: the desktop never came up`); await browser.close(); process.exit(1); }
console.log(`${ts()} desktop ready, pixel path = ${st.path}, layers ${JSON.stringify(st.layers)}`);

/* Generic probes: they use nothing that only one of the two builds provides, so the same
   measurement runs against the single-threaded page (before) and the worker page (after), and
   neither of them reads a pixel back from the GPU -- a getImageData in the measurement loop
   stalls the compositor and would measure the probe rather than the page.
 *
 *   iv      the interval between the page's own requestAnimationFrame callbacks: a composite
 *           that arrives late is a dropped frame, whatever the cause.
 *   delays  performance.now() at the head of the touch handler minus the event's own timeStamp:
 *           how long the finger's event sat in the queue waiting for this thread.
 *   lat     from the touch event to the guest's own report that it has drawn the menu (the PVT
 *           line on the debug channel), i.e. input to guest reaction, end to end.
 */
await page.evaluate(() => {
    const G = window.__gen = { iv: [], delays: [], lat: [], pending: null, last: 0, frames: 0 };
    const pres = document.getElementById("pres");
    const onDown = ev => { const now = performance.now(); G.delays.push(+(now - ev.timeStamp).toFixed(2)); G.pending = { at: now }; };
    pres.addEventListener("touchstart", onDown, { capture: true, passive: true });
    pres.addEventListener("mousedown", onDown, { capture: true });
    window.emulator.bus.register("pv-debug", line => {
        if(!G.pending || !/^PVT /.test(line)) return;
        G.lat.push(+(performance.now() - G.pending.at).toFixed(2));
        G.pending = null;
    });
    (function loop() {
        requestAnimationFrame(() => {
            const now = performance.now();
            if(G.last) { G.iv.push(now - G.last); G.frames++; }
            G.last = now;
            if(G.pending && now - G.pending.at > 4000) { G.lat.push(-1); G.pending = null; }
            loop();
        });
    })();
    window.__genReset = () => { G.iv.length = 0; G.delays.length = 0; G.lat.length = 0; G.frames = 0; G.pending = null; if(window.pvPerf) window.pvPerf(); };
});

/* The after build can say exactly when new guest pixels reached the canvas; the before build
   cannot, so this one is reported for the worker path only. */
await page.evaluate(() => {
    if(!window.pvDirty) { window.__bench = { latencies: [] }; window.__benchReset = () => {}; return; }
    const P = window.__bench = { latencies: [], pending: null };
    const pres = document.getElementById("pres");
    const onDown = () => { P.pending = { at: performance.now(), gen: window.pvDirty().gen }; };
    pres.addEventListener("touchstart", onDown, { capture: true, passive: true });
    pres.addEventListener("mousedown", onDown, { capture: true });
    (function loop() {
        requestAnimationFrame(() => {
            const p = P.pending;
            if(p)
            {
                const d = window.pvDirty();
                if(d.gen > p.gen && d.rect) { P.latencies.push(+(performance.now() - p.at).toFixed(2)); P.pending = null; }
                else if(performance.now() - p.at > 4000) { P.latencies.push(-1); P.pending = null; }
            }
            loop();
        });
    })();
    window.__benchReset = () => { P.latencies.length = 0; P.pending = null; };
});

const pct = (a, p) => a.length ? +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2) : 0;
const cmd = (n, arg) => page.evaluate((n, arg) => window.emulator.bus.send("pv-command", [n, arg]), n, arg);
const runExe = exe => page.evaluate(exe => window.emulator.bus.send("pv-command-string", [5, exe]), exe);

/* Something for the finger to do that always produces guest pixels: tap "File" in the shell's
   menu bar (the menu opens), then Escape (it closes). Anything that only moved the pointer would
   make the input-to-pixel figure meaningless, and tapping an icon would launch a program. */
const MENU_X = Math.round(W * 0.20), MENU_Y = Math.round(H * 0.083);
async function tapper(ms)
{
    const end = Date.now() + ms;
    let n = 0;
    while(Date.now() < end)
    {
        await page.touchscreen.tap(MENU_X, MENU_Y);
        n++;
        await sleep(250);
        await page.evaluate(() => { window.emulator.bus.send("keyboard-code", 0x01); window.emulator.bus.send("keyboard-code", 0x81); });
        await sleep(250);
    }
    return n;
}

/* The absolute-pointer round trip: pv-mouse-abs plus a PS/2 packet to raise the interrupt, then
   wait for the guest to report where its cursor ended up. This is the confirmation the press
   pipeline waits on (5-11 ms before the emulator moved to a worker), so it is the one number a
   thread hop could plausibly spoil. */
async function pointer_round_trip(n)
{
    return await page.evaluate(async n => {
        const out = [];
        const m = window.pvState().mode || { w: 640, h: 480 };
        for(let i = 0; i < n; i++)
        {
            const x = 100 + (i % 7) * 13, y = 200 + (i % 5) * 11;
            const before = window.pvGuestCursor();
            const t = performance.now();
            window.emulator.bus.send("pv-mouse-abs", [Math.round((x + 0.5) * 65536 / m.w) & 0xFFFF, Math.round((y + 0.5) * 65536 / m.h) & 0xFFFF]);
            window.emulator.bus.send("mouse-delta", [1, 0]);
            const deadline = t + 1000;
            for(;;)
            {
                const c = window.pvGuestCursor();
                if(c !== before) { out.push(+(performance.now() - t).toFixed(2)); break; }
                if(performance.now() > deadline) { out.push(-1); break; }
                await new Promise(r => setTimeout(r, 0));
            }
            await new Promise(r => setTimeout(r, 60));
        }
        return out;
    }, n);
}

async function measure(name, busyFn)
{
    await page.evaluate(() => { window.__genReset(); window.__benchReset(); });
    const busy = busyFn ? busyFn() : Promise.resolve();
    const taps = await tapper(SECONDS * 1000);
    await busy;
    const r = await page.evaluate(() => ({
        perf: window.pvPerf ? window.pvPerf(false) : null,
        g: { iv: window.__gen.iv, delays: window.__gen.delays, lat: window.__gen.lat, frames: window.__gen.frames },
        px: window.__bench.latencies,
    }));
    const iv = r.g.iv, lat = r.g.lat.filter(x => x > 0);
    const row = {
        case: name, taps, frames: r.g.frames,
        fps: iv.length ? +(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)).toFixed(1) : 0,
        iv_p50: pct(iv, 0.5), iv_p95: pct(iv, 0.95), iv_max: pct(iv, 1),
        iv_over20: iv.filter(x => x > 20).length, iv_over33: iv.filter(x => x > 33).length,
        inq_p50: pct(r.g.delays, 0.5), inq_p95: pct(r.g.delays, 0.95), inq_max: pct(r.g.delays, 1),
        lat_p50: pct(lat, 0.5), lat_p95: pct(lat, 0.95), lat_max: pct(lat, 1), lat_lost: r.g.lat.filter(x => x < 0).length,
        px_p50: pct(r.px.filter(x => x > 0), 0.5), px_p95: pct(r.px.filter(x => x > 0), 0.95),
        draw_p95: r.perf ? r.perf.draw_p95 : null, draw_max: r.perf ? r.perf.draw_max : null,
        sync_ms: r.perf ? r.perf.sync_ms : null, guestFrames: r.perf ? r.perf.guestFrames : null,
        path: r.perf ? r.perf.path : "main-thread",
    };
    const rt = (await pointer_round_trip(12)).filter(x => x > 0);
    row.ptr_p50 = pct(rt, 0.5); row.ptr_p95 = pct(rt, 0.95); row.ptr_max = pct(rt, 1); row.ptr_n = rt.length;
    console.log(`${ts()} ${name}: ` + JSON.stringify(row));
    return row;
}

const rows = [];
rows.push(await measure("idle"));

/* Busy: the guest given real work. "winfile" opens File Manager (17 M instructions, and the
   heaviest repaint in the tour); "repaint" then keeps it repainting by minimising and restoring
   it; "dos" runs a whole-disk directory scan in a DOS box. */
async function busy()
{
    if(BUSY === "dos") { await runExe("COMMAND.COM /C DIR C:\\ /S"); await sleep(SECONDS * 1000); return; }
    await runExe("WINFILE.EXE");
    const end = Date.now() + SECONDS * 1000;
    await sleep(1500);
    let slot = 0;
    const st2 = await state();
    const w = (st2.layers || []).find(l => /^W/.test(l) && /File Manager|WINFILE/i.test(l));
    if(w) slot = Number(w[1]) || 0;
    while(Date.now() < end) { await cmd(4, slot); await sleep(350); await cmd(2, slot); await sleep(350); }
}
rows.push(await measure("busy:" + BUSY, busy));

await sleep(1500);
rows.push(await measure("after"));

const out = { label: LABEL, throttle: THROTTLE, at: new Date().toISOString(), size: `${W}x${H}@${DPR}`, seconds: SECONDS, busy: BUSY, path: rows[0].path, rows };
const file = path.join(root, "shots", `bench-${LABEL}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 1));
await page.screenshot({ path: path.join(root, "shots", `bench-${LABEL}.png`) });
console.log(`${ts()} wrote ${file}`);
console.log("\ncase              fps  iv_p50 iv_p95 iv_max >20ms >33ms inq_p50 inq_p95 inq_max lat_p50 lat_p95 ptr_p50 ptr_p95");
for(const r of rows)
{
    console.log(`${r.case.padEnd(16)} ${String(r.fps).padStart(5)} ${String(r.iv_p50).padStart(6)} ${String(r.iv_p95).padStart(6)} ${String(r.iv_max).padStart(6)} ${String(r.iv_over20).padStart(5)} ${String(r.iv_over33).padStart(5)} ${String(r.inq_p50).padStart(7)} ${String(r.inq_p95).padStart(7)} ${String(r.inq_max).padStart(7)} ${String(r.lat_p50).padStart(7)} ${String(r.lat_p95).padStart(7)} ${String(r.ptr_p50).padStart(7)} ${String(r.ptr_p95).padStart(7)}`);
}
await browser.close();
