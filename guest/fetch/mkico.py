#!/usr/bin/env python3
"""Write fetch.ico: one 32x32 16-colour icon for FETCH.EXE -- a globe, which is what a 1994 icon
for "the network is out there" looked like.

The standard Windows 16-colour palette, so tools/grpadd.py's nearest-colour mapping into the
Program Manager group file is the identity. Layout: ICONDIR + ICONDIRENTRY + a DIB whose
BITMAPINFOHEADER has height 2*32 (XOR bits then the AND mask), rows bottom-up.
"""
import struct
import sys

STD16 = [(0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0), (0, 0, 128), (128, 0, 128), (0, 128, 128), (192, 192, 192),
         (128, 128, 128), (255, 0, 0), (0, 255, 0), (255, 255, 0), (0, 0, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)]
BLACK, NAVY, GREEN, BLUE, CYAN = 0, 4, 2, 12, 14

W = H = 32
px = [[None] * W for _ in range(H)]          # None = transparent


def plot(x, y, c):
    if 0 <= x < W and 0 <= y < H:
        px[y][x] = c


# A globe: a disc of ocean, lighter towards the north-west, a black rim, the equator and three
# meridians in a darker blue, and two continents where the Atlantic leaves them.
cx = cy = 15.5
R = 13.0
for y in range(H):
    for x in range(W):
        d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
        if d <= R - 1.0:
            plot(x, y, CYAN if (x - cx) + (y - cy) < -6 else BLUE)
        elif d <= R:
            plot(x, y, BLACK)

for x in range(W):
    if abs(x - cx) <= R - 1.0:
        plot(x, int(round(cy)), NAVY)
for y in range(H):
    dy = (y - cy) / R
    if abs(dy) <= 1.0:
        w = R * (1.0 - dy * dy) ** 0.5
        for f in (0.0, -0.55, 0.55):
            plot(int(round(cx + w * f)), y, NAVY)

for (x, y) in [(11, 9), (12, 9), (13, 9), (10, 10), (11, 10), (12, 10), (13, 10), (14, 10),
               (11, 11), (12, 11), (13, 11), (12, 12), (12, 13), (11, 14), (12, 14),
               (19, 12), (20, 12), (21, 12), (19, 13), (20, 13), (21, 13), (22, 13),
               (20, 14), (21, 14), (20, 15), (21, 15), (20, 16), (19, 17), (20, 17)]:
    if ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 <= R - 1.0:
        plot(x, y, GREEN)

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
name = sys.argv[1] if len(sys.argv) > 1 else "fetch.ico"
open(name, "wb").write(out)
print("wrote %s (%d bytes)" % (name, len(out)))
