#!/usr/bin/env python3
"""Add (or replace) an item in a Windows 3.x Program Manager group file (.GRP), in place.

    python3 tools/grpadd.py GAMES.GRP "SkiFree" 'C:\\GAMES\\SKI.EXE' [--exe path/to/SKI.EXE] [--icon N]
    python3 tools/grpadd.py GAMES.GRP --list

The .GRP format ("PMCC", Windows 3.1 SDK "Program Manager group file format"):

    GROUPHEADER  cIdentifier[4] wCheckSum cbGroup nCmdShow rcNormal ptMin pName cxIcon cyIcon
                 wIconFormat wReserved cItems rgiItems[cItems]        (34 bytes + 2 per item)
    ITEMDATA     pt iIcon cbHeader cbANDPlane cbXORPlane pHeader pANDPlane pXORPlane pName pCommand
                 pIconPath                                            (24 bytes; all p* are file offsets)

wCheckSum makes the 16-bit word sum of the whole file zero. Each item carries its icon in the
*display driver's* device format: a 12-byte CURSORSHAPE header (hot spot, cx, cy, cbWidth = bytes
per plane row, Planes, BitsPixel) then the AND mask (1 bpp, rows top-down) and the XOR bits. The
stock groups are wIconFormat 0x0401 (4 planes x 1 bpp, VGA): rows top-down, each row 4 x 4 bytes,
plane 0..3 one after the other within the row, and the 4-bit value is the index in the standard
16-colour palette (verified against Solitaire's RT_ICON: identity mapping). The icon comes from
the executable's RT_GROUP_ICON `--icon N` (1-based ordinal, default the first): its 32x32 4 bpp
member, whose colour table is mapped to the nearest standard colour. Program Manager re-extracts
icons itself when the display driver changes, so what matters most is that pIconPath exists on
the guest's disk; the bits here are what it shows until then. An item whose command line matches
(case-insensitively) is replaced, so the tool is idempotent.
"""
import importlib.util
import os
import struct
import sys

STD16 = [(0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0), (0, 0, 128), (128, 0, 128), (0, 128, 128), (192, 192, 192),
         (128, 128, 128), (255, 0, 0), (0, 255, 0), (255, 255, 0), (0, 0, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)]
HDR = "<4sHHHhhhhhhHHHHHH"          # 34 bytes
ITEM = "<hhHHHHHHHHHH"              # 24 bytes


def cstr(buf, off):
    return buf[off:buf.index(b"\0", off)].decode("cp437")


def parse(g):
    h = struct.unpack_from(HDR, g, 0)
    if h[0] != b"PMCC":
        raise SystemExit("not a PMCC group file")
    n = h[15]
    offs = struct.unpack_from("<%dH" % n, g, 34)
    items = []
    for o in offs:
        f = struct.unpack_from(ITEM, g, o)
        pt, iicon, cbh, cba, cbx, ph, pa, px, pn, pc, pi = (f[0], f[1]), f[2], f[3], f[4], f[5], f[6], f[7], f[8], f[9], f[10], f[11]
        items.append(dict(pt=pt, iicon=iicon, hdr=g[ph:ph + cbh], andp=g[pa:pa + cba], xorp=g[px:px + cbx],
                          name=cstr(g, pn), cmd=cstr(g, pc), iconpath=cstr(g, pi)))
    return dict(ncmd=h[3], rc=h[4:8], ptmin=h[8:10], gname=cstr(g, h[10]), cx=h[11], cy=h[12], fmt=h[13], items=items)


def build(grp):
    n = len(grp["items"])
    body = bytearray(34 + 2 * n)
    offs = []
    gname_off = len(body)
    body += grp["gname"].encode("cp437") + b"\0"
    for it in grp["items"]:
        o = len(body)
        offs.append(o)
        body += bytes(24)
        pn = len(body); body += it["name"].encode("cp437") + b"\0"
        pc = len(body); body += it["cmd"].encode("cp437") + b"\0"
        pi = len(body); body += it["iconpath"].encode("cp437") + b"\0"
        ph = len(body); body += it["hdr"]
        pa = len(body); body += it["andp"]
        px = len(body); body += it["xorp"]
        struct.pack_into(ITEM, body, o, it["pt"][0], it["pt"][1], it["iicon"], len(it["hdr"]), len(it["andp"]), len(it["xorp"]), ph, pa, px, pn, pc, pi)
    if len(body) & 1:
        body += b"\0"
    struct.pack_into(HDR, body, 0, b"PMCC", 0, len(body), grp["ncmd"], *grp["rc"], *grp["ptmin"], gname_off,
                     grp["cx"], grp["cy"], grp["fmt"], 0, n)
    struct.pack_into("<%dH" % n, body, 34, *offs)
    s = sum(struct.unpack_from("<%dH" % (len(body) // 2), body, 0)) & 0xFFFF
    struct.pack_into("<H", body, 4, (-s) & 0xFFFF)
    return bytes(body)


def vga_icon_from_exe(exe, ordinal):
    """The 32x32 4 bpp member of the exe's Nth RT_GROUP_ICON as (hdr, and_plane, xor_planes)."""
    spec = importlib.util.spec_from_file_location("ne_icons", os.path.join(os.path.dirname(os.path.abspath(__file__)), "ne-icons.py"))
    ne = importlib.util.module_from_spec(spec); spec.loader.exec_module(ne)
    data = open(exe, "rb").read()
    res = ne.parse_ne(data)
    groups = [r for r in res if r[0] == ne.RT_GROUP_ICON]
    if not groups:
        raise SystemExit("%s: no RT_GROUP_ICON" % exe)
    if ordinal < 1 or ordinal > len(groups):
        raise SystemExit("%s: has %d group icons" % (exe, len(groups)))
    _, _, goff, glen = groups[ordinal - 1]
    count = struct.unpack_from("<H", data, goff + 4)[0]
    pick = None
    for i in range(count):
        w, h, ncol, _r, _planes, bpp, _size, rid = struct.unpack_from("<BBBBHHIH", data, goff + 6 + 14 * i)
        if w == 32 and h == 32 and (ncol == 16 or bpp == 4):
            pick = rid
    if pick is None:
        raise SystemExit("%s: group icon %d has no 32x32 16-colour member" % (exe, ordinal))
    icon = [r for r in res if r[0] == ne.RT_ICON and r[1] == pick][0]
    blob = data[icon[2]:icon[2] + icon[3]]
    (hsize, w, h, _planes, bpp, comp) = struct.unpack_from("<IiiHHI", blob, 0)
    if comp or bpp != 4 or w != 32 or h != 64:
        raise SystemExit("%s: icon %d is not an uncompressed 32x32 4 bpp DIB" % (exe, pick))
    pal = []
    p = hsize
    for _ in range(16):
        b, g, r, _ = blob[p:p + 4]; p += 4
        pal.append(min(range(16), key=lambda i: (STD16[i][0] - r) ** 2 + (STD16[i][1] - g) ** 2 + (STD16[i][2] - b) ** 2))
    xor = blob[p:p + 16 * 32]; p += 16 * 32
    mask = blob[p:p + 4 * 32]
    andp = bytearray(128); xorp = bytearray(512)
    for y in range(32):
        src = 31 - y                                   # DIB rows are bottom-up, the device format top-down
        andp[y * 4:y * 4 + 4] = mask[src * 4:src * 4 + 4]
        row = xor[src * 16:src * 16 + 16]
        for x in range(32):
            v = pal[(row[x >> 1] >> (0 if x & 1 else 4)) & 0xF]
            for pl in range(4):
                if (v >> pl) & 1:
                    xorp[y * 16 + pl * 4 + (x >> 3)] |= 0x80 >> (x & 7)
    hdr = struct.pack("<hhhhhBB", 16, 16, 32, 32, 4, 4, 1)   # CURSORSHAPE: hot spot, cx, cy, cbWidth, Planes, BitsPixel
    return bytes(hdr), bytes(andp), bytes(xorp)


def main(argv):
    if len(argv) < 3:
        print(__doc__); return 2
    path = argv[1]
    grp = parse(open(path, "rb").read())
    if argv[2] == "--list":
        print("%s: %d items, icon format 0x%04x" % (grp["gname"], len(grp["items"]), grp["fmt"]))
        for it in grp["items"]:
            print("  %-16s %-24s %s  at %s" % (it["name"], it["cmd"], it["iconpath"], it["pt"]))
        return 0
    if grp["fmt"] != 0x0401 or grp["cx"] != 32:
        raise SystemExit("%s: icon format 0x%04x %dx%d not supported (VGA 4-plane only)" % (path, grp["fmt"], grp["cx"], grp["cy"]))
    name, cmd = argv[2], argv[3]
    exe = argv[argv.index("--exe") + 1] if "--exe" in argv else None
    ordinal = int(argv[argv.index("--icon") + 1]) if "--icon" in argv else 1
    if exe:
        hdr, andp, xorp = vga_icon_from_exe(exe, ordinal)
    else:                                              # no executable at hand: borrow the first item's icon
        ref = grp["items"][0]; hdr, andp, xorp = ref["hdr"], ref["andp"], ref["xorp"]
    iconpath = cmd.split(" ")[0]
    items = [it for it in grp["items"] if it["cmd"].lower() != cmd.lower()]
    n = len(items)
    items.append(dict(pt=(0, 0), iicon=0, hdr=hdr, andp=andp, xorp=xorp, name=name, cmd=cmd, iconpath=iconpath))
    # Re-flow every item onto a grid that fits the phone's group window. The stock groups store a
    # 5-across, 75 px grid from a 640x480 desktop; in a 344 px client that put a column off the
    # right edge (Josh: "why is the games folder 4 cols?" -- it was 5, with the fifth clipped).
    # COLS x CELL must fit the client, and CELL matches WIN.INI desktop.IconSpacing.
    COLS, CELLW, CELLH = int(os.environ.get("GRP_COLS", 3)), int(os.environ.get("GRP_CELLW", 100)), int(os.environ.get("GRP_CELLH", 78))
    for i, it in enumerate(items):
        it["pt"] = (12 + CELLW * (i % COLS), 4 + CELLH * (i // COLS))
    grp["items"] = items
    out = build(grp)
    parse(out)                                         # round-trips
    open(path, "wb").write(out)
    print("%s: %s -> %s (%d items, %d bytes)" % (path, name, cmd, len(items), len(out)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
