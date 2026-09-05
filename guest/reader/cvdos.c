/* cvdos.c -- run the real 16-bit build of cinepak.c and say what it decoded.
 *
 * The host harness (cvtest.c) proves the decoder is right; it cannot prove Watcom's 16-bit code
 * generation is, and the whole design leans on __huge arithmetic: a picture bigger than a segment,
 * a far cursor walking one selector at a time, a block write that falls back to bytes when it
 * would straddle. So the same cinepak.c is built with wcc -bt=dos -ml and run under DOSBox-X on a
 * picture that is deliberately larger than 64 KB, printing a checksum per frame. Those checksums
 * have to match the host's, byte for byte, or something about the 16-bit build is wrong.
 *
 *   wcc -bt=dos -ml -ox -wx cinepak.c cvdos.c ; wlink ... name CVDOS.EXE
 *   CVDOS.EXE            (reads FRAMES.BIN and LUT.BIN, writes SUMS.TXT)
 *
 * FRAMES.BIN is written by cvcheck.py --dos: u16 w, u16 h, u16 count, then per frame u32 length
 * and that many bytes.
 */
#include <stdio.h>
#include <stdlib.h>
#include <malloc.h>
#include <i86.h>            /* MK_FP */

#define FAR __far
#include "cinepak.h"

static unsigned char CV_HUGE *g_out;
static unsigned char CV_FAR  *g_lut;
static unsigned char CV_FAR  *g_frame;
static CV_STATE CV_FAR *g_st;

/* Fletcher's, which needs nothing wider than the machine has. */
static unsigned long sum_of(const unsigned char CV_HUGE *p, unsigned long n)
{
    unsigned long a = 1, b = 0;      /* long: on a 16-bit machine `unsigned` overflows here, and
                                        an hour went into believing that was the decoder */
    while (n--) {
        a = (a + *p++) % 65521UL;
        b = (b + a) % 65521UL;
    }
    return (b << 16) | a;
}

int main(int argc, char **argv)
{
    /* The BIOS tick, 18.2 a second: crude, but the decode of a whole clip is hundreds of them and
       the run happens at a fixed DOSBox-X cycle count, so it converts straight into cycles a
       frame -- a number that means something on any machine. */
    unsigned long FAR *bios_tick = (unsigned long FAR *)MK_FP(0x40, 0x6C);
    unsigned long t0, ticks = 0;
    FILE *f = fopen("FRAMES.BIN", "rb"), *o, *raw;
    unsigned w, h, n, i, stride;
    unsigned char head[8];

    (void)argv;
    if (!f) { printf("no FRAMES.BIN\n"); return 1; }
    if (fread(head, 1, 6, f) != 6) return 1;
    w = head[0] | (head[1] << 8);
    h = head[2] | (head[3] << 8);
    n = head[4] | (head[5] << 8);
    stride = (w + 3u) & ~3u;

    g_out = (unsigned char CV_HUGE *)halloc((long)stride * h, 1);
    g_lut = (unsigned char CV_FAR *)_fmalloc(32768u);
    g_frame = (unsigned char CV_FAR *)_fmalloc(60000u);
    g_st = (CV_STATE CV_FAR *)_fmalloc(sizeof(CV_STATE));
    if (!g_out || !g_lut || !g_frame || !g_st) { printf("out of memory\n"); return 1; }
    {
        FILE *l = fopen("LUT.BIN", "rb");
        if (!l || fread(g_lut, 1, 32768u, l) != 32768u) { printf("no LUT.BIN\n"); return 1; }
        fclose(l);
    }
    {
        unsigned long k = (unsigned long)stride * h;
        unsigned char CV_HUGE *p = g_out;
        while (k--) *p++ = 0;
    }
    cv_reset(g_st);

    o = fopen("SUMS.TXT", "w");
    if (!o) return 1;
    raw = argc > 1 ? fopen("OUT.RAW", "wb") : NULL;   /* only when a run is being compared */
    printf("%ux%u, %u frames\n", w, h, n);
    for (i = 0; i < n; i++) {
        unsigned long len;
        int e;
        if (fread(head, 1, 4, f) != 4) break;
        len = (unsigned long)head[0] | ((unsigned long)head[1] << 8)
            | ((unsigned long)head[2] << 16) | ((unsigned long)head[3] << 24);
        if (len > 60000UL) { printf("frame %u too big\n", i); break; }
        if (fread(g_frame, 1, (size_t)len, f) != (size_t)len) break;
        t0 = *bios_tick;
        e = cv_decode(g_st, (const unsigned char CV_HUGE *)g_frame, len, g_lut,
                      g_out, stride, w, h);
        ticks += *bios_tick - t0;
        fprintf(o, "%d %08lx\n", e, sum_of(g_out, (unsigned long)stride * h));
        if (raw) {                        /* small pictures only: this is for finding a bug, not
                                             for the timing runs */
            unsigned long k = 0, tot = (unsigned long)stride * h;
            static unsigned char piece[1024];
            while (k < tot) {
                unsigned m = (unsigned)(tot - k > 1024UL ? 1024UL : tot - k), j;
                for (j = 0; j < m; j++) piece[j] = g_out[k + j];
                fwrite(piece, 1, m, raw);
                k += m;
            }
        }
    }
    fprintf(o, "ticks %lu frames %u\n", ticks, i);
    fclose(o);
    if (raw) fclose(raw);
    fclose(f);
    printf("%lu ticks for %u frames\n", ticks, i);
    return 0;
}
