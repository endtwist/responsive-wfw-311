/* The host end of a serial line, as an internet.
 *
 * Windows for Workgroups shipped NetBEUI and IPX and no TCP/IP at all, and it could not do TLS if
 * it had: no ciphers worth the name and a 35 MIPS budget. So the guest gets a period-correct
 * dial-up link -- a Winsock over SLIP on COM1, which is exactly how everyone reached the internet
 * in 1994 -- and everything modern happens on this side of the wire. The guest thinks it has
 * dialled a terminal server. What it has is this file.
 *
 * v86 already emulates the UART, so there is no device to write: bytes the guest writes to COM1
 * arrive as `serial0-output` and bytes we hand back go in as `serial0-input`. This module is the
 * peer on the other end of that cable, and it is deliberately pure -- frames in, frames out, no
 * bus and no fetch -- so the whole stack can be driven from a test without an emulator
 * (v86/tests/pv/slipnet.mjs).
 *
 * What it answers:
 *   ICMP echo    - so `ping` from the guest proves the link before anything harder is tried
 *   DNS (UDP 53) - every name resolves to an address out of a private pool, and the name is
 *                  remembered against it, so a later connection to that address knows which host
 *                  the guest meant. This is how a 1994 stack reaches a 2026 name it cannot look up.
 *   TCP          - handshake, in-order data, and a close. A stream to port 80 is handed to the
 *                  owner of this object as (host, request bytes) and whatever comes back is
 *                  streamed to the guest. The owner does the fetch, off-device, over TLS if the
 *                  real site wants TLS: the guest asked for http and neither knows nor cares.
 *
 * Addresses: the host is 10.0.2.2, the guest 10.0.2.15 (what everyone's NAT uses, so a hand-typed
 * configuration in the guest matches what a person expects), and resolved names get 10.64.x.y.
 */

const END = 0xC0, ESC = 0xDB, ESC_END = 0xDC, ESC_ESC = 0xDD;

const IP_ICMP = 1, IP_TCP = 6, IP_UDP = 17;
const FIN = 1, SYN = 2, RST = 4, PSH = 8, ACK = 16;

function ip4(a, b, c, d) { return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0; }
function ipStr(v) { return `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`; }

/* The one's-complement sum every header in this file is checked with. */
function checksum(bytes, from, to) {
  let sum = 0;
  for (let i = from; i < to - 1; i += 2) sum += (bytes[i] << 8) | bytes[i + 1];
  if ((to - from) & 1) sum += bytes[to - 1] << 8;
  while (sum >>> 16) sum = (sum & 0xFFFF) + (sum >>> 16);
  return (~sum) & 0xFFFF;
}

export function slipEncode(payload) {
  const out = [END];
  for (const b of payload) {
    if (b === END) out.push(ESC, ESC_END);
    else if (b === ESC) out.push(ESC, ESC_ESC);
    else out.push(b);
  }
  out.push(END);
  return Uint8Array.from(out);
}

/* SLIP has no length field: a frame is whatever arrived between two ENDs. Empty frames (two ENDs
   in a row, which is normal padding) are dropped rather than passed on as zero-length packets. */
export class SlipReader {
  constructor() { this.buf = []; this.esc = false; }
  push(bytes) {
    const frames = [];
    for (const b of bytes) {
      if (b === END) {
        if (this.buf.length) frames.push(Uint8Array.from(this.buf));
        this.buf = []; this.esc = false;
        continue;
      }
      if (this.esc) { this.buf.push(b === ESC_END ? END : b === ESC_ESC ? ESC : b); this.esc = false; continue; }
      if (b === ESC) { this.esc = true; continue; }
      this.buf.push(b);
    }
    return frames;
  }
}

export class SlipNet {
  /* `send(bytes)` puts bytes on the wire towards the guest; `request(host, port, data, conn)` is
     called with a complete request the owner should satisfy off-device. Both are the owner's. */
  constructor({ send, request, log } = {}) {
    this.sendRaw = send || (() => {});
    this.request = request || (() => {});
    this.log = log || (() => {});
    this.reader = new SlipReader();
    this.hostIp = ip4(10, 0, 2, 2);
    this.guestIp = ip4(10, 0, 2, 15);
    this.names = new Map();          // name -> address handed out for it
    this.byAddr = new Map();         // address -> name
    this.nextName = ip4(10, 64, 0, 1);
    this.conns = new Map();          // "sport:dport" -> connection
    this.ipId = 1;
  }

  /* ------------------------------------------------------------------ the wire */
  fromGuest(bytes) {
    for (const frame of this.reader.push(bytes)) this.onIp(frame);
  }
  toGuest(packet) { this.sendRaw(slipEncode(packet)); }

  /* ------------------------------------------------------------------ IP */
  onIp(p) {
    if (p.length < 20 || (p[0] >> 4) !== 4) return;                 // not IPv4: SLIP carries nothing else
    const ihl = (p[0] & 15) * 4;
    const proto = p[9];
    const src = (p[12] << 24 | p[13] << 16 | p[14] << 8 | p[15]) >>> 0;
    const dst = (p[16] << 24 | p[17] << 16 | p[18] << 8 | p[19]) >>> 0;
    const body = p.subarray(ihl);
    if (src !== this.guestIp) this.guestIp = src;                   // whatever it configured itself as
    if (proto === IP_ICMP) return this.onIcmp(dst, body);
    if (proto === IP_UDP) return this.onUdp(dst, body);
    if (proto === IP_TCP) return this.onTcp(dst, body);
  }
  buildIp(proto, src, dst, body) {
    const p = new Uint8Array(20 + body.length);
    p[0] = 0x45; p[1] = 0;
    p[2] = (p.length >> 8) & 255; p[3] = p.length & 255;
    const id = this.ipId = (this.ipId + 1) & 0xFFFF;
    p[4] = (id >> 8) & 255; p[5] = id & 255;
    p[6] = 0x40;                                                    // don't fragment
    p[8] = 64; p[9] = proto;
    p[12] = (src >>> 24) & 255; p[13] = (src >>> 16) & 255; p[14] = (src >>> 8) & 255; p[15] = src & 255;
    p[16] = (dst >>> 24) & 255; p[17] = (dst >>> 16) & 255; p[18] = (dst >>> 8) & 255; p[19] = dst & 255;
    const c = checksum(p, 0, 20);
    p[10] = (c >> 8) & 255; p[11] = c & 255;
    p.set(body, 20);
    return p;
  }

  /* ------------------------------------------------------------------ ICMP: ping */
  onIcmp(dst, m) {
    if (m.length < 8 || m[0] !== 8) return;                         // only echo requests
    const reply = Uint8Array.from(m);
    reply[0] = 0; reply[2] = 0; reply[3] = 0;
    const c = checksum(reply, 0, reply.length);
    reply[2] = (c >> 8) & 255; reply[3] = c & 255;
    this.toGuest(this.buildIp(IP_ICMP, dst, this.guestIp, reply));
    this.log(`icmp echo from the guest to ${ipStr(dst)}: replied`);
  }

  /* ------------------------------------------------------------------ names */
  addressFor(name) {
    const key = name.toLowerCase();
    if (this.names.has(key)) return this.names.get(key);
    const addr = this.nextName;
    this.nextName = (this.nextName + 1) >>> 0;
    this.names.set(key, addr);
    this.byAddr.set(addr, key);
    this.log(`dns: ${key} is ${ipStr(addr)}`);
    return addr;
  }
  nameFor(addr) { return this.byAddr.get(addr) || ipStr(addr); }

  /* A DNS query, answered from the pool. Only A records and only the first question, which is all
     a 1994 resolver ever asks for. */
  onUdp(dst, u) {
    if (u.length < 8) return;
    const sport = (u[0] << 8) | u[1], dport = (u[2] << 8) | u[3];
    if (dport !== 53) return;
    const q = u.subarray(8);
    if (q.length < 12) return;
    let off = 12;
    const labels = [];
    while (off < q.length && q[off]) {
      const len = q[off];
      if (len > 63 || off + 1 + len > q.length) return;
      labels.push(String.fromCharCode(...q.subarray(off + 1, off + 1 + len)));
      off += 1 + len;
    }
    const nameEnd = off + 1;
    if (nameEnd + 4 > q.length) return;
    const name = labels.join(".");
    const addr = this.addressFor(name);
    /* The answer echoes the question and appends one A record with a pointer to the name. */
    const ans = new Uint8Array(nameEnd + 4 + 16);
    ans.set(q.subarray(0, nameEnd + 4));
    ans[2] = 0x81; ans[3] = 0x80;                                   // response, recursion available
    ans[6] = 0; ans[7] = 1;                                         // one answer
    let o = nameEnd + 4;
    ans[o++] = 0xC0; ans[o++] = 12;                                 // pointer to the question's name
    ans[o++] = 0; ans[o++] = 1;                                     // A
    ans[o++] = 0; ans[o++] = 1;                                     // IN
    ans[o++] = 0; ans[o++] = 0; ans[o++] = 0; ans[o++] = 60;        // ttl
    ans[o++] = 0; ans[o++] = 4;
    ans[o++] = (addr >>> 24) & 255; ans[o++] = (addr >>> 16) & 255;
    ans[o++] = (addr >>> 8) & 255; ans[o++] = addr & 255;
    this.sendUdp(dst, 53, sport, ans.subarray(0, o));
  }
  sendUdp(src, sport, dport, payload) {
    const u = new Uint8Array(8 + payload.length);
    u[0] = (sport >> 8) & 255; u[1] = sport & 255;
    u[2] = (dport >> 8) & 255; u[3] = dport & 255;
    u[4] = (u.length >> 8) & 255; u[5] = u.length & 255;
    u.set(payload, 8);
    this.toGuest(this.buildIp(IP_UDP, src, this.guestIp, u));       // checksum 0: allowed for UDP
  }

  /* ------------------------------------------------------------------ TCP */
  onTcp(dst, t) {
    if (t.length < 20) return;
    const sport = (t[0] << 8) | t[1], dport = (t[2] << 8) | t[3];
    const seq = (t[4] << 24 | t[5] << 16 | t[6] << 8 | t[7]) >>> 0;
    const flags = t[13];
    const doff = (t[12] >> 4) * 4;
    const data = t.subarray(doff);
    const key = `${sport}:${dport}:${dst >>> 0}`;
    let c = this.conns.get(key);

    if (flags & SYN && !(flags & ACK)) {
      /* The guest's maximum segment size, out of the SYN's options. A peer must not send a segment
         larger than this, and the guest here means it: Trumpet is configured with an MTU of 576 and
         drops anything bigger, so a reply sent in 1 KB segments arrives as nothing at all and the
         program sits on "Waiting for the reply". 536 is the default when no option is offered. */
      let mss = 536;
      for (let o = 20; o < doff && o < t.length; ) {
        const kind = t[o];
        if (kind === 0) break;                                      // end of options
        if (kind === 1) { o++; continue; }                           // no-op padding
        const len = t[o + 1];
        if (!len || o + len > doff) break;
        if (kind === 2 && len === 4) mss = (t[o + 2] << 8) | t[o + 3];
        o += len;
      }
      if (mss < 128) mss = 128;
      c = { key, sport, dport, addr: dst, host: this.nameFor(dst), theirs: (seq + 1) >>> 0,
            mine: 0x1000, req: [], open: true, sent: false, mss,
            /* Flow control: what is queued for the guest, how far it has acknowledged, and the
               window it last advertised. Without this the host pushed a whole page down the line as
               fast as it could build frames -- half a megabyte of Wikipedia at once -- and the
               guest, which reads it a few hundred bytes at a time, saw the first 16 KB and lost the
               rest. */
            q: [], qoff: 0, qbytes: 0, una: 0, win: ((t[14] << 8) | t[15]) || 2048,
            wantFin: false, finSent: false };
      this.conns.set(key, c);
      this.tcp(c, SYN | ACK);
      c.mine = (c.mine + 1) >>> 0;
      c.una = c.mine;
      this.log(`tcp: connection to ${c.host}:${dport} opened (mss ${mss})`);
      return;
    }
    if (!c) { return; }                                             // stray segment: nothing to reset to
    if (flags & ACK) {
      const ack = (t[8] << 24 | t[9] << 16 | t[10] << 8 | t[11]) >>> 0;
      if (((ack - c.una) >>> 0) < 0x80000000) c.una = ack;           // sequence arithmetic wraps
      /* A window of zero would stall the connection until the guest sent an update of its own
         accord; one segment is offered instead, which is what a zero-window probe does. */
      c.win = ((t[14] << 8) | t[15]) || c.mss;
      this.pump(c);
    }
    if (data.length) {
      c.theirs = (c.theirs + data.length) >>> 0;
      for (const b of data) c.req.push(b);
      this.tcp(c, ACK);
      /* A request is complete at a blank line -- that is HTTP/1.0's own rule, and a 1994 browser
         sends nothing after it. Handing it over then avoids waiting for a close that will not
         come until we answer. */
      const s = String.fromCharCode(...c.req);
      if (!c.sent && (s.includes("\r\n\r\n") || s.includes("\n\n"))) {
        c.sent = true;
        this.request(c.host, c.dport, Uint8Array.from(c.req), c);
      }
    }
    if (flags & FIN) {
      c.theirs = (c.theirs + 1) >>> 0;
      this.tcp(c, ACK | FIN);
      c.open = false;
      this.conns.delete(key);
      this.log(`tcp: ${c.host}:${c.dport} closed by the guest`);
    }
  }
  /* The owner calls these two as its fetch produces bytes. Both only queue: what actually goes on
     the wire, and when, is pump()'s business. */
  deliver(c, bytes) {
    if (!c.open || !bytes.length) return;
    c.q.push(bytes);
    c.qbytes += bytes.length;
    this.pump(c);
  }
  finish(c) {
    if (!c.open) return;
    c.wantFin = true;
    this.pump(c);
  }
  /* Send as much as the guest's window has room for, a segment at a time, and close once the queue
     is empty. Called again from every ACK, which is what turns a 500 KB page into a conversation
     the guest can keep up with. */
  pump(c) {
    const mss = c.mss || 536;
    for (;;) {
      const inflight = (c.mine - c.una) >>> 0;
      const room = Math.min(c.win - inflight, mss, c.qbytes);
      if (room <= 0) break;
      const seg = new Uint8Array(room);
      let n = 0;
      while (n < room) {
        const head = c.q[0];
        const take = Math.min(head.length - c.qoff, room - n);
        seg.set(head.subarray(c.qoff, c.qoff + take), n);
        n += take; c.qoff += take;
        if (c.qoff >= head.length) { c.q.shift(); c.qoff = 0; }
      }
      c.qbytes -= room;
      this.tcp(c, ACK | PSH, seg);
      c.mine = (c.mine + room) >>> 0;
    }
    if (c.wantFin && !c.qbytes && !c.finSent) {
      c.finSent = true;
      this.tcp(c, ACK | FIN);
      c.mine = (c.mine + 1) >>> 0;
      c.open = false;
      this.conns.delete(c.key);
    }
  }
  tcp(c, flags, payload) {
    const body = payload || new Uint8Array(0);
    const t = new Uint8Array(20 + body.length);
    t[0] = (c.dport >> 8) & 255; t[1] = c.dport & 255;               // from the server's port
    t[2] = (c.sport >> 8) & 255; t[3] = c.sport & 255;
    t[4] = (c.mine >>> 24) & 255; t[5] = (c.mine >>> 16) & 255; t[6] = (c.mine >>> 8) & 255; t[7] = c.mine & 255;
    t[8] = (c.theirs >>> 24) & 255; t[9] = (c.theirs >>> 16) & 255; t[10] = (c.theirs >>> 8) & 255; t[11] = c.theirs & 255;
    t[12] = 5 << 4; t[13] = flags;
    t[14] = 0x20; t[15] = 0x00;                                      // an 8 KB window: plenty for this
    t.set(body, 20);
    /* TCP's checksum covers a pseudo-header of the addresses, the protocol and the length. */
    const ph = new Uint8Array(12 + t.length);
    const src = c.addr >>> 0, dst = this.guestIp >>> 0;
    ph[0] = (src >>> 24) & 255; ph[1] = (src >>> 16) & 255; ph[2] = (src >>> 8) & 255; ph[3] = src & 255;
    ph[4] = (dst >>> 24) & 255; ph[5] = (dst >>> 16) & 255; ph[6] = (dst >>> 8) & 255; ph[7] = dst & 255;
    ph[9] = IP_TCP; ph[10] = (t.length >> 8) & 255; ph[11] = t.length & 255;
    ph.set(t, 12);
    const ck = checksum(ph, 0, ph.length);
    t[16] = (ck >> 8) & 255; t[17] = ck & 255;
    this.toGuest(this.buildIp(IP_TCP, c.addr, this.guestIp, t));
  }
}

export const _internals = { checksum, ip4, ipStr };
