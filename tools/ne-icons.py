#!/usr/bin/env python3
"""List and extract icons / bitmaps from a Win16 NE executable (EXE, DLL, DRV).

    python3 tools/ne-icons.py list  PROGMAN.EXE
    python3 tools/ne-icons.py icons PROGMAN.EXE OUTDIR          # every RT_ICON -> PNG (RGBA)
    python3 tools/ne-icons.py icon  PROGMAN.EXE ID OUT.PNG [--scale N] [--pad W H] [--bg RRGGBB]
    python3 tools/ne-icons.py bitmaps PROGMAN.EXE OUTDIR        # every RT_BITMAP -> PNG

An RT_ICON resource is a DIB fragment: BITMAPINFOHEADER (biHeight doubled), colour table,
XOR bitmap (bottom-up, 4-byte padded rows), then a 1-bpp AND mask. Pixels whose AND bit is 1
are transparent. RT_GROUP_ICON is the .ICO directory that names the RT_ICON ids. No Pillow
needed: PNGs are written by hand with zlib. `--scale` is a nearest-neighbour integer upscale,
`--pad` centres the result on a W x H canvas, `--bg` fills transparency (and the padding)
with an opaque colour; without it the padding is transparent.
"""
import struct
import sys
import zlib

RT_NAMES = {1: "CURSOR", 2: "BITMAP", 3: "ICON", 4: "MENU", 5: "DIALOG", 6: "STRING",
            7: "FONTDIR", 8: "FONT", 9: "ACCELERATOR", 10: "RCDATA", 11: "MESSAGETABLE",
            12: "GROUP_CURSOR", 14: "GROUP_ICON", 16: "VERSION"}
RT_BITMAP, RT_ICON, RT_GROUP_ICON = 2, 3, 14


def parse_ne(data):
    """Return a list of (type_id_or_name, res_id_or_name, offset, length)."""
    if data[:2] != b"MZ":
        raise SystemExit("not an MZ executable")
    ne = struct.unpack_from("<I", data, 0x3C)[0]
    if data[ne:ne + 2] != b"NE":
        raise SystemExit("not an NE (Win16) executable")
    rsrc_off = struct.unpack_from("<H", data, ne + 0x24)[0]
    restab_off = struct.unpack_from("<H", data, ne + 0x26)[0]  # resident names follow the resources
    if rsrc_off == 0 or rsrc_off == restab_off:
        return []
    base = ne + rsrc_off
    shift = struct.unpack_from("<H", data, base)[0]
    pos = base + 2
    out = []

    def name_at(rel):
        n = data[base + rel]
        return data[base + rel + 1: base + rel + 1 + n].decode("latin-1")

    while True:
        type_id, count = struct.unpack_from("<HH", data, pos)
        if type_id == 0:
            break
        pos += 8
        tkey = type_id & 0x7FFF if type_id & 0x8000 else name_at(type_id)
        for _ in range(count):
            off, length, _flags, rid = struct.unpack_from("<HHHH", data, pos)
            pos += 12
            rkey = rid & 0x7FFF if rid & 0x8000 else name_at(rid)
            out.append((tkey, rkey, off << shift, length << shift))
    return out


def rle_decode(blob, p, w, h, stride, bpp):
    """BI_RLE8 (bpp 8) / BI_RLE4 (bpp 4) -> packed bottom-up rows, same layout as an
    uncompressed DIB. Returns (bytes, position after the encoded data)."""
    out = bytearray(stride * h)
    x = y = 0

    def put(v):
        nonlocal x
        if x < w:
            if bpp == 8:
                out[y * stride + x] = v
            else:
                i = y * stride + (x >> 1)
                out[i] = (out[i] & 0x0F) | (v << 4) if not x & 1 else (out[i] & 0xF0) | (v & 0xF)
        x += 1

    while p + 1 < len(blob):
        n, v = blob[p], blob[p + 1]
        p += 2
        if n:  # encoded run
            for i in range(n):
                put(v if bpp == 8 else ((v >> 4) if not i & 1 else (v & 0xF)))
        elif v == 0:  # end of line
            x, y = 0, y + 1
        elif v == 1:  # end of bitmap
            break
        elif v == 2:  # delta
            x += blob[p]
            y += blob[p + 1]
            p += 2
        else:  # absolute run of v pixels, padded to a word
            nbytes = v if bpp == 8 else (v + 1) // 2
            for i in range(v):
                b = blob[p + (i if bpp == 8 else i >> 1)]
                put(b if bpp == 8 else ((b >> 4) if not i & 1 else (b & 0xF)))
            p += nbytes + (nbytes & 1)
    return bytes(out), p


def dib_to_rgba(blob, icon=True):
    """Decode a DIB fragment (icon=True: height is doubled and an AND mask follows).
    Returns (width, height, rgba bytes)."""
    (hsize, w, h, planes, bpp, comp) = struct.unpack_from("<IiiHHI", blob, 0)
    if comp not in (0, 1, 2):
        raise ValueError("biCompression=%d not supported" % comp)
    if icon:
        h //= 2
    ncol = struct.unpack_from("<I", blob, 32)[0] or (1 << bpp if bpp <= 8 else 0)
    pal = []
    p = hsize
    for _ in range(ncol):
        b, g, r, _ = blob[p:p + 4]
        pal.append((r, g, b))
        p += 4
    stride = ((w * bpp + 31) // 32) * 4
    if comp:
        xor, p = rle_decode(blob, p, w, h, stride, bpp)
    else:
        xor = blob[p:p + stride * h]
        p += stride * h
    mstride = ((w + 31) // 32) * 4
    mask = blob[p:p + mstride * h] if icon else None
    rgba = bytearray(w * h * 4)
    for y in range(h):
        row = xor[(h - 1 - y) * stride:(h - y) * stride]
        mrow = mask[(h - 1 - y) * mstride:(h - y) * mstride] if icon else None
        for x in range(w):
            if bpp == 1:
                idx = (row[x >> 3] >> (7 - (x & 7))) & 1
                r, g, b = pal[idx]
            elif bpp == 4:
                idx = (row[x >> 1] >> (0 if x & 1 else 4)) & 0xF
                r, g, b = pal[idx]
            elif bpp == 8:
                r, g, b = pal[row[x]]
            elif bpp == 24:
                b, g, r = row[x * 3:x * 3 + 3]
            else:
                raise ValueError("bpp %d not supported" % bpp)
            a = 255
            if icon and (mrow[x >> 3] >> (7 - (x & 7))) & 1:
                a = 0
            o = (y * w + x) * 4
            rgba[o:o + 4] = bytes((r, g, b, a))
    return w, h, bytes(rgba)


def scale_pad(w, h, rgba, scale=1, pad=None, bg=None):
    if scale > 1:
        out = bytearray()
        for y in range(h):
            row = bytearray()
            for x in range(w):
                row += rgba[(y * w + x) * 4:(y * w + x) * 4 + 4] * scale
            out += row * scale
        w, h, rgba = w * scale, h * scale, bytes(out)
    if bg is not None:
        br, bgc, bb = bg
        buf = bytearray(rgba)
        for i in range(0, len(buf), 4):
            if buf[i + 3] == 0:
                buf[i:i + 4] = bytes((br, bgc, bb, 255))
        rgba = bytes(buf)
    if pad:
        pw, ph = pad
        fill = bytes(bg) + b"\xff" if bg is not None else b"\0\0\0\0"
        canvas = bytearray(fill * (pw * ph))
        ox, oy = (pw - w) // 2, (ph - h) // 2
        for y in range(h):
            canvas[((oy + y) * pw + ox) * 4:((oy + y) * pw + ox + w) * 4] = rgba[y * w * 4:(y + 1) * w * 4]
        w, h, rgba = pw, ph, bytes(canvas)
    return w, h, rgba


def write_png(path, w, h, rgba):
    def chunk(tag, body):
        c = struct.pack(">I", len(body)) + tag + body
        return c + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    raw = b"".join(b"\0" + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    cmd, exe = argv[1], argv[2]
    data = open(exe, "rb").read()
    res = parse_ne(data)
    if cmd == "list":
        for t, rid, off, length in res:
            tname = RT_NAMES.get(t, str(t)) if isinstance(t, int) else repr(t)
            extra = ""
            if t == RT_ICON:
                _, w, h, _, bpp = struct.unpack_from("<IiiHH", data, off)
                extra = "  %dx%d %dbpp" % (w, h // 2, bpp)
            elif t == RT_BITMAP:
                _, w, h, _, bpp = struct.unpack_from("<IiiHH", data, off)
                extra = "  %dx%d %dbpp" % (w, h, bpp)
            elif t == RT_GROUP_ICON:
                n = struct.unpack_from("<H", data, off + 4)[0]
                ents = []
                for i in range(n):
                    w, h, cc, _, _, bpp, _, iid = struct.unpack_from("<BBBBHHIH", data, off + 6 + 14 * i)
                    ents.append("%dx%d/%dc->icon %d" % (w, h, cc, iid))
                extra = "  " + ", ".join(ents)
            print("%-12s %-12s off=0x%06x len=%6d%s" % (tname, rid, off, length, extra))
        return 0
    if cmd in ("icons", "bitmaps"):
        import os
        want = RT_ICON if cmd == "icons" else RT_BITMAP
        os.makedirs(argv[3], exist_ok=True)
        for t, rid, off, length in res:
            if t != want:
                continue
            w, h, rgba = dib_to_rgba(data[off:off + length], icon=(want == RT_ICON))
            p = os.path.join(argv[3], "%s_%s_%dx%d.png" % (cmd[:-1], rid, w, h))
            write_png(p, w, h, rgba)
            print(p)
        return 0
    if cmd == "icon":
        rid, out = int(argv[3]), argv[4]
        scale, pad, bg = 1, None, None
        rest = argv[5:]
        while rest:
            a = rest.pop(0)
            if a == "--scale":
                scale = int(rest.pop(0))
            elif a == "--pad":
                pad = (int(rest.pop(0)), int(rest.pop(0)))
            elif a == "--bg":
                v = rest.pop(0)
                bg = tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))
        for t, r, off, length in res:
            if t == RT_ICON and r == rid:
                w, h, rgba = dib_to_rgba(data[off:off + length])
                w, h, rgba = scale_pad(w, h, rgba, scale, pad, bg)
                write_png(out, w, h, rgba)
                print("%s %dx%d" % (out, w, h))
                return 0
        raise SystemExit("no RT_ICON %d" % rid)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
