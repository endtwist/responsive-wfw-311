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

# Windows' twenty static colours, and they must go where Windows keeps them: the first ten at
# 0..9 and the last ten at 246..255. Putting all twenty at 0..19 (the obvious thing) guarantees the
# logical palette is never an identity map, so GDI runs a 256-entry colour translation on every
# StretchDIBits -- which, for video, is a cost per frame. Laid out this way the mapping is the
# identity and the translation disappears.
SYS_LOW = [(0,0,0),(128,0,0),(0,128,0),(128,128,0),(0,0,128),(128,0,128),(0,128,128),(192,192,192),
           (192,220,192),(166,202,240)]
SYS_HIGH = [(255,251,240),(160,160,164),(128,128,128),(255,0,0),(0,255,0),(255,255,0),(0,0,255),
            (255,0,255),(0,255,255),(255,255,255)]
PIC_FIRST, PIC_COUNT = 10, 236

T_HEAD, T_PARA, T_RULE, T_IMAGE, T_VIDEO, T_LUT555, T_STYLE, T_SUB = 1, 2, 3, 4, 5, 6, 7, 8
CODEC_DELTA, CODEC_CINEPAK = 0, 2

# Typography. The page is read in a 344-pixel column on a phone, so the measure is short and the
# body has to be large enough to read at arm's length without turning the column into four words a
# line. Colours are palette INDICES, not RGB, and they are Windows' own static colours, which the
# builder places where Windows keeps them -- so text is drawn exactly, with no dithering and no
# colour translation. Faces are the TrueType ones Windows for Workgroups ships.
IDX_BLACK, IDX_NAVY, IDX_SILVER, IDX_GREY = 0, 4, 7, 248
DEFAULT_STYLES = [
    # for_type, points, weight, italic, colour,     space_before, space_after, face
    (T_HEAD,    20,     700,    0,      IDX_BLACK,  0,            10,          "Arial"),
    (T_SUB,     13,     700,    0,      IDX_NAVY,   14,           4,           "Arial"),
    (T_PARA,    11,     400,    0,      IDX_BLACK,  0,            9,           "Arial"),
]


def style_block(styles):
    out = struct.pack("<H", len(styles))
    for t, pt, wt, it, col, before, after, face in styles:
        out += struct.pack("<HHHBBHH32s", t, pt, wt, it, col, before, after,
                           face.encode("cp1252")[:31])
    return out


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


def cinepak_frames(path, width, fps):
    """Encode with ffmpeg's Cinepak and hand back the compressed frames, straight out of the AVI.
    This is where the size comes from: the three clips are 309 KB as Cinepak against 3,377 KB as raw
    delta segments, and the bundle crosses the real internet to the visitor before the fast emulated
    link ever sees it, so those are the bytes that matter. Microsoft Video 1 is smaller still (63 KB)
    and visibly blocky -- 28.2 dB against Cinepak's 35.7, and 27.2 against 31.4 once the guest's
    palette has had its say -- which is not a trade worth making on somebody's photographs."""
    with tempfile.TemporaryDirectory() as d:
        avi = os.path.join(d, "v.avi")
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                                "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
                               capture_output=True, text=True).stdout.strip().split(",")
        sw, sh = int(probe[0]), int(probe[1])
        h = max(4, int(round(width * sh / sw)) // 4 * 4)          # the codec needs multiples of four
        subprocess.run(["ffmpeg", "-v", "error", "-i", path,
                        "-vf", f"fps={fps},scale={width}:{h}", "-c:v", "cinepak", "-an", avi],
                       check=True)
        return (width, h, avi_frames(avi))


def avi_frames(path):
    """The compressed frames out of a RIFF AVI: every '##dc' chunk inside the movi list."""
    d = open(path, "rb").read()
    assert d[:4] == b"RIFF" and d[8:12] == b"AVI ", "not an AVI"
    frames, o = [], 12
    def walk(start, end):
        o = start
        while o + 8 <= end:
            cid, ln = d[o:o + 4], struct.unpack_from("<I", d, o + 4)[0]
            body = o + 8
            if cid == b"LIST":
                if d[body:body + 4] == b"movi":
                    walk(body + 4, body + ln)
            elif cid[2:4] in (b"dc", b"db"):
                frames.append(d[body:body + ln])
            o = body + ln + (ln & 1)
    walk(o, len(d))
    return frames


def video_frames(path, width, fps):
    """Decoded, resized frames. ffmpeg does the codec work; the guest never sees one."""
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["ffmpeg", "-v", "error", "-i", path,
                        "-vf", f"fps={fps},scale={width}:-2",
                        os.path.join(d, "f%05d.png")], check=True)
        names = sorted(os.listdir(d))
        return [Image.open(os.path.join(d, n)).convert("RGB").copy() for n in names]


def build_palette(images, frames):
    """One adaptive palette over everything on the page, with the system colours kept so Windows'
    own chrome is not disturbed when it is realised."""
    tiles = list(images) + [f for seq in frames for f in seq[::8]]
    if not tiles:
        """A page of nothing but text still needs a palette: Windows' own twenty colours where
        Windows keeps them, and a neutral ramp through the middle so a styled colour index that
        is not one of the twenty still lands on something sensible."""
        cols = list(SYS_LOW) + [(v, v, v) for v in
                                [round(i * 255 / (PIC_COUNT - 1)) for i in range(PIC_COUNT)]] + list(SYS_HIGH)
        flat = [c for col in cols for c in col]
        flat += [0] * (768 - len(flat))
        p = Image.new("P", (1, 1))
        p.putpalette(flat)
        return p, bytes(flat)
    w = max(t.width for t in tiles)
    strip = Image.new("RGB", (w, sum(t.height for t in tiles)))
    y = 0
    for t in tiles:
        strip.paste(t, (0, y)); y += t.height
    q = strip.quantize(colors=PIC_COUNT, method=Image.MEDIANCUT)
    pal = q.getpalette()[: PIC_COUNT * 3]
    cols = list(SYS_LOW) + [tuple(pal[i * 3:i * 3 + 3]) for i in range(PIC_COUNT)] + list(SYS_HIGH)
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


def lut555(palimg):
    """RGB555 -> palette index, all 32768 of them. Microsoft Video 1 carries its colours as RGB555
    and the guest cannot afford to search 256 entries a pixel, so the table is built here once."""
    im = Image.new("RGB", (32768, 1))
    px = im.load()
    for i in range(32768):
        r = (i >> 10) & 31; g = (i >> 5) & 31; b = i & 31
        px[i, 0] = (r << 3 | r >> 2, g << 3 | g >> 2, b << 3 | b >> 2)
    return im.quantize(palette=palimg, dither=Image.NONE).tobytes()


def cinepak_block(w, h, frames, fps):
    out = struct.pack("<HHHHH", w, h, fps, len(frames), CODEC_CINEPAK)
    for f in frames:
        out += struct.pack("<I", len(f)) + f
    return out


def video_block(frames, palimg, fps):
    qs = [to_indexed(f, palimg, False).tobytes() for f in frames]   # never dithered: see the header
    w, h = frames[0].size
    out = struct.pack("<HHHHH", w, h, fps, len(qs), CODEC_DELTA)
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
            path = asset(base, value)
            fr = video_frames(path, VIDEO_WIDTH, VIDEO_FPS)      # decoded, for the shared palette
            videos.append(fr)
            blocks.append((T_VIDEO, cinepak_frames(path, VIDEO_WIDTH, VIDEO_FPS)))
        elif kind == "head":
            blocks.append((T_HEAD, value))
        elif kind == "sub":
            blocks.append((T_SUB, value))
        elif kind == "para":
            blocks.append((T_PARA, value))
        elif kind == "rule":
            blocks.append((T_RULE, None))

    palimg, palbytes = build_palette(images, videos)
    blocks.insert(0, (T_STYLE, spec.get("styles")))          # how the page is set, before anything
    # The RGB555 table goes in once, ahead of the first video that needs it.
    if videos:
        blocks.insert(next(i for i, b in enumerate(blocks) if b[0] == T_VIDEO), (T_LUT555, None))
    body = bytearray()
    for kind, value in blocks:
        if kind == T_IMAGE:
            payload = image_block(value, palimg)
        elif kind == T_VIDEO:
            w, h, frames = value
            payload = cinepak_block(w, h, frames, VIDEO_FPS)
        elif kind == T_LUT555:
            payload = lut555(palimg)
        elif kind == T_STYLE:
            payload = style_block([tuple(r) for r in value] if value else DEFAULT_STYLES)
        elif kind == T_RULE:
            payload = b""
        else:                                                 # HEAD, SUB, PARA
            payload = value.encode("cp1252", "replace")   # the screen font is ANSI; cp437 cost a conversion
        body += struct.pack("<HI", kind, len(payload)) + payload

    with open(out_path, "wb") as fh:
        fh.write(b"PVPG" + struct.pack("<HH", 1, len(blocks)) + palbytes + bytes(body))
    total = os.path.getsize(out_path)
    print(f"{out_path}: {len(blocks)} blocks, {len(images)} images, {len(videos)} videos, "
          f"{total/1e6:.2f} MB")
    for kind, value in blocks:
        if kind == T_VIDEO:
            print(f"  video {value[0]}x{value[1]} {len(value[2])} frames")


main(sys.argv[1], sys.argv[2])
