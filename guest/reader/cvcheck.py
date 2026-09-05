#!/usr/bin/env python3
"""Check guest/reader/cinepak.c against ffmpeg's own Cinepak decoder.

The decoder is compiled for the host (guest/reader/cvtest.c), fed the compressed frames out of a
real AVI, and its palette indices are compared with ffmpeg's decode of the same file put through
the same RGB555 table -- indices to indices, which is the only fair comparison when the guest's
output is 8-bpp.

Three passes, for three different questions:

  colour     three tables that map RGB555 to r5, g5 and b5. Three decodes then give back the exact
             RGB555 the decoder computed, so the comparison is of colour, not of a palette's
             opinion. This is the one that says whether the decoder is right.
  selectors  the same source built with CV_WRAPTEST, which pretends the address space is cut into
             little selectors and so takes the renormalising paths the guest takes on a picture or
             a frame bigger than 64 KB. It has to decode identically.
  palette    one adaptive 256-colour palette over the clip, built the way tools/mkpage.py builds
             the page's, and the LUT555 block that goes with it. This is what the guest will
             actually see, and it says how much of any disagreement survives quantisation.

    python3 guest/reader/cvcheck.py clip.avi [clip.avi ...]

guest/reader/cvdos.sh goes further and runs the real 16-bit Watcom build under DOSBox-X, which is
the only way to know Watcom's own huge-pointer code generation agrees.
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def build(tmp):
    """Two builds of the same source: the plain one, and one where CV_WRAPTEST pretends the
    address space is cut into little selectors, so the renormalising paths the guest will take on
    a >64 KB frame or picture are exercised here too."""
    exes = []
    for name, extra in (("cvtest", []), ("cvtest-wrap", ["-DCV_WRAPTEST"])):
        exe = os.path.join(tmp, name)
        subprocess.run(["cc", "-O2", "-Wall", "-Wextra", "-o", exe] + extra +
                       [os.path.join(HERE, "cvtest.c"), os.path.join(HERE, "cinepak.c")], check=True)
        exes.append(exe)
    return exes


def channel_luts():
    """RGB555 -> r5 / g5 / b5, as three 32768-byte tables."""
    r = bytes((i >> 10) & 31 for i in range(32768))
    g = bytes((i >> 5) & 31 for i in range(32768))
    b = bytes(i & 31 for i in range(32768))
    return r, g, b


def rgb_frames(path):
    """ffmpeg's own decode, as raw RGB24 frames."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-pix_fmt", "rgb24",
                          "-f", "rawvideo", "-"], check=True, capture_output=True).stdout
    return out


def probe(path):
    s = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,nb_frames", "-of", "csv=p=0", path],
                       check=True, capture_output=True, text=True).stdout.strip().split(",")
    return int(s[0]), int(s[1])


def run(exe, avi, lut, tmp, name):
    lp = os.path.join(tmp, name + ".lut")
    rp = os.path.join(tmp, name + ".raw")
    open(lp, "wb").write(lut)
    r = subprocess.run([exe, avi, lp, rp], capture_output=True, text=True)
    if r.stderr:
        print("   cvtest:", r.stderr.strip())
    lines = r.stdout.split("\n")
    n, w, h, stride = (int(x) for x in lines[0].split())
    return open(rp, "rb").read(), n, w, h, stride


def dos_kit(avi, lut, outdir):
    """Everything CVDOS.EXE needs: the compressed frames and the table, in the simplest possible
    shape for a DOS program to read."""
    import struct as st
    d = open(avi, "rb").read()
    frames, w, h = [], 0, 0
    def walk(o, end, inmovi):
        nonlocal w, h
        while o + 8 <= end:
            cid, ln = d[o:o + 4], st.unpack_from("<I", d, o + 4)[0]
            body = o + 8
            if cid in (b"LIST", b"RIFF"):
                walk(body + 4, body + ln, inmovi or d[body:body + 4] == b"movi")
            elif cid == b"strf" and not w:
                w, h = st.unpack_from("<ii", d, body + 4)
            elif inmovi and cid[2:3] == b"d":
                frames.append(d[body:body + ln])
            o = body + ln + (ln & 1)
    walk(12, len(d), False)
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "FRAMES.BIN"), "wb") as f:
        f.write(st.pack("<HHH", w, h, len(frames)))
        for fr in frames:
            f.write(st.pack("<I", len(fr)) + fr)
    open(os.path.join(outdir, "LUT.BIN"), "wb").write(lut)
    return len(frames)


def crop(raw, n, w, h, stride):
    """Drop the stride padding so a frame is w*h bytes."""
    out = []
    fs = stride * h
    for i in range(n):
        f = raw[i * fs:(i + 1) * fs]
        out.append(b"".join(f[y * stride:y * stride + w] for y in range(h)))
    return out


def adaptive_palette(avi, w, h, ref):
    from PIL import Image
    tiles = [Image.frombytes("RGB", (w, h), ref[i * w * h * 3:(i + 1) * w * h * 3])
             for i in range(0, len(ref) // (w * h * 3), 8)]
    strip = Image.new("RGB", (w, h * len(tiles)))
    for i, t in enumerate(tiles):
        strip.paste(t, (0, i * h))
    q = strip.quantize(colors=236, method=Image.MEDIANCUT)
    pal = q.getpalette()[:236 * 3]
    flat = [0, 0, 0] * 10 + pal + [255, 255, 255] * 10
    flat += [0] * (768 - len(flat))
    p = Image.new("P", (1, 1))
    p.putpalette(flat)
    lut = Image.new("RGB", (32768, 1))
    px = lut.load()
    for i in range(32768):
        r, g, b = (i >> 10) & 31, (i >> 5) & 31, i & 31
        px[i, 0] = (r << 3 | r >> 2, g << 3 | g >> 2, b << 3 | b >> 2)
    table = lut.quantize(palette=p, dither=Image.NONE).tobytes()
    return table


def main(paths):
    with tempfile.TemporaryDirectory() as tmp:
        exe, wrapexe = build(tmp)
        for avi in paths:
            w, h = probe(avi)
            ref = rgb_frames(avi)
            nref = len(ref) // (w * h * 3)
            print("%s  %dx%d  %d frames  %d KB" % (os.path.basename(avi), w, h, nref,
                                                   os.path.getsize(avi) // 1024))

            # --- exact: compare the RGB555 the decoder computed, channel by channel
            planes = []
            for name, lut in zip("rgb", channel_luts()):
                raw, n, cw, ch, stride = run(exe, avi, lut, tmp, name)
                assert (cw, ch) == (w, h), "size mismatch %dx%d" % (cw, ch)
                planes.append(crop(raw, n, w, h, stride))
                nfr = n
            worst = (0, -1)
            total = badpx = 0
            for i in range(min(nfr, nref)):
                rf = ref[i * w * h * 3:(i + 1) * w * h * 3]
                bad = 0
                for k in range(w * h):
                    if (planes[0][i][k] != rf[k * 3] >> 3
                            or planes[1][i][k] != rf[k * 3 + 1] >> 3
                            or planes[2][i][k] != rf[k * 3 + 2] >> 3):
                        bad += 1
                badpx += bad
                total += w * h
                if bad > worst[0]:
                    worst = (bad, i)
            print("   RGB555 vs ffmpeg: %d/%d pixels differ (%.4f%%), worst frame %d with %d"
                  % (badpx, total, 100.0 * badpx / total, worst[1], worst[0]))

            # --- the same source with pretend 16-bit selectors must decode identically
            same = True
            for name, lut in zip("rgb", channel_luts()):
                a, _, _, _, _ = run(exe, avi, lut, tmp, name)
                b, _, _, _, _ = run(wrapexe, avi, lut, tmp, name + "w")
                same = same and a == b
            print("   with pretend selectors: %s" % ("identical" if same else "DIFFERENT"))

            # --- palette: what the guest will actually see
            try:
                table = adaptive_palette(avi, w, h, ref)
            except ImportError:
                print("   (PIL missing: skipping the palette pass)")
                continue
            raw, n, cw, ch, stride = run(exe, avi, table, tmp, "pal")
            mine = crop(raw, n, w, h, stride)
            badpx = total = 0
            worst = (0, -1)
            for i in range(min(n, nref)):
                rf = ref[i * w * h * 3:(i + 1) * w * h * 3]
                want = bytes(table[((rf[k * 3] >> 3) << 10) | ((rf[k * 3 + 1] >> 3) << 5)
                                   | (rf[k * 3 + 2] >> 3)] for k in range(w * h))
                bad = sum(1 for k in range(w * h) if want[k] != mine[i][k])
                badpx += bad
                total += w * h
                if bad > worst[0]:
                    worst = (bad, i)
            print("   palette indices:  %d/%d pixels differ (%.4f%%), worst frame %d with %d"
                  % (badpx, total, 100.0 * badpx / total, worst[1], worst[0]))


if __name__ == "__main__":
    main(sys.argv[1:] or [os.path.join(HERE, "..", "..", "clip.avi")])
