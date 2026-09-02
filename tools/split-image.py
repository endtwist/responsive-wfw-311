#!/usr/bin/env python3
"""Split a disk image into zstd-compressed fixed-size part files for v86's AsyncXHRPartfileBuffer.

    tools/split-image.py image/work-phone-<stamp>.img [chunk=262144]

writes image/parts/work-phone-<stamp>/p-<start>-<end>.img.zst for every chunk (v86 fetches
`<basename>-<offset>-<offset+chunk><ext>`; a directory basename gets no extra dash, so the page
uses `../image/parts/<stamp dir>/p.img.zst` as the url) and adds a "parts" entry to
image/current.json if that file names the image. Every part must exist, including the all-zero
ones (v86 has no 404 fallback for a part), but a zero part compresses to a few dozen bytes: the
245 MB WfW image, of which only ~30 MB is non-zero, becomes ~20 MB of parts. This is what lets the
image sit on a static host with a 100 MB per-file limit (Vercel Hobby) without Range requests.

zstd frames must carry the content size (v86 asserts on it): the zstd CLI writes it when it
compresses regular files, which is why the parts are written raw first and compressed in place.
"""
import json, os, subprocess, sys

img = sys.argv[1]
chunk = int(sys.argv[2]) if len(sys.argv) > 2 else 262144
size = os.path.getsize(img)
if size % chunk:
    sys.exit(f"{img}: size {size} is not a multiple of {chunk}")
stem = os.path.basename(img)[:-len(".img")] if img.endswith(".img") else os.path.basename(img)
outdir = os.path.join(os.path.dirname(img) or ".", "parts", stem)
n = size // chunk
have = [f for f in os.listdir(outdir)] if os.path.isdir(outdir) else []
if len(have) == n and all(f.endswith(".img.zst") for f in have):
    print(f"{outdir}: {n} parts already present")
else:
    os.makedirs(outdir, exist_ok=True)
    for f in have:
        os.remove(os.path.join(outdir, f))
    raw = []
    with open(img, "rb") as fh:
        for i in range(n):
            off = i * chunk
            p = os.path.join(outdir, f"p-{off}-{off + chunk}.img")
            with open(p, "wb") as out:
                out.write(fh.read(chunk))
            raw.append(p)
    # -19: the parts are written once and fetched many times. --rm replaces p-*.img by p-*.img.zst.
    for i in range(0, len(raw), 200):
        subprocess.run(["zstd", "-19", "-q", "-f", "--rm", "-T0", *raw[i:i + 200]], check=True)
    total = sum(os.path.getsize(os.path.join(outdir, f)) for f in os.listdir(outdir))
    print(f"{outdir}: {n} parts, {total / 1e6:.1f} MB (from {size / 1e6:.1f} MB)")
    # Each part must decompress to exactly `chunk` bytes: check the frame content size on the first.
    lst = subprocess.run(["zstd", "-l", os.path.join(outdir, f"p-0-{chunk}.img.zst")], capture_output=True, text=True).stdout
    if "Uncompressed" not in lst or "unknown" in lst.lower():
        sys.exit("zstd frame has no content size:\n" + lst)

cur = os.path.join(os.path.dirname(img) or ".", "current.json")
if os.path.exists(cur):
    m = json.load(open(cur))
    if m.get("image") == os.path.basename(img):
        m["parts"] = {"dir": f"parts/{stem}", "size": size, "chunk": chunk}
        json.dump(m, open(cur, "w"))
        open(cur, "a").write("\n")
        print(f"{cur}: parts added")
