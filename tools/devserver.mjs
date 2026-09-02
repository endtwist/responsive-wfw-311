// Minimal static dev server with HTTP Range support (v86 lazy disk loading needs it).
// Usage: node tools/devserver.mjs [port] [root]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
// Byte accounting, so the first-load delivery budget can be measured: GET /__stats
const stats = { bytes: 0, byPath: {} };
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
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const out = path.join(root, "image", "boot.state.gz");
      fs.writeFileSync(out, Buffer.concat(chunks));
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      res.end("boot.state.gz " + fs.statSync(out).size);
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
