#!/usr/bin/env python3
"""Make a Windows 3.x PIF run its DOS program in a window instead of full screen.

A full-screen DOS session switches the whole display to text mode, which takes the composited
desktop down with it; windowed sessions are drawn by the grabber into an ordinary window. Clears
fFullScreen (bit 3) in the 'WINDOWS 386 3.0' section's PfW386Flags.
Usage: pifwin.py IN.PIF OUT.PIF
"""
import struct, sys
d = bytearray(open(sys.argv[1], "rb").read())
p = 0x171
while p + 22 <= len(d):
    name = d[p:p+16].rstrip(b"\0 "); nxt, off, ln = struct.unpack_from("<HHH", d, p + 16)
    if name.startswith(b"WINDOWS 386"):
        flags = struct.unpack_from("<I", d, off + 16)[0]
        struct.pack_into("<I", d, off + 16, flags & ~0x8)
        print(f"{sys.argv[2]}: 386 flags {flags:#x} -> {flags & ~0x8:#x} (windowed)")
    if nxt == 0xFFFF: break
    p = nxt
open(sys.argv[2], "wb").write(d)
