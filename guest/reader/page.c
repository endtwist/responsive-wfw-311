/* PAGE.EXE - a scrolling reader for the guest, in native Win16.
 *
 * FETCH.EXE proved that a 1994 machine can pull a 2026 document off the network at memory-copy
 * speed by letting the host own the TCP stack (guest/fetch/fetch.c). This is the other half: what
 * you do with the bytes once they are here. It fetches a page bundle by URL over the same
 * paravirtual socket and shows it -- headings, paragraphs, photographs and short silent videos --
 * in one scrolling column, with the finger gesture the host turns into WM_VSCROLL.
 *
 * Nothing is baked into the disk image. The bundle arrives at run time, and it can be several
 * megabytes, which is the first thing that makes this not an ordinary Windows 3.1 program: a
 * megabyte does not fit in a 16-bit segment. The whole reply is held in ONE GlobalAlloc block and
 * addressed with __huge pointers (see "the huge buffer" below for why that, and not a chunk list).
 *
 * The format it reads is .PVP, built by tools/mkpage.py:
 *
 *   header  "PVPG", u16 version = 1, u16 block_count, 768 bytes of palette (256 x R,G,B)
 *   block   u16 type, u32 length, `length` bytes of payload
 *             1 HEAD   cp437 text, no terminator
 *             2 PARA   cp437 text, no terminator
 *             3 RULE   empty
 *             4 IMAGE  u16 w, u16 h, h rows of 8-bpp pixels, top-down, rows padded to 4 bytes
 *             5 VIDEO  u16 w, u16 h, u16 fps, u16 frame_count, u16 codec, then per frame
 *                        u32 frame_length followed by that many bytes of frame data.
 *                      codec 0, delta segments: u16 seg_count, seg_count x { u16 y, u16 x,
 *                        u16 len, len bytes }, each segment replacing len pixels at (x, y) of the
 *                        frame before it; seg_count 0 repeats the previous frame
 *                      codec 2, Cinepak ("cvid"): one AVI frame per frame, decoded to palette
 *                        indices by guest/reader/cinepak.c. Eleven times smaller than the same
 *                        clips as delta segments -- 309 KB against 3,377 KB for three of them --
 *                        and the bundle crosses the real internet before the fast emulated link
 *                        ever sees it, so those are the bytes that decide this.
 *             6 LUT555 32768 bytes: entry i is the palette index nearest to RGB555 colour i,
 *                        i = r<<10 | g<<5 | b. Cinepak's colours live in its codebooks, so this
 *                        table is consulted a few hundred times a frame, not per pixel. It comes
 *                        before any codec 2 video.
 *
 * One palette for every image and every video in the bundle, so scrolling past a photograph does
 * not repaint the world. It is realised on WM_PAINT and on the palette messages; the paravirtual
 * display driver does support a realised palette, which a photograph shown in Paintbrush proved.
 *
 * Build: guest/reader/build.sh  (Open Watcom via tools/watcom.sh)
 */
#include <windows.h>
#include <string.h>            /* _fmemcpy */
#include <conio.h>             /* inpw, outpw */
#include <i86.h>               /* FP_OFF, _disable, _enable */
#include "cinepak.h"           /* the Cinepak decoder: bytes in, palette indices out */

/* ------------------------------------------------------------------ the adapter
   Identical to FETCH.EXE's, register for register; see guest/fetch/fetch.c for why the transfer
   goes through a port pair rather than the A0000 aperture, and why the index register is read back
   instead of being guarded with cli. The one difference is the handle: FETCH claims 7 and this
   claims 6, so the two can be fetching at the same time without stealing each other's bytes. */
#define DISPI_INDEX  0x1CE
#define DISPI_DATA   0x1CF
#define R_DEBUG      0x16
#define R_PV_CMD     0x30
#define R_PV_ARG     0x31
#define R_PV_RESULT  0x32
#define R_PV_STATE   0x33
#define R_PV_DATA    0x34
#define R_PV_CHAR    0x35
#define R_PV_SEL     0x36
#define PV_HANDLE    6         /* FETCH.EXE has 7; WINSOCK.DLL hands out 0 upwards */

#define PVCMD_OPEN   1
#define PVCMD_READ   2
#define PVCMD_CLOSE  3

#define PVST_IDLE     0
#define PVST_FETCHING 1
#define PVST_DATA     2
#define PVST_DONE     3
#define PVST_ERROR    0xFF

#define PV_BLOCK   0xF000u     /* the most one READ may hand back: the device's own limit */
#define PV_CHUNK   0x2000u     /* drained from the data register this much at a time */
#define PV_BURST    512        /* interrupts are off for this long at a time, no longer */

static unsigned rd(unsigned idx)
{
    unsigned v; int tries = 4;
    do { outpw(DISPI_INDEX, idx); v = inpw(DISPI_DATA); } while (inpw(DISPI_INDEX) != idx && --tries);
    return v;
}
static void wr(unsigned idx, unsigned v)
{
    int tries = 4;
    do { outpw(DISPI_INDEX, idx); outpw(DISPI_DATA, v); } while (inpw(DISPI_INDEX) != idx && --tries);
}
static void dbg(const char *s) { while (*s) wr(R_DEBUG, (unsigned char)*s++); wr(R_DEBUG, 10); }

/* ------------------------------------------------------------------ ids and geometry
   Get is IDOK and Close is IDCANCEL on purpose. The message loop runs IsDialogMessage so that Tab
   moves between the controls, and IsDialogMessage answers Return with WM_COMMAND(IDOK) and Escape
   with WM_COMMAND(IDCANCEL). The URL box used to be control 1 -- so Return in it sent a command
   addressed to the box itself, and typing an address and pressing Return did nothing at all. */
#define ID_GET     1                   /* IDOK: the default button, and what Return presses */
#define ID_CLOSE   2                   /* IDCANCEL: what Escape presses */
#define ID_URL     100
#define ID_STATUS  101
#define ID_VIEW    102

#define IDT_PUMP   1           /* the transfer */
#define IDT_FRAME  2           /* every visible video, on one timer */
#define PUMP_MS    10          /* Windows rounds this up to the 18.2 Hz tick, which is fast enough */
#define FRAME_MS   40          /* likewise: ~18 fps is the ceiling this machine's timer can offer */

#define MARGIN      8
#define ROW        24
#define GAP         6
#define PAD        10          /* the page's own left and right margin inside the view */

/* ------------------------------------------------------------------ the huge buffer
   A page bundle with seven photographs and three clips is a few megabytes, and there is no way to
   hold that in a segment. Two shapes were on offer: a list of 64 KB chunks, or one GlobalAlloc
   block addressed with __huge pointers. This is the second, for one reason that decides it -- an
   image's rows have to reach StretchDIBits as one run of bytes, and with a chunk list every block
   that straddled a chunk boundary would need reassembling anyway, so the copy never goes away and
   the bookkeeping does not either. With one block the copy is a plain _fmemcpy per row into a
   small band buffer, and every offset in the file is just a DWORD.

   Watcom's huge pointers do the right thing here: __PIA (its pointer-add helper) shifts the
   carry out of the offset by __HShift, and the Windows startup sets __HShift to 3 in protected
   mode -- that is the selector-array stride KERNEL uses for a >64 KB global block. Arithmetic
   normalises, so a __huge pointer cast to FAR is always valid for the rest of its 64 KB, which is
   what hmove() below relies on to move whole rows with _fmemcpy instead of a byte at a time. */
#define BUF_START   0x00040000L      /* 256 KB, before Content-Length says otherwise */
#define BUF_MAX     0x00800000L      /* 8 MB: the machine has 32, and Windows wants most of it */

static HGLOBAL g_bh;
static BYTE __huge *g_buf;
static DWORD g_cap, g_len;

/* Move n bytes between any two places in the address space, huge or far, without ever letting a
   copy run off the end of a selector. FAR pointers may be passed in: a FAR pointer is a valid
   __huge pointer for as long as it stays inside its own object. */
static void hmove(BYTE __huge *d, const BYTE __huge *s, unsigned n)
{
    while (n) {
        BYTE FAR *dp = (BYTE FAR *)d;
        const BYTE FAR *sp = (const BYTE FAR *)s;
        DWORD da = 65536L - (DWORD)FP_OFF(dp), sa = 65536L - (DWORD)FP_OFF(sp);
        DWORD lim = da < sa ? da : sa;
        unsigned take = lim < (DWORD)n ? (unsigned)lim : n;
        _fmemcpy(dp, sp, take);
        d += take; s += take; n -= take;
    }
}
/* The three little-endian reads the format needs. Bounds are the caller's business except that
   nothing here is allowed to read past what arrived: hu8 answers 0 beyond the end. */
static unsigned hu8(DWORD off)  { return off < g_len ? (unsigned)g_buf[off] : 0; }
static unsigned hu16(DWORD off) { return hu8(off) | (hu8(off + 1) << 8); }
static DWORD hu32(DWORD off)
{
    return (DWORD)hu16(off) | ((DWORD)hu16(off + 2) << 16);
}

static BOOL buf_reserve(DWORD need)
{
    HGLOBAL nh;
    DWORD cap;
    if (need <= g_cap) return TRUE;
    if (need > BUF_MAX) return FALSE;
    cap = g_cap ? g_cap : BUF_START;
    while (cap < need) {
        cap += cap / 2;
        if (cap >= BUF_MAX) { cap = BUF_MAX; break; }
    }
    if (!g_bh) {
        nh = GlobalAlloc(GMEM_MOVEABLE, cap);
        if (!nh) return FALSE;
    } else {
        /* GlobalReAlloc will not move a locked block, and a moveable one has to be free to move
           if it is to grow at all. The lock goes first and comes back after. */
        GlobalUnlock(g_bh);
        g_buf = NULL;
        nh = GlobalReAlloc(g_bh, cap, GMEM_MOVEABLE);
        if (!nh) { g_buf = (BYTE __huge *)GlobalLock(g_bh); return FALSE; }
    }
    g_bh = nh;
    g_buf = (BYTE __huge *)GlobalLock(g_bh);
    if (!g_buf) { g_cap = 0; return FALSE; }
    g_cap = cap;
    return TRUE;
}
static void buf_free(void)
{
    if (g_bh) { GlobalUnlock(g_bh); GlobalFree(g_bh); g_bh = 0; }
    g_buf = NULL; g_cap = 0; g_len = 0;
}

/* ------------------------------------------------------------------ the display list */
#define MAX_BLOCKS   512
#define B_HEAD  1
#define B_PARA  2
#define B_RULE  3
#define B_IMAGE 4
#define B_VIDEO 5
#define B_LUT555 6
#define B_STYLE  7
#define B_SUB    8
#define NSTYLE   9              /* the style table is indexed by block type */

#define CODEC_DELTA   0
#define CODEC_CINEPAK 2

typedef struct {
    unsigned type;
    DWORD    off, len;          /* the payload, in the bundle */
    long     y;                 /* top, in document coordinates */
    int      h;                 /* height, including the space above and below it */
    int      before;            /* of that height, how much is air above the text */
    /* pictures */
    int      w, ih;             /* natural size */
    int      dx, dw, dh;        /* where it lands in the view, and at what size */
    /* video */
    unsigned codec;
    unsigned fps, frames, frameIx;
    DWORD    first, next;       /* the first frame, and the one to decode next */
    HGLOBAL  fbh;               /* the working frame, w-stride x ih, only while it is on screen */
    BYTE __huge *fb;
    HGLOBAL  cvh;               /* Cinepak's codebooks, likewise only while it is playing */
    CV_STATE __far *cv;
    DWORD    due;               /* GetTickCount at which the next frame is owed */
} BLOCK;

static BLOCK g_blk[MAX_BLOCKS];
static int   g_nblk;
static long  g_docH;            /* the whole page */
static long  g_scrollY;
static int   g_scrollShift;     /* doc pixels per scroll-bar unit, as a shift: see set_range */
static int   g_lineH = 16;      /* one SB_LINEUP, and the leading between paragraphs */
static int   g_viewW, g_viewH;
/* The column the page is set in. A window this desktop can be a third of a phone screen or the
   whole of a monitor, and a line of text that ran the full width of the second would be unreadable
   for the usual reason -- the eye loses the start of the next line. So the column is the view,
   less its margins, up to a measure of about seventy characters, and centred in whatever is left.
   Pictures are laid out in the same column, which is what keeps their edges lined up with the
   text at every width. */
#define COL_MAX 460
static int   g_colX, g_colW;

/* ------------------------------------------------------------------ palette and DIB
   One BITMAPINFO, built once from the bundle's 768 bytes and reused for every blit: only
   biWidth/biHeight/biSizeImage change, band by band. `usage` is normally DIB_RGB_COLORS, which
   makes GDI match each of the 256 colours to the realised palette -- correct everywhere, and the
   only thing that is certain to be correct. [PVMon] PageDibPal=1 switches to DIB_PAL_COLORS, where
   the DIB's own indices ARE logical palette indices and the translation disappears; that is the
   fast path for video, and it is a switch rather than the default because it is the driver's
   behaviour being trusted rather than GDI's. */
typedef struct { BITMAPINFOHEADER h; RGBQUAD c[256]; } DIBRGB;
typedef struct { BITMAPINFOHEADER h; WORD    c[256]; } DIBPAL;
static DIBRGB   g_dibRgb;
static DIBPAL   g_dibPal;
static UINT     g_usage = DIB_RGB_COLORS;
static HPALETTE g_pal;

/* The LUT555 block, lifted out of the bundle into a segment of its own so the decoder can reach
   it with a plain far pointer: 32768 bytes is exactly half a segment, and a table that had to be
   addressed hugely would put a pointer-add helper call on every codebook entry. */
static HGLOBAL g_luth;
static BYTE __far *g_lut;

#define BAND_BYTES 0x8000u          /* the scratch a band of rows is flipped into: 32 KB, one segment */
static HGLOBAL g_bandh;
static BYTE FAR *g_band;

/* ------------------------------------------------------------------ window state */
#ifdef SHELL_ABOUT
/* ABOUT.EXE is this same reader with a different shell: two tabs instead of an address bar, and
   two bundles fetched from the site the page is served from. One renderer, two programs -- the
   note about how to use this machine is a page like any other, and editing its .PVP updates it
   without rebuilding the disk image. */
#define TAB_H   26
#define NTABS    2
static char *tabName[NTABS] = { "What is this?", "How to use" };
static char *tabUrl[NTABS]  = { "/pages/about-what.pvp", "/pages/about-how.pvp" };
static int  g_tab = 0;
static HWND hHide, hNote;
static int  g_wideHost = 0;          /* the host is a desktop: say so, and say why it matters */
static int  g_noteH = 0;             /* the desktop note, measured once it has a width */

/* The host reports its own viewport in the adapter's registers, which is how a program inside the
   guest can know what it is being looked at on. The same rule the page uses: the shorter side
   under 600 host pixels is a phone. It decides two things -- whether to say that none of the
   gestures on the other tab apply here, and how big this window should be. */
static int host_wide(void)
{
    unsigned hw = rd(0x10), hh = rd(0x11);
    if (!hw || !hh) return 0;
    return (hw < hh ? hw : hh) >= 600;
}
static char szIniKey[] = "AboutShown";
#define ID_HIDE 103
static char szClass[]  = "PVAbout";
static char szView[]   = "PVAboutView";
static char szTitle[]  = "About";
#else
static char szClass[]  = "PVPage";
static char szView[]   = "PVPageView";
static char szTitle[]  = "Page";
#endif
static char szIni[]    = "PVMon";

static HWND hMain, hUrl, hGet, hClose, hStatus, hView;

/* ------------------------------------------------------------------ styles
   The bundle may carry a style table: one row per kind of text block, giving a point size, a
   weight, an italic flag, a colour as an index into the page's own palette, and the air to leave
   above and below, also in points. A page that carries none is set in the defaults below, so an
   older bundle still reads properly.

   The colour is an index rather than an RGB on purpose. The builder puts Windows' twenty static
   colours where Windows keeps them, so index 0 really is black and index 4 really is navy on this
   machine, and asking for the RGB out of the page's own palette means GDI has nothing to match:
   the text lands on a physical colour that is already realised, with no dithering and no drift
   towards whatever the pictures happened to need. */
typedef struct {
    int   pt;                   /* points; the height a printer would set it at */
    int   weight, italic;
    int   col;                  /* an index into the page's palette */
    int   before, after;        /* the air above and below, in points */
    char  face[32];
    HFONT font;
} STYLE;
static STYLE g_sty[NSTYLE];

/* Head, sub, body -- the same three the builder emits when a page does not say otherwise. */
static void style_defaults(void)
{
    int i;
    for (i = 0; i < NSTYLE; i++) _fmemset((char FAR *)&g_sty[i], 0, sizeof(STYLE));
    g_sty[B_HEAD].pt = 20; g_sty[B_HEAD].weight = 700; g_sty[B_HEAD].col = 0;
    g_sty[B_HEAD].before = 10; g_sty[B_HEAD].after = 10; lstrcpy(g_sty[B_HEAD].face, "Arial");
    g_sty[B_SUB].pt  = 13; g_sty[B_SUB].weight  = 700; g_sty[B_SUB].col  = 4;
    g_sty[B_SUB].before  = 14; g_sty[B_SUB].after  = 4;  lstrcpy(g_sty[B_SUB].face, "Arial");
    g_sty[B_PARA].pt = 11; g_sty[B_PARA].weight = 400; g_sty[B_PARA].col = 0;
    g_sty[B_PARA].before = 0;  g_sty[B_PARA].after = 9;  lstrcpy(g_sty[B_PARA].face, "Arial");
}

static void style_free(void)
{
    int i;
    for (i = 0; i < NSTYLE; i++)
        if (g_sty[i].font) { DeleteObject(g_sty[i].font); g_sty[i].font = 0; }
}

/* Points into pixels, at the screen's own resolution: the same sum GDI does for a point size in
   a dialog, so a 20pt heading is 20pt whatever the driver reports. */
static int g_dpi = 96;
static int pt2px(int pt) { return pt <= 0 ? 0 : MulDiv(pt, g_dpi, 72); }

/* Build one font per style. Called after a bundle's style table has been read, and once at
   startup for the defaults. */
static void style_fonts(void)
{
    LOGFONT lf;
    HDC hdc = GetDC(hView ? hView : hMain);
    int i;

    if (hdc) { g_dpi = GetDeviceCaps(hdc, LOGPIXELSY); ReleaseDC(hView ? hView : hMain, hdc); }
    if (g_dpi < 48) g_dpi = 96;
    style_free();
    for (i = 0; i < NSTYLE; i++) {
        STYLE *st = &g_sty[i];
        if (!st->pt) continue;
        _fmemset((char FAR *)&lf, 0, sizeof(lf));
        lf.lfHeight = -pt2px(st->pt);
        lf.lfWeight = st->weight ? st->weight : FW_NORMAL;
        lf.lfItalic = (BYTE)(st->italic ? 1 : 0);
        lf.lfCharSet = ANSI_CHARSET;
        lf.lfOutPrecision = OUT_DEFAULT_PRECIS;
        lf.lfQuality = PROOF_QUALITY;        /* never stretch a raster face to fake a size */
        lf.lfPitchAndFamily = DEFAULT_PITCH | FF_DONTCARE;
        lstrcpy(lf.lfFaceName, st->face[0] ? st->face : "Helv");
        st->font = CreateFontIndirect(&lf);   /* a style with no font falls back below */
    }
}

static HFONT style_font(int type)
{
    HFONT f = (type >= 0 && type < NSTYLE) ? g_sty[type].font : 0;
    return f ? f : (HFONT)GetStockObject(SYSTEM_FONT);
}
/* A palette index as a colour GDI can be handed. The page's own palette is realised while the
   view paints, and its first ten and last ten entries are Windows' static colours, so asking for
   the RGB the table holds lands on an exact physical colour rather than a dithered mix. */
static COLORREF pal_rgb(int i)
{
    if (i < 0 || i > 255) i = 0;
    return RGB(g_dibRgb.c[i].rgbRed, g_dibRgb.c[i].rgbGreen, g_dibRgb.c[i].rgbBlue);
}
static HGLOBAL g_txth;
static char FAR *g_txt;             /* one block's text, converted to ANSI, for measuring/drawing */
#define TXT_MAX 8000u

static HGLOBAL blkh;
static char FAR *blk;               /* PV_CHUNK bytes, drained from the device */
static BOOL  pvOpen, pvTimer, pumping, frameTimer;
static char  hdr[600 + 4];
static unsigned hdrN;
static BOOL  inBody;
static char  statusLine[64];
static DWORD g_expect;              /* Content-Length, when the reply gave one */

#define URL_MAX 600

static void status(const char *s) { if (hStatus) SetWindowText(hStatus, s); }

/* ------------------------------------------------------------------ the transfer
   Byte for byte the same as FETCH.EXE's: a burst sets the index register once and reads the data
   register in a loop, with interrupts off for the length of the burst because PVMOUSE's handler
   writes the same index register. */
static void drain(char FAR *dst, unsigned len)
{
    unsigned done = 0;
    while (done < len) {
        unsigned n = len - done, i;
        if (n > PV_BURST) n = PV_BURST;
        _disable();
        outpw(DISPI_INDEX, R_PV_DATA);
        for (i = 0; i + 1 < n; i += 2) {
            unsigned w = inpw(DISPI_DATA);
            dst[done + i] = (char)(w & 0xFF);
            dst[done + i + 1] = (char)((w >> 8) & 0xFF);
        }
        if (i < n) { unsigned w = inpw(DISPI_DATA); dst[done + i] = (char)(w & 0xFF); }
        _enable();
        done += n;
    }
}
static void send_url(const char *url, unsigned len)
{
    unsigned i;
    for (i = 0; i < len; i++) wr(R_PV_CHAR, (unsigned)(unsigned char)url[i]);
}
static unsigned clean_url(const char *in, char *out)
{
    const char FAR *p = (const char FAR *)in;
    unsigned n = 0;
    while (*p == ' ' || *p == '\t') p++;
    if (!*p) return 0;
    if (_fstrnicmp(p, (const char FAR *)"http://", 7) && _fstrnicmp(p, (const char FAR *)"https://", 8)) {
        lstrcpy(out, "http://");
        n = 7;
    }
    while (*p && n < URL_MAX - 1) out[n++] = *p++;
    while (n && (out[n - 1] == ' ' || out[n - 1] == '\t')) n--;
    out[n] = 0;
    return n;
}

/* ------------------------------------------------------------------ pictures */
static int stride_of(int w) { return (w + 3) & ~3; }

static void video_stop(BLOCK *b)
{
    if (b->fbh) { GlobalUnlock(b->fbh); GlobalFree(b->fbh); b->fbh = 0; }
    b->fb = NULL;
    if (b->cvh) { GlobalUnlock(b->cvh); GlobalFree(b->cvh); b->cvh = 0; }
    b->cv = NULL;
}
static BOOL video_start(BLOCK *b)
{
    DWORD need = (DWORD)stride_of(b->w) * (DWORD)b->ih;
    if (b->fb) return TRUE;
    if (!need) return FALSE;
    b->fbh = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, need);
    if (!b->fbh) return FALSE;
    b->fb = (BYTE __huge *)GlobalLock(b->fbh);
    if (!b->fb) { GlobalFree(b->fbh); b->fbh = 0; return FALSE; }
    /* Cinepak's codebooks are 24 KB of state that lives from frame to frame, and it is only worth
       holding while the clip is actually on screen -- the same bargain the working frame makes. */
    if (b->codec == CODEC_CINEPAK) {
        if (!g_lut) { video_stop(b); return FALSE; }      /* no LUT555 block: nothing to draw with */
        b->cvh = GlobalAlloc(GMEM_MOVEABLE, (DWORD)sizeof(CV_STATE));
        if (!b->cvh) { video_stop(b); return FALSE; }
        b->cv = (CV_STATE __far *)GlobalLock(b->cvh);
        if (!b->cv) { video_stop(b); return FALSE; }
        cv_reset(b->cv);
    }
    b->next = b->first;
    b->frameIx = 0;
    b->due = GetTickCount();
    return TRUE;
}

/* Step to the next frame and hand back where its data starts, or 0 when there is none to be had.
   A clip that has run out rounds back to the beginning; a truncated one simply stops growing.
   Everything is bounds-checked against both the picture and the end of the block: the bundle came
   off the network. */
static DWORD video_next(BLOCK *b, DWORD *flen)
{
    DWORD p, end = b->off + b->len;

    if (!b->fb || !b->frames) return 0;
    if (b->frameIx >= b->frames || b->next + 4 > end) {      /* round again */
        b->next = b->first;
        b->frameIx = 0;
        if (b->next + 4 > end) return 0;
        /* Cinepak is inter-coded: the first frame is a keyframe, but its codebooks may still be
           partial updates of what a decoder was told earlier, so the state goes back to nothing
           at the same moment the clip does. */
        if (b->cv) cv_reset(b->cv);
    }
    *flen = hu32(b->next);
    p = b->next + 4;
    if (*flen > (DWORD)(end - p)) { b->frames = b->frameIx; return 0; }   /* truncated: stop here */
    b->next = p + *flen;
    b->frameIx++;
    return p;
}

/* Apply one frame's delta segments to the working frame. A seg_count of 0 is a repeat, which
   costs nothing but the advance. */
static void video_delta(BLOCK *b, DWORD p, DWORD flen)
{
    unsigned segs, i, stride = (unsigned)stride_of(b->w);
    DWORD end = p + flen;

    if (flen < 2) return;
    segs = hu16(p);
    p += 2;
    for (i = 0; i < segs; i++) {
        unsigned sy, sx, sl;
        if (p + 6 > end) return;
        sy = hu16(p); sx = hu16(p + 2); sl = hu16(p + 4);
        p += 6;
        if (p + (DWORD)sl > end) return;
        if (sy < (unsigned)b->ih && sx < (unsigned)b->w && sl <= (unsigned)b->w - sx)
            hmove(b->fb + (DWORD)sy * stride + sx, g_buf + p, sl);
        p += sl;
    }
}

/* Decode the next frame into the working frame, whichever codec the clip is in. */
static void video_frame(BLOCK *b)
{
    DWORD flen = 0, p = video_next(b, &flen);
    if (!p) return;
    if (b->codec == CODEC_CINEPAK) {
        if (b->cv && g_lut)
            cv_decode(b->cv, g_buf + p, flen, g_lut, b->fb,
                      (unsigned)stride_of(b->w), (unsigned)b->w, (unsigned)b->ih);
    } else {
        video_delta(b, p, flen);
    }
}

/* Draw an 8-bpp top-down picture, from anywhere in the address space, in bands small enough to
   flip into one segment. Windows 3.1 has no top-down DIB, so each band is copied bottom-up into
   the scratch buffer and blitted on its own; the destination rows of consecutive bands are
   computed from the same scaled mapping, so they meet exactly and no seam appears even when the
   picture is being fitted to a narrower column. */
static void draw_pic(HDC hdc, const BYTE __huge *src, int w, int ih, int dx, int dy, int dw, int dh,
                     const RECT FAR *clip)
{
    unsigned stride;
    int rows, row0;

    if (!g_band || w <= 0 || ih <= 0 || dw <= 0 || dh <= 0) return;
    stride = (unsigned)stride_of(w);
    rows = (int)(BAND_BYTES / stride);
    if (rows < 1) return;                      /* a row wider than the scratch buffer: nothing to do */
    if (rows > ih) rows = ih;
    g_dibRgb.h.biWidth = g_dibPal.h.biWidth = w;
    for (row0 = 0; row0 < ih; row0 += rows) {
        int n = ih - row0, i, dy0, dy1;
        if (n > rows) n = rows;
        dy0 = dy + (int)(((long)row0 * dh) / ih);
        dy1 = dy + (int)(((long)(row0 + n) * dh) / ih);
        if (dy1 <= dy0) continue;
        if (clip && (dy1 <= clip->top || dy0 >= clip->bottom)) continue;   /* not in the update rect */
        for (i = 0; i < n; i++)
            hmove((BYTE __huge *)(g_band + (unsigned)i * stride),
                  src + (DWORD)(row0 + n - 1 - i) * stride, stride);
        g_dibRgb.h.biHeight = g_dibPal.h.biHeight = n;
        g_dibRgb.h.biSizeImage = g_dibPal.h.biSizeImage = (DWORD)stride * n;
        StretchDIBits(hdc, dx, dy0, dw, dy1 - dy0, 0, 0, w, n, g_band,
                      (LPBITMAPINFO)(g_usage == DIB_PAL_COLORS ? (void FAR *)&g_dibPal
                                                              : (void FAR *)&g_dibRgb),
                      g_usage, SRCCOPY);
    }
}

/* ------------------------------------------------------------------ text
   The bundle's text is cp437, which is what the guest's own files are; the screen font is ANSI.
   OemToAnsiBuff is the translation Windows itself uses for exactly this, and it is done once here
   rather than in the builder so that the same bundle would still read correctly on a machine with
   a different code page. */
static int text_of(const BLOCK *b)
{
    unsigned n = b->len > (DWORD)(TXT_MAX - 1) ? TXT_MAX - 1 : (unsigned)b->len;
    if (!g_txt) return 0;
    hmove((BYTE __huge *)g_txt, g_buf + b->off, n);
    g_txt[n] = 0;
    /* The bundle emits Windows ANSI now, which is what the screen font speaks: no conversion. */
    return (int)n;
}

/* ------------------------------------------------------------------ measuring
   Every block is measured once, at the client width, and its height and y offset kept. Nothing is
   measured again until the view is resized or a new bundle arrives, which is what keeps a scroll
   to the cost of a ScrollWindow and a repaint of the strip that came in. */
#define DT_FLAGS (DT_WORDBREAK | DT_NOPREFIX | DT_EXPANDTABS)

static void set_range(void);

static void measure(void)
{
    HDC hdc;
    HFONT old;
    int i, seen = 0, avail = g_viewW - 2 * PAD;
    long y = PAD;

    if (avail > COL_MAX) avail = COL_MAX;
    if (avail < 32) avail = 32;
    g_colW = avail;
    g_colX = (g_viewW - avail) / 2;
    if (g_colX < PAD) g_colX = PAD;
    hdc = GetDC(hView);
    old = (HFONT)SelectObject(hdc, style_font(B_PARA));
    {   /* one line of body text: the scroll step, and the space between blocks */
        TEXTMETRIC tm;
        GetTextMetrics(hdc, &tm);
        g_lineH = tm.tmHeight + tm.tmExternalLeading;
        if (g_lineH < 8) g_lineH = 8;
    }
    for (i = 0; i < g_nblk; i++) {
        BLOCK *b = &g_blk[i];
        b->y = y;
        switch (b->type) {
        case B_HEAD:
        case B_SUB:
        case B_PARA: {
            RECT r;
            STYLE *st = &g_sty[b->type];
            int len = text_of(b);
            SelectObject(hdc, style_font(b->type));
            r.left = 0; r.top = 0; r.right = avail; r.bottom = 0;
            if (len) DrawText(hdc, g_txt, len, &r, DT_FLAGS | DT_CALCRECT);
            else r.bottom = 0;
            /* Nothing gets air above it at the very top of the page: the view's own margin is
               already there, and a heading that started an inch down would look like a mistake. */
            b->before = seen ? pt2px(st->before) : 0;
            b->h = b->before + r.bottom + pt2px(st->after);
            break;
        }
        case B_RULE:
            b->h = g_lineH;
            break;
        case B_IMAGE:
        case B_VIDEO:
            if (b->w > 0 && b->ih > 0) {
                if (b->w > avail) {
                    b->dw = avail;
                    b->dh = (int)(((long)b->ih * avail) / b->w);
                    if (b->dh < 1) b->dh = 1;
                } else {
                    b->dw = b->w;
                    b->dh = b->ih;
                }
            } else {
                b->dw = b->dh = 0;
            }
            b->dx = g_colX + (avail - b->dw) / 2;
            b->before = 0;
            b->h = b->dh + g_lineH / 2;
            break;
        default:
            b->h = 0;
            break;
        }
        if (b->h > 0) seen = 1;
        y += b->h;
    }
    SelectObject(hdc, old);
    ReleaseDC(hView, hdc);
    g_docH = y + PAD;
    set_range();
}

/* The scroll bar counts in ints, and a page of photographs is easily taller than 32767 of anything.
   The bar therefore counts in units of 2^g_scrollShift document pixels, chosen so the range always
   fits; for an ordinary page the shift is 0 and a unit is a pixel. */
static void set_range(void)
{
    long span = g_docH - g_viewH;
    if (span < 0) span = 0;
    g_scrollShift = 0;
    while ((span >> g_scrollShift) > 30000L) g_scrollShift++;
    if (g_scrollY > span) g_scrollY = span;
    if (g_scrollY < 0) g_scrollY = 0;
    SetScrollRange(hView, SB_VERT, 0, (int)(span >> g_scrollShift), FALSE);
    SetScrollPos(hView, SB_VERT, (int)(g_scrollY >> g_scrollShift), TRUE);
}

/* ------------------------------------------------------------------ visibility
   The only reason a block knows whether it is on screen is video: a clip that has scrolled away
   must stop being decoded, and must give its working frame back. Both happen here, and the frame
   timer only runs while something is actually playing. */
static BOOL on_screen(const BLOCK *b)
{
    return b->y + b->h > g_scrollY && b->y < g_scrollY + g_viewH;
}
static void update_playing(void)
{
    int i, any = 0;
    for (i = 0; i < g_nblk; i++) {
        BLOCK *b = &g_blk[i];
        if (b->type != B_VIDEO) continue;
        if (on_screen(b)) {
            /* The first frame is decoded as the clip comes into view, not on the next tick: a
               clip that scrolled in showing a blank rectangle for a twentieth of a second is a
               flash of the wrong colour exactly where the eye has just landed. */
            if (!b->fb && video_start(b)) video_frame(b);
            if (b->fb) any = 1;
        } else if (b->fb) {
            video_stop(b);
        }
    }
    if (any && !frameTimer) frameTimer = SetTimer(hMain, IDT_FRAME, FRAME_MS, NULL) != 0;
    else if (!any && frameTimer) { KillTimer(hMain, IDT_FRAME); frameTimer = FALSE; }
}

/* ------------------------------------------------------------------ parsing the bundle */
static void free_page(void)
{
    int i;
    if (frameTimer) { KillTimer(hMain, IDT_FRAME); frameTimer = FALSE; }
    for (i = 0; i < g_nblk; i++) video_stop(&g_blk[i]);
    g_nblk = 0;
    g_docH = 0;
    g_scrollY = 0;
    if (g_pal) { DeleteObject(g_pal); g_pal = 0; }
    if (g_luth) { GlobalUnlock(g_luth); GlobalFree(g_luth); g_luth = 0; }
    g_lut = NULL;
    /* Back to the built-in styles, so a bundle that carries no table of its own reads in them
       rather than in the last page's. Fonts are rebuilt here and again at the end of a successful
       parse, which costs three CreateFontIndirect calls and means every path out of the parser
       leaves the table and the fonts describing the same thing. */
    style_defaults();
    style_fonts();
}

static void build_palette(DWORD off)
{
    HGLOBAL lh = GlobalAlloc(GMEM_MOVEABLE, (DWORD)sizeof(LOGPALETTE) + 256L * sizeof(PALETTEENTRY));
    LOGPALETTE FAR *lp;
    int i;

    for (i = 0; i < 256; i++) {
        BYTE r = (BYTE)hu8(off + (DWORD)i * 3);
        BYTE g = (BYTE)hu8(off + (DWORD)i * 3 + 1);
        BYTE b = (BYTE)hu8(off + (DWORD)i * 3 + 2);
        g_dibRgb.c[i].rgbRed = r; g_dibRgb.c[i].rgbGreen = g; g_dibRgb.c[i].rgbBlue = b;
        g_dibRgb.c[i].rgbReserved = 0;
        g_dibPal.c[i] = (WORD)i;
    }
    if (!lh) return;
    lp = (LOGPALETTE FAR *)GlobalLock(lh);
    if (lp) {
        lp->palVersion = 0x300;
        lp->palNumEntries = 256;
        for (i = 0; i < 256; i++) {
            lp->palPalEntry[i].peRed   = g_dibRgb.c[i].rgbRed;
            lp->palPalEntry[i].peGreen = g_dibRgb.c[i].rgbGreen;
            lp->palPalEntry[i].peBlue  = g_dibRgb.c[i].rgbBlue;
            /* The bundle puts Windows' static colours where Windows keeps them -- the first ten
               at 0..9 and the last ten at 246..255 -- so the logical palette is an identity map and
               GDI has no colour translation to run per blit. Those entries must map onto the
               ones already in the physical palette rather than take entries of their own. The rest
               are the picture's own and are asked for exactly. */
            lp->palPalEntry[i].peFlags = (i < 10 || i >= 246) ? 0 : PC_NOCOLLAPSE;
        }
        g_pal = CreatePalette(lp);
        GlobalUnlock(lh);
    }
    GlobalFree(lh);
}

/* Walk the bundle and fill the display list. Returns an error string, or NULL. */
static const char *parse_page(void)
{
    DWORD p;
    unsigned count, i;

    free_page();
    if (g_len < 4 + 2 + 2 + 768) return "That is not a page bundle (too short).";
    if (hu8(0) != 'P' || hu8(1) != 'V' || hu8(2) != 'P' || hu8(3) != 'G')
        return "That is not a page bundle (no PVPG).";
    if (hu16(4) != 1) return "That bundle is a version this reader does not know.";
    count = hu16(6);
    build_palette(8);
    p = 8 + 768;
    for (i = 0; i < count && p + 6 <= g_len; i++) {
        BLOCK *b;
        unsigned type = hu16(p);
        DWORD len = hu32(p + 2);
        p += 6;
        if (len > g_len - p) return "That bundle is truncated.";
        if (g_nblk >= MAX_BLOCKS) break;
        b = &g_blk[g_nblk];
        _fmemset((char FAR *)b, 0, sizeof(BLOCK));
        b->type = type;
        b->off = p;
        b->len = len;
        if (type == B_IMAGE) {
            if (len < 4) return "A picture in that bundle has no size.";
            b->w = (int)hu16(p);
            b->ih = (int)hu16(p + 2);
            b->off = p + 4;
            b->len = len - 4;
            if (b->w <= 0 || b->ih <= 0
                || (DWORD)stride_of(b->w) * (DWORD)b->ih > b->len) return "A picture in that bundle is short.";
        } else if (type == B_VIDEO) {
            if (len < 10) return "A clip in that bundle has no size.";
            b->w = (int)hu16(p);
            b->ih = (int)hu16(p + 2);
            b->fps = hu16(p + 4);
            b->frames = hu16(p + 6);
            b->codec = hu16(p + 8);
            if (b->w <= 0 || b->ih <= 0) return "A clip in that bundle has no size.";
            if (b->codec != CODEC_DELTA && b->codec != CODEC_CINEPAK)
                return "A clip in that bundle is in a codec this reader does not know.";
            /* Cinepak's colours arrive as YUV codebooks and are turned into palette indices
               through the LUT555 block, which the format puts ahead of the first clip that needs
               it. Without it there is nothing to draw with, and saying so beats a grey rectangle. */
            if (b->codec == CODEC_CINEPAK && !g_lut)
                return "That bundle's video comes before the colour table it needs.";
            if (!b->fps) b->fps = 12;
            b->off = p;                       /* the whole payload, so `end` covers every frame */
            b->len = len;
            b->first = b->next = p + 10;
        } else if (type == B_STYLE) {
            /* One row per kind of text block: 44 bytes, in the order the builder packs them. A
               row naming a block type this reader does not have is skipped rather than refused,
               so a bundle can carry a style for something added later. */
            unsigned n = len >= 2 ? hu16(p) : 0, k;
            DWORD q = p + 2;
            for (k = 0; k < n && q + 44 <= p + len; k++, q += 44) {
                unsigned t = hu16(q);
                STYLE *st;
                int c;
                if (t >= NSTYLE) continue;
                st = &g_sty[t];
                st->pt     = (int)hu16(q + 2);
                st->weight = (int)hu16(q + 4);
                st->italic = (int)hu8(q + 6);
                st->col    = (int)hu8(q + 7);
                st->before = (int)hu16(q + 8);
                st->after  = (int)hu16(q + 10);
                for (c = 0; c < 31; c++) st->face[c] = (char)hu8(q + 12 + (DWORD)c);
                st->face[31] = 0;
                if (st->pt < 4) st->pt = 4;
                if (st->pt > 96) st->pt = 96;
            }
        } else if (type == B_LUT555) {
            /* One table for the page, copied out of the bundle into its own segment; a second one
               would only overwrite the first, so the first wins. */
            if (len < 32768L) return "The colour table in that bundle is short.";
            if (!g_lut) {
                g_luth = GlobalAlloc(GMEM_MOVEABLE, 32768L);
                if (g_luth) g_lut = (BYTE __far *)GlobalLock(g_luth);
                if (!g_lut) return "There is not enough memory for that page's colour table.";
                hmove((BYTE __huge *)g_lut, g_buf + p, 32768u);
            }
        }
        g_nblk++;
        p += len;
    }
    if (!g_nblk) return "That bundle has nothing in it.";
    style_fonts();
    return NULL;
}

/* ------------------------------------------------------------------ painting */
static void paint_block(HDC hdc, BLOCK *b, int top, const RECT FAR *clip)
{
    switch (b->type) {
    case B_HEAD:
    case B_SUB:
    case B_PARA: {
        RECT r;
        COLORREF oldc;
        int len = text_of(b);
        if (!len) break;
        SelectObject(hdc, style_font(b->type));
        oldc = SetTextColor(hdc, pal_rgb(g_sty[b->type].col));
        r.left = g_colX;
        r.right = g_colX + g_colW;
        r.top = top + b->before;
        r.bottom = top + b->h;
        DrawText(hdc, g_txt, len, &r, DT_FLAGS);
        SetTextColor(hdc, oldc);
        break;
    }
    case B_RULE: {
        HPEN pen = CreatePen(PS_SOLID, 1, GetSysColor(COLOR_WINDOWFRAME));
        HPEN old = (HPEN)SelectObject(hdc, pen);
        int y = top + b->h / 2;
        MoveTo(hdc, g_colX, y);
        LineTo(hdc, g_colX + g_colW, y);
        SelectObject(hdc, old);
        DeleteObject(pen);
        break;
    }
    case B_IMAGE:
        if (b->dw > 0) draw_pic(hdc, g_buf + b->off, b->w, b->ih, b->dx, top, b->dw, b->dh, clip);
        break;
    case B_VIDEO:
        if (b->dw > 0 && b->fb) draw_pic(hdc, b->fb, b->w, b->ih, b->dx, top, b->dw, b->dh, clip);
        else if (b->dw > 0) {                      /* not started yet: leave the space, not a hole */
            RECT r;
            r.left = b->dx; r.top = top; r.right = b->dx + b->dw; r.bottom = top + b->dh;
            FillRect(hdc, &r, (HBRUSH)GetStockObject(LTGRAY_BRUSH));
        }
        break;
    }
}

static void paint_view(HWND hwnd)
{
    PAINTSTRUCT ps;
    HDC hdc;
    HPALETTE oldPal = 0;
    HFONT oldFont;
    int i;

    hdc = BeginPaint(hwnd, &ps);
    if (g_pal) {
        oldPal = SelectPalette(hdc, g_pal, FALSE);
        RealizePalette(hdc);
    }
    SetStretchBltMode(hdc, COLORONCOLOR);
    SetBkMode(hdc, TRANSPARENT);
    oldFont = (HFONT)SelectObject(hdc, style_font(B_PARA));
    for (i = 0; i < g_nblk; i++) {
        BLOCK *b = &g_blk[i];
        long top = b->y - g_scrollY;
        if (top + b->h <= (long)ps.rcPaint.top) continue;
        if (top >= (long)ps.rcPaint.bottom) break;             /* the list is in document order */
        paint_block(hdc, b, (int)top, &ps.rcPaint);
    }
    SelectObject(hdc, oldFont);
    if (oldPal) SelectPalette(hdc, oldPal, TRUE);
    EndPaint(hwnd, &ps);
}

/* A frame does not go through WM_PAINT: it is the same rectangle every time, it is opaque, and
   invalidating it would repaint the text around it as well. */
static void blit_video(BLOCK *b)
{
    HDC hdc;
    HPALETTE oldPal = 0;
    int top = (int)(b->y - g_scrollY);
    if (!b->fb || b->dw <= 0) return;
    hdc = GetDC(hView);
    if (!hdc) return;
    if (g_pal) { oldPal = SelectPalette(hdc, g_pal, TRUE); RealizePalette(hdc); }
    SetStretchBltMode(hdc, COLORONCOLOR);
    draw_pic(hdc, b->fb, b->w, b->ih, b->dx, top, b->dw, b->dh, NULL);
    if (oldPal) SelectPalette(hdc, oldPal, TRUE);
    ReleaseDC(hView, hdc);
}

static void tick_videos(void)
{
    DWORD now = GetTickCount();
    int i;
    for (i = 0; i < g_nblk; i++) {
        BLOCK *b = &g_blk[i];
        DWORD step;
        if (b->type != B_VIDEO || !b->fb || !on_screen(b)) continue;
        step = 1000L / (b->fps ? b->fps : 12);
        if (!step) step = 1;
        /* One frame per tick at most. A clip that has fallen behind (the machine was busy
           fetching, or the window was buried) catches up by dropping its schedule forward rather
           than by decoding a burst of frames nobody would see. */
        if ((long)(now - b->due) < 0) continue;
        b->due += step;
        if ((long)(now - b->due) > (long)(4 * step)) b->due = now + step;
        video_frame(b);
        blit_video(b);
    }
}

/* ------------------------------------------------------------------ scrolling */
static void scroll_to(long y)
{
    long span = g_docH - g_viewH, dy;
    if (span < 0) span = 0;
    if (y > span) y = span;
    if (y < 0) y = 0;
    dy = g_scrollY - y;
    if (!dy) return;
    g_scrollY = y;
    SetScrollPos(hView, SB_VERT, (int)(g_scrollY >> g_scrollShift), TRUE);
    if (dy > (long)g_viewH || dy < -(long)g_viewH) InvalidateRect(hView, NULL, TRUE);
    else ScrollWindow(hView, 0, (int)dy, NULL, NULL);
    update_playing();
    UpdateWindow(hView);
}

static void on_vscroll(int code, int pos)
{
    long y = g_scrollY;
    switch (code) {
    case SB_LINEUP:        y -= g_lineH; break;
    case SB_LINEDOWN:      y += g_lineH; break;
    case SB_PAGEUP:        y -= (g_viewH > 2 * g_lineH) ? g_viewH - g_lineH : g_lineH; break;
    case SB_PAGEDOWN:      y += (g_viewH > 2 * g_lineH) ? g_viewH - g_lineH : g_lineH; break;
    case SB_TOP:           y = 0; break;
    case SB_BOTTOM:        y = g_docH; break;
    case SB_THUMBPOSITION:
    case SB_THUMBTRACK:    y = (long)pos << g_scrollShift; break;
    default: return;                                  /* SB_ENDSCROLL and anything else */
    }
    scroll_to(y);
}

/* ------------------------------------------------------------------ the view window */
LRESULT CALLBACK __export ViewProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_PAINT:
        paint_view(hwnd);
        return 0;
    case WM_ERASEBKGND: {
        /* Painted here rather than by the class brush so that a scroll's newly exposed strip is
           cleared in one go and the blocks draw over it.

           The brush has to be a real brush. (HBRUSH)(COLOR_WINDOW + 1) is a WNDCLASS convention --
           Windows resolves it when IT erases -- and FillRect under Win16 takes it at face value,
           fails on the bogus handle, and erases nothing. Every scroll then drew the page over
           whatever was already on the glass: paragraphs on top of paragraphs, text across
           photographs, the heading still sitting there at the foot of the document. */
        RECT r;
        HBRUSH br = CreateSolidBrush(GetSysColor(COLOR_WINDOW));
        GetClientRect(hwnd, &r);
        if (br) { FillRect((HDC)wParam, &r, br); DeleteObject(br); }
        else FillRect((HDC)wParam, &r, (HBRUSH)GetStockObject(WHITE_BRUSH));
        return 1;
    }
    case WM_VSCROLL:
        /* Win16 packs this the way LCD.EXE's comment describes: the code is the whole of wParam
           and the position is the LOW word of lParam. PVMON sends SB_LINEUP/SB_LINEDOWN one per
           line of the gesture and SB_ENDSCROLL at the end of it, so a flick arrives as a stream of
           these and the momentum comes for free. */
        on_vscroll((int)wParam, (int)LOWORD(lParam));
        return 0;
    case WM_KEYDOWN:
        switch (wParam) {
        case VK_UP:    on_vscroll(SB_LINEUP, 0); break;
        case VK_DOWN:  on_vscroll(SB_LINEDOWN, 0); break;
        case VK_PRIOR: on_vscroll(SB_PAGEUP, 0); break;
        case VK_NEXT:  on_vscroll(SB_PAGEDOWN, 0); break;
        case VK_HOME:  on_vscroll(SB_TOP, 0); break;
        case VK_END:   on_vscroll(SB_BOTTOM, 0); break;
        }
        return 0;
    case WM_SIZE: {
        RECT r;
        GetClientRect(hwnd, &r);
        g_viewW = r.right;
        g_viewH = r.bottom;
        if (g_nblk) { measure(); update_playing(); InvalidateRect(hwnd, NULL, TRUE); }
        return 0;
    }
    case WM_LBUTTONDOWN:
        SetFocus(hwnd);
        return 0;
    case WM_GETDLGCODE:
        /* IsDialogMessage in the message loop otherwise takes the arrow keys for moving between
           controls, and the one window on this desktop where Down means "down the page" would be
           the one where it did not. */
        return DLGC_WANTARROWS;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

/* ------------------------------------------------------------------ the reply */
static void take_body(const char *p, unsigned len)
{
    if (!len) return;
    if (!buf_reserve(g_len + len)) return;      /* out of room: the rest is dropped, and parse says so */
    hmove(g_buf + g_len, (const BYTE __huge *)(const BYTE FAR *)p, len);
    g_len += len;
}
static unsigned take_header(const char *buf, unsigned len)
{
    unsigned i, k;
    for (i = 0; i < len; i++) {
        if (hdrN < 600) hdr[hdrN++] = buf[i];
        else { inBody = TRUE; return i; }
        if (hdrN >= 4 && hdr[hdrN - 4] == '\r' && hdr[hdrN - 3] == '\n'
                      && hdr[hdrN - 2] == '\r' && hdr[hdrN - 1] == '\n') inBody = TRUE;
        else if (hdrN >= 2 && hdr[hdrN - 2] == '\n' && hdr[hdrN - 1] == '\n') inBody = TRUE;
        if (inBody) {
            char FAR *q;
            hdr[hdrN] = 0;
            for (k = 0; k < sizeof(statusLine) - 1 && hdr[k] && hdr[k] != '\r' && hdr[k] != '\n'; k++)
                statusLine[k] = hdr[k];
            statusLine[k] = 0;
            status(statusLine);
            /* Content-Length, if the host gave one, so the buffer is allocated once at the right
               size instead of being grown and copied four times on the way to a few megabytes. */
            for (q = (char FAR *)hdr; (unsigned)(q - (char FAR *)hdr) + 15 <= hdrN; q++) {
                if ((*q == 'C' || *q == 'c') && !_fstrnicmp(q, (const char FAR *)"content-length:", 15)) {
                    char FAR *v = q + 15;
                    DWORD n = 0;
                    while (*v == ' ') v++;
                    while (*v >= '0' && *v <= '9') { n = n * 10 + (DWORD)(*v - '0'); v++; }
                    if (n && n <= BUF_MAX) { g_expect = n; buf_reserve(n); }
                    break;
                }
            }
            return i + 1;
        }
    }
    return len;
}
static void consume(const char *buf, unsigned len)
{
    unsigned at = 0;
    if (!inBody) at = take_header(buf, len);
    if (inBody && at < len) take_body(buf + at, len - at);
}

static void pv_close(void)
{
    if (!pvOpen) return;
    pvOpen = FALSE;
    wr(R_PV_CMD, PVCMD_CLOSE);
}
static void drop(HWND hwnd)
{
    if (pvTimer) { KillTimer(hwnd, IDT_PUMP); pvTimer = FALSE; }
    pv_close();
    if (hGet) EnableWindow(hGet, TRUE);
}

/* Everything arrived: parse it, lay it out, realise the palette and show the top of the page. */
static void present(void)
{
    const char *err = parse_page();
    if (err) {
        free_page();
        status(err);
        InvalidateRect(hView, NULL, TRUE);
        return;
    }
    g_scrollY = 0;
    measure();
    update_playing();
    if (g_pal) {
        HDC hdc = GetDC(hView);
        if (hdc) {
            HPALETTE old = SelectPalette(hdc, g_pal, FALSE);
            RealizePalette(hdc);
            SelectPalette(hdc, old, TRUE);
            ReleaseDC(hView, hdc);
        }
    }
    InvalidateRect(hView, NULL, TRUE);
    /* Nothing. The status line is for what is happening (fetching, how much has arrived) and for
       what went wrong; a page that loaded has nothing to say about itself, and "22 blocks, 2152K"
       was a note to myself while the format was being written. */
    status("");
}

#define PV_MAX_BLOCKS 32
static void pv_pump(HWND hwnd)
{
    unsigned st, got, off, chunk;
    int blocks = 0;
    char msg[80];

    wr(R_PV_SEL, PV_HANDLE);
    for (;;) {
        st = rd(R_PV_STATE);
        if (st == PVST_FETCHING) return;
        if (st != PVST_DATA) break;
        if (++blocks > PV_MAX_BLOCKS) return;
        wr(R_PV_ARG, PV_BLOCK);
        wr(R_PV_CMD, PVCMD_READ);
        got = rd(R_PV_RESULT);
        if (got == 0 || got > PV_BLOCK) return;
        for (off = 0; off < got; off += chunk) {
            chunk = got - off;
            if (chunk > PV_CHUNK) chunk = PV_CHUNK;
            drain(blk, chunk);
            consume(blk, chunk);
        }
        if (g_expect) wsprintf(msg, "%luK of %luK...", (DWORD)(g_len / 1024L), (DWORD)(g_expect / 1024L));
        else wsprintf(msg, "%luK...", (DWORD)(g_len / 1024L));
        status(msg);
    }
    drop(hwnd);
    if (st == PVST_ERROR) status("The host could not fetch that.");
    else if (g_len == 0) status("The host sent nothing.");
    else present();
}

static void fetch_go(HWND hwnd, const char *want)
{
    char raw_url[URL_MAX + 8], url[URL_MAX + 8], msg[URL_MAX + 40];
    unsigned len, res, st;

    drop(hwnd);
    free_page();
    InvalidateRect(hView, NULL, TRUE);
    wr(R_PV_SEL, PV_HANDLE);
    if (want) lstrcpy(raw_url, want);
    else GetWindowText(hUrl, raw_url, sizeof(raw_url));
    /* A target that starts with "/" is the site's own, and the host resolves its origin: this
       machine has no idea what it is being served from, and must not -- the same disk image is a
       preview deployment and production. */
    if (raw_url[0] == '/') { lstrcpy(url, raw_url); len = lstrlen(url); }
    else len = clean_url(raw_url, url);
    if (!len) { status("Type an address."); return; }
    g_len = 0;
    hdrN = 0;
    inBody = FALSE;
    g_expect = 0;
    statusLine[0] = 0;
    if (!buf_reserve(BUF_START)) { status("Out of memory."); return; }

    dbg("page: open");
    dbg(url);
    send_url(url, len);
    wr(R_PV_ARG, len);
    wr(R_PV_CMD, PVCMD_OPEN);
    res = rd(R_PV_RESULT);
    if (res != 0) {
        wsprintf(msg, "The host refused that address (%u).", res);
        status(msg);
        return;
    }
    pvOpen = TRUE;
    st = rd(R_PV_STATE);
    if (st == PVST_IDLE) {
        status("No paravirtual socket on this host.");
        drop(hwnd);
        return;
    }
    wsprintf(msg, "Fetching %s...", (LPSTR)url);
    status(msg);
    if (hGet) EnableWindow(hGet, FALSE);
    if (SetTimer(hwnd, IDT_PUMP, PUMP_MS, NULL)) pvTimer = TRUE;
    else { status("No timer available."); drop(hwnd); }
}

/* ------------------------------------------------------------------ the frame window */
#ifdef SHELL_ABOUT
/* Windows 3.1 has no tab control -- that arrived with the 95 common controls -- so the strip is
   drawn. Two tabs across the width: the selected one is the window's own colour with its bottom
   edge open, the other is the face grey, and one rule runs under the strip and stops at the
   selected tab. It is four FillRects and a few lines, and it behaves the way the reader expects:
   a click picks a tab, and the tab loads a page. */
static void tab_rect(HWND hwnd, int i, RECT *out)
{
    RECT r;
    int w;
    GetClientRect(hwnd, &r);
    w = r.right / NTABS;
    out->left = i * w;
    out->right = (i == NTABS - 1) ? r.right : (i + 1) * w;
    out->top = g_wideHost ? g_noteH : 0;
    out->bottom = out->top + TAB_H;
}
static void draw_tabs(HWND hwnd, HDC hdc)
{
    RECT r, t;
    HPEN dark = CreatePen(PS_SOLID, 1, GetSysColor(COLOR_WINDOWFRAME));
    HPEN oldPen = (HPEN)SelectObject(hdc, dark);
    HFONT oldFont = (HFONT)SelectObject(hdc, (HFONT)GetStockObject(SYSTEM_FONT));
    int i;
    GetClientRect(hwnd, &r);
    SetBkMode(hdc, TRANSPARENT);
    for (i = 0; i < NTABS; i++) {
        int on = (i == g_tab);
        tab_rect(hwnd, i, &t);
        {   /* the tab body */
            HBRUSH b = CreateSolidBrush(GetSysColor(on ? COLOR_WINDOW : COLOR_BTNFACE));
            FillRect(hdc, &t, b);
            DeleteObject(b);
        }
        MoveTo(hdc, t.left, t.bottom - 1); LineTo(hdc, t.left, t.top);      /* left, top, right */
        LineTo(hdc, t.right - 1, t.top);
        LineTo(hdc, t.right - 1, t.bottom - 1);
        if (!on) { MoveTo(hdc, t.left, t.bottom - 1); LineTo(hdc, t.right, t.bottom - 1); }
        SetTextColor(hdc, GetSysColor(on ? COLOR_WINDOWTEXT : COLOR_BTNTEXT));
        DrawText(hdc, tabName[i], -1, &t, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }
    SelectObject(hdc, oldFont);
    SelectObject(hdc, oldPen);
    DeleteObject(dark);
}
static void load_tab(HWND hwnd, int i)
{
    if (i < 0 || i >= NTABS) return;
    g_tab = i;
    InvalidateRect(hwnd, NULL, TRUE);
    fetch_go(hwnd, tabUrl[i]);
}
#endif

static void layout(HWND hwnd)
{
    RECT r;
    int w, y;
    GetClientRect(hwnd, &r);
    w = r.right - 2 * MARGIN;
    if (w < 64) w = 64;
#ifdef SHELL_ABOUT
    {
        int bottom = r.bottom - MARGIN - ROW;              /* the row with Close on it */
        y = (g_wideHost ? g_noteH : 0) + TAB_H;
        if (hNote) MoveWindow(hNote, MARGIN, 4, w, g_noteH - 8, TRUE);
        MoveWindow(hStatus, MARGIN, bottom - 18, w, 16, TRUE);
        MoveWindow(hHide, MARGIN, bottom, w - 74, ROW, TRUE);
        MoveWindow(hClose, r.right - MARGIN - 64, bottom, 64, ROW, TRUE);
        MoveWindow(hView, 0, y, r.right, bottom - 18 - y > 0 ? bottom - 18 - y : 1, TRUE);
        return;
    }
#else
    y = MARGIN;
    MoveWindow(hUrl, MARGIN, y, w, ROW, TRUE);            y += ROW + GAP;
    MoveWindow(hGet, MARGIN, y, 64, ROW, TRUE);
    MoveWindow(hClose, r.right - MARGIN - 64, y, 64, ROW, TRUE);
    y += ROW + GAP;
    MoveWindow(hStatus, MARGIN, y, w, 16, TRUE);          y += 16 + GAP;
    MoveWindow(hView, 0, y, r.right, r.bottom - y > 0 ? r.bottom - y : 1, TRUE);
#endif
}

LRESULT CALLBACK __export WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_CREATE: {
        HINSTANCE inst = ((LPCREATESTRUCT)lParam)->hInstance;
        HFONT f = (HFONT)GetStockObject(SYSTEM_FONT);
        HWND c;
        hMain = hwnd;
#ifdef SHELL_ABOUT
        hUrl = 0; hGet = 0;
        if (g_wideHost)
            hNote = CreateWindow("static",
                "On a desktop this is Windows 3.11 with a few modern affordances. The real magic "
                "is on a phone. Open \"Phone\" in Program Manager to see that here, or open this "
                "site on your own phone.",
                WS_CHILD | WS_VISIBLE | SS_LEFT, 0, 0, 10, 10, hwnd, (HMENU)-1, inst, NULL);
        hHide = CreateWindow("button", "&Don't show this again",
                             WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
                             0, 0, 10, 10, hwnd, (HMENU)ID_HIDE, inst, NULL);
        SendMessage(hHide, BM_SETCHECK, 1, 0L);
        if (hNote) {                       /* however many lines it takes at this width */
            RECT rc;
            HDC hdc = GetDC(hwnd);
            HFONT old = (HFONT)SelectObject(hdc, f);
            char note[400];      /* the note is measured by reading it back: room to grow */
            GetClientRect(hwnd, &rc);
            rc.left = 0; rc.top = 0; rc.right = rc.right - 2 * MARGIN; rc.bottom = 1;
            GetWindowText(hNote, note, sizeof(note));
            DrawText(hdc, note, -1, &rc, DT_LEFT | DT_WORDBREAK | DT_CALCRECT | DT_NOPREFIX);
            SelectObject(hdc, old);
            ReleaseDC(hwnd, hdc);
            g_noteH = rc.bottom + 10;
        }
#else
        hUrl = CreateWindow("edit", "http://",
                            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL,
                            0, 0, 10, 10, hwnd, (HMENU)ID_URL, inst, NULL);
        hGet = CreateWindow("button", "&Get", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                            0, 0, 10, 10, hwnd, (HMENU)ID_GET, inst, NULL);
#endif
        hClose = CreateWindow("button", "&Close", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                              0, 0, 10, 10, hwnd, (HMENU)ID_CLOSE, inst, NULL);
        hStatus = CreateWindow("static", "Ready.", WS_CHILD | WS_VISIBLE | SS_LEFT,
                               0, 0, 10, 10, hwnd, (HMENU)ID_STATUS, inst, NULL);
        /* WS_VSCROLL is not decoration: PVMON's scroll_target() looks for the first visible child
           with a scroll bar, and that is how a finger on the host reaches this window. */
        hView = CreateWindow(szView, "",
                             WS_CHILD | WS_VISIBLE | WS_BORDER | WS_VSCROLL | WS_TABSTOP,
                             0, 0, 10, 10, hwnd, (HMENU)ID_VIEW, inst, NULL);
#ifdef SHELL_ABOUT
        if (!hView || !hClose || !hHide) return -1;      /* no address bar in this shell */
#else
        if (!hUrl || !hView) return -1;
#endif
        for (c = GetWindow(hwnd, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT))
            if (c != hView) SendMessage(c, WM_SETFONT, (WPARAM)f, 0L);
        style_defaults();
        style_fonts();
        g_txth = GlobalAlloc(GMEM_MOVEABLE, (DWORD)TXT_MAX + 2);
        g_txt = g_txth ? (char FAR *)GlobalLock(g_txth) : NULL;
        blkh = GlobalAlloc(GMEM_MOVEABLE, (DWORD)PV_CHUNK);
        blk = blkh ? (char FAR *)GlobalLock(blkh) : NULL;
        g_bandh = GlobalAlloc(GMEM_MOVEABLE, (DWORD)BAND_BYTES);
        g_band = g_bandh ? (BYTE FAR *)GlobalLock(g_bandh) : NULL;
        if (!g_txt || !blk || !g_band) {
            MessageBox(hwnd, "Out of memory.", szTitle, MB_OK | MB_ICONSTOP);
            return -1;
        }
        g_dibRgb.h.biSize = g_dibPal.h.biSize = sizeof(BITMAPINFOHEADER);
        g_dibRgb.h.biPlanes = g_dibPal.h.biPlanes = 1;
        g_dibRgb.h.biBitCount = g_dibPal.h.biBitCount = 8;
        g_dibRgb.h.biCompression = g_dibPal.h.biCompression = BI_RGB;
        g_dibRgb.h.biClrUsed = g_dibPal.h.biClrUsed = 256;
        g_dibRgb.h.biClrImportant = g_dibPal.h.biClrImportant = 256;
        if (GetProfileInt(szIni, "PageDibPal", 0)) g_usage = DIB_PAL_COLORS;
        return 0;
    }
    case WM_SIZE:
        layout(hwnd);
        return 0;
#ifdef SHELL_ABOUT
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);
        draw_tabs(hwnd, hdc);
        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_LBUTTONDOWN: {
        POINT pt;
        RECT t;
        int i;
        pt.x = LOWORD(lParam); pt.y = HIWORD(lParam);
        for (i = 0; i < NTABS; i++) {
            tab_rect(hwnd, i, &t);
            if (PtInRect(&t, pt)) { if (i != g_tab) load_tab(hwnd, i); return 0; }
        }
        return 0;
    }
    case WM_CTLCOLOR:
        if (HIWORD(lParam) == CTLCOLOR_STATIC || HIWORD(lParam) == CTLCOLOR_BTN) {
            SetBkColor((HDC)wParam, GetSysColor(COLOR_WINDOW));
            SetTextColor((HDC)wParam, GetSysColor(COLOR_WINDOWTEXT));
            return (LRESULT)GetStockObject(WHITE_BRUSH);
        }
        break;
    case WM_SETFOCUS:
        SetFocus(hView);
        return 0;
#else
    case WM_SETFOCUS:
        SetFocus(hUrl);
        return 0;
#endif
    case WM_TIMER:
        if (wParam == IDT_PUMP) {
            if (!pumping) { pumping = TRUE; pv_pump(hwnd); pumping = FALSE; }
        } else if (wParam == IDT_FRAME) {
            tick_videos();
        }
        return 0;
    /* The palette is the program's, and Windows hands it out to whoever is in front. Both messages
       go to the top-level window; the view is where it has to be realised. */
    case WM_QUERYNEWPALETTE: {
        HDC hdc;
        UINT n = 0;
        if (!g_pal) return 0;
        hdc = GetDC(hView);
        if (hdc) {
            HPALETTE old = SelectPalette(hdc, g_pal, FALSE);
            n = RealizePalette(hdc);
            SelectPalette(hdc, old, TRUE);
            ReleaseDC(hView, hdc);
        }
        if (n) InvalidateRect(hView, NULL, TRUE);
        return n != 0;
    }
    case WM_PALETTECHANGED:
        if (!g_pal || (HWND)wParam == hwnd) return 0;
        {
            HDC hdc = GetDC(hView);
            if (hdc) {
                HPALETTE old = SelectPalette(hdc, g_pal, TRUE);
                if (RealizePalette(hdc)) InvalidateRect(hView, NULL, TRUE);
                SelectPalette(hdc, old, TRUE);
                ReleaseDC(hView, hdc);
            }
        }
        return 0;
    case WM_COMMAND:
        if (wParam == ID_GET) fetch_go(hwnd, NULL);
        else if (wParam == ID_CLOSE) DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
#ifdef SHELL_ABOUT
        WriteProfileString(szIni, szIniKey,
                           (hHide && SendMessage(hHide, BM_GETCHECK, 0, 0L)) ? "1" : "0");
#endif
        drop(hwnd);
        free_page();
        buf_free();
        if (g_txth) { GlobalUnlock(g_txth); GlobalFree(g_txth); g_txth = 0; g_txt = NULL; }
        if (blkh)   { GlobalUnlock(blkh);   GlobalFree(blkh);   blkh = 0;   blk = NULL; }
        if (g_bandh){ GlobalUnlock(g_bandh);GlobalFree(g_bandh);g_bandh = 0;g_band = NULL; }
        style_free();
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

int PASCAL WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show)
{
    WNDCLASS wc;
    HWND hwnd;
    MSG m;

#ifdef SHELL_ABOUT
    /* First run only, the contract ABOUT.EXE has always had: WIN.INI [windows] run= starts this
       at every Windows start and it leaves at once when [PVMon] AboutShown is set. Any argument
       overrides that -- "/show" from the Program Manager item, and "/how" from the host when the
       URL asked for a particular tab (/about#how-to-use). */
    {
        const char *p = cmd;
        int forced = 0;
        while (*p == ' ') p++;
        if (*p == '/' || *p == '-') {
            char c = p[1] >= 'A' && p[1] <= 'Z' ? (char)(p[1] + 32) : p[1];
            forced = 1;
            if (c == 'h') g_tab = 1;                      /* /how */
            else if (c == 'w') g_tab = 0;                 /* /what */
        }
        if (!forced && GetProfileInt(szIni, szIniKey, 0)) return 0;
    }
#endif
#ifdef SHELL_ABOUT
    g_wideHost = host_wide();
#endif
    if (!prev) {
        wc.style = 0; wc.lpfnWndProc = WndProc; wc.cbClsExtra = 0; wc.cbWndExtra = 0;
        wc.hInstance = inst; wc.hIcon = LoadIcon(inst, MAKEINTRESOURCE(1));
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
        wc.lpszMenuName = NULL; wc.lpszClassName = szClass;
        if (!RegisterClass(&wc)) return 0;
        wc.style = CS_HREDRAW;      /* a narrower column remeasures; a shorter one only rescrolls */
        wc.lpfnWndProc = ViewProc;
        wc.hIcon = NULL;
        wc.hbrBackground = NULL;    /* WM_ERASEBKGND does it, so a scroll clears in one fill */
        wc.lpszClassName = szView;
        if (!RegisterClass(&wc)) return 0;
    }
#ifdef SHELL_ABOUT
    /* On a phone: the column's width, and no thick frame, so PVHOOK's geometry invariant leaves
       the window at its natural size instead of reflowing it. On a desktop there is room, and no
       reason to read a note about the machine through a slot 352 pixels wide: an ordinary
       resizable window, two thirds of the screen, up to a point. The text column inside is capped
       and centred either way (COL_MAX), so a wider window gives wider margins rather than lines
       too long to read. */
    if (g_wideHost) {
        int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
        int w = sw * 2 / 3, h = sh * 4 / 5;
        if (w < 480) w = 480;
        if (w > 720) w = 720;
        if (h < 420) h = 420;
        if (h > 760) h = 760;
        hwnd = CreateWindow(szClass, szTitle, WS_OVERLAPPEDWINDOW,
                            (sw - w) / 2, (sh - h) / 2, w, h, NULL, NULL, inst, NULL);
    } else {
        hwnd = CreateWindow(szClass, szTitle, WS_POPUP | WS_CAPTION | WS_SYSMENU,
                            0, 0, 352, 560, NULL, NULL, inst, NULL);
    }
#else
    hwnd = CreateWindow(szClass, szTitle, WS_OVERLAPPEDWINDOW,
                        CW_USEDEFAULT, CW_USEDEFAULT, 352, 560, NULL, NULL, inst, NULL);
#endif
    if (!hwnd) return 0;
    ShowWindow(hwnd, show ? show : SW_SHOW);
    UpdateWindow(hwnd);
#ifdef SHELL_ABOUT
    load_tab(hwnd, g_tab);
#else
    /* An address on the command line is fetched as soon as the window is up, the way FETCH.EXE
       does it: that is what makes this reachable from a Program Manager item and from the host's
       deep links. */
    if (cmd && cmd[0]) {
        SetWindowText(hUrl, cmd);
        PostMessage(hwnd, WM_COMMAND, ID_GET, 0L);
    }
#endif
    while (GetMessage(&m, NULL, 0, 0)) {
        if (!IsDialogMessage(hwnd, &m)) { TranslateMessage(&m); DispatchMessage(&m); }
    }
    return 0;
}
