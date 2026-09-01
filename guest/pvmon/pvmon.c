/* PVMON.EXE - companion utility for the responsive-wfw311 paravirtual display.
 *
 * Phase 2.5 ("restart-based resize"): polls the adapter's GENERATION register; when the
 * host has asked for a mode that differs from the current screen size, exits Windows to
 * DOS. AUTOEXEC.BAT runs WIN in a loop, so Windows comes straight back up, and PVDISP.DRV
 * reads HOST_XRES/YRES at Enable time, so it comes back at the new size.
 *
 * ExitWindows(EW_RESTARTWINDOWS) was tried first and does restart Windows at the new mode,
 * but the restarted instance never paints: no writes reach video memory at all, not even
 * for Ctrl+Esc, while the same mode reached by a fresh start paints correctly. The screen
 * appears to stay "owned" by something else across the in-place restart (VDD / USER repaint
 * suppression). Exiting to DOS and re-running WIN reproduces the fresh-start path exactly.
 * Phase 3 replaces this with a live re-mode through a driver escape; the polling loop stays.
 *
 * Runs hidden, started from WIN.INI [windows] load=PVMON.EXE.
 * Build: guest/pvmon/build.sh  (Open Watcom via tools/watcom.sh)
 */
#include <windows.h>
#include <toolhelp.h>
#include <conio.h>

#define DISPI_INDEX 0x1CE
#define DISPI_DATA  0x1CF
#define R_HOST_XRES 0x10
#define R_HOST_YRES 0x11
#define R_HOST_DPI  0x12
#define R_STATUS    0x13
#define R_DEBUG     0x16
#define R_GEN       0x17

/* Private display-driver escapes (see guest/driver/port/SRC/CONTROL.ASM) */
#define PV_QUERY_MODE 0x4A00   /* out: cur w,h, host w,h, dpi, generation */
#define PV_REMODE     0x4A01   /* re-mode the adapter live; 1 if the mode changed */

#define POLL_MS       250
#define SETTLE_POLLS  3      /* host request must be stable this many polls before acting */
#define IDT_POLL      1
#define IDT_ARRANGE   2
#define ARRANGE_MS    3000   /* the shell starts after us (WIN.INI load=), so wait for it */

static unsigned rd(unsigned idx) { outpw(DISPI_INDEX, idx); return inpw(DISPI_DATA); }
static void wr(unsigned idx, unsigned v) { outpw(DISPI_INDEX, idx); outpw(DISPI_DATA, v); }
static void dbg(const char *s) { while (*s) wr(R_DEBUG, (unsigned char)*s++); wr(R_DEBUG, 10); }
static void dbgnum(const char *s, unsigned a, unsigned b)
{
    char buf[64]; wsprintf(buf, "%s %ux%u", (LPSTR)s, a, b); dbg(buf);
}

/* Fit the shell to the current screen. Program Manager restores the window rectangles it
   saved in PROGMAN.INI, which were sized for whatever resolution it last ran at, so after a
   resize its main window and group windows are the wrong size and icon captions collide.
   This is SPEC 2.3's window wrangling, tier 1 of the reflow stretch goal. */
/* Find a menu command by its text, so we do not hard-code Program Manager's private menu
   IDs. Returns 0 if not found. Searches one level of submenus, which is where it lives. */
static UINT find_menu_command(HWND hwnd, const char *want)
{
    HMENU bar = GetMenu(hwnd);
    char buf[64];
    int i, j, nsub, nitem;
    if (!bar) return 0;
    nsub = GetMenuItemCount(bar);
    for (i = 0; i < nsub; i++) {
        HMENU sub = GetSubMenu(bar, i);
        if (!sub) continue;
        nitem = GetMenuItemCount(sub);
        for (j = 0; j < nitem; j++) {
            if (GetMenuString(sub, j, buf, sizeof(buf), MF_BYPOSITION) > 0) {
                char *p = buf;
                while (*p) {                      /* menu text carries '&' accelerators */
                    const char *a = p, *b = want;
                    while (*b && *a && ((*a == '&') ? (a++, 1) : (*a++ == *b++)));
                    if (!*b) return GetMenuItemID(sub, j);
                    p++;
                }
            }
        }
    }
    return 0;
}

static void arrange_shell(void)
{
    HWND pm, mdi, active;
    UINT idArrange;
    int cx = GetSystemMetrics(SM_CXSCREEN), cy = GetSystemMetrics(SM_CYSCREEN);
    pm = FindWindow("Progman", NULL);
    if (!pm) return;
    SetWindowPos(pm, NULL, 0, 0, cx, cy, SWP_NOZORDER | SWP_NOACTIVATE);
    mdi = GetWindow(pm, GW_CHILD);               /* Program Manager's MDI client */
    if (!mdi) return;
    active = (HWND)(WORD)SendMessage(mdi, WM_MDIGETACTIVE, 0, 0L);
    if (active) SendMessage(mdi, WM_MDIMAXIMIZE, (WPARAM)active, 0L);
    SendMessage(mdi, WM_MDIICONARRANGE, 0, 0L);
    /* Re-grid the program items inside the group: their positions come from the .GRP files
       and were saved for the old resolution, so captions collide until Program Manager
       re-arranges them itself. */
    idArrange = find_menu_command(pm, "Arrange");
    if (idArrange) PostMessage(pm, WM_COMMAND, idArrange, 0L);
    dbgnum("pvmon: arranged shell to", cx, cy);
    if (!idArrange) dbg("pvmon: no Arrange command found");
}

static unsigned g_lastGen;
static unsigned g_wantW, g_wantH, g_stable;
static BOOL g_restarting;
static BOOL g_live;            /* WIN.INI [PVMon] Live=1 -> try the Phase 3 live re-mode */
static unsigned g_doneW, g_doneH;  /* mode the live path has already applied */

/* ------------------------------------------------------------------ Phase 3 step 3b
 * After a live re-mode the driver and GDI's screen surface know the new size, but USER
 * still reports the old one, so the shell lays itself out for a screen that is no longer
 * there. USER keeps the screen size in its system-metrics array and in the desktop
 * window's rectangles, both in USER's own data segment.
 *
 * Nothing here hard-codes a Windows build. USER's data segment is found through
 * TOOLHELP.DLL, the metrics array is found by matching a run of entries against what
 * GetSystemMetrics returns, and the desktop rectangle is found by matching 0,0,cx,cy
 * inside the desktop window's structure, which in Win16 is addressed by the HWND value
 * itself as an offset into that segment. Every location is verified against the live
 * values before it is written to, and the whole thing simply switches itself off if any
 * step fails.
 */
#define PVFP(sel, off) ((WORD __far *)(((DWORD)(WORD)(sel) << 16) | (WORD)(off)))
#define MET_RUN 12                 /* metrics matched in a row to accept a candidate */

static WORD g_userDS;              /* USER's DGROUP selector */
static WORD g_gdiDS;               /* GDI's DGROUP selector */
static WORD g_offCaps;             /* offset of the screen's GDIINFO within it */
static WORD g_offSysMet;           /* offset of rgwSysMet within it */
static WORD g_offDeskRc;           /* offset of rcWindow within the desktop WND */
static BOOL g_patchReady;

typedef HMODULE (WINAPI *PFNMODULEFINDNAME)(LPMODULEENTRY, LPCSTR);
typedef BOOL (WINAPI *PFNGLOBALWALK)(LPGLOBALENTRY, WORD);

static WORD find_dgroup(LPCSTR module)
{
    HINSTANCE th;
    PFNMODULEFINDNAME pModuleFindName;
    PFNGLOBALWALK pGlobalFirst, pGlobalNext;
    MODULEENTRY me;
    GLOBALENTRY ge;
    HMODULE hUser;
    WORD sel = 0;

    th = LoadLibrary("TOOLHELP.DLL");
    if (th < HINSTANCE_ERROR) return 0;
    pModuleFindName = (PFNMODULEFINDNAME)GetProcAddress(th, "ModuleFindName");
    pGlobalFirst    = (PFNGLOBALWALK)GetProcAddress(th, "GlobalFirst");
    pGlobalNext     = (PFNGLOBALWALK)GetProcAddress(th, "GlobalNext");
    if (pModuleFindName && pGlobalFirst && pGlobalNext) {
        me.dwSize = sizeof(me);
        hUser = pModuleFindName(&me, module);
        if (hUser) {
            ge.dwSize = sizeof(ge);
            if (pGlobalFirst(&ge, GLOBAL_ALL)) {
                do {
                    if (ge.hOwner == hUser && ge.wType == GT_DGROUP) {
                        sel = (WORD)ge.hBlock;    /* DGROUP is fixed: handle is the selector */
                        break;
                    }
                    ge.dwSize = sizeof(ge);
                } while (pGlobalNext(&ge, GLOBAL_ALL));
            }
        }
    }
    FreeLibrary(th);
    return sel;
}

/* rgwSysMet[i] is what GetSystemMetrics(i) returns, so a run of them is a strong signature. */
static BOOL find_sysmet(WORD sel, WORD limit)
{
    WORD want[MET_RUN];
    WORD off;
    int i, hits = 0;
    for (i = 0; i < MET_RUN; i++) want[i] = (WORD)GetSystemMetrics(i);
    for (off = 0; off < limit - MET_RUN * 2; off += 2) {
        WORD __far *p = PVFP(sel, off);
        for (i = 0; i < MET_RUN; i++) if (p[i] != want[i]) break;
        if (i == MET_RUN) { if (!hits++) g_offSysMet = off; }
    }
    if (hits == 1) return TRUE;
    dbgnum("pvmon: sysmet candidates", (unsigned)hits, 0);
    return hits > 0;               /* ambiguous: take the first, but say so */
}

/* GDI keeps the GDIINFO the driver filled in at Enable, and GetDeviceCaps indexes it by byte
   offset, so a run of caps read back through the API is a signature for the block itself.
   Applications that ask GetDeviceCaps(HORZRES) read this, not USER's metrics. */
#define CAPS_RUN 12
static BOOL find_gdi_caps(WORD sel, WORD limit)
{
    HDC hdc;
    WORD want[CAPS_RUN];
    WORD off;
    int i, hits = 0;
    hdc = GetDC(NULL);
    if (!hdc) return FALSE;
    for (i = 0; i < CAPS_RUN; i++) want[i] = (WORD)GetDeviceCaps(hdc, i * 2);
    ReleaseDC(NULL, hdc);
    for (off = 0; off < limit - CAPS_RUN * 2; off += 2) {
        WORD __far *p = PVFP(sel, off);
        for (i = 0; i < CAPS_RUN; i++) if (p[i] != want[i]) break;
        if (i == CAPS_RUN) { if (!hits++) g_offCaps = off; }
    }
    if (hits != 1) dbgnum("pvmon: gdiinfo candidates", (unsigned)hits, 0);
    return hits > 0;
}

/* The desktop window's rectangle reads 0,0,cx,cy; find it inside its WND structure. */
static BOOL find_desktop_rect(WORD sel)
{
    HWND desk = GetDesktopWindow();
    RECT rc;
    WORD base = (WORD)desk, off;
    GetWindowRect(desk, &rc);
    for (off = 0; off < 96; off += 2) {
        WORD __far *p = PVFP(sel, base + off);
        if (p[0] == (WORD)rc.left && p[1] == (WORD)rc.top &&
            p[2] == (WORD)rc.right && p[3] == (WORD)rc.bottom) { g_offDeskRc = off; return TRUE; }
    }
    return FALSE;
}

static void find_user_state(void)
{
    char buf[80];
    g_userDS = find_dgroup("USER");
    if (!g_userDS) { dbg("pvmon: USER DGROUP not found, live re-mode limited"); return; }
    if (!find_sysmet(g_userDS, 0xF000)) { dbg("pvmon: sysmet not found"); return; }
    if (!find_desktop_rect(g_userDS)) { dbg("pvmon: desktop rect not found"); return; }
    g_patchReady = TRUE;
    wsprintf(buf, "pvmon: USER ds=%04X sysmet=+%04X deskrc=hwnd+%u",
             g_userDS, g_offSysMet, (unsigned)g_offDeskRc);
    dbg(buf);
    /* GDI's cached caps are a bonus: the shell reflows without them, but applications that
       ask GetDeviceCaps would otherwise keep seeing the boot-time screen. */
    g_gdiDS = find_dgroup("GDI");
    if (g_gdiDS && find_gdi_caps(g_gdiDS, 0xF000)) {
        wsprintf(buf, "pvmon: GDI ds=%04X gdiinfo=+%04X", g_gdiDS, g_offCaps);
        dbg(buf);
    } else {
        g_gdiDS = 0;
        dbg("pvmon: GDI caps not found, apps will see the old screen size");
    }
}

/* Tell USER the screen is a different size. */
static void patch_user_metrics(unsigned w, unsigned h)
{
    WORD __far *met;
    WORD __far *rc;
    unsigned oldW, oldH;
    if (!g_patchReady) return;
    met = PVFP(g_userDS, g_offSysMet);
    oldW = met[SM_CXSCREEN]; oldH = met[SM_CYSCREEN];
    met[SM_CXSCREEN] = w;
    met[SM_CYSCREEN] = h;
    /* the full-screen metrics are the screen less the caption, so keep the difference */
    if (oldW) met[SM_CXFULLSCREEN] = (WORD)(w - (oldW - met[SM_CXFULLSCREEN]));
    if (oldH) met[SM_CYFULLSCREEN] = (WORD)(h - (oldH - met[SM_CYFULLSCREEN]));
    rc = PVFP(g_userDS, (WORD)GetDesktopWindow() + g_offDeskRc);
    rc[2] = (WORD)w; rc[3] = (WORD)h;      /* rcWindow.right/bottom */
    rc[6] = (WORD)w; rc[7] = (WORD)h;      /* rcClient follows rcWindow */
    dbgnum("pvmon: patched USER to", w, h);
    if (g_gdiDS) {
        WORD __far *caps = PVFP(g_gdiDS, g_offCaps);
        WORD dpiX = caps[LOGPIXELSX / 2], dpiY = caps[LOGPIXELSY / 2];
        caps[HORZRES / 2] = (WORD)w;
        caps[VERTRES / 2] = (WORD)h;
        /* the physical size in millimetres has to follow the pixel count */
        if (dpiX) caps[HORZSIZE / 2] = (WORD)((DWORD)w * 254 / (10L * dpiX));
        if (dpiY) caps[VERTSIZE / 2] = (WORD)((DWORD)h * 254 / (10L * dpiY));
        dbgnum("pvmon: patched GDI caps to", w, h);
        {   /* read it back through the API, to prove that is the block GDI answers from */
            HDC hdc = GetDC(NULL);
            if (hdc) {
                dbgnum("pvmon: GetDeviceCaps now reports",
                       (unsigned)GetDeviceCaps(hdc, HORZRES), (unsigned)GetDeviceCaps(hdc, VERTRES));
                ReleaseDC(NULL, hdc);
            }
        }
    }
}

/* Phase 3 step 3a: ask the driver to re-mode the adapter underneath a running Windows.
   The driver updates its own surface state and GDI's copy of the screen BITMAP. GDI's
   cached device caps and USER's screen metrics are still the old size at this point, so
   the shell is expected to keep drawing at the old geometry until 3b/3c land. */
static BOOL live_remode(unsigned w, unsigned h)
{
    HDC hdc;
    int r;
    POINT pt;
    hdc = GetDC(NULL);
    if (!hdc) return FALSE;
    /* The display driver owns the cursor, and its software cursor keeps a saved copy of the
       pixels underneath. Re-moding with the cursor drawn leaves that state describing a
       screen that no longer exists, and USER's mouse path then stalls: mouse bytes stop
       being read from the controller entirely. Hide it across the change and show it after. */
    ShowCursor(FALSE);
    r = Escape(hdc, PV_REMODE, 0, NULL, NULL);
    ReleaseDC(NULL, hdc);
    dbgnum("pvmon: live re-mode returned", (unsigned)r, 0);
    if (r <= 0) { ShowCursor(TRUE); return FALSE; }
    patch_user_metrics(w, h);
    /* Put the pointer somewhere that exists on the new screen and let USER recompute its
       clip rectangle from the metrics we just patched. */
    GetCursorPos(&pt);
    if (pt.x >= (int)w) pt.x = (int)w - 1;
    if (pt.y >= (int)h) pt.y = (int)h - 1;
    ClipCursor(NULL);
    SetCursorPos(pt.x, pt.y);
    ShowCursor(TRUE);
    InvalidateRect(NULL, NULL, TRUE);        /* repaint everything we can reach */
    arrange_shell();
    return TRUE;
}

static BOOL adapter_present(void)
{
    /* DEBUG register reads back the 'PV' signature on the paravirtual adapter */
    return rd(R_DEBUG) == 0x5056;
}

static void poll(HWND hwnd)
{
    unsigned gen, w, h, curW, curH;
    if (g_restarting) return;
    gen = rd(R_GEN);
    w = rd(R_HOST_XRES) & ~7u;
    h = rd(R_HOST_YRES) & ~1u;
    if (w < 320 || h < 200) return;
    curW = GetSystemMetrics(SM_CXSCREEN);
    curH = GetSystemMetrics(SM_CYSCREEN);
    if (gen != g_lastGen) { g_lastGen = gen; g_stable = 0; g_wantW = w; g_wantH = h; }
    if (w != g_wantW || h != g_wantH) { g_wantW = w; g_wantH = h; g_stable = 0; return; }
    if (w == curW && h == curH) { g_stable = 0; return; }
    if (g_live && w == g_doneW && h == g_doneH) { g_stable = 0; return; }
    if (++g_stable < SETTLE_POLLS) return;
    dbgnum("pvmon: host wants", w, h);
    if (g_live && live_remode(w, h)) {
        /* Until 3b/3c patch USER and GDI, GetSystemMetrics still reports the old size, so
           remember what we applied instead of comparing against it, or we would keep
           re-triggering and fall through to the restart below. */
        g_doneW = w; g_doneH = h; g_stable = 0;
        return;
    }
    dbgnum("pvmon: exiting Windows from", curW, curH);
    g_restarting = TRUE;
    KillTimer(hwnd, IDT_POLL);
    if (!ExitWindows(0, 0)) {
        /* an app vetoed WM_QUERYENDSESSION: try again later */
        dbg("pvmon: exit vetoed, retrying");
        g_restarting = FALSE; g_stable = 0;
        SetTimer(hwnd, IDT_POLL, POLL_MS, NULL);
    }
}

LRESULT CALLBACK __export WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_CREATE: {
        HDC hdc; TEXTMETRIC tm; char buf[80];
        g_lastGen = rd(R_GEN);
        g_live = GetProfileInt("PVMon", "Live", 0) != 0;
        if (g_live) { dbg("pvmon: live re-mode enabled"); find_user_state(); }
        SetTimer(hwnd, IDT_POLL, POLL_MS, NULL);
        SetTimer(hwnd, IDT_ARRANGE, ARRANGE_MS, NULL);
        dbgnum("pvmon: up, screen", GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        /* What GDI actually ended up with: driver DPI vs the font SYSTEM.INI loaded. If these
           disagree, text metrics and layout will not match the glyphs being drawn. */
        hdc = GetDC(hwnd);
        if (hdc) {
            SelectObject(hdc, GetStockObject(SYSTEM_FONT));
            GetTextMetrics(hdc, &tm);
            wsprintf(buf, "pvmon: caps %dx%d, dpi %d/%d, sysfont h=%d avew=%d, iconspacing=%d",
                     GetDeviceCaps(hdc, HORZRES), GetDeviceCaps(hdc, VERTRES),
                     GetDeviceCaps(hdc, LOGPIXELSX), GetDeviceCaps(hdc, LOGPIXELSY),
                     (int)tm.tmHeight, (int)tm.tmAveCharWidth,
                     GetSystemMetrics(SM_CXICONSPACING));
            dbg(buf);
            ReleaseDC(hwnd, hdc);
        }
        return 0;
    }
    case WM_TIMER:
        if (wParam == IDT_ARRANGE) { KillTimer(hwnd, IDT_ARRANGE); arrange_shell(); }
        else poll(hwnd);
        return 0;
    case WM_ENDSESSION:
        if (wParam) KillTimer(hwnd, IDT_POLL);
        return 0;
    case WM_DESTROY:
        KillTimer(hwnd, IDT_ARRANGE);
        KillTimer(hwnd, IDT_POLL);
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

int PASCAL WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow)
{
    WNDCLASS wc; HWND hwnd; MSG msg;
    if (hPrev) return 0;                       /* single instance */
    if (!adapter_present()) return 0;          /* not on the paravirtual adapter: do nothing */
    wc.style = 0; wc.lpfnWndProc = WndProc; wc.cbClsExtra = 0; wc.cbWndExtra = 0;
    wc.hInstance = hInst; wc.hIcon = NULL; wc.hCursor = NULL; wc.hbrBackground = NULL;
    wc.lpszMenuName = NULL; wc.lpszClassName = "PVMonitor";
    if (!RegisterClass(&wc)) return 0;
    hwnd = CreateWindow("PVMonitor", "PV Monitor", WS_OVERLAPPED, 0, 0, 0, 0, NULL, NULL, hInst, NULL);
    if (!hwnd) return 0;                       /* hidden: never shown */
    while (GetMessage(&msg, NULL, 0, 0)) { TranslateMessage(&msg); DispatchMessage(&msg); }
    return msg.wParam;
}
