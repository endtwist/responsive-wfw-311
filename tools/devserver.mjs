// Minimal static dev server with HTTP Range support (v86 lazy disk loading needs it).
// Usage: node tools/devserver.mjs [port] [root]
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
  ".bin": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".map": "application/json",
  ".webmanifest": "application/manifest+json", ".gz": "application/gzip" };
/* The phone needs a SECURE origin for three things the page wants: the Web Share API (a printed
   PDF reaching the iOS share sheet), the microphone (Sound Recorder), and SharedArrayBuffer for
   the worker's pixels. Plain http can never be one, whatever the address, so `--https` starts a
   second listener with a self-signed certificate on port+1: accept the warning once on the phone
   and that origin is secure, which makes the LAN behave like the deploy. The certificate is
   generated on first use and kept out of git. */
const wantHttps = process.argv.includes("--https");
function selfSignedCert() {
  const dir = path.join(root, ".certs");
  const key = path.join(dir, "dev-key.pem"), crt = path.join(dir, "dev-cert.pem");
  if (!fs.existsSync(key) || !fs.existsSync(crt)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
      "-keyout", key, "-out", crt, "-subj", "/CN=responsive-wfw311.local",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:192.168.4.62"], { stdio: "ignore" });
    console.log(`generated a self-signed certificate in ${dir}`);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

const handler = (req, res) => {
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
  // Print jobs (with ?diag=1): the page POSTs the finished PDF (or the raw job if the conversion
  // failed) here, so a print can be checked without the browser's download UI: shots/print-<ms>.<ext>
  if (url === "/__print" && req.method === "POST") {
    const chunks = [];
    const ext = ((new URL(req.url, "http://x").searchParams.get("ext") || "pdf").replace(/[^a-z0-9]/gi, "") || "pdf").slice(0, 8);
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const name = `print-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(root, "shots", name), Buffer.concat(chunks));
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
  /* The guest's internet, locally: the same contract as api/fetch.js on the deploy, so the LAN
     behaves the same. Kept as narrow as that one -- GET/HEAD, http/https, nothing private. */
  if (url === "/api/fetch") {
    const target = new URL(req.url, "http://x").searchParams.get("url") || "";
    let u = null;
    try { u = new URL(target); } catch (e) {}
    const priv = u && /^(localhost$|.*\.local$|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || priv) {
      res.writeHead(400, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      return res.end("bad url");
    }
    fetch(u, { method: req.method === "HEAD" ? "HEAD" : "GET",
               headers: { "user-agent": "Mozilla/1.22 (Windows; I; 16bit)", accept: "*/*" } })
      .then(async r => {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "application/octet-stream",
                             "Access-Control-Allow-Origin": "*", "x-upstream-status": String(r.status),
                             "Cache-Control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : buf);
      })
      .catch(e => { res.writeHead(502, { "Content-Type": "text/plain" }); res.end(`upstream: ${e.message}`); });
    return;
  }
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
  // The site root is the page too (the PWA manifest's start_url).
  if (!fs.existsSync(file) && (url === "/" || /^\/[a-z]+\/?$/i.test(url))) file = path.join(root, "web", "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("404 " + url); }
  const size = fs.statSync(file).size;
  const headers = { "Content-Type": mime[path.extname(file)] || "application/octet-stream",
    "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*",
    "Last-Modified": fs.statSync(file).mtime.toUTCString(),
    /* Cross-origin isolation, which is what SharedArrayBuffer needs: the emulator worker then
       writes guest pixels straight into memory the compositor reads (SPEC 2026-09-03). It only
       takes effect in a secure context, so it works on http://localhost and is inert over plain
       http on the LAN -- which is why the page keeps a transferred-ImageBitmap path for phones. */
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin" };
  // The service worker is registered with scope "/" from /web/sw.js: allowed here, and a real
  // deployment must send the same header (or serve sw.js from the root).
  if (url === "/web/sw.js") headers["Service-Worker-Allowed"] = "/";
  // The committed manifest is the production one (start_url "/"). A phone installed from the dev
  // server is the parked remote-control device, so here the start_url carries the dev query.
  if (url === "/web/manifest.webmanifest") {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    m.start_url = "/?remote=phone&diag=1";
    const body = JSON.stringify(m, null, 2);
    delete headers["Last-Modified"];
    headers["Content-Length"] = Buffer.byteLength(body);
    res.writeHead(200, headers);
    return res.end(req.method === "HEAD" ? undefined : body);
  }
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
};
http.createServer(handler).listen(port, "0.0.0.0",
  () => console.log(`dev server http://0.0.0.0:${port}/ (LAN ok) root=${root}`));
if (wantHttps) {
  try {
    https.createServer(selfSignedCert(), handler).listen(port + 1, "0.0.0.0",
      () => console.log(`dev server https://0.0.0.0:${port + 1}/ (secure context: share sheet, microphone, SharedArrayBuffer)`));
  } catch (e) {
    console.error(`--https failed (${e.message}); http only`);
  }
}
