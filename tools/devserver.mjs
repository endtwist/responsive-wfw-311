// Minimal static dev server with HTTP Range support (v86 lazy disk loading needs it).
// Usage: node tools/devserver.mjs [port] [root]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
// Byte accounting, so the first-load delivery budget can be measured: GET /__stats
const stats = { bytes: 0, byPath: {} };
const remote = { devices: new Map(), device(name) {
  let d = remote.devices.get(name);
  if (!d) remote.devices.set(name, d = { name, seen: 0, addr: "", ua: "", queue: [], waiters: new Set(), results: new Map(), resultWaiters: new Map() });
  return d;
} };
const port = Number(process.argv[2] || 8311);
const root = path.resolve(process.argv[3] || ".");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css", ".img": "application/octet-stream",
  ".bin": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".map": "application/json" };
http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // Screenshots: the page POSTs a PNG data URL here so a frame can be captured even when the
  // browser pane is not compositing and no screenshot API is available.
  if (url === "/__shot" && req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
                         "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }
  if (url === "/__shot" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      const b64 = body.replace(/^data:image\/\w+;base64,/, "");
      const name = `shot-${Date.now()}.png`;
      fs.writeFileSync(path.join(root, "shots", name), Buffer.from(b64, "base64"));
      res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }); res.end(name);
    });
    return;
  }
  // Boot snapshot from the browser: POST the gzipped v86 state, it becomes image/boot.state.gz,
  // which the page restores on a cold visit so the desktop is up in seconds instead of a minute.
  if (url === "/__state" && req.method === "POST") {
    const chunks = [];
    const name = (new URL(req.url, "http://x").searchParams.get("name") || "boot.state.gz").replace(/[^A-Za-z0-9._-]/g, "");
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const out = path.join(root, "image", name);
      fs.writeFileSync(out, Buffer.concat(chunks));
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      res.end(name + " " + fs.statSync(out).size);
    });
    return;
  }
  // Diagnostics from phones: the page posts uncaught errors and a periodic heartbeat here.
  if (url === "/__log" && req.method === "POST") {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const line = `${new Date().toISOString()} ${req.socket.remoteAddress} ${Buffer.concat(chunks).toString().slice(0, 4000)}\n`;
      fs.appendFileSync(path.join(root, "shots", "devicelog.txt"), line);
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" }); res.end();
    });
    return;
  }
  /* Remote control (SPEC 2026-09-02): a parked phone long-polls GET /__cmd?device=<name> for the
     next command (JSON, or 204 after ~25 s); anything may POST /__cmd?device=<name> to enqueue
     one ({id, type, ...}; id is filled in if missing); the page posts {id, ok, value|error, t} to
     POST /__result?device=<name>, kept in shots/results/<device>/<id>.json and appended to the
     device log. GET /__devices lists devices with last-seen times. GET /__result?device=&id= waits
     for one result (long-poll, 204 on timeout). No auth: LAN tooling. */
  const q = new URL(req.url, "http://x").searchParams;
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  const dev = () => (q.get("device") || "default").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "default";
  const readBody = () => new Promise(res => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => res(Buffer.concat(c).toString())); });
  const logLine = text => fs.appendFileSync(path.join(root, "shots", "devicelog.txt"), `${new Date().toISOString()} ${req.socket.remoteAddress} ${text.slice(0, 4000)}\n`);
  if ((url === "/__cmd" || url === "/__result" || url === "/__devices") && req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (url === "/__cmd" && req.method === "GET") {
    const d = remote.device(dev());
    d.seen = Date.now(); d.addr = req.socket.remoteAddress; d.ua = req.headers["user-agent"] || "";
    const give = cmd => { res.writeHead(200, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(cmd)); };
    const next = () => { while (d.queue.length) { const c = d.queue.shift(); if (Date.now() - c.at <= 60000) return c; logLine(`remote ${d.name} dropped stale ${c.id} ${c.type}`); } return null; };
    const c = next();
    if (c) return give(c);
    const waiter = { give: () => { const c2 = next(); if (!c2) return false; clearTimeout(waiter.timer); give(c2); return true; } };
    waiter.timer = setTimeout(() => { d.waiters.delete(waiter); res.writeHead(204, cors); res.end(); }, 25000);
    d.waiters.add(waiter);
    req.on("close", () => { clearTimeout(waiter.timer); d.waiters.delete(waiter); });
    return;
  }
  if (url === "/__cmd" && req.method === "POST") {
    readBody().then(body => {
      let cmd; try { cmd = JSON.parse(body || "{}"); } catch (e) { res.writeHead(400, cors); return res.end("bad json"); }
      if (!cmd.type) { res.writeHead(400, cors); return res.end("type required"); }
      cmd.id = String(cmd.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
      cmd.at = Date.now();
      const d = remote.device(dev());
      d.queue.push(cmd);
      for (const w of d.waiters) if (w.give()) { d.waiters.delete(w); break; }
      logLine(`remote ${d.name} queued ${cmd.id} ${cmd.type} ${JSON.stringify(cmd).slice(0, 300)}`);
      res.writeHead(200, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify({ id: cmd.id, queued: d.queue.length, online: Date.now() - d.seen < 40000 }));
    });
    return;
  }
  if (url === "/__result" && req.method === "POST") {
    readBody().then(body => {
      const d = remote.device(dev());
      d.seen = Date.now();
      let r; try { r = JSON.parse(body); } catch (e) { r = { id: "bad", ok: false, error: "unparseable result", raw: body.slice(0, 200) }; }
      const id = String(r.id || "noid").replace(/[^A-Za-z0-9._-]/g, "");
      const dir = path.join(root, "shots", "results", d.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(r, null, 1));
      d.results.set(id, r);
      for (const w of d.resultWaiters.get(id) || []) w(r);
      d.resultWaiters.delete(id);
      logLine(`remote ${d.name} result ${id} ok=${r.ok} ${JSON.stringify(r.ok ? r.value : r.error).slice(0, 1500)}`);
      res.writeHead(204, cors); res.end();
    });
    return;
  }
  if (url === "/__result" && req.method === "GET") {
    const d = remote.device(dev()), id = (q.get("id") || "").replace(/[^A-Za-z0-9._-]/g, "");
    const send = r => { res.writeHead(200, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(r)); };
    if (d.results.has(id)) return send(d.results.get(id));
    const file = path.join(root, "shots", "results", d.name, id + ".json");
    if (fs.existsSync(file)) return send(JSON.parse(fs.readFileSync(file, "utf8")));
    const list = d.resultWaiters.get(id) || d.resultWaiters.set(id, []).get(id);
    const timer = setTimeout(() => { d.resultWaiters.set(id, (d.resultWaiters.get(id) || []).filter(f => f !== fn)); res.writeHead(204, cors); res.end(); }, 25000);
    const fn = r => { clearTimeout(timer); send(r); };
    list.push(fn);
    return;
  }
  if (url === "/__devices") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    return res.end(JSON.stringify([...remote.devices.values()].map(d => ({ device: d.name, addr: d.addr, ua: d.ua, seenAgo: Date.now() - d.seen, online: Date.now() - d.seen < 40000, queued: d.queue.length, waiting: d.waiters.size }))));
  }
  if (url === "/__stats") {
    if (req.method === "DELETE") { stats.bytes = 0; stats.byPath = {}; }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(stats));
  }
  const count = n => { stats.bytes += n; stats.byPath[url] = (stats.byPath[url] || 0) + n; };
  let file = path.normalize(path.join(root, url));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  // Clean application paths: /solitaire, /hearts ... are the page, which reads the last segment.
  if (!fs.existsSync(file) && /^\/[a-z]+\/?$/i.test(url)) file = path.join(root, "web", "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("404 " + url); }
  const size = fs.statSync(file).size;
  const headers = { "Content-Type": mime[path.extname(file)] || "application/octet-stream",
    "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*",
    "Last-Modified": fs.statSync(file).mtime.toUTCString() };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    let start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    let end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (start > end || start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`; headers["Content-Length"] = end - start + 1;
    res.writeHead(206, headers);
    if (req.method === "HEAD") return res.end();
    count(end - start + 1);
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  headers["Content-Length"] = size; res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  count(size);
  fs.createReadStream(file).pipe(res);
}).listen(port, "0.0.0.0", () => console.log(`dev server http://0.0.0.0:${port}/ (LAN ok) root=${root}`));
