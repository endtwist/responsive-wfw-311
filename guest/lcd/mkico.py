#!/usr/bin/env python3
"""Write lcd.ico: one 32x32 16-colour icon (a white note with a blue "i") for LCD.EXE.

The standard Windows 16-colour palette, so tools/grpadd.py's nearest-colour mapping into the
Program Manager group file is the identity. Layout: ICONDIR + ICONDIRENTRY + a DIB whose
BITMAPINFOHEADER has height 2*32 (XOR bits then the AND mask), rows bottom-up.
"""
import struct
import sys

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


# A laptop screen: a grey case, a lit greenish panel, a hinge line and a base.
rect(3, 4, 28, 24, SILVER)                   # the case
rect(3, 4, 28, 4, BLACK)
rect(3, 24, 28, 24, BLACK)
rect(3, 4, 3, 24, BLACK)
rect(28, 4, 28, 24, BLACK)
rect(6, 7, 25, 21, WHITE)                    # the panel, lit
rect(6, 7, 25, 7, GRAY)
rect(6, 7, 6, 21, GRAY)
rect(24, 8, 25, 21, SILVER)                  # brighter down the tube side
rect(9, 10, 22, 10, GRAY)                    # a couple of lines of "text"
rect(9, 13, 20, 13, GRAY)
rect(9, 16, 22, 16, GRAY)
rect(2, 26, 29, 29, SILVER)                  # the base
rect(2, 26, 29, 26, BLACK)
rect(2, 29, 29, 29, BLACK)
rect(2, 26, 2, 29, BLACK)
rect(29, 26, 29, 29, BLACK)
rect(12, 27, 19, 28, GRAY)                   # a keyboard hint

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
open(sys.argv[1] if len(sys.argv) > 1 else "lcd.ico", "wb").write(out)
print("wrote %s (%d bytes)" % (sys.argv[1] if len(sys.argv) > 1 else "lcd.ico", len(out)))
