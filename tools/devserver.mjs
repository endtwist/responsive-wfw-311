// Minimal static dev server with HTTP Range support (v86 lazy disk loading needs it).
// Usage: node tools/devserver.mjs [port] [root]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const port = Number(process.argv[2] || 8311);
const root = path.resolve(process.argv[3] || ".");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css", ".img": "application/octet-stream",
  ".bin": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".map": "application/json" };
http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.normalize(path.join(root, url));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("404 " + url); }
  const size = fs.statSync(file).size;
  const headers = { "Content-Type": mime[path.extname(file)] || "application/octet-stream",
    "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    let start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    let end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (start > end || start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`; headers["Content-Length"] = end - start + 1;
    res.writeHead(206, headers);
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  headers["Content-Length"] = size; res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`dev server http://127.0.0.1:${port}/ root=${root}`));
