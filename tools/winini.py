#!/usr/bin/env python3
"""Set keys in a Windows 3.x WIN.INI in place. Usage: winini.py WIN.INI section.key=value ..."""
import sys, re
path = sys.argv[1]
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
for a in sys.argv[2:]:
    sk, val = a.split("=", 1)
    # "section::key=value" for section names that contain a dot (e.g. "PSCRIPT,C:\PRINT.PS")
    sec, key = sk.split("::", 1) if "::" in sk else sk.split(".", 1)
    setkey(secs, sec, key, val)
out = []
for name, lines in secs:
    if name: out.append(f"[{name}]")
    out.extend(lines)
open(path, "wb").write("\n".join(out).replace("\n", "\r\n").encode("cp437"))
print(f"{path}: {' '.join(sys.argv[2:])}")
