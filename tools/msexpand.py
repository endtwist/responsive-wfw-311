#!/usr/bin/env python3
"""Decompress Microsoft SZDD ("compress.exe"/LZEXPAND) files, e.g. SVGA256.DR_ -> SVGA256.DRV.
Usage: msexpand.py IN.DR_ OUT.DRV   (OUT may be omitted: last char of extension restored from header)"""
import sys, os
def expand(data):
    if data[:8] != b"SZDD\x88\xf0\x27\x33":
        raise SystemExit("not an SZDD file (magic %r)" % data[:8])
    mode, last_char = data[8], chr(data[9])
    size = int.from_bytes(data[10:14], "little")
    out = bytearray(); win = bytearray(b" " * 4096); pos = 4096 - 16; i = 14
    while i < len(data) and len(out) < size:
        ctrl = data[i]; i += 1
        for b in range(8):
            if i >= len(data): break
            if ctrl & (1 << b):
                c = data[i]; i += 1; out.append(c); win[pos] = c; pos = (pos + 1) & 4095
            else:
                lo, hi = data[i], data[i+1]; i += 2
                off = lo | ((hi & 0xF0) << 4); ln = (hi & 0x0F) + 3
                for _ in range(ln):
                    c = win[off]; off = (off + 1) & 4095
                    out.append(c); win[pos] = c; pos = (pos + 1) & 4095
    return bytes(out[:size]), last_char
if __name__ == "__main__":
    src = sys.argv[1]; data = open(src, "rb").read(); out, last = expand(data)
    dst = sys.argv[2] if len(sys.argv) > 2 else (src[:-1] + last if src.endswith("_") else src + ".out")
    open(dst, "wb").write(out); print(f"{src} -> {dst} ({len(out)} bytes)")
