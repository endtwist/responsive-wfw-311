/* cinepak.h -- Cinepak ("cvid") frames in, 8-bpp palette indices out.
 *
 * The decoder proper knows nothing about Windows: it takes a pointer to a frame's bytes, a
 * pointer to an 8-bpp output buffer, a stride, and a 32768-entry RGB555 -> palette-index table,
 * and it writes palette indices. That is what lets the same cinepak.c compile for Watcom Win16
 * and for the host harness (guest/reader/cvtest.c), which is the only honest way to know the
 * thing decodes correctly before it ever runs on a 1994 machine.
 *
 * Why Cinepak suits an 8-bpp guest: its codebooks are the only place colour lives. Convert a
 * codebook entry from YUV to RGB555 and look its palette index up ONCE, when the codebook is
 * updated (at most 512 entries a frame, usually far fewer), and drawing a block afterwards is
 * pure index copying -- four bytes a row, no arithmetic, no per-pixel lookup.
 */
#ifndef CINEPAK_H
#define CINEPAK_H

/* The one portability seam. In the guest a frame lives in the bundle's multi-megabyte GlobalAlloc
   block and may straddle a 64 KB selector, so frame and output pointers are __huge; the palette
   table gets a segment of its own, so it is merely __far. On the host both vanish. */
#if defined(__WATCOMC__) && defined(_M_I86)
#  define CV_HUGE __huge
#  define CV_FAR  __far
#  define CV_16   1
#else
#  define CV_HUGE
#  define CV_FAR
#  define CV_16   0
#endif

/* Codebooks are per strip and survive from frame to frame, so they have to be kept somewhere.
   Twelve strips is more than any encoder uses for a phone-sized clip (ffmpeg's asks for two at
   172x228) and keeps the whole state at 24 KB -- one segment, so a plain far pointer reaches all
   of it, and small enough to hand back the moment the clip scrolls off screen. */
#define CV_MAX_STRIPS 12

typedef struct {
    /* Four palette indices per codebook entry, in raster order within the 2x2 vector:
       top-left, top-right, bottom-left, bottom-right. */
    unsigned char v4[CV_MAX_STRIPS][256][4];
    unsigned char v1[CV_MAX_STRIPS][256][4];
} CV_STATE;

#define CV_OK          0
#define CV_E_SHORT   (-1)      /* the frame is too small to hold what it claims */
#define CV_E_GEOM    (-2)      /* a strip does not fit the picture it is being drawn into */
#define CV_E_DATA    (-3)      /* a chunk runs off the end of its strip */

/* Forget every codebook. Call before the first frame and whenever the clip loops. */
void cv_reset(CV_STATE CV_FAR *st);

/* Decode one frame over the top of `out` (Cinepak is inter-coded: blocks a frame does not
   mention keep whatever the frame before left there). `stride` is the output's row pitch and
   must be at least (width + 3) & ~3, since strips are allowed to cover the padding that rounds
   the picture up to whole 4x4 blocks. Returns CV_OK or one of the CV_E_* codes; on failure as
   much of the frame as was good has already been drawn. */
int cv_decode(CV_STATE CV_FAR *st,
              const unsigned char CV_HUGE *data, unsigned long size,
              const unsigned char CV_FAR *lut,
              unsigned char CV_HUGE *out, unsigned stride,
              unsigned width, unsigned height);

#endif
