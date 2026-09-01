/* Offline support for the shell and the emulator.
 *
 * Network first, cache as the fallback: a cache-first worker pins whatever shipped on the first
 * visit, which silently serves stale code after an update. The disk image is never handled here,
 * because v86 fetches it with Range requests and a cached full response would break them.
 */
const CACHE = "responsive-wfw311-v2";
const ASSETS = ["index.html", "app.js", "../v86/build/v86.wasm",
                "../v86/bios/seabios.bin", "../v86/bios/vgabios.bin"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  if (/\.img(\?|$)/.test(new URL(req.url).pathname)) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req))
  );
});
