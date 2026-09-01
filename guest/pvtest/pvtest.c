/* PVTEST.EXE - DOS test for the responsive-wfw311 paravirtual display adapter.
 * Sets a Bochs-VBE (DISPI) 8bpp mode with a fixed 2560-pixel pitch, draws a test
 * pattern through the 64K bank window at A000:0000, then polls GENERATION and
 * re-modes to HOST_XRES x HOST_YRES whenever the host changes it. Any key exits.
 * Build: tools/watcom.sh wcc -bt=dos -ms -ox -zq pvtest.c && tools/watcom.sh wlink system dos name PVTEST.EXE file pvtest.obj
 */
#include <conio.h>
#include <dos.h>
#include <stdio.h>
#include <string.h>

#define DISPI_INDEX 0x1CE
#define DISPI_DATA  0x1CF
enum { R_ID=0, R_XRES=1, R_YRES=2, R_BPP=3, R_ENABLE=4, R_BANK=5, R_VIRT_W=6, R_VIRT_H=7, R_XOFF=8, R_YOFF=9,
       R_HOST_XRES=0x10, R_HOST_YRES=0x11, R_HOST_DPI=0x12, R_STATUS=0x13, R_CURX=0x14, R_CURY=0x15, R_DEBUG=0x16, R_GEN=0x17 };
#define PITCH 2560

static unsigned rd(unsigned idx) { outpw(DISPI_INDEX, idx); return inpw(DISPI_DATA); }
static void wr(unsigned idx, unsigned v) { outpw(DISPI_INDEX, idx); outpw(DISPI_DATA, v); }
static void dbg(const char *s) { while (*s) wr(R_DEBUG, (unsigned char)*s++); wr(R_DEBUG, 10); }

static unsigned char far *vram = (unsigned char far *)MK_FP(0xA000, 0);
static unsigned cur_bank = 0xFFFF;
static void setbank(unsigned b) { if (b != cur_bank) { wr(R_BANK, b); cur_bank = b; } }
static void put(unsigned x, unsigned y, unsigned char c) {
    unsigned long off = (unsigned long)y * PITCH + x;
    setbank((unsigned)(off >> 16));
    vram[(unsigned)off] = c;
}
static void hline(unsigned x0, unsigned x1, unsigned y, unsigned char c) {
    unsigned long off = (unsigned long)y * PITCH + x0;
    unsigned n = x1 - x0;
    while (n) {
        unsigned bank = (unsigned)(off >> 16), o = (unsigned)off;
        unsigned long left = 0x10000UL - o;          /* bytes left in this 64K bank */
        unsigned run = left < n ? (unsigned)left : n;
        setbank(bank);
        _fmemset(vram + o, c, run);
        off += run; n -= run;
    }
}
static void palette(void) {
    unsigned i;
    outp(0x3C8, 0);
    for (i = 0; i < 256; i++) {              /* 0..63 grey ramp, then colour cube-ish ramps */
        unsigned char r, g, b;
        if (i < 64) { r = g = b = (unsigned char)i; }
        else if (i < 128) { r = (unsigned char)(i - 64); g = 0; b = 0; }
        else if (i < 192) { r = 0; g = (unsigned char)(i - 128); b = 0; }
        else { r = 0; g = 0; b = (unsigned char)(i - 192); }
        outp(0x3C9, r); outp(0x3C9, g); outp(0x3C9, b);
    }
}
static void setmode(unsigned w, unsigned h) {
    char buf[80];
    wr(R_ENABLE, 0);
    wr(R_XRES, w); wr(R_YRES, h); wr(R_BPP, 8);
    wr(R_VIRT_W, PITCH); wr(R_VIRT_H, 1600);
    wr(R_XOFF, 0); wr(R_YOFF, 0);
    wr(R_ENABLE, 1 | 0x40 | 0x80);           /* enable | LFB | no-clear */
    outpw(0x3C4, 0x0E04);                    /* sequencer: chain-4 on (linear byte addressing) */
    outpw(0x3C4, 0x0F02);                    /* map mask: all planes */
    cur_bank = 0xFFFF;
    sprintf(buf, "pvtest: mode %ux%u pitch %u (virt_w reads %u)", w, h, PITCH, rd(R_VIRT_W));
    dbg(buf);
}
static void draw(unsigned w, unsigned h) {
    unsigned x, y;
    char buf[64];
    for (y = 0; y < h; y++)                  /* grey gradient background, 8px-checker in corners */
        hline(0, w, y, (unsigned char)((y * 63UL) / (h ? h : 1)));
    for (y = 0; y < h; y += 8) { hline(0, w, y, 191); }          /* green grid rows */
    for (x = 0; x < w; x += 8) for (y = 0; y < h; y++) put(x, y, 191);
    hline(0, w, 0, 127); hline(0, w, h - 1, 127);               /* red frame */
    for (y = 0; y < h; y++) { put(0, y, 127); put(w - 1, y, 127); }
    for (y = 0; y < 16; y++) hline(0, 64, y, (unsigned char)(y * 4));  /* top-left grey swatch */
    for (y = 16; y < 32; y++) hline(0, 64, y, 255);              /* blue swatch */
    sprintf(buf, "pvtest: drew %ux%u", w, h); dbg(buf);
}

int main(void) {
    unsigned w, h, gen, id;
    char buf[96];
    id = rd(R_DEBUG);
    if (id != 0x5056) { printf("No PV adapter signature (got %04X); DISPI id %04X\n", id, rd(R_ID)); return 1; }
    w = rd(R_HOST_XRES); h = rd(R_HOST_YRES); gen = rd(R_GEN);
    if (!w || !h) { w = 640; h = 480; }
    sprintf(buf, "pvtest: start host=%ux%u dpi=%u gen=%u", w, h, rd(R_HOST_DPI), gen); dbg(buf);
    palette();
    setmode(w, h); draw(w, h);
    wr(R_STATUS, 1);
    for (;;) {
        unsigned g;
        if (kbhit()) { getch(); break; }
        g = rd(R_GEN);
        if (g != gen) {
            gen = g;
            w = rd(R_HOST_XRES); h = rd(R_HOST_YRES);
            sprintf(buf, "pvtest: gen %u -> re-mode %ux%u", gen, w, h); dbg(buf);
            setmode(w, h); draw(w, h);
            wr(R_STATUS, 1);
        }
        wr(R_CURX, w / 2); wr(R_CURY, h / 2);
        _asm { int 28h }                       /* DOS idle: lets the emulator breathe */
    }
    wr(R_ENABLE, 0);
    _asm { mov ax, 3h  }
    _asm { int 10h }
    printf("pvtest: exit at gen %u\n", gen);
    return 0;
}
