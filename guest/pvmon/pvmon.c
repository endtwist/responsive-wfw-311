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
#include <conio.h>

#define DISPI_INDEX 0x1CE
#define DISPI_DATA  0x1CF
#define R_HOST_XRES 0x10
#define R_HOST_YRES 0x11
#define R_HOST_DPI  0x12
#define R_STATUS    0x13
#define R_DEBUG     0x16
#define R_GEN       0x17

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
    if (++g_stable < SETTLE_POLLS) return;
    dbgnum("pvmon: host wants", w, h);
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
        SetTimer(hwnd, IDT_POLL, POLL_MS, NULL);
        SetTimer(hwnd, IDT_ARRANGE, ARRANGE_MS, NULL);
        dbgnum("pvmon: up, screen", GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        /* What GDI actually ended up with: driver DPI vs the font SYSTEM.INI loaded. If these
           disagree, text metrics and layout will not match the glyphs being drawn. */
        hdc = GetDC(hwnd);
        if (hdc) {
            SelectObject(hdc, GetStockObject(SYSTEM_FONT));
            GetTextMetrics(hdc, &tm);
            wsprintf(buf, "pvmon: dpi %d/%d, sysfont h=%d avew=%d, iconspacing=%d",
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
