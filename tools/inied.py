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
# net=1: the NE2000 with Microsoft TCP/IP-32 over NDIS 3. Every key here was read back out of a
# guest where Windows Setup had done the install itself (image/changes/net/config/SYSTEM.INI),
# because hand-writing it does not work: the hint that matters is [386Enh] network=, which names
# WFW's own network core. Without it NDIS.386 loads and never returns, and Windows hangs on its
# splash screen with nothing printed at all. The TCP/IP VxDs go on the transport= line, not on
# device= lines of their own. The card is v86's: I/O 0x300, ISA line 10 (tools/probe.mjs netcard).
if opts.get("net") == "1":
    ip = opts.get("ip", "10.0.2.15"); mask = opts.get("mask", "255.255.255.0")
    gw = opts.get("gw", "10.0.2.2"); dns = opts.get("dns", gw); host = opts.get("host", "wfw311")
    setkey(secs, "boot", "network.drv", "wfwnet.drv")
    setkey(secs, "boot.description", "network.drv", "Microsoft Windows Network (version 3.11)")
    setkey(secs, "boot.description", "secondnet.drv", "No Additional Network Installed")
    setkey(secs, "Network", "winnet", "wfwnet/00025100")
    setkey(secs, "Network", "multinet", "nonet")
    setkey(secs, "386Enh", "network", "*vnetbios,*vwc,vnetsup.386,vredir.386,vserver.386")
    setkey(secs, "386Enh", "netcard", "ne2000.386")
    setkey(secs, "386Enh", "transport",
           "nwlink.386,nwnblink.386,netbeui.386,vip.386,vdhcp.386,vtdi.386,vtcp.386,vnbt.386")
    setkey(secs, "386Enh", "secondnet.drv", "No Additional Network Installed")
    setkey(secs, "network drivers", "devdir", "C:\\WINDOWS")
    setkey(secs, "network drivers", "LoadRMDrivers", "No")
    setkey(secs, "network drivers", "netcard", "ne2000.dos")
    setkey(secs, "network drivers", "transport", "ndishlp.sys,*netbeui")
    # The addresses live in a per-interface section, not in PROTOCOL.INI where one would look.
    setkey(secs, "ms$ne2clone0", "Binding", "ms$ne2clone")
    setkey(secs, "ms$ne2clone0", "Description", "NE2000 Compatible")
    setkey(secs, "ms$ne2clone0", "IPAddress", ip)
    setkey(secs, "ms$ne2clone0", "IPMask", mask)
    setkey(secs, "ms$ne2clone0", "DefaultGateway", gw)
    setkey(secs, "MSTCP", "EnableRouting", "0")
    setkey(secs, "MSTCP", "Interfaces", "ms$ne2clone0")
    setkey(secs, "MSTCP", "deadgwdetect", "1")
    setkey(secs, "MSTCP", "pmtudiscovery", "1")
    setkey(secs, "DNS", "DNSServers", dns)
    setkey(secs, "DNS", "HostName", host)
    setkey(secs, "DNS", "DomainName", "")
    setkey(secs, "DNS", "DNSDomains", "")
    setkey(secs, "NBT", "LANABASE", "2")
    setkey(secs, "NBT", "EnableProxy", "0")
    setkey(secs, "NBT", "EnableDNS", "0")

out = []
for name, lines in secs:
    if name: out.append(f"[{name}]")
    out.extend(lines)
open(path, "wb").write(("\n".join(out)).replace("\n", "\r\n").encode("cp437"))
print(f"{path}: display={disp} res={res} dpi={dpi}" + (" net=1" if opts.get("net") == "1" else ""))
