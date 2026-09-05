/* cvtest.c -- the host harness for cinepak.c. Not built into PAGE.EXE and not for the guest.
 *
 * The decoder in cinepak.c is bytes in, palette indices out, with no Windows in it, so the same
 * source compiles here as an ordinary C program. This feeds it the compressed frames straight out
 * of a RIFF AVI -- the same '##dc' chunks tools/mkpage.py puts in the bundle -- and writes the
 * indices out as one raw plane per frame, for guest/reader/cvcheck.py to compare against ffmpeg's
 * own decode of the same file.
 *
 *   cc -O2 -o cvtest cvtest.c cinepak.c
 *   ./cvtest clip.avi lut555.bin out.raw
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cinepak.h"

static unsigned char *slurp(const char *path, long *len)
{
    FILE *f = fopen(path, "rb");
    unsigned char *p;
    if (!f) { perror(path); exit(1); }
    fseek(f, 0, SEEK_END);
    *len = ftell(f);
    fseek(f, 0, SEEK_SET);
    p = (unsigned char *)malloc((size_t)*len);
    if (!p || fread(p, 1, (size_t)*len, f) != (size_t)*len) { fprintf(stderr, "read %s\n", path); exit(1); }
    fclose(f);
    return p;
}
/* The same checksum cvdos.c prints, so a 16-bit run under DOSBox-X can be compared with this
   one frame by frame. */
static unsigned long sum_of(const unsigned char *p, unsigned long n)
{
    unsigned long a = 1, b = 0;      /* long: on a 16-bit machine `unsigned` overflows here, and
                                        an hour went into believing that was the decoder */
    while (n--) {
        a = (a + *p++) % 65521UL;
        b = (b + a) % 65521UL;
    }
    return (b << 16) | a;
}
static unsigned long le32(const unsigned char *p)
{
    return (unsigned long)p[0] | ((unsigned long)p[1] << 8)
         | ((unsigned long)p[2] << 16) | ((unsigned long)p[3] << 24);
}

static const unsigned char *g_frame[4096];
static unsigned long g_flen[4096];
static int g_nframes;
static unsigned g_w, g_h;

static void walk(const unsigned char *d, unsigned long o, unsigned long end, int inmovi)
{
    while (o + 8 <= end) {
        unsigned long ln = le32(d + o + 4), body = o + 8;
        if (!memcmp(d + o, "LIST", 4) || !memcmp(d + o, "RIFF", 4)) {
            walk(d, body + 4, body + ln, inmovi || !memcmp(d + body, "movi", 4));
        } else if (!memcmp(d + o, "strf", 4) && !g_w) {
            g_w = (unsigned)le32(d + body + 4);
            g_h = (unsigned)le32(d + body + 8);
        } else if (inmovi && d[o + 2] == 'd' && (d[o + 3] == 'c' || d[o + 3] == 'b')
                   && g_nframes < 4096) {
            g_frame[g_nframes] = d + body;
            g_flen[g_nframes] = ln;
            g_nframes++;
        }
        o = body + ln + (ln & 1);
    }
}

int main(int argc, char **argv)
{
    long alen, llen;
    unsigned char *avi, *lut, *out;
    unsigned stride;
    CV_STATE *st;
    FILE *f;
    int i, bad = 0;
    static unsigned long sums[4096];
    static int sumerr[4096];

    if (argc < 4) { fprintf(stderr, "usage: cvtest in.avi lut555.bin out.raw [fuzzseed]\n"); return 2; }
    avi = slurp(argv[1], &alen);
    lut = slurp(argv[2], &llen);
    if (llen != 32768) { fprintf(stderr, "lut must be 32768 bytes\n"); return 2; }
    if (alen < 12 || memcmp(avi, "RIFF", 4) || memcmp(avi + 8, "AVI ", 4)) {
        fprintf(stderr, "not an AVI\n"); return 2;
    }
    walk(avi, 12, (unsigned long)alen, 0);
    if (!g_nframes || !g_w || !g_h) { fprintf(stderr, "no frames\n"); return 2; }

    stride = (g_w + 3u) & ~3u;
    out = (unsigned char *)calloc(stride, g_h);
    st = (CV_STATE *)calloc(1, sizeof(CV_STATE));
    cv_reset(st);
    f = fopen(argv[3], "wb");
    if (!out || !st || !f) { fprintf(stderr, "alloc\n"); return 2; }

    /* With a seed the frames are chewed up first -- bytes flipped, lengths cut short -- and the
       only thing that matters is that the decoder refuses them without writing outside `out`,
       which is what an AddressSanitizer build of this harness proves. The bundle arrives over the
       network, so this is not a hypothetical. */
    if (argc > 4) srand((unsigned)atoi(argv[4]));

    for (i = 0; i < g_nframes; i++) {
        int e;
        if (argc > 4) {
            unsigned long n = g_flen[i], j, cut = n ? (unsigned long)rand() % n : 0;
            unsigned char *chewed = (unsigned char *)malloc((size_t)n + 1);
            memcpy(chewed, g_frame[i], (size_t)n);
            for (j = 0; j < 24; j++) if (n) chewed[rand() % (int)n] = (unsigned char)(rand() & 255);
            e = cv_decode(st, chewed, cut, lut, out, stride, g_w, g_h);
            free(chewed);
        } else {
            e = cv_decode(st, g_frame[i], g_flen[i], lut, out, stride, g_w, g_h);
        }
        if (e != CV_OK) { if (argc <= 4) fprintf(stderr, "frame %d: error %d\n", i, e); bad++; }
        fwrite(out, 1, (size_t)stride * g_h, f);
        sums[i] = sum_of(out, (unsigned long)stride * g_h);
        sumerr[i] = e;
    }
    if (argc > 4) { printf("%d %u %u %u\n", g_nframes, g_w, g_h, stride); return 0; }
    fclose(f);
    printf("%d %u %u %u\n", g_nframes, g_w, g_h, stride);
    for (i = 0; i < g_nframes; i++) printf("%d %08lx\n", sumerr[i], sums[i]);
    return bad ? 1 : 0;
}
