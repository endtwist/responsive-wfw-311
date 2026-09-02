#!/usr/bin/env python3
"""Scale a Windows 2.x/3.x .BMP by an integer factor, nearest-neighbour, keeping its format.

The display driver's system bitmaps (OBM_*: caption boxes, scroll arrows, check boxes) set the
size of Windows' own chrome, so a scaled set makes captions, scroll bars and buttons thumb-sized
with nothing but Windows' own pixels. Handles BITMAPCOREHEADER (Windows 2.x, 16-bit width and
height, used by the DDK's RES96 set) and BITMAPINFOHEADER files, 1/4/8 bpp.
Usage: scalebmp.py FACTOR IN.BMP OUT.BMP   (FACTOR may be fractional, e.g. 1.5)
"""
import struct, sys

def scale(data, n):
    assert data[:2] == b"BM", "not a BMP"
    off_bits = struct.unpack_from("<I", data, 10)[0]
    hdr_size = struct.unpack_from("<I", data, 14)[0]
    if hdr_size == 12:                                   # BITMAPCOREHEADER
        w, h, planes, bpp = struct.unpack_from("<HHHH", data, 18)
        pal_entry = 3
    else:                                                # BITMAPINFOHEADER
        w, h, planes, bpp = struct.unpack_from("<iiHH", data, 18)
        pal_entry = 4
    assert planes == 1 and bpp in (1, 4, 8), (planes, bpp)
    top_down = h < 0
    h = abs(h)
    stride = (w * bpp + 31) // 32 * 4
    W, H = round(w * n), round(h * n)
    STRIDE = (W * bpp + 31) // 32 * 4

    def px(row, x):
        if bpp == 8: return row[x]
        if bpp == 4: return (row[x >> 1] >> (4 if x & 1 == 0 else 0)) & 0xF
        return (row[x >> 3] >> (7 - (x & 7))) & 1

    out_rows = []
    for y in range(h):
        row = data[off_bits + y * stride: off_bits + (y + 1) * stride]
        new = bytearray(STRIDE)
        for x in range(W):
            v = px(row, min(w - 1, int(x / n)))
            if bpp == 8: new[x] = v
            elif bpp == 4: new[x >> 1] |= v << (4 if x & 1 == 0 else 0)
            else: new[x >> 3] |= v << (7 - (x & 7))
        out_rows.append(bytes(new))
    # rows: nearest-neighbour too, so a fractional factor repeats some rows and not others
    pixels = b"".join(out_rows[min(h - 1, int(Y / n))] for Y in range(H))

    head = bytearray(data[:off_bits])
    if hdr_size == 12:
        struct.pack_into("<HH", head, 18, W, H)
    else:
        struct.pack_into("<ii", head, 18, W, -H if top_down else H)
        struct.pack_into("<I", head, 34, len(pixels))
    struct.pack_into("<I", head, 2, len(head) + len(pixels))
    return bytes(head) + pixels

if __name__ == "__main__":
    n, src, dst = float(sys.argv[1]), sys.argv[2], sys.argv[3]
    open(dst, "wb").write(scale(open(src, "rb").read(), n))
