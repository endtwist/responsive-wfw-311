/* cinepak.c -- a Cinepak ("cvid") decoder that writes palette indices.
 *
 * The format, verified against ffmpeg's decoder rather than taken on trust (libavcodec/cinepak.c;
 * everything here that contradicts the usual prose descriptions is marked):
 *
 *   frame   u8 flags, u24BE length, u16BE width, u16BE height, u16BE strip_count, then the strips.
 *           flags bit 0 clear means "each strip after the first starts from the strip before it's
 *           codebooks"; set means every strip brings its own.
 *   strip   u8 id (0x10 intra, 0x11 inter), u24BE size INCLUDING this 12-byte header,
 *           u16BE y0, u16BE x0, u16BE y1, u16BE x1, then chunks.
 *           NOT a u16 id and a u16 size: the id is one byte and the size is 24 bits, which is why
 *           a strip header reads as 0x1000/0x1100 if you squint at it as two words.
 *           A y0 of zero means "carry on under the strip before" -- then y1 is a HEIGHT, not a
 *           bottom edge. Strips stack down the picture; x0/x1 are absolute.
 *   chunk   u8 id, u24BE size INCLUDING this 4-byte header, then the body. Again one byte and 24
 *           bits, not two words.
 *
 *   chunk ids, as bits: 0x20 = V4 codebook, 0x22 = V1 codebook (+1 = partial/bit-masked update,
 *   +4 = monochrome, 4-byte entries instead of 6); 0x30 = blocks with a V1/V4 selector bit each,
 *   0x31 = the same but with a leading "is this block coded at all" bit, 0x32 = V1 blocks only.
 *   A codebook entry is y0 y1 y2 y3 (the 2x2 vector, raster order) then signed u, v.
 *
 * Colour is converted exactly as ffmpeg does, since that is what the encoder's own quality
 * numbers were measured against:  r = y + 2v,  g = y - u/2 - v,  b = y + 2u,  each clipped, u/2
 * truncating toward zero. It happens once per codebook entry, never per pixel; the result is
 * reduced to RGB555 and turned into a palette index through the bundle's LUT555 table.
 *
 * Bounds: the frame came off the network, so every read is checked against the end of its chunk,
 * every chunk against the end of its strip, and every strip against the picture. A malformed
 * frame stops the decode, it never writes outside `out`.
 */
#include "cinepak.h"

#if CV_16
#include <i86.h>                /* FP_OFF */
/* How many bytes a far pointer is good for before its offset wraps. Watcom's huge arithmetic only
   carries into the selector on overflow, so a huge pointer cast to far is valid exactly this far
   and no further -- which is what both the reader and the block writer below count. */
#define CV_ROOM(p) (0x10000UL - (unsigned long)FP_OFF(p))
#elif defined(CV_WRAPTEST)
#include <stddef.h>            /* size_t, for the pretend selectors below */
/* Host builds are flat and would never take the renormalising paths, so the harness can ask for
   pretend selectors -- small ones, so the wrap happens constantly -- and exercise exactly the code
   the guest will run. cv_seek and the byte-at-a-time block write below are the only things that
   care, and both are correct on a flat pointer either way. */
#define CV_ROOM(p) (0x100UL - ((unsigned long)(size_t)(p) & 0xFFUL))
#else
#define CV_ROOM(p) ((void)(p), 0x10000UL)
#endif

/* ------------------------------------------------------------------ reading the frame
   A frame can be bigger than a segment, so it is addressed hugely; but reading it a byte at a
   time through huge pointers would put a call to the pointer-add helper on every byte. Instead a
   far cursor walks the current selector and is renormalised only when it runs out -- once per
   64 KB, rather than once per byte. On the host CV_ROOM is a constant and this is a plain
   pointer walk. */
typedef struct {
    const unsigned char CV_HUGE *base;
    unsigned long pos, end;             /* both offsets from base */
    const unsigned char CV_FAR *p;      /* good for `win` more bytes */
    unsigned long win;
} CVRD;

static void cv_seek(CVRD *r, unsigned long pos)
{
    r->pos = pos;
    r->p = (const unsigned char CV_FAR *)(r->base + pos);
    r->win = CV_ROOM(r->p);
}
static unsigned long cv_left(const CVRD *r)
{
    return r->pos < r->end ? r->end - r->pos : 0UL;
}
static unsigned cv_u8(CVRD *r)
{
    if (!r->win) cv_seek(r, r->pos);
    r->pos++;
    r->win--;
    return *r->p++;
}
static unsigned cv_be16(CVRD *r)
{
    unsigned h = cv_u8(r);
    return (h << 8) | cv_u8(r);
}
static unsigned long cv_be24(CVRD *r)
{
    unsigned long h = (unsigned long)cv_be16(r);
    return (h << 8) | (unsigned long)cv_u8(r);
}
static unsigned long cv_be32(CVRD *r)
{
    unsigned long h = (unsigned long)cv_be16(r);
    return (h << 16) | (unsigned long)cv_be16(r);
}

/* ------------------------------------------------------------------ codebooks */
static unsigned char cv_clip(int v)
{
    if (v < 0) return 0;
    if (v > 255) return 255;
    return (unsigned char)v;
}

/* One codebook chunk. `cb` is 256 entries of four palette indices. A partial update (chunk id bit
   0) carries a 32-bit mask ahead of every 32 entries and only the flagged ones are present; the
   rest keep what they had, which is the whole point of the inter-coded case. */
static void cv_codebook(unsigned char CV_FAR *cb, unsigned chunk_id, CVRD *r,
                        const unsigned char CV_FAR *lut)
{
    unsigned long flag = 0, mask = 0;
    unsigned n = (chunk_id & 0x04) ? 4u : 6u;
    unsigned i, k;

    for (i = 0; i < 256; i++) {
        if (chunk_id & 0x01) {
            mask >>= 1;
            if (!mask) {
                if (cv_left(r) < 4) return;
                flag = cv_be32(r);
                mask = 0x80000000UL;
            }
        }
        if ((chunk_id & 0x01) && !(flag & mask)) continue;
        if (cv_left(r) < (unsigned long)n) return;

        if (n == 6) {
            unsigned char y[4];
            int u, v, uh;
            for (k = 0; k < 4; k++) y[k] = (unsigned char)cv_u8(r);
            u = (int)(signed char)(unsigned char)cv_u8(r);
            v = (int)(signed char)(unsigned char)cv_u8(r);
            /* u/2 truncated toward zero, spelled out: C89 leaves the sign of a negative
               division's remainder to the implementation, and a shift would floor instead. */
            uh = u >= 0 ? (u >> 1) : -((-u) >> 1);
            for (k = 0; k < 4; k++) {
                int yy = (int)y[k];
                unsigned char rr = cv_clip(yy + 2 * v);
                unsigned char gg = cv_clip(yy - uh - v);
                unsigned char bb = cv_clip(yy + 2 * u);
                cb[i * 4 + k] = lut[(((unsigned)rr & 0xF8u) << 7)
                                  | (((unsigned)gg & 0xF8u) << 2)
                                  | ((unsigned)bb >> 3)];
            }
        } else {
            /* Monochrome strip: four greys, no chroma. */
            for (k = 0; k < 4; k++) {
                unsigned g5 = cv_u8(r) >> 3;
                cb[i * 4 + k] = lut[g5 * 0x421u];   /* g5 in all three 5-bit fields */
            }
        }
    }
}

/* ------------------------------------------------------------------ drawing blocks
   The output may straddle a selector too, so each of the four rows of the current block row keeps
   a byte offset and a far cursor with the room left in its selector. A block's four-byte run is
   written through the cursor when it fits (which it does for all but a handful of blocks in a
   64 KB picture) and byte by byte through the huge pointer when it does not. */
typedef struct {
    unsigned char CV_HUGE *base;
    unsigned char CV_FAR  *p;
    unsigned long off, room;
} CVROW;

static void cv_row_at(CVROW *w, unsigned char CV_HUGE *base, unsigned long off)
{
    w->base = base;
    w->off = off;
    w->p = (unsigned char CV_FAR *)(base + off);
    w->room = CV_ROOM(w->p);
}
static void cv_put4(CVROW *w, unsigned char a, unsigned char b, unsigned char c, unsigned char d)
{
    if (w->room >= 4) {
        w->p[0] = a; w->p[1] = b; w->p[2] = c; w->p[3] = d;
    } else {
        unsigned char CV_HUGE *q = w->base + w->off;
        q[0] = a; q[1] = b; q[2] = c; q[3] = d;
    }
}
static void cv_row_next(CVROW *w)
{
    w->off += 4;
    if (w->room >= 8) { w->room -= 4; w->p += 4; }
    else cv_row_at(w, w->base, w->off);
}

/* One block chunk: walk the strip's 4x4 blocks left to right, top to bottom, taking a codebook
   index (V1) or four of them (V4) for each, or skipping it. The two flag words are drawn from the
   same 32-bit mask stream in the order ffmpeg reads them -- coded-or-not first, then V1-or-V4 --
   and both refills come out of that one stream, which is the detail that makes 0x31 work. */
static int cv_vectors(CV_STATE CV_FAR *st, unsigned si, unsigned chunk_id, CVRD *r,
                      unsigned char CV_HUGE *out, unsigned stride,
                      unsigned width, unsigned height,
                      unsigned x0, unsigned y0, unsigned x1, unsigned y1)
{
    unsigned long flag = 0, mask = 0;
    unsigned char CV_FAR *v1 = &st->v1[si][0][0];
    unsigned char CV_FAR *v4 = &st->v4[si][0][0];
    unsigned x, y;

    for (y = y0; y < y1; y += 4) {
        CVROW w0, w1, w2, w3;
        unsigned long base = (unsigned long)y * (unsigned long)stride + (unsigned long)x0;

        /* A picture whose height is not a multiple of four still gets whole blocks; the rows that
           would fall off the bottom are aimed at the last real row instead, exactly as ffmpeg
           does, so the block ends up correct and nothing is written past the buffer. */
        cv_row_at(&w0, out, base);
        cv_row_at(&w1, out, height - y > 1 ? base + stride : base);
        cv_row_at(&w2, out, height - y > 2 ? base + 2UL * stride : w1.off);
        cv_row_at(&w3, out, height - y > 3 ? base + 3UL * stride : w2.off);

        for (x = x0; x < x1; x += 4) {
            unsigned coded = 1;

            if (chunk_id & 0x01) {
                mask >>= 1;
                if (!mask) {
                    if (cv_left(r) < 4) return CV_E_DATA;
                    flag = cv_be32(r);
                    mask = 0x80000000UL;
                }
                coded = (flag & mask) ? 1u : 0u;
            }
            if (coded) {
                unsigned isv1 = 1;
                if (!(chunk_id & 0x02)) {
                    mask >>= 1;
                    if (!mask) {
                        if (cv_left(r) < 4) return CV_E_DATA;
                        flag = cv_be32(r);
                        mask = 0x80000000UL;
                    }
                    isv1 = (flag & mask) ? 0u : 1u;
                }
                if (isv1) {
                    unsigned char CV_FAR *p;
                    if (!cv_left(r)) return CV_E_DATA;
                    p = v1 + (cv_u8(r) << 2);
                    cv_put4(&w0, p[0], p[0], p[1], p[1]);
                    cv_put4(&w1, p[0], p[0], p[1], p[1]);
                    cv_put4(&w2, p[2], p[2], p[3], p[3]);
                    cv_put4(&w3, p[2], p[2], p[3], p[3]);
                } else {
                    unsigned char CV_FAR *a, *b, *c, *d;
                    if (cv_left(r) < 4) return CV_E_DATA;
                    a = v4 + (cv_u8(r) << 2);
                    b = v4 + (cv_u8(r) << 2);
                    c = v4 + (cv_u8(r) << 2);
                    d = v4 + (cv_u8(r) << 2);
                    cv_put4(&w0, a[0], a[1], b[0], b[1]);
                    cv_put4(&w1, a[2], a[3], b[2], b[3]);
                    cv_put4(&w2, c[0], c[1], d[0], d[1]);
                    cv_put4(&w3, c[2], c[3], d[2], d[3]);
                }
            }
            cv_row_next(&w0); cv_row_next(&w1); cv_row_next(&w2); cv_row_next(&w3);
        }
    }
    (void)width;
    return CV_OK;
}

/* ------------------------------------------------------------------ strips and frames */
static int cv_strip(CV_STATE CV_FAR *st, unsigned si, CVRD *r, const unsigned char CV_FAR *lut,
                    unsigned char CV_HUGE *out, unsigned stride,
                    unsigned width, unsigned height,
                    unsigned x0, unsigned y0, unsigned x1, unsigned y1)
{
    unsigned long strip_end = r->end;

    while (cv_left(r) >= 4) {
        unsigned long here = r->pos, size;
        unsigned id = cv_u8(r);
        size = cv_be24(r);
        if (size < 4) return CV_E_DATA;
        if (here + size > strip_end) size = strip_end - here;    /* clamp, as ffmpeg does */
        r->end = here + size;

        switch (id) {
        case 0x20: case 0x21: case 0x24: case 0x25:
            cv_codebook(&st->v4[si][0][0], id, r, lut);
            break;
        case 0x22: case 0x23: case 0x26: case 0x27:
            cv_codebook(&st->v1[si][0][0], id, r, lut);
            break;
        case 0x30: case 0x31: case 0x32: {
            int e = cv_vectors(st, si, id, r, out, stride, width, height, x0, y0, x1, y1);
            r->end = strip_end;
            return e;
        }
        default:
            break;
        }
        r->end = strip_end;
        cv_seek(r, here + size);
    }
    return CV_E_DATA;                 /* a strip with no block chunk drew nothing */
}

void cv_reset(CV_STATE CV_FAR *st)
{
    unsigned char CV_FAR *p = (unsigned char CV_FAR *)st;
    unsigned long n = (unsigned long)sizeof(CV_STATE);
    while (n--) *p++ = 0;
}

int cv_decode(CV_STATE CV_FAR *st,
              const unsigned char CV_HUGE *data, unsigned long size,
              const unsigned char CV_FAR *lut,
              unsigned char CV_HUGE *out, unsigned stride,
              unsigned width, unsigned height)
{
    CVRD rd;
    unsigned flags, nstrips, i;
    unsigned padw = (width + 3u) & ~3u, padh = (height + 3u) & ~3u;
    unsigned y0 = 0;
    unsigned long flen;

    if (size < 10UL) return CV_E_SHORT;
    if (!width || !height || stride < padw) return CV_E_GEOM;

    rd.base = data;
    rd.end = size;
    cv_seek(&rd, 0UL);

    flags = cv_u8(&rd);
    flen = cv_be24(&rd);
    (void)cv_be16(&rd);                    /* the frame's own width and height: the bundle's */
    (void)cv_be16(&rd);                    /* header is what lays the page out, so ignore them */
    nstrips = cv_be16(&rd);
    if (flen < 10UL) return CV_E_SHORT;
    if (flen < size) rd.end = flen;        /* trailing padding in the container is not ours */

    for (i = 0; i < nstrips; i++) {
        unsigned long here, ssize, strip_end;
        unsigned sy0, sx0, sy1, sx1, si = i < CV_MAX_STRIPS ? i : CV_MAX_STRIPS - 1;
        int e;

        if (cv_left(&rd) < 12UL) return CV_E_SHORT;
        here = rd.pos;
        (void)cv_u8(&rd);                  /* strip id: 0x10 intra, 0x11 inter. Nothing here has
                                              to care -- an inter strip simply updates less. */
        ssize = cv_be24(&rd);
        sy0 = cv_be16(&rd);
        sx0 = cv_be16(&rd);
        sy1 = cv_be16(&rd);
        sx1 = cv_be16(&rd);
        /* A zero top edge means the strip carries on from the one above and its "bottom" is
           really a height. Every ffmpeg-encoded file in hand is written this way. */
        if (!sy0) { sy0 = y0; sy1 = y0 + sy1; }
        if (ssize < 12UL) return CV_E_DATA;
        strip_end = here + ssize;
        if (strip_end > rd.end) strip_end = rd.end;
        if (strip_end <= rd.pos) return CV_E_DATA;

        if (sx1 > padw || sy1 > padh || sx0 >= sx1 || sy0 >= sy1) return CV_E_GEOM;

        /* Codebooks live from frame to frame, per strip. Unless the frame says otherwise, a strip
           also starts from the one above it. */
        if (i > 0 && i < CV_MAX_STRIPS && !(flags & 0x01)) {
            unsigned char CV_FAR *d = &st->v4[si][0][0];
            unsigned char CV_FAR *s = &st->v4[si - 1][0][0];
            unsigned k;
            for (k = 0; k < 256 * 4; k++) d[k] = s[k];
            d = &st->v1[si][0][0];
            s = &st->v1[si - 1][0][0];
            for (k = 0; k < 256 * 4; k++) d[k] = s[k];
        }

        rd.end = strip_end;
        e = cv_strip(st, si, &rd, lut, out, stride, width, height, sx0, sy0, sx1, sy1);
        rd.end = flen < size ? flen : size;
        if (e != CV_OK) return e;

        cv_seek(&rd, strip_end);
        y0 = sy1;
    }
    return CV_OK;
}
