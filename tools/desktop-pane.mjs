#!/usr/bin/env node
/* responsive-wfw311: the desktop-mode host path in a real (headless) Chromium, for when the Browser
 * pane is full. Loads /solitaire on a dev server at a desktop viewport, waits for the guest to
 * switch to desktop mode and for Solitaire, screenshots the page (the host's composite, 1:1),
 * checks hover / click mapping, resizes the window (re-mode), then goes narrow (back to the phone
 * layout). Screenshots land in shots/pane-*.png.
 *
 *   node tools/desktop-pane.mjs [--port 8390] [--size 1280x800]
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
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const PORT = val("--port") || "8390";
const [W, H] = (val("--size") || "1280x800").split("x").map(Number);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now(); const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ts()} CHECK ${name}: ${ok ? "PASS" : "FAIL"} ${detail || ""}`); };

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", `--window-size=${W},${H}`] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on("console", m => { const t = m.text(); if (/^\[guest\] (pvmon|pvhook):|PVD|PVA/.test(t) && !/PVH/.test(t)) console.log("  " + t); });
page.on("pageerror", e => console.log("  PAGEERROR " + e.message));
await page.goto(`http://localhost:${PORT}/solitaire?keepalive=1`, { waitUntil: "domcontentloaded" });
const state = () => page.evaluate(() => { const s = window.pvState ? window.pvState() : null; if (!s) return null; return { ready: s.desktopReady, guestDesktop: s.guestDesktop, wantDesktop: s.wantDesktop, mode: s.mode, view: s.view, shell: s.shell,
  layers: s.layers.map(L => ({ kind: L.kind, slot: L.slot, wx: L.wx, wy: L.wy, ww: L.ww, wh: L.wh, gx: L.gx, gy: L.gy, gw: L.gw, gh: L.gh, title: L.title })),
  screen: (() => { const c = document.querySelector("#screen_container canvas"); return c ? [c.width, c.height] : null; })(), bar: !!document.getElementById("bar"), log: s.log.slice(-6) }; });
const until = async (pred, timeout, step = 250) => { const s = Date.now(); for (;;) { const st = await state(); if (st && pred(st)) return st; if (Date.now() - s > timeout) return st; await sleep(step); } };
const shot = async name => { const p = path.join(root, "shots", name); fs.mkdirSync(path.dirname(p), { recursive: true }); await page.screenshot({ path: p }); console.log(`${ts()} shot ${p}`); };

let st = await until(s => s.ready && s.guestDesktop === true && s.layers.some(L => L.kind === "W" && /Solitaire/.test(L.title)), 90000);
console.log(`${ts()} state: ready=${st && st.ready} guestDesktop=${st && st.guestDesktop} mode=${JSON.stringify(st && st.mode)} screen=${JSON.stringify(st && st.screen)} view=${JSON.stringify(st && st.view)}`);
for (const L of st ? st.layers : []) console.log(`   ${L.kind}${L.slot} ${L.wx},${L.wy} ${L.ww}x${L.wh} "${L.title}"`);
check("no dev toolbar in the page", st && !st.bar);
check("guest in desktop mode", st && st.guestDesktop === true);
check(`guest screen is the viewport ${W}x${H}`, st && st.screen && st.screen[0] === Math.floor(W / 8) * 8 && st.screen[1] === Math.floor(H / 2) * 2, JSON.stringify(st && st.screen));
check("composited 1:1", st && st.view && st.view.scale === 1, JSON.stringify(st && st.view));
const S = st && st.layers.find(L => L.kind === "S"), SOL = st && st.layers.find(L => L.kind === "W" && /Solitaire/.test(L.title));
check("Program Manager is a normal window on the screen", S && S.wx >= 0 && S.wx + S.ww <= W && S.wh > 300 && S.ww > 400, S && `${S.wx},${S.wy} ${S.ww}x${S.wh}`);
check("Solitaire is a normal window on the screen (no slot column)", SOL && SOL.wx >= 0 && SOL.wx + SOL.ww <= W && SOL.wy + SOL.wh <= H, SOL && `${SOL.wx},${SOL.wy} ${SOL.ww}x${SOL.wh}`);
await sleep(1500);
await shot(`pane-${W}x${H}-desktop.png`);

/* hover: the guest pointer follows the mouse 1:1 */
if (SOL) {
  const hx = SOL.gx + Math.round(SOL.gw / 2), hy = SOL.gy + Math.round(SOL.gh * 0.8);
  const ox = st.view.ox || 0;
  await page.mouse.move(ox + hx, hy); await sleep(150); await page.mouse.move(ox + hx + 1, hy + 1); await sleep(900);
  const cur = await page.evaluate(() => window.pvGuestCursor());
  check("hover moved the guest pointer 1:1", cur && Math.abs(cur.x - (hx + 1)) <= 2 && Math.abs(cur.y - (hy + 1)) <= 2, `asked ${hx + 1},${hy + 1} guest ${JSON.stringify(cur)}`);
  /* click: Solitaire's Game menu opens (a transient layer appears) */
  const mx = SOL.wx + 30, my = SOL.gy - 20;               // the menu row is just above the client
  await page.mouse.click(ox + mx, my);
  const st2 = await until(s => s.layers.some(L => L.kind === "T"), 6000);
  const T = st2 && st2.layers.find(L => L.kind === "T");
  check("a click on Solitaire's menu bar opened a menu (1:1 mapping)", !!T, T && `menu at ${T.wx},${T.wy} ${T.ww}x${T.wh}`);
  await shot(`pane-${W}x${H}-menu.png`);
  await page.keyboard.press("Escape"); await sleep(600);
  const st3 = await until(s => !s.layers.some(L => L.kind === "T"), 4000);
  check("Esc (hardware keyboard through v86) closed the menu", st3 && !st3.layers.some(L => L.kind === "T"));
}

/* resize: the guest re-modes to the new viewport */
const W2 = W - 160, H2 = H - 100;
await page.setViewport({ width: W2, height: H2, deviceScaleFactor: 1 });
st = await until(s => s.screen && s.screen[0] === Math.floor(W2 / 8) * 8 && s.screen[1] === Math.floor(H2 / 2) * 2, 20000);
check(`window resize re-moded the guest to ${W2}x${H2}`, st && st.screen && st.screen[0] === Math.floor(W2 / 8) * 8, JSON.stringify(st && st.screen));
await sleep(2000);
await shot(`pane-${W2}x${H2}-resized.png`);

/* narrow: back to the phone layout */
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
st = await until(s => s.guestDesktop === false && s.screen && s.screen[0] === 2560, 30000);
check("narrow viewport switched the guest back to the phone layout (2560x970, layers)", st && st.guestDesktop === false && st.screen && st.screen[0] === 2560 && st.screen[1] === 970, `screen ${JSON.stringify(st && st.screen)} layers ${st && st.layers.map(L => L.kind + L.slot + ":" + L.wx).join(" ")}`);
await sleep(3000);
await shot("pane-390x844-phone.png");
st = await state();
for (const L of st ? st.layers : []) console.log(`   ${L.kind}${L.slot} ${L.wx},${L.wy} ${L.ww}x${L.wh} "${L.title}"`);
const SOL2 = st && st.layers.find(L => L.kind === "W" && /Solitaire/.test(L.title)), S2 = st && st.layers.find(L => L.kind === "S");
check("Solitaire parked in a slot column again", SOL2 && SOL2.wx >= 640 && SOL2.wx % 640 === 0, SOL2 && `${SOL2.wx},${SOL2.wy}`);
check("shell back in its column", S2 && S2.wx === 0 && S2.ww <= 352, S2 && `${S2.wx},${S2.wy} ${S2.ww}x${S2.wh}`);

/* and wide again */
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
st = await until(s => s.guestDesktop === true && s.screen && s.screen[0] === Math.floor(W / 8) * 8, 30000);
check("wide again: desktop mode again", st && st.guestDesktop === true && st.screen && st.screen[0] === Math.floor(W / 8) * 8, JSON.stringify(st && st.screen));
await sleep(2500);
await shot(`pane-${W}x${H}-desktop-again.png`);
console.log(`${ts()} ${results.filter(r => r.ok).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
