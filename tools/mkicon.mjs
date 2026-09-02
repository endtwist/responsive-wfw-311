// Home-screen icons: the Windows 3.1 flag as pixel art (the four waving panes, black trail), drawn
// at 32 px in the VGA palette and scaled up with nearest neighbour, so it reads as guest pixels.
// Usage: node tools/mkicon.mjs  -> web/icon-192.png, web/icon-512.png
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

const OUT = path.resolve(new URL(".", import.meta.url).pathname, "..", "web");

function png(width, height, rgba) {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  const crc = buf => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// 32x32 source, VGA colours: . background (teal desktop), K black, R red, G green, B blue, Y yellow, w white
const PAL = { ".": [0, 128, 128], K: [0, 0, 0], R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255], Y: [255, 255, 0], w: [255, 255, 255] };
const art = [
  "................................",
  "................................",
  "................................",
  "........KKK..RRRRRRR..GGGGGGG...",
  ".....KKK.....RRRRRRR..GGGGGGG...",
  "...KK........RRRRRRR..GGGGGGG...",
  "..K..........RRRRRRR..GGGGGGG...",
  ".K...........RRRRRRR..GGGGGGG...",
  ".K...........RRRRRRR..GGGGGGG...",
  "K............RRRRRRR..GGGGGGG...",
  "K.....KKK....RRRRRRR..GGGGGGG...",
  "K...KK.......RRRRRRR..GGGGGGG...",
  "K..K............................",
  "K.K..........BBBBBBB..YYYYYYY...",
  "KK...........BBBBBBB..YYYYYYY...",
  "K............BBBBBBB..YYYYYYY...",
  "K.....KKK....BBBBBBB..YYYYYYY...",
  "K...KK.......BBBBBBB..YYYYYYY...",
  "K..K.........BBBBBBB..YYYYYYY...",
  ".KK..........BBBBBBB..YYYYYYY...",
  ".K...........BBBBBBB..YYYYYYY...",
  ".K....KKK....BBBBBBB..YYYYYYY...",
  "..K.KK..........................",
  "..KK............................",
  "................................",
  "................................",
  "................................",
  "................................",
  "................................",
  "................................",
  "................................",
  "................................",
];
// The panes wave: shift each pane's rows so the top edge slopes, as the original does.
function make(size) {
  const s = size / 32;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sx = Math.floor(x / s), sy = Math.floor(y / s);
    // wave: within each pane column, rows shift down toward the right by up to 2 px
    const ch0 = art[sy][sx];
    let ch = ch0;
    if ("RGBY".includes(ch0) || ch0 === ".") {
      const col = sx >= 13 && sx <= 20 ? sx - 13 : sx >= 22 && sx <= 28 ? sx - 22 : -1;
      if (col >= 0) { const wy = sy - Math.round(col / 4); ch = wy >= 0 && wy < 32 ? art[wy][sx] : "."; if (!"RGBY".includes(ch)) ch = "."; }
    }
    const c = PAL[ch] || PAL["."];
    const i = (y * size + x) * 4;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
  }
  return png(size, size, out);
}
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), make(size));
  console.log(`web/icon-${size}.png`);
}
