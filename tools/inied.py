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
secs = parse(text)
large = dpi == "120"
fonts = ("8514fix.fon", "8514oem.fon", "8514sys.fon") if large else ("vgafix.fon", "vgaoem.fon", "vgasys.fon")
setkey(secs, "boot", "fixedfon.fon", fonts[0]); setkey(secs, "boot", "oemfonts.fon", fonts[1])
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
out = []
for name, lines in secs:
    if name: out.append(f"[{name}]")
    out.extend(lines)
open(path, "wb").write(("\n".join(out)).replace("\n", "\r\n").encode("cp437"))
print(f"{path}: display={disp} res={res} dpi={dpi}")
