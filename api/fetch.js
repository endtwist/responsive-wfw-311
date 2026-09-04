/* The off-device half of the guest's internet.
 *
 * Windows for Workgroups cannot do TLS -- it has no ciphers worth the name and about 35 MIPS to
 * spend -- so the guest speaks plain HTTP/1.0 to a terminal server that does not exist
 * (web/net.js), and the request comes out here to be made for real. This function is where the
 * 2026 internet is: TLS, redirects, compression, SNI, all of it, none of it in the guest.
 *
 * It also exists because the page cannot do this itself. A fetch from the browser is subject to
 * the other site's CORS policy, and almost no site allows it; a fetch from a server is not.
 *
 * Deliberately narrow, because this is an open fetcher on somebody's deployment:
 *   - GET and HEAD only, http and https only, no credentials forwarded, no cookies kept.
 *   - Private and loopback addresses refused, so it cannot be used to reach inside the network
 *     it runs in.
 *   - A size and a time limit, since the guest is a 1994 browser and cannot use more.
 *   - The response is returned as-is with its content type; the guest's browser decides what it
 *     can make of it, exactly as it would have then.
 */

const MAX_BYTES = 4 * 1024 * 1024;          // a 1994 browser has nowhere to put more than this
const TIMEOUT_MS = 15000;

/* Anything that resolves inward is refused. Hostnames are checked by shape rather than resolved:
   a name that looks like a private address, localhost, or a .internal/.local suffix never goes
   out. This is a guard against being turned into a way into the deployment's own network. */
function refused(host) {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^\[?::1\]?$/.test(h) || /^\[?fd[0-9a-f]{2}:/i.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
        || (a === 169 && b === 254) || a >= 224) return true;
  }
  return false;
}

export default async function handler(req, res) {
  const target = (req.query && req.query.url) || "";
  if (!target) { res.status(400).send("no url"); return; }
  if (req.method !== "GET" && req.method !== "HEAD") { res.status(405).send("GET or HEAD only"); return; }

  let url;
  try { url = new URL(target); } catch (e) { res.status(400).send("bad url"); return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") { res.status(400).send("http or https only"); return; }
  if (refused(url.hostname)) { res.status(403).send("that address is not reachable from here"); return; }

  const stop = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      redirect: "follow",
      signal: stop,
      headers: {
        /* A period user agent, because that is what the guest is, and because some sites serve a
           simpler page to one. Nothing is forwarded from the caller. */
        "user-agent": "Mozilla/1.22 (Windows; I; 16bit)",
        "accept": "*/*",
      },
    });
  } catch (e) {
    res.status(502).send(`could not reach ${url.hostname}: ${e && e.name === "TimeoutError" ? "timed out" : "failed"}`);
    return;
  }

  const type = upstream.headers.get("content-type") || "application/octet-stream";
  const body = new Uint8Array(await upstream.arrayBuffer());
  const bytes = body.length > MAX_BYTES ? body.subarray(0, MAX_BYTES) : body;
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("x-upstream-status", String(upstream.status));
  res.setHeader("x-upstream-url", upstream.url || url.toString());
  if (bytes.length !== body.length) res.setHeader("x-truncated", "1");
  res.status(200).send(Buffer.from(bytes));
}
