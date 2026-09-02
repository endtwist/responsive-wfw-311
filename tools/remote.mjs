#!/usr/bin/env node
/* responsive-wfw311: drive a parked phone through the dev server (web/remote.js).
 *
 *   node tools/remote.mjs [--server http://localhost:8311] [--timeout 600] <device> <type> [args]
 *
 *   node tools/remote.mjs phone ping
 *   node tools/remote.mjs phone tour                       # the self-test; prints the table
 *   node tools/remote.mjs phone tour '{"apps":["NOTEPAD"]}'
 *   node tools/remote.mjs phone shot                       # -> shots/shot-<ms>.png on the server
 *   node tools/remote.mjs phone eval 'return pvState().layers.map(l => l.title)'
 *   node tools/remote.mjs phone tap 200 400
 *   node tools/remote.mjs phone type 'hello'
 *   node tools/remote.mjs phone keys 0x38 0x21 0xa1 0xb8   # Alt+F
 *   node tools/remote.mjs phone reload 'remote=phone&diag=1'
 *   node tools/remote.mjs --devices                        # who is online
 *
 * Posts the command, then long-polls GET /__result until the device answers (or --timeout s).
 * Exit code: 0 ok, 1 the command failed on the device (or a tour with failures), 2 no answer. */
const args = process.argv.slice(2);
const take = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const server = (take("--server", process.env.REMOTE_SERVER || "http://localhost:8311")).replace(/\/$/, "");
const timeout = +take("--timeout", 600) * 1000;
if (args.includes("--devices")) {
  const r = await fetch(server + "/__devices").then(r => r.json());
  for (const d of r) console.log(`${d.device.padEnd(12)} ${d.online ? "online " : "offline"} seen ${Math.round(d.seenAgo / 1000)}s ago queued=${d.queued} ${d.addr} ${d.ua}`);
  if (!r.length) console.log("no devices have polled yet");
  process.exit(0);
}
const [device, type, ...rest] = args;
if (!device || !type) { console.error("usage: remote.mjs <device> <type> [args]   (--devices to list)"); process.exit(2); }
const json = s => { try { return JSON.parse(s); } catch (e) { return undefined; } };
let cmd = { type };
switch (type) {
  case "eval": cmd.src = rest.join(" "); break;
  case "tour": cmd.opts = rest[0] ? json(rest[0]) : {}; break;
  case "tap": cmd.x = +rest[0]; cmd.y = +rest[1]; break;
  case "type": cmd.text = rest.join(" "); break;
  case "keys": cmd.codes = rest.map(s => Number(s)); break;
  case "reload": if (rest[0] !== undefined) cmd.query = rest[0]; break;
  default: if (rest[0]) Object.assign(cmd, json(rest[0]) || {});
}
const q = `?device=${encodeURIComponent(device)}`;
const posted = await fetch(`${server}/__cmd${q}`, { method: "POST", body: JSON.stringify(cmd) }).then(r => r.json());
console.error(`queued ${posted.id} for ${device} (${posted.online ? "online" : "NOT SEEN RECENTLY"})`);
const t0 = Date.now();
let result = null;
while (Date.now() - t0 < timeout) {
  const r = await fetch(`${server}/__result${q}&id=${posted.id}`);
  if (r.status === 200) { result = await r.json(); break; }
}
if (!result) { console.error(`no result after ${timeout / 1000}s`); process.exit(2); }
if (!result.ok) { console.error(`FAILED (${result.t} ms): ${result.error}`); process.exit(1); }
if (type === "tour" && result.value && result.value.rows) {
  const { table } = await import(new URL("../web/selftest.js", import.meta.url));
  console.log(table(result.value));
  process.exit(result.value.fail ? 1 : 0);
}
console.log(typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 1));
console.error(`ok (${result.t} ms)`);
