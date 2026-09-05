#!/usr/bin/env python3
"""Write grossis.ico for GROSSIS.EXE: the favicon from gross.is, as a Windows 3.1 icon.

The standard Windows 16-colour palette, so tools/grpadd.py's nearest-colour mapping into the
Program Manager group file is the identity. Layout: ICONDIR + ICONDIRENTRY + a DIB whose
BITMAPINFOHEADER has height 2*32 (XOR bits then the AND mask), rows bottom-up.
"""
import os
import struct
import sys

from PIL import Image

STD16 = [(0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0), (0, 0, 128), (128, 0, 128), (0, 128, 128), (192, 192, 192),
         (128, 128, 128), (255, 0, 0), (0, 255, 0), (255, 255, 0), (0, 0, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)]
BLACK, SILVER, GRAY, BLUE, WHITE = 0, 7, 8, 12, 15

W = H = 32
px = [[None] * W for _ in range(H)]          # None = transparent


def rect(x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if 0 <= x < W and 0 <= y < H:
                px[y][x] = c


# The site's own favicon (guest/grossis/favicon.png, the 32x32 frame of https://gross.is/
# favicon.ico), mapped onto the sixteen colours Windows 3.1 has. It is a red glyph on nothing, so
# the mapping is two decisions per pixel: transparent below half alpha, and otherwise the nearest
# of the sixteen -- which for this vermilion is the palette's bright red.
def nearest(rgb):
    r, g, b = rgb
    best, bi = None, 0
    for i, (pr, pg, pb) in enumerate(STD16):
        d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
        if best is None or d < best:
            best, bi = d, i
    return bi


src = Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "favicon.png")).convert("RGBA")
if src.size != (W, H):
    src = src.resize((W, H), Image.LANCZOS)
sp = src.load()
for y in range(H):
    for x in range(W):
        r, g, b, a = sp[x, y]
        px[y][x] = None if a < 128 else nearest((r, g, b))

pal = b"".join(struct.pack("<4B", b, g, r, 0) for (r, g, b) in STD16)
xor = bytearray()
for y in range(H - 1, -1, -1):               # bottom-up
    row = bytearray(W // 2)
    for x in range(W):
        v = px[y][x] if px[y][x] is not None else 0
        if x & 1:
            row[x >> 1] |= v
        else:
            row[x >> 1] |= v << 4
    xor += row
mask = bytearray()
for y in range(H - 1, -1, -1):
    row = bytearray(4)
    for x in range(W):
        if px[y][x] is None:
            row[x >> 3] |= 0x80 >> (x & 7)   # 1 = transparent
    mask += row

dib = struct.pack("<IiiHHIIiiII", 40, W, H * 2, 1, 4, 0, len(xor) + len(mask), 0, 0, 16, 0) + pal + bytes(xor) + bytes(mask)
out = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", W, H, 16, 0, 1, 4, len(dib), 22) + dib
open(sys.argv[1] if len(sys.argv) > 1 else "grossis.ico", "wb").write(out)
print("wrote %s (%d bytes)" % (sys.argv[1] if len(sys.argv) > 1 else "grossis.ico", len(out)))
