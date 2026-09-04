/* The host end of the guest's dial-up link, driven without an emulator.
 *
 * web/net.js is deliberately pure -- frames in, frames out -- so the whole stack can be checked
 * here: SLIP framing, an IPv4 header a real stack would accept, a ping answered, a name resolved
 * out of the pool, and a TCP connection carried from handshake to close with a request handed over
 * and a response streamed back. Run: node v86/tests/pv/slipnet.mjs
 */
import { SlipNet, SlipReader, slipEncode, _internals } from "../../../web/net.js";

let checks = 0, failures = 0;
function eq(got, want, what) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.log(`FAIL ${what}: got ${g} expected ${w}`); }
}
const { checksum, ip4, ipStr } = _internals;

/* ---------------------------------------------------------------- SLIP framing */
{
  const framed = slipEncode(Uint8Array.from([1, 0xC0, 2, 0xDB, 3]));
  eq([...framed], [0xC0, 1, 0xDB, 0xDC, 2, 0xDB, 0xDD, 3, 0xC0], "END and ESC are escaped, both ends framed");
  const r = new SlipReader();
  eq(r.push(framed).map(f => [...f]), [[1, 0xC0, 2, 0xDB, 3]], "and come back as they went in");
  eq(r.push(Uint8Array.from([0xC0, 0xC0])).length, 0, "empty frames are padding, not packets");
  const split = new SlipReader();
  eq(split.push(framed.subarray(0, 4)).length, 0, "a frame split across two reads is held");
  eq(split.push(framed.subarray(4)).map(f => [...f]), [[1, 0xC0, 2, 0xDB, 3]], "...and completed by the rest");
}

/* ---------------------------------------------------------------- helpers for the tests */
const GUEST = ip4(10, 0, 2, 15);
function ipPacket(proto, src, dst, body) {
  const p = new Uint8Array(20 + body.length);
  p[0] = 0x45;
  p[2] = (p.length >> 8) & 255; p[3] = p.length & 255;
  p[8] = 64; p[9] = proto;
  p[12] = (src >>> 24) & 255; p[13] = (src >>> 16) & 255; p[14] = (src >>> 8) & 255; p[15] = src & 255;
  p[16] = (dst >>> 24) & 255; p[17] = (dst >>> 16) & 255; p[18] = (dst >>> 8) & 255; p[19] = dst & 255;
  const c = checksum(p, 0, 20);
  p[10] = (c >> 8) & 255; p[11] = c & 255;
  p.set(body, 20);
  return p;
}
function harness(opts = {}) {
  const out = [];                                     // frames the host put on the wire
  const reader = new SlipReader();
  const net = new SlipNet({
    send: bytes => { for (const f of reader.push(bytes)) out.push(f); },
    request: (host, port, data, conn) => { out.requests.push({ host, port, text: String.fromCharCode(...data), conn }); },
    log: () => {},
    ...opts,
  });
  out.requests = [];
  return { net, out, feed: p => net.fromGuest(slipEncode(p)) };
}
const proto = p => p[9];
const body = p => p.subarray((p[0] & 15) * 4);

/* ---------------------------------------------------------------- IP and ICMP */
{
  const { net, out, feed } = harness();
  const echo = new Uint8Array(12);
  echo[0] = 8;                                        // echo request
  echo[4] = 0x12; echo[5] = 0x34;                     // id
  echo[8] = 0xAB;                                     // one byte of payload pattern
  const ck = checksum(echo, 0, echo.length);
  echo[2] = (ck >> 8) & 255; echo[3] = ck & 255;
  feed(ipPacket(1, GUEST, ip4(10, 0, 2, 2), echo));
  eq(out.length, 1, "a ping is answered");
  const reply = out[0];
  eq((reply[0] >> 4), 4, "the reply is IPv4");
  eq(checksum(reply, 0, 20), 0, "its header checksum is right");
  eq(proto(reply), 1, "it is ICMP");
  const r = body(reply);
  eq(r[0], 0, "an echo REPLY");
  eq([r[4], r[5]], [0x12, 0x34], "the identifier comes back");
  eq(r[8], 0xAB, "and the payload");
  eq(checksum(r, 0, r.length), 0, "with its own checksum right");
  eq([reply[16], reply[17], reply[18], reply[19]], [10, 0, 2, 15], "addressed back to the guest");
}

/* ---------------------------------------------------------------- DNS */
function dnsQuery(name, id = 0x2A2A) {
  const labels = name.split(".");
  let len = 12;
  for (const l of labels) len += 1 + l.length;
  len += 1 + 4;
  const q = new Uint8Array(len);
  q[0] = id >> 8; q[1] = id & 255;
  q[2] = 0x01;                                        // recursion desired
  q[5] = 1;                                           // one question
  let o = 12;
  for (const l of labels) { q[o++] = l.length; for (const ch of l) q[o++] = ch.charCodeAt(0); }
  q[o++] = 0; q[o++] = 0; q[o++] = 1; q[o++] = 0; q[o++] = 1;
  const u = new Uint8Array(8 + q.length);
  u[0] = 0x04; u[1] = 0x00;                           // from port 1024
  u[2] = 0; u[3] = 53;
  u[4] = (u.length >> 8) & 255; u[5] = u.length & 255;
  u.set(q, 8);
  return u;
}
{
  const { net, out, feed } = harness();
  feed(ipPacket(17, GUEST, ip4(10, 0, 2, 2), dnsQuery("example.com")));
  eq(out.length, 1, "a name query is answered");
  const u = body(out[0]);
  eq([u[2], u[3]], [0x04, 0x00], "to the port that asked (1024)");
  const d = u.subarray(8);
  eq([d[0], d[1]], [0x2A, 0x2A], "the transaction id comes back");
  eq(d[2] & 0x80, 0x80, "flagged as a response");
  eq([d[6], d[7]], [0, 1], "with one answer");
  const a = d.subarray(d.length - 4);
  eq([...a], [10, 64, 0, 1], "the first name gets the first address in the pool");
  eq(net.nameFor(ip4(10, 64, 0, 1)), "example.com", "and the address remembers whose it is");
  feed(ipPacket(17, GUEST, ip4(10, 0, 2, 2), dnsQuery("example.com")));
  const again = body(out[1]).subarray(8);
  eq([...again.subarray(again.length - 4)], [10, 64, 0, 1], "the same name keeps its address");
  feed(ipPacket(17, GUEST, ip4(10, 0, 2, 2), dnsQuery("other.example")));
  const other = body(out[2]).subarray(8);
  eq([...other.subarray(other.length - 4)], [10, 64, 0, 2], "a second name gets the next one");
}

/* ---------------------------------------------------------------- TCP */
function tcpSeg(sport, dport, seq, ack, flags, payload) {
  const data = payload ? Uint8Array.from(payload, c => typeof c === "string" ? c.charCodeAt(0) : c) : new Uint8Array(0);
  const t = new Uint8Array(20 + data.length);
  t[0] = (sport >> 8) & 255; t[1] = sport & 255;
  t[2] = (dport >> 8) & 255; t[3] = dport & 255;
  t[4] = (seq >>> 24) & 255; t[5] = (seq >>> 16) & 255; t[6] = (seq >>> 8) & 255; t[7] = seq & 255;
  t[8] = (ack >>> 24) & 255; t[9] = (ack >>> 16) & 255; t[10] = (ack >>> 8) & 255; t[11] = ack & 255;
  t[12] = 5 << 4; t[13] = flags;
  t[14] = 0x20;
  t.set(data, 20);
  return t;
}
{
  const { net, out, feed } = harness();
  const addr = net.addressFor("example.com");
  const SYN = 2, ACK = 16, PSH = 8, FIN = 1;
  feed(ipPacket(6, GUEST, addr, tcpSeg(1055, 80, 1000, 0, SYN)));
  eq(out.length, 1, "a SYN is answered");
  let t = body(out[0]);
  eq(t[13], SYN | ACK, "with SYN+ACK");
  eq([t[0], t[1]], [0, 80], "from the port it connected to");
  const theirAck = (t[8] << 24 | t[9] << 16 | t[10] << 8 | t[11]) >>> 0;
  eq(theirAck, 1001, "acknowledging the SYN's sequence number");
  eq(checksum((() => {                                      // the pseudo-header sum must come out zero
    const ph = new Uint8Array(12 + t.length);
    ph[0] = (addr >>> 24) & 255; ph[1] = (addr >>> 16) & 255; ph[2] = (addr >>> 8) & 255; ph[3] = addr & 255;
    ph[4] = 10; ph[5] = 0; ph[6] = 2; ph[7] = 15;
    ph[9] = 6; ph[10] = (t.length >> 8) & 255; ph[11] = t.length & 255;
    ph.set(t, 12);
    return ph;
  })(), 0, 12 + t.length), 0, "and a valid TCP checksum");

  const req = "GET /index.html HTTP/1.0\r\nHost: example.com\r\n\r\n";
  feed(ipPacket(6, GUEST, addr, tcpSeg(1055, 80, 1001, 0, ACK | PSH, [...req])));
  eq(out.requests.length, 1, "a complete request is handed over once");
  eq(out.requests[0].host, "example.com", "with the name the guest looked up");
  eq(out.requests[0].port, 80, "and the port");
  eq(out.requests[0].text, req, "byte for byte");

  const conn = out.requests[0].conn;
  const before = out.length;
  net.deliver(conn, Uint8Array.from("HTTP/1.0 200 OK\r\n\r\nhi", c => c.charCodeAt(0)));
  net.finish(conn);
  const sent = out.slice(before).map(p => body(p));
  eq(sent.length, 2, "the response goes out as data then a close");
  eq(String.fromCharCode(...sent[0].subarray(20)), "HTTP/1.0 200 OK\r\n\r\nhi", "the bytes arrive intact");
  eq(sent[1][13] & FIN, FIN, "and the connection is closed");

  feed(ipPacket(6, GUEST, addr, tcpSeg(1055, 80, 1001 + req.length, 0, FIN)));
  eq(out.requests.length, 1, "a late FIN does not produce another request");
}

/* ---------------------------------------------------------------- an address is an address */
{
  eq(ipStr(ip4(192, 168, 4, 62)), "192.168.4.62", "addresses print as people write them");
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
