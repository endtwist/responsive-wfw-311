#!/usr/bin/env python3
"""Write page.ico: one 32x32 16-colour icon for PAGE.EXE -- a sheet of paper with a photograph on
it, which is what a 1994 icon for "a page with pictures in it" looked like.

The standard Windows 16-colour palette, so tools/grpadd.py's nearest-colour mapping into the
Program Manager group file is the identity. Layout: ICONDIR + ICONDIRENTRY + a DIB whose
BITMAPINFOHEADER has height 2*32 (XOR bits then the AND mask), rows bottom-up.
"""
import struct
import sys

STD16 = [(0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0), (0, 0, 128), (128, 0, 128), (0, 128, 128), (192, 192, 192),
         (128, 128, 128), (255, 0, 0), (0, 255, 0), (255, 255, 0), (0, 0, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)]
BLACK, GREY, DGREY, WHITE, NAVY, CYAN, GREEN, YELLOW = 0, 7, 8, 15, 4, 14, 2, 11

W = H = 32
px = [[None] * W for _ in range(H)]          # None = transparent


def plot(x, y, c):
    if 0 <= x < W and 0 <= y < H:
        px[y][x] = c


def rect(x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            plot(x, y, c)


# The sheet: white, a black rule round it, a grey shadow down the right and along the bottom.
rect(5, 2, 26, 30, BLACK)
rect(6, 3, 25, 29, WHITE)
rect(27, 4, 28, 30, DGREY)
rect(7, 31, 28, 31, DGREY)

# Two lines of text at the top, one of them a heading.
rect(9, 6, 22, 7, BLACK)
for y in (10, 13, 16):
    rect(9, y, 22 if y != 16 else 18, y, GREY)

# A photograph pasted onto the lower half: sky, a hill, a sun.
rect(9, 19, 22, 27, BLACK)
rect(10, 20, 21, 26, CYAN)
for x in range(10, 22):
    h = 3 - abs(x - 15) // 2
    for y in range(26 - h, 27):
        plot(x, y, GREEN)
for (x, y) in [(18, 21), (19, 21), (18, 22), (19, 22)]:
    plot(x, y, YELLOW)

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
name = sys.argv[1] if len(sys.argv) > 1 else "page.ico"
open(name, "wb").write(out)
print("wrote %s (%d bytes)" % (name, len(out)))
