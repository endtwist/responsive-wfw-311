#!/usr/bin/env python3
"""Build a single-font .FON from an existing raster font.

Windows 3.1 sizes captions, menus and caption boxes from the SYSTEM font (SYSTEM.INI [boot]
fonts.fon), not from the OEM bitmaps, so a taller system font is the native way to thumb-sized
chrome. Rather than scaling glyphs, this takes a hand-tuned raster from another FON (MS Sans
Serif 18 pt, 29 px, from SSERIFE.FON) and wraps it as the system font, retagged for the DPI in
use and renamed "System".

Usage: mkfon.py TEMPLATE.FON SOURCE.FON PIXEL_HEIGHT OUT.FON [dpi=120] [face=System]
"""
import struct, sys

def resources(d):
    ne = struct.unpack_from("<H", d, 0x3C)[0]
    assert d[ne:ne+2] == b"NE"
    rtab = ne + struct.unpack_from("<H", d, ne + 0x24)[0]
    shift = struct.unpack_from("<H", d, rtab)[0]
    p = rtab + 2
    out = []                       # (type, id, table_entry_pos, offset, length)
    while True:
        tid = struct.unpack_from("<H", d, p)[0]
        if tid == 0: break
        cnt = struct.unpack_from("<H", d, p + 2)[0]; p += 8
        for _ in range(cnt):
            off, ln, flags, rid = struct.unpack_from("<HHHH", d, p)
            out.append((tid, rid, p, off << shift, ln << shift))
            p += 12
    return ne, rtab, shift, out

def main():
    tpl, src, want_h, outp = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    opts = dict(a.split("=", 1) for a in sys.argv[5:])
    dpi, face = int(opts.get("dpi", "120")), opts.get("face", "System").encode()

    S = open(src, "rb").read()
    fnt = None
    for tid, rid, _, off, ln in resources(S)[3]:
        if tid == 0x8008:
            f = S[off:off + ln]
            if struct.unpack_from("<H", f, 88)[0] == want_h: fnt = bytearray(f); break
    assert fnt, f"no {want_h} px font in {src}"
    size = struct.unpack_from("<I", fnt, 2)[0]
    fnt = fnt[:size]                                     # resource padding off
    # Retag: point size for this dpi, resolution, and the face name (overwritten in place: the
    # name lives after the glyph bits and "System" is shorter than "MS Sans Serif").
    struct.pack_into("<H", fnt, 68, round(want_h * 72 / dpi))
    struct.pack_into("<HH", fnt, 70, dpi, dpi)
    face_off = struct.unpack_from("<I", fnt, 105)[0]
    old = fnt[face_off:fnt.index(b"\0", face_off)]
    assert len(face) <= len(old), "face name too long to patch in place"
    fnt[face_off:face_off + len(old)] = face + b"\0" * (len(old) - len(face))

    T = bytearray(open(tpl, "rb").read())
    ne, rtab, shift, res = resources(T)
    align = 1 << shift
    data_start = min(off for _, _, _, off, _ in res)
    out = bytearray(T[:data_start])
    def pad(b):
        b = bytes(b); return b + b"\0" * (-len(b) % align)
    for tid, rid, pos, off, ln in res:
        if tid == 0x8007:                                # FONTDIR: count, ordinal, header copy, names
            font_ord = next(r for t, r, *_ in res if t == 0x8008)
            entry = struct.pack("<HH", 1, font_ord) + bytes(fnt[:113]) + b"\0" + face + b"\0"
            blob = pad(entry)
        elif tid == 0x8008:
            blob = pad(fnt)
        else:
            blob = pad(T[off:off + ln])
        struct.pack_into("<HH", out, pos, len(out) >> shift, len(blob) >> shift)
        out += blob
    open(outp, "wb").write(out)
    print(f"{outp}: {len(out)} bytes, font {want_h} px, {dpi} dpi, face {face.decode()}")

if __name__ == "__main__":
    main()
