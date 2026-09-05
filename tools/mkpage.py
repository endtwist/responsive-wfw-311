#!/usr/bin/env python3
"""Build a .PVP page bundle for the guest's PAGE.EXE reader.

The guest has no JPEG decoder, no video codec and 256 colours, and it has about 31 MIPS to spend.
So everything expensive happens here: photographs are resized to the column, quantised to one
palette shared by the whole page, and dithered; video is decoded, resized, quantised against the
same palette and delta-coded into segments the guest applies with a memcpy per run. What reaches
the guest is already in its native form -- 8-bpp pixels and runs of bytes -- so displaying it costs
a blit and playing it costs a few hundred memcpys a frame.

Two things learned the hard way and encoded here:
  - Dither the photographs, never the video. Floyd-Steinberg makes every pixel differ from frame to
    frame even where nothing moved, which destroys the temporal coherence the delta coding depends
    on: measured, it doubled a clip from 1.2 MB to 2.6 MB.
  - One palette for the page. A palette per image looks marginally better and makes the screen
    flash as you scroll between them, which is exactly the 1994 experience nobody wants back.

Usage: tools/mkpage.py page.json out.pvp
       where page.json is {"blocks": [{"head"|"para"|"rule"|"image"|"video": value}, ...]}
An image or video value may be a path relative to the json, or a URL -- so a page description can
live in the repo and pull its assets from the site it came from, and the bundle itself (megabytes of
somebody's photographs) need not be committed.
"""
import json, os, struct, subprocess, sys, tempfile, urllib.request
from PIL import Image

WIDTH = 344          # the client width of a window in the phone column
VIDEO_WIDTH = 172    # half that: a frame is a quarter of the pixels, and it reads as a video still
VIDEO_FPS = 12
VIDEO_SECONDS = 5    # these are silent loops; five seconds of one reads the same as twelve and the
                     # video is ~90% of a bundle's bytes

SYS20 = [(0,0,0),(128,0,0),(0,128,0),(128,128,0),(0,0,128),(128,0,128),(0,128,128),(192,192,192),
         (192,220,192),(166,202,240),(255,251,240),(160,160,164),(128,128,128),(255,0,0),(0,255,0),
         (255,255,0),(0,0,255),(255,0,255),(0,255,255),(255,255,255)]

T_HEAD, T_PARA, T_RULE, T_IMAGE, T_VIDEO = 1, 2, 3, 4, 5


_cache = {}


def asset(base, value):
    """A local path, or a URL fetched once into the cache directory."""
    if not value.startswith(("http://", "https://")):
        return os.path.join(base, value)
    if value not in _cache:
        d = os.path.join(tempfile.gettempdir(), "pvp-assets")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, value.rsplit("/", 1)[-1])
        if not os.path.exists(p):
            print(f"  fetching {value}")
            urllib.request.urlretrieve(value, p)
        _cache[value] = p
    return _cache[value]


def fit(im, width):
    im = im.convert("RGB")
    return im.resize((width, max(1, round(im.height * width / im.width))), Image.LANCZOS)


def video_frames(path, width, fps, seconds=VIDEO_SECONDS):
    """Decoded, resized frames. ffmpeg does the codec work; the guest never sees one."""
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["ffmpeg", "-v", "error", "-t", str(seconds), "-i", path,
                        "-vf", f"fps={fps},scale={width}:-2",
                        os.path.join(d, "f%05d.png")], check=True)
        names = sorted(os.listdir(d))
        return [Image.open(os.path.join(d, n)).convert("RGB").copy() for n in names]


def build_palette(images, frames):
    """One adaptive palette over everything on the page, with the system colours kept so Windows'
    own chrome is not disturbed when it is realised."""
    tiles = list(images) + [f for seq in frames for f in seq[::8]]
    w = max(t.width for t in tiles)
    strip = Image.new("RGB", (w, sum(t.height for t in tiles)))
    y = 0
    for t in tiles:
        strip.paste(t, (0, y)); y += t.height
    q = strip.quantize(colors=256 - len(SYS20), method=Image.MEDIANCUT)
    pal = q.getpalette()[: (256 - len(SYS20)) * 3]
    cols = list(SYS20) + [tuple(pal[i * 3:i * 3 + 3]) for i in range(256 - len(SYS20))]
    p = Image.new("P", (1, 1))
    flat = []
    for c in cols:
        flat += list(c)
    flat += [0] * (768 - len(flat))
    p.putpalette(flat)
    return p, bytes(flat)


def to_indexed(im, palimg, dither):
    return im.quantize(palette=palimg, dither=Image.FLOYDSTEINBERG if dither else Image.NONE)


def image_block(im, palimg):
    q = to_indexed(im, palimg, True)
    w, h = q.size
    stride = (w + 3) & ~3
    px = q.tobytes()
    rows = bytearray()
    for y in range(h):
        row = px[y * w:(y + 1) * w]
        rows += row + b"\0" * (stride - w)
    return struct.pack("<HH", w, h) + bytes(rows)


def delta_frame(prev, cur, w, h):
    """Segments: every run of pixels that differs from the previous frame. Runs separated by fewer
    than four identical pixels are merged, because two segment headers cost more than three bytes
    of redundant pixels."""
    segs = bytearray()
    n = 0
    for y in range(h):
        a = prev[y * w:(y + 1) * w] if prev else None
        b = cur[y * w:(y + 1) * w]
        x = 0
        while x < w:
            if a is not None and a[x] == b[x]:
                x += 1
                continue
            start = x
            gap = 0
            while x < w and gap < 4:
                gap = gap + 1 if (a is not None and a[x] == b[x]) else 0
                x += 1
            end = x - gap
            seg = b[start:end]
            while seg:
                take = seg[:65535]
                segs += struct.pack("<HHH", y, start, len(take)) + take
                n += 1
                start += len(take)
                seg = seg[len(take):]
    return struct.pack("<H", n) + bytes(segs)


def video_block(frames, palimg, fps):
    qs = [to_indexed(f, palimg, False).tobytes() for f in frames]   # never dithered: see the header
    w, h = frames[0].size
    out = struct.pack("<HHHH", w, h, fps, len(qs))
    prev = None
    for f in qs:
        d = delta_frame(prev, f, w, h)
        out += struct.pack("<I", len(d)) + d
        prev = f
    return out


def main(spec_path, out_path):
    spec = json.load(open(spec_path))
    base = os.path.dirname(os.path.abspath(spec_path))
    blocks, images, videos = [], [], []
    for b in spec["blocks"]:
        (kind, value), = b.items()
        if kind == "image":
            im = fit(Image.open(asset(base, value)), WIDTH)
            images.append(im)
            blocks.append((T_IMAGE, im))
        elif kind == "video":
            fr = video_frames(asset(base, value), VIDEO_WIDTH, VIDEO_FPS)
            videos.append(fr)
            blocks.append((T_VIDEO, fr))
        elif kind == "head":
            blocks.append((T_HEAD, value))
        elif kind == "para":
            blocks.append((T_PARA, value))
        elif kind == "rule":
            blocks.append((T_RULE, None))

    palimg, palbytes = build_palette(images, videos)
    body = bytearray()
    for kind, value in blocks:
        if kind == T_IMAGE:
            payload = image_block(value, palimg)
        elif kind == T_VIDEO:
            payload = video_block(value, palimg, VIDEO_FPS)
        elif kind == T_RULE:
            payload = b""
        else:
            payload = value.encode("cp437", "replace")
        body += struct.pack("<HI", kind, len(payload)) + payload

    with open(out_path, "wb") as fh:
        fh.write(b"PVPG" + struct.pack("<HH", 1, len(blocks)) + palbytes + bytes(body))
    total = os.path.getsize(out_path)
    print(f"{out_path}: {len(blocks)} blocks, {len(images)} images, {len(videos)} videos, "
          f"{total/1e6:.2f} MB")
    for kind, value in blocks:
        if kind == T_VIDEO:
            print(f"  video {value[0].width}x{value[0].height} {len(value)} frames")


main(sys.argv[1], sys.argv[2])
