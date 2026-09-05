#!/usr/bin/env python3
"""Write phone.ico: one 32x32 16-colour icon (a phone, screen lit) for PHONE.EXE.

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


# A phone: a black body, a lit screen, an earpiece slot and a home button. The same drawing the
# boot artwork uses, at 32 pixels.
rect(9, 1, 22, 30, BLACK)                    # the body
rect(10, 5, 21, 25, WHITE)                   # the screen, lit
rect(10, 5, 21, 5, SILVER)                   # a highlight along the top of the glass
rect(10, 5, 10, 25, SILVER)
rect(13, 3, 18, 3, GRAY)                     # the earpiece
rect(14, 27, 17, 28, GRAY)                   # the home button
rect(12, 9, 15, 13, BLUE)                    # four panes, the flag on the screen
rect(16, 9, 19, 13, GRAY)
rect(12, 15, 15, 19, GRAY)
rect(16, 15, 19, 19, BLUE)

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
open(sys.argv[1] if len(sys.argv) > 1 else "phone.ico", "wb").write(out)
print("wrote %s (%d bytes)" % (sys.argv[1] if len(sys.argv) > 1 else "phone.ico", len(out)))
