/* Offline support for the shell and the emulator.
 *
 * Network first, cache as the fallback: a cache-first worker pins whatever shipped on the first
 * visit, which silently serves stale code after an update. The disk image is never handled here,
 * because v86 fetches it with Range requests and a cached full response would break them; the boot
 * snapshot (2 MB) and the manifest are left to the network too, since a stale pair of those is
 * exactly what the page's stamp checks exist to reject.
 *
 * Registered with scope "/" (the clean paths /solitaire, /notepad are the page), which needs the
 * server to send `Service-Worker-Allowed: /` for this file; the dev server does. Only installed
 * over https, never on localhost or the LAN (see app.js).
 */
const CACHE = "responsive-wfw311-v7";
const PRECACHE = ["/web/index.html", "/web/app.js", "/web/manifest.webmanifest", "/web/icon-192.png",
                  "/web/apple-touch-icon.png", "/web/favicon.png", "/web/boot-splash.webp", "/web/boot-splash-tall.webp",
                  "/v86/build/v86.wasm", "/v86/bios/seabios.bin", "/v86/bios/vgabios.bin"];

self.addEventListener("install", e => {
  // Each asset on its own: one 404 must not fail the install (the v86 source modules are picked
  // up at runtime anyway).
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const NEVER = /\.(img|state\.gz)(\?|$)|\/image\/current\.json|\/__/;

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;              // CDNs (ghostscript) go straight out
  if (NEVER.test(url.pathname)) return;
  // A clean path (/solitaire) is the page: cache it under the page's own key.
  const isPage = req.mode === "navigate" || /^\/[a-z]+\/?$/i.test(url.pathname) || url.pathname === "/";
  const key = isPage ? "/web/index.html" : req;
  // A failed fetch falls back to the cache; a cache miss retries the network with a fresh
  // connection rather than answering with nothing, which the browser reports as ERR_FAILED (seen
  // after the dev server was restarted: the worker's pooled connections were dead).
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && (res.type === "basic" || res.type === "default")) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(key).then(hit => hit || fetch(req, { cache: "reload" })))
      .catch(() => Response.error())
  );
});
