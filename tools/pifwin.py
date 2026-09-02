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
        # clear fFullScreen, set fALTENTERdis: no way back to full screen from inside the box
        new = (flags & ~0x8) | 0x100
        struct.pack_into("<I", d, off + 16, new)
        # low priorities: a DOS session at the default foreground priority (100) starves Windows,
        # and on a phone the emulator is slow to begin with; 20/10 keeps the desktop responsive
        struct.pack_into("<HH", d, off + 4, 20, 10)
        print(f"{sys.argv[2]}: 386 flags {flags:#x} -> {new:#x} (windowed, Alt+Enter disabled)")
    if nxt == 0xFFFF: break
    p = nxt
open(sys.argv[2], "wb").write(d)
