#!/usr/bin/env python3
"""Edit a Windows 3.x SYSTEM.INI in place for a given display driver configuration.
Usage: inied.py SYSTEM.INI display=svga256|vga|pvdisp res=1|2|3 dpi=96|120"""
import sys, re
path = sys.argv[1]; opts = dict(a.split("=", 1) for a in sys.argv[2:])
disp, res, dpi = opts.get("display", "svga256"), opts.get("res", "2"), opts.get("dpi", "96")
text = open(path, "rb").read().decode("cp437").replace("\r\n", "\n")
def parse(t):
    secs, cur = [], None
    for line in t.split("\n"):
        m = re.match(r"^\[(.+)\]\s*$", line)
        if m: cur = [m.group(1), []]; secs.append(cur)
        elif cur is None: secs.append([None, [line]])
        else: cur[1].append(line)
    return secs
def setkey(secs, sec, key, val):
    for s in secs:
        if s[0] and s[0].lower() == sec.lower():
            for i, l in enumerate(s[1]):
                if re.match(rf"^{re.escape(key)}\s*=", l, re.I): s[1][i] = f"{key}={val}"; return
            s[1].insert(0, f"{key}={val}"); return
    secs.append([sec, [f"{key}={val}", ""]])
def addline(secs, sec, line):
    """Add a line to a section unless an identical one is there ([386Enh] has many device= lines)."""
    for s in secs:
        if s[0] and s[0].lower() == sec.lower():
            if any(l.strip().lower() == line.lower() for l in s[1]): return
            s[1].insert(0, line); return
    secs.append([sec, [line, ""]])
secs = parse(text)
large = dpi == "120"
fonts = ("8514fix.fon", "8514oem.fon", "8514sys.fon") if large else ("vgafix.fon", "vgaoem.fon", "vgasys.fon")
setkey(secs, "boot", "fixedfon.fon", fonts[0]); setkey(secs, "boot", "oemfonts.fon", fonts[1])
if opts.get("mousedrv"): setkey(secs, "boot", "mouse.drv", opts["mousedrv"])
if opts.get("sound"):
    # Sound Blaster 2.0 driver on v86's SB16 (port 220, IRQ 5, DMA 1); VSBD virtualises it for DOS boxes
    setkey(secs, "drivers", "wave", "sndblst2.drv")
    setkey(secs, "sndblst.drv", "port", "220"); setkey(secs, "sndblst.drv", "int", "5"); setkey(secs, "sndblst.drv", "dmachannel", "1")
    # MIDI out: the SB's OPL FM synth through MSADLIB.DRV (port 388). Without a midi= line the
    # MIDI mapper has no device and a sequencer MCI open fails (Chip's Challenge music, .MID files).
    setkey(secs, "drivers", "midi", "msadlib.drv")
    setkey(secs, "msadlib.drv", "port", "388")
    addline(secs, "386Enh", "device=vsbd.386")
    # MIDI: MSADLIB.DRV is the Ad Lib FM output driver (ports 388/389, no INI settings of its own
    # beyond [adlib.drv] WriteDelay), and the box has no wavetable, so FM is the only MIDI there
    # is. midimapper= is already in the stock SYSTEM.INI; MIDIMAP.CFG's "Ad Lib" base-level setup
    # is what routes the mapper to this driver (SPEC 2026-09-03).
    setkey(secs, "drivers", "midi", "msadlib.drv")
    setkey(secs, "boot.description", "midi", "Ad Lib")
# sysfont=PVSYS.FON: a taller system font (tools/mkfon.py) makes captions, menus and caption
# boxes bigger, which is how the chrome becomes thumb-sized with only Windows' own pixels.
setkey(secs, "boot", "fonts.fon", opts.get("sysfont", fonts[2]) if large else fonts[2])
if disp == "svga256":
    setkey(secs, "boot", "display.drv", "svga256.drv"); setkey(secs, "boot", "386grabber", "vgadib.3gr")
    setkey(secs, "386Enh", "display", "vddsvga.386")
    setkey(secs, "svga256.drv", "resolution", res); setkey(secs, "svga256.drv", "svgamode", ""); setkey(secs, "svga256.drv", "dpi", dpi)
    setkey(secs, "boot.description", "display.drv", f"Super VGA ({ {'1':'640x480','2':'800x600','3':'1024x768'}[res] }, 256 colors)")
elif disp == "vga":
    setkey(secs, "boot", "display.drv", "vga.drv"); setkey(secs, "boot", "386grabber", "vga.3gr"); setkey(secs, "386Enh", "display", "*vddvga")
elif disp == "pvdisp":
    setkey(secs, "boot", "display.drv", "pvdisp.drv"); setkey(secs, "boot", "386grabber", "vgadib.3gr"); setkey(secs, "386Enh", "display", "*vddvga"); setkey(secs, "boot.description", "display.drv", "Responsive paravirtual display (256 colors)")
# net=1: the NE2000 with Microsoft TCP/IP-32 over NDIS 3 (image/changes/net). The VxD list and
# where each file goes come from TCP32B's own OEMSETUP.INF; the card's driver name and its
# parameter names come from WFW's NETWORK.INF ([ms$ne2000], [ms$ne2clone_nif]). v86's card sits at
# I/O 0x300 and its PCI interrupt is routed to ISA line 10 (tools/probe.mjs netcard).
if opts.get("net") == "1":
    setkey(secs, "network drivers", "netcard", "ne2000.386")
    setkey(secs, "network drivers", "devdir", "C:\\WINDOWS")
    setkey(secs, "network drivers", "LoadRMDrivers", "No")
    for vxd in ("ndis.386", "ne2000.386", "vip.386", "vtcp.386", "vudp.386", "vtdi.386",
                "vdhcp.386", "vnbt.386", "wsock.386", "wstcp.386"):
        addline(secs, "386Enh", f"device={vxd}")
    setkey(secs, "386Enh", "TimerCriticalSection", "5000")   # what WFW's own network setup writes

out = []
for name, lines in secs:
    if name: out.append(f"[{name}]")
    out.extend(lines)
open(path, "wb").write(("\n".join(out)).replace("\n", "\r\n").encode("cp437"))
print(f"{path}: display={disp} res={res} dpi={dpi}" + (" net=1" if opts.get("net") == "1" else ""))
