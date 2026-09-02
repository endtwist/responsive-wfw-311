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
#define R_CURSOR_X  0x14
#define R_CURSOR_Y  0x15
#define R_GEN       0x17
#define R_CMD       0x1A   /* host -> guest command, 0 = none; guest writes 0 to acknowledge */
#define R_CMDARG    0x1B
#define R_CMDSTR    0x1C   /* command string, one byte per read, 0 at the end */

/* Private display-driver escapes (see guest/driver/port/SRC/CONTROL.ASM) */
#define PV_QUERY_MODE 0x4A00   /* out: cur w,h, host w,h, dpi, generation */
#define PV_REMODE     0x4A01   /* re-mode the adapter live; 1 if the mode changed */
#define PV_SETMODE    0x4A02   /* in: two words, an explicit size the guest wants */

/* Windows 3.x dialogs are fixed-size templates laid out for a 640-column screen, so a phone-sized
   desktop cuts their buttons off: the common File Open dialog needs about 620 pixels at 120 dpi.
   That is what stops the resolution simply being lowered to make everything bigger. Since a
   re-mode now costs about a second and nothing else, the screen can instead be widened only while
   a dialog is actually up, and put back afterwards. */
#define DIALOG_MIN_W  640
#define UNDIALOG_POLLS 4       /* dialog must be gone this many polls before going back */

#define PVMON_VERSION 25     /* reported in PVD so the host log shows which build a snapshot holds */
#define HEARTBEAT_POLLS 25   /* PVH <tick> about once a second: its absence tells the host the guest is wedged */
#define POLL_MS       40     /* host commands are polled this often: cheap, one port read */
#define LAYOUT_EVERY  4      /* the layout scan (EnumWindows etc.) runs every Nth poll: a phone's guest is slow */
#define SETTLE_POLLS  3      /* host request must be stable this many polls before acting */
#define IDT_POLL      1
#define IDT_ARRANGE   2
#define ARRANGE_MS    50     /* the shell starts after us (WIN.INI load=): poll for it, arrange the moment it is up */
#define ARRANGE_GIVEUP 200   /* polls (10 s) before we stop looking */

/* The adapter is programmed as an index write then a data access. PVMOUSE.DRV's interrupt handler
   writes the same index register (cursor position 1Dh/1Eh/1Fh), so an interrupt between the two
   halves would make us read or write the wrong register: a dropped host command, a misread size.
   cli/popf around the pair was tried and hung the system VM (v24: Write's menu bar, a click ->
   everything stopped; ring-3 popf does not restore IF the way the VMM's trapped cli expects), so
   the pair is checked instead: the index register reads back, and if the handler changed it
   under us the access is repeated. A clobbered write lands once in a cursor register the host
   rewrites on the next move. */
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
static void dbgnum(const char *s, unsigned a, unsigned b)
{
    char buf[64]; wsprintf(buf, "%s %ux%u", (LPSTR)s, a, b); dbg(buf);
}

static BOOL is_transient(HWND hwnd, char *cls, int len);

static HINSTANCE g_hInst;
static HINSTANCE g_hookDll;
typedef BOOL (FAR PASCAL *HOOKINSTALL)(void);
typedef void (FAR PASCAL *HOOKREMOVE)(void);
typedef void (FAR PASCAL *HOOKSETSHELL)(int, int);
typedef BOOL (FAR PASCAL *HOOKISDEAD)(HWND);
static HOOKISDEAD g_isDead;
/* A window the hook has seen HCBT_DESTROYWND for: its task may be gone, and a cross-task
   SendMessage to it (GetWindowText, SetWindowPos) can block PVMON until something else wakes
   the scheduler. Such windows are left alone even while IsWindow still says yes. */
static BOOL is_dead(HWND h) { return g_isDead ? g_isDead(h) : FALSE; }
static unsigned g_shellW, g_shellH;
/* The hook DLL enforces the geometry invariant in every task; it needs the shell column's
   runtime height, which only the host knows and PVMON receives (CMD_SHELLSIZE). */
static void hook_set_shell(void)
{
    HOOKSETSHELL set;
    if (!g_hookDll) return;
    set = (HOOKSETSHELL)GetProcAddress(g_hookDll, "PvHookSetShell");
    if (set) set((int)g_shellW, (int)g_shellH);
}
static void install_hook(void)
{
    HOOKINSTALL inst;
    g_hookDll = LoadLibrary("PVHOOK.DLL");
    if ((UINT)g_hookDll < 32) { g_hookDll = NULL; dbg("pvmon: PVHOOK.DLL not found"); return; }
    inst = (HOOKINSTALL)GetProcAddress(g_hookDll, "PvHookInstall");
    g_isDead = (HOOKISDEAD)GetProcAddress(g_hookDll, "PvHookIsDead");
    dbg(inst && inst() ? "pvmon: hooks installed (windows are born in their slots and clamped to the frame)" : "pvmon: CBT hook failed");
    hook_set_shell();
}
static void heartbeat(void)
{
    char b[24];
    wsprintf(b, "PVH %lu", GetTickCount());
    dbg(b);
}
static void remove_hook(void)
{
    HOOKREMOVE rem;
    if (!g_hookDll) return;
    rem = (HOOKREMOVE)GetProcAddress(g_hookDll, "PvHookRemove");
    if (rem) rem();
    FreeLibrary(g_hookDll); g_hookDll = NULL;
}
/* The screen is deliberately taller than anything the host displays at once. The shell lives in
   the top ShellWidth x ShellHeight corner, which is the only part shown as "the desktop"; every
   application window is parked below that, in screen space the host never draws directly. The
   host then composites: it shows the shell region, or an application's region, each scaled on its
   own. Windows has no idea -- as far as it is concerned this is one big screen and the windows
   are simply somewhere on it. That is what gives each application its own framebuffer without
   Windows having any notion of one. */
#define SLOT_W   640              /* each application gets a full-width slot of its own */
#define ICON_ROW  76         /* desktop rows kept free for minimised icons (32px icon + title) */
#define MAX_SLOTS 3          /* shell column + this many application columns */
static char g_lastPub[256];         /* last line published to the host, to avoid repeats */
static unsigned g_fitW, g_fitH;     /* screen the window fixer is fitting to */
static unsigned g_prevW, g_prevH;   /* screen it is fitting from */

/* Bring one top-level window back inside the screen after a resize. Maximised windows are
   re-maximised so they refill it; the rest are clamped, and shrunk if they no longer fit.
   This is the rest of SPEC 2.3's window wrangling: without it, a window that was maximised at
   the old size keeps that size, and windows can end up entirely off-screen after a shrink. */
/* A re-mode leaves windows holding painted content that was clipped to the old screen, and
   InvalidateRect(NULL, ...) only invalidates the desktop, not the windows on it. That is why a
   dialog that opened just before the screen widened came back half drawn: the part of it beyond
   the old screen width was never repainted. Invalidate each window and its controls explicitly. */
static FARPROC g_repaintProc;

BOOL CALLBACK __export RepaintChild(HWND hwnd, LPARAM lParam)
{
    InvalidateRect(hwnd, NULL, FALSE);
    return TRUE;
}

static void repaint_tree(HWND hwnd)
{
    /* The parent erases, because content that moved leaves the area behind it stale; the
       controls do not, since each paints its whole surface. Erasing once per window rather than
       once per control is the difference between a flicker and a flash. */
    InvalidateRect(hwnd, NULL, TRUE);
    if (g_repaintProc) EnumChildWindows(hwnd, (WNDENUMPROC)g_repaintProc, 0L);
    UpdateWindow(hwnd);
}

BOOL CALLBACK __export FitWindow(HWND hwnd, LPARAM lParam)
{
    RECT rc;
    char cls[24];
    int w, h, x, y;
    BOOL isShell;
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return TRUE;
    if (is_transient(hwnd, cls, sizeof(cls))) return TRUE;   /* leave menus where they pop up */
    isShell = lstrcmp(cls, "Progman") == 0;
    /* Phone layout: applications are placed by publish_layout and a zoomed window is already
       clamped to its column by the hook; refilling "the screen" here would be the 2560x970 one. */
    if (g_shellW && (!isShell || IsZoomed(hwnd))) return TRUE;
    GetWindowRect(hwnd, &rc);
    w = rc.right - rc.left; h = rc.bottom - rc.top;
    x = rc.left; y = rc.top;
    /* Refill the screen for anything that filled the old one, whether it is formally maximised
       or merely sized to fit (which is how most of these apps open). Resizing directly is used
       rather than restore-then-maximise: Windows 3.x is cooperative, and the maximise only
       takes effect once the owning task pumps messages, which it may not do for a while. */
    if (IsZoomed(hwnd) ||
        (g_prevW && g_prevH &&
         w >= (int)(g_prevW - g_prevW / 20) && h >= (int)(g_prevH - g_prevH / 20))) {
        SetWindowPos(hwnd, NULL, 0, 0, g_fitW, g_fitH, SWP_NOZORDER | SWP_NOACTIVATE);
        repaint_tree(hwnd);
        return TRUE;
    }
    /* Everything else keeps the size it was given and is only moved back on screen. Shrinking
       these is what broke Solitaire on a narrow screen: its window was squashed to the screen
       width and it re-laid its tableau into a column of overlapping cards. Applications of this
       era lay out to their own window size, so a window that no longer fits is better left its
       own size and pinned to the top left than resized into nonsense. */
    if (isShell) { x = 0; y = 0; }
    else if (g_shellW) return TRUE;   /* applications are placed by publish_layout, not here */
    if (x + w > (int)g_fitW) x = (int)g_fitW - w;
    if (y + h > (int)g_fitH) y = (int)g_fitH - h;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x != rc.left || y != rc.top)
        SetWindowPos(hwnd, NULL, x, y, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
    repaint_tree(hwnd);
    return TRUE;
}

static void fit_windows(unsigned prevW, unsigned prevH)
{
    FARPROC proc;
    g_fitW = GetSystemMetrics(SM_CXSCREEN);
    g_fitH = GetSystemMetrics(SM_CYSCREEN);
    g_prevW = prevW; g_prevH = prevH;
    proc = MakeProcInstance((FARPROC)FitWindow, g_hInst);
    if (!proc) return;
    g_repaintProc = MakeProcInstance((FARPROC)RepaintChild, g_hInst);
    EnumWindows((WNDENUMPROC)proc, 0L);
    if (g_repaintProc) { FreeProcInstance(g_repaintProc); g_repaintProc = NULL; }
    FreeProcInstance(proc);
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

static BOOL g_arrangePending;   /* the shell was iconic when its column changed: arrange on restore */
static void arrange_shell(void)
{
    HWND pm, mdi, active;
    UINT idArrange;
    int cx = GetSystemMetrics(SM_CXSCREEN), cy = GetSystemMetrics(SM_CYSCREEN);
    pm = FindWindow("Progman", NULL);
    if (!pm) return;
    /* A minimised window's rectangle IS its icon: sizing it to the column here (the phone's
       browser bars come and go, so CMD_SHELLSIZE arrives at any time) turned Program Manager's
       icon into a column-sized iconic window with the icon lost in the middle of it. */
    if (IsIconic(pm)) { g_arrangePending = TRUE; return; }
    g_arrangePending = FALSE;
    /* On a narrow display the shell is kept to a comfortable strip rather than the whole screen,
       so the host can magnify that strip and still show all of it. */
    if (g_shellW && (unsigned)cx > g_shellW) cx = (int)g_shellW;
    if (g_shellH && (unsigned)cy > g_shellH) cy = (int)g_shellH;
    /* Leave a row free along the bottom of the shell column: that is where Windows puts the
       icons of minimised applications, and minimise should work the way it always has. */
    if (g_shellW) cy -= ICON_ROW;
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
    fit_windows(g_prevW, g_prevH);
    dbgnum("pvmon: arranged shell to", cx, cy);
    if (!idArrange) dbg("pvmon: no Arrange command found");
}

static unsigned g_lastGen;
static unsigned g_wantW, g_wantH, g_stable;
static BOOL g_restarting;
static BOOL g_live;
static BOOL g_dlgReflow;           /* WIN.INI [PVMon] DialogReflow */
static unsigned g_hostW, g_hostH;  /* the size the host actually asked for */            /* WIN.INI [PVMon] Live=1 -> try the Phase 3 live re-mode */
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
#define MAX_DESK_RC 4
static WORD g_deskRc[MAX_DESK_RC];  /* offsets of the desktop's rectangles within its WND */
static int  g_nDeskRc;
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

/* The desktop window's rectangles read 0,0,cx,cy; find them inside its WND structure.
   There is more than one -- the window rectangle and the client rectangle at least -- and
   USER clamps window sizes against them, so every copy has to be found and patched. Guessing
   that the client rectangle simply follows the window rectangle was wrong: a resize past the
   old screen height was silently clamped back to it. */
static BOOL find_desktop_rect(WORD sel)
{
    HWND desk = GetDesktopWindow();
    RECT rc;
    WORD base = (WORD)desk, off;
    GetWindowRect(desk, &rc);
    g_nDeskRc = 0;
    for (off = 0; off < 128 && g_nDeskRc < MAX_DESK_RC; off += 2) {
        WORD __far *p = PVFP(sel, base + off);
        if (p[0] == (WORD)rc.left && p[1] == (WORD)rc.top &&
            p[2] == (WORD)rc.right && p[3] == (WORD)rc.bottom)
            g_deskRc[g_nDeskRc++] = off;
    }
    return g_nDeskRc > 0;
}

static void find_user_state(void)
{
    char buf[80];
    g_userDS = find_dgroup("USER");
    if (!g_userDS) { dbg("pvmon: USER DGROUP not found, live re-mode limited"); return; }
    if (!find_sysmet(g_userDS, 0xF000)) { dbg("pvmon: sysmet not found"); return; }
    if (!find_desktop_rect(g_userDS)) { dbg("pvmon: desktop rect not found"); return; }
    g_patchReady = TRUE;
    wsprintf(buf, "pvmon: USER ds=%04X sysmet=+%04X deskrc=%d at +%u,+%u",
             g_userDS, g_offSysMet, g_nDeskRc, (unsigned)g_deskRc[0],
             (unsigned)(g_nDeskRc > 1 ? g_deskRc[1] : 0));
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

/* USER keeps at least one more copy of the screen size than GetSystemMetrics reads: window
   sizing is clamped to a maximum tracking size of screen + frame, and after patching the
   metrics array and the desktop rectangles a resize was still cut to the OLD height plus the
   frame. Rather than hard-code where that copy lives, find it: every stale (oldW,oldH) word
   pair left in USER's data segment is a candidate, so patch one, ask a real window to resize,
   and keep the candidate only if the resize stops being clamped. The offset is remembered, so
   the search happens once per session.

   Restricting candidates to an adjacent pair that matches the old screen exactly keeps the
   search both short and safe, and any candidate that does not help is put back immediately. */
static WORD g_offScreenPair;      /* a word pair that also holds the screen size */
static WORD g_pairAddW, g_pairAddH; /* what is added to the screen size at that spot */
static BOOL g_pairSearched;

static BOOL resize_reaches(HWND probe, unsigned w, unsigned h)
{
    RECT rc;
    SetWindowPos(probe, NULL, 0, 0, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
    GetWindowRect(probe, &rc);
    return (unsigned)(rc.bottom - rc.top) + 16 >= h;
}

/* Try every adjacent word pair holding (oldW+addW, oldH+addH), and keep the one that actually
   unblocks a resize. Anything that does not help is put straight back. */
static BOOL search_pair(HWND probe, unsigned oldW, unsigned oldH, unsigned w, unsigned h,
                        unsigned addW, unsigned addH)
{
    WORD wantW = (WORD)(oldW + addW), wantH = (WORD)(oldH + addH);
    WORD off;
    char buf[80];
    for (off = 0; off < 0xF000 - 4; off += 2) {
        WORD __far *p = PVFP(g_userDS, off);
        if (p[0] != wantW || p[1] != wantH) continue;
        p[0] = (WORD)(w + addW); p[1] = (WORD)(h + addH);
        if (resize_reaches(probe, w, h)) {
            g_offScreenPair = off; g_pairAddW = (WORD)addW; g_pairAddH = (WORD)addH;
            wsprintf(buf, "pvmon: tracking size cached at USER:+%04X (screen+%u,%u)",
                     off, addW, addH);
            dbg(buf);
            return TRUE;
        }
        p[0] = wantW; p[1] = wantH;
    }
    return FALSE;
}

/* USER keeps more copies of the screen size than GetSystemMetrics reads. After patching the
   metrics array and the desktop rectangles, a resize was still cut to the OLD height plus the
   window frame, which is the classic maximum tracking size. Rather than hard-code where that
   lives, find it by experiment: patch a candidate, ask a real window to resize, and keep the
   candidate only if the clamp goes away. Learned once, then reused for the session. */
static void find_screen_pair(unsigned oldW, unsigned oldH, unsigned w, unsigned h)
{
    HWND probe = FindWindow("Progman", NULL);
    unsigned fx, fy;
    if (!probe || !g_userDS) return;
    if (resize_reaches(probe, w, h)) return;          /* nothing is clamping us */
    fx = 2 * GetSystemMetrics(SM_CXFRAME);
    fy = 2 * GetSystemMetrics(SM_CYFRAME);
    if (search_pair(probe, oldW, oldH, w, h, fx, fy)) return;   /* screen + frame */
    if (search_pair(probe, oldW, oldH, w, h, 0, 0)) return;     /* the bare screen size */
    if (search_pair(probe, oldW, oldH, w, h, 2 * fx, 2 * fy)) return;
    dbg("pvmon: no cached tracking size found");
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
    {
        int i;
        WORD base = (WORD)GetDesktopWindow();
        for (i = 0; i < g_nDeskRc; i++) {
            rc = PVFP(g_userDS, base + g_deskRc[i]);
            rc[2] = (WORD)w; rc[3] = (WORD)h;
        }
    }
    if (g_offScreenPair) {
        WORD __far *p = PVFP(g_userDS, g_offScreenPair);
        p[0] = (WORD)(w + g_pairAddW); p[1] = (WORD)(h + g_pairAddH);
    }
    dbgnum("pvmon: patched USER to", w, h);
    if (!g_pairSearched) { g_pairSearched = TRUE; find_screen_pair(oldW, oldH, w, h); }
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
/* Responsive dialogs.
 *
 * Windows 3.x dialogs are fixed templates laid out for a 640-column screen: the common File Open
 * dialog is about 620 pixels wide. On a phone-sized desktop they hang off the right-hand edge and
 * their buttons are unreachable, which is the one thing that stopped the screen simply being made
 * small enough to read.
 *
 * Rather than resize the screen around them, the dialog is reflowed: controls that fall off the
 * edge are moved down into rows underneath the ones that fit, and the dialog is made narrower and
 * taller to match. Nothing is scaled, so no text is squashed or clipped -- the buttons that
 * normally sit in a column down the right simply end up in a row along the bottom, which is what
 * the same dialog would look like if it had been designed for a narrow screen.
 */
#ifndef WM_SETREDRAW
#define WM_SETREDRAW 0x000B
#endif

#define DLG_MARGIN   8
#define DLG_GAP      6
#define MAX_KIDS     40

typedef struct { HWND hwnd; int x, y, cx, cy; } KID;
static KID g_kids[MAX_KIDS];
static int g_nKids;

BOOL CALLBACK __export CollectKid(HWND hwnd, LPARAM lParam)
{
    RECT rc;
    if (g_nKids >= MAX_KIDS) return FALSE;
    if (!IsWindowVisible(hwnd)) return TRUE;
    GetWindowRect(hwnd, &rc);
    g_kids[g_nKids].hwnd = hwnd;
    g_kids[g_nKids].x = rc.left;  g_kids[g_nKids].y = rc.top;
    g_kids[g_nKids].cx = rc.right - rc.left;
    g_kids[g_nKids].cy = rc.bottom - rc.top;
    g_nKids++;
    return TRUE;
}

/* Move the controls that do not fit into rows below the ones that do, and resize the dialog to
   match. Child positions are relative to the parent's *client* area, so screen coordinates are
   converted through the client origin rather than the window rectangle. */
static BOOL reflow_dialog(HWND dlg, int screenW)
{
    FARPROC proc;
    RECT dr;
    POINT org;
    int avail, i, fitBottom, rowX, rowY, rowH, moved = 0, widest = 0, newW, newH;

    GetWindowRect(dlg, &dr);
    avail = screenW - 2 * DLG_MARGIN;
    if (dr.right - dr.left <= avail) return FALSE;      /* already fits */

    g_nKids = 0;
    proc = MakeProcInstance((FARPROC)CollectKid, g_hInst);
    if (!proc) return FALSE;
    EnumChildWindows(dlg, (WNDENUMPROC)proc, 0L);
    FreeProcInstance(proc);
    if (!g_nKids) return FALSE;

    org.x = 0; org.y = 0;
    ClientToScreen(dlg, &org);           /* screen position of the dialog's client origin */

    /* Moving a dozen controls one at a time repaints the dialog a dozen times, which is what the
       flicker is. Turn painting off for the dialog, move everything with SWP_NOREDRAW so no
       repaints are generated on the way, then turn it back on and paint once. */
    SendMessage(dlg, WM_SETREDRAW, FALSE, 0L);

    /* Anything whose right edge still lands on screen keeps its place. */
    fitBottom = org.y;
    for (i = 0; i < g_nKids; i++) {
        if (g_kids[i].x + g_kids[i].cx <= dr.left + avail) {
            if (g_kids[i].y + g_kids[i].cy > fitBottom) fitBottom = g_kids[i].y + g_kids[i].cy;
            if (g_kids[i].x + g_kids[i].cx - org.x > widest) widest = g_kids[i].x + g_kids[i].cx - org.x;
        }
    }

    /* The rest go into rows underneath, in their original order, wrapping at the edge. */
    rowX = org.x + DLG_MARGIN;
    rowY = fitBottom + DLG_GAP;
    rowH = 0;
    for (i = 0; i < g_nKids; i++) {
        if (g_kids[i].x + g_kids[i].cx <= dr.left + avail) continue;
        if (rowH && (rowX - org.x) + g_kids[i].cx > avail - DLG_MARGIN) {
            rowX = org.x + DLG_MARGIN;
            rowY += rowH + DLG_GAP;
            rowH = 0;
        }
        SetWindowPos(g_kids[i].hwnd, NULL, rowX - org.x, rowY - org.y, 0, 0,
                     SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOREDRAW);
        rowX += g_kids[i].cx + DLG_GAP;
        if (g_kids[i].cy > rowH) rowH = g_kids[i].cy;
        if (rowX - org.x > widest) widest = rowX - org.x;
        moved++;
    }
    if (!moved) { SendMessage(dlg, WM_SETREDRAW, TRUE, 0L); return FALSE; }

    /* Grow the frame back around the new content: the difference between the window and client
       rectangles is the border and caption we have to add back. */
    newW = widest + DLG_MARGIN + ((dr.right - dr.left) - (avail));    /* placeholder, fixed below */
    newW = widest + DLG_MARGIN + (org.x - dr.left) * 2;
    newH = (rowY + rowH - org.y) + DLG_MARGIN + (org.y - dr.top) + (org.x - dr.left);
    if (newW > avail) newW = avail;
    SendMessage(dlg, WM_SETREDRAW, TRUE, 0L);
    /* The dialog's own resize is left to redraw normally: suppressing it means Windows never
       invalidates the area the dialog uncovers as it shrinks, which leaves the old right-hand
       column of buttons painted on the desktop behind it. */
    SetWindowPos(dlg, NULL, DLG_MARGIN, dr.top, newW, newH, SWP_NOZORDER | SWP_NOACTIVATE);
    InvalidateRect(dlg, NULL, TRUE);     /* one erase and one paint, for the whole dialog */
    UpdateWindow(dlg);
    dbgnum("pvmon: reflowed a dialog to", (unsigned)newW, (unsigned)newH);
    return TRUE;
}

/* Menus, combo drop-downs, the Alt+Tab switcher and the like are top-level windows in their own
   right, so they turn up in a window enumeration looking exactly like an application. They must
   not be parked: a menu belongs wherever it popped up. They are published as transient layers,
   which the host draws 1:1 anchored to whichever layer's column they popped up in. */
static BOOL is_transient(HWND hwnd, char *cls, int len)
{
    if (GetClassName(hwnd, cls, len) <= 0) return TRUE;
    return lstrcmp(cls, "#32768") == 0        /* menu */
        || lstrcmp(cls, "#32771") == 0        /* Alt+Tab task switcher */
        || lstrcmp(cls, "ComboLBox") == 0     /* combo box drop-down */
        || lstrcmp(cls, "tooltips_class") == 0
        || lstrcmp(cls, "PVMonitor") == 0;    /* ourselves */
}

/* Collect the top-level windows, front to back, and sort them into kinds.

   Each application is parked in a slot to the right of the shell, in screen space no view ever
   shows directly, and both its window and client rectangles are published. The host draws the
   shell strip as the desktop, then draws each application's client area over the top, every one
   scaled and placed on its own, inside its own chrome drawn at host scale. So the contents shrink
   to fit a phone while the chrome stays finger-sized and crisp, and the windows are side by side
   in the guest but layered on the host. Windows is none the wiser.

   Owned windows (dialogs, message boxes) are not parked either: Windows places them relative to
   their owner, so they already sit in the owner's column, and the host draws them over the
   owner's layer. Iconic windows are reported so the host can offer them in a dock.

   A window keeps its slot for its whole life: the slot is not re-derived from z-order, or every
   activation would physically move windows about and force a repaint of each one. */
#define MAX_WND 24
typedef struct { HWND hwnd; char kind; HWND owner; } WndRec;   /* kind: A app, O owned, T transient, I iconic, S shell */
static WndRec g_wnds[MAX_WND];
static int g_nWnds;
static HWND g_slotWnd[MAX_SLOTS];

BOOL CALLBACK __export FindApp(HWND hwnd, LPARAM lParam)
{
    char cls[24];
    WndRec *r;
    if (g_nWnds >= MAX_WND) return FALSE;
    if (!IsWindowVisible(hwnd) || is_dead(hwnd)) return TRUE;
    if (is_transient(hwnd, cls, sizeof(cls))) {
        if (lstrcmp(cls, "PVMonitor") == 0) return TRUE;
        r = &g_wnds[g_nWnds++]; r->hwnd = hwnd; r->kind = 'T'; r->owner = NULL;
        return TRUE;
    }
    if (lstrcmp(cls, "Progman") == 0) {                      /* the shell: published in z-order, never parked */
        r = &g_wnds[g_nWnds++]; r->hwnd = hwnd; r->kind = 'S'; r->owner = NULL;
        return TRUE;
    }
    if (lstrcmp(cls, "#32772") == 0) return TRUE;             /* icon title of a minimised window */
    {
        HWND o = GetWindow(hwnd, GW_OWNER);
        if (o && IsIconic(o)) return TRUE;                    /* belongs to something in the dock */
    }
    r = &g_wnds[g_nWnds++]; r->hwnd = hwnd; r->owner = GetWindow(hwnd, GW_OWNER);
    if (!r->owner && lstrcmp(cls, "#32770") == 0) {
        /* an unowned dialog belongs to its task's main window if it has one: WinOldAp's
           "Application still active" box is owned by nothing but is the DOS window's */
        HTASK t = GetWindowTask(hwnd);
        HWND h; char c[24];
        for (h = GetWindow(GetDesktopWindow(), GW_CHILD); h; h = GetWindow(h, GW_HWNDNEXT)) {
            if (h == hwnd || !IsWindowVisible(h) || GetWindowTask(h) != t || GetWindow(h, GW_OWNER)) continue;
            if (GetClassName(h, c, sizeof(c)) <= 0 || c[0] == '#' || lstrcmp(c, "ComboLBox") == 0) continue;
            r->owner = h; break;
        }
    }
    if (IsIconic(hwnd)) r->kind = 'I';
    else if (r->owner && IsWindow(r->owner) && IsWindowVisible(r->owner)) r->kind = 'O';
    else r->kind = 'A';
    return TRUE;
}

static void collect_apps(void)
{
    FARPROC proc;
    g_nWnds = 0;
    proc = MakeProcInstance((FARPROC)FindApp, g_hInst);
    if (!proc) return;
    EnumWindows((WNDENUMPROC)proc, 0L);
    FreeProcInstance(proc);
}

static int slot_of(HWND hwnd)
{
    int i, free = -1;
    for (i = 0; i < MAX_SLOTS; i++) if (g_slotWnd[i] == hwnd) return i;
    for (i = 0; i < MAX_SLOTS; i++)
        if (free < 0 && (g_slotWnd[i] == NULL || !IsWindow(g_slotWnd[i]) || is_dead(g_slotWnd[i]) ||
                         !IsWindowVisible(g_slotWnd[i]))) free = i;   /* a closed program's window lingers hidden while its task exits */
    if (free < 0) return -1;
    g_slotWnd[free] = hwnd;
    return free;
}

/* The slot of an owned window is its owner's (following owner chains); -1 if none. */
static int owner_slot(HWND owner)
{
    int i, hops;
    for (hops = 0; owner && hops < 8; hops++) {
        for (i = 0; i < MAX_SLOTS; i++) if (g_slotWnd[i] == owner) return i;
        owner = GetWindow(owner, GW_OWNER);
    }
    return -1;
}

/* Owned windows are placed once, when first seen; a dialog the program then moves itself is left
   alone unless it leaves its owner's column. */
static HWND g_owned[24];
static BOOL owned_seen(HWND hwnd)               /* TRUE the first time hwnd is seen */
{
    int i, free = -1;
    for (i = 0; i < 24; i++) {
        if (g_owned[i] == hwnd) return FALSE;
        if (free < 0 && (g_owned[i] == NULL || !IsWindow(g_owned[i]))) free = i;
    }
    if (free >= 0) g_owned[free] = hwnd;
    return TRUE;
}

/* Dialogs wider than the phone are reported once each, so the list of stock dialogs that
   overflow at the 20 px system font is known rather than guessed. */
static HWND g_wide[16];
static void report_wide(HWND hwnd, int w, int h)
{
    int i, free = -1;
    char line[96], title[32], mod[16], path[128], *base, *p; int n;
    HINSTANCE inst;
    for (i = 0; i < 16; i++) {
        if (g_wide[i] == hwnd) return;
        if (free < 0 && (g_wide[i] == NULL || !IsWindow(g_wide[i]))) free = i;
    }
    if (free < 0) return;
    g_wide[free] = hwnd;
    title[0] = 0; mod[0] = 0;
    GetWindowText(hwnd, title, sizeof(title));
    inst = (HINSTANCE)GetWindowWord(hwnd, GWW_HINSTANCE);
    if (inst && GetModuleFileName(inst, path, sizeof(path))) {
        base = path;
        for (p = path; *p; p++) if (*p == '\\' || *p == ':') base = p + 1;
        for (n = 0; base[n] && base[n] != '.' && n < 15; n++) mod[n] = base[n];
        mod[n] = 0;
    }
    wsprintf(line, "PVQ wide %s \"%s\" %dx%d", (LPSTR)mod, (LPSTR)title, w, h);
    dbg(line);
}

/* Keep an application inside its slot. Maximising is one tap away and would make the window as
   wide as the whole virtual screen, overlapping the other slots and forcing the host to scale
   it down to nothing; so a maximised window is restored and then sized to fill its slot, which
   is what maximise means here. Windows accepts this as an ordinary size change. */
/* Some applications lay out to their window's shape (Paintbrush stretches its toolbox to the
   window height), so a slot-tall maximise looks wrong for them. WIN.INI can cap it per module:
   [PVMon] MaxHeight.PBRUSH=480 */
static int max_height_for(HWND hwnd)
{
    char path[128], key[48], *base, *p;
    HINSTANCE inst = (HINSTANCE)GetWindowWord(hwnd, GWW_HINSTANCE);
    int h;
    if (!inst || !GetModuleFileName(inst, path, sizeof(path))) return GetSystemMetrics(SM_CYSCREEN);
    base = path;
    for (p = path; *p; p++) if (*p == '\\' || *p == ':') base = p + 1;
    for (p = base; *p && *p != '.'; p++) ;
    *p = 0;
    wsprintf(key, "MaxHeight.%s", (LPSTR)base);
    h = GetProfileInt("PVMon", key, 0);
    return (h > 100 && h < GetSystemMetrics(SM_CYSCREEN)) ? h : GetSystemMetrics(SM_CYSCREEN);
}

/* Per-module initial size, applied once per window: [PVMon] Size.WINOA386=400x340 makes a
   windowed DOS session about a phone's width, and WinOldAp then picks a smaller font on its own,
   so the text is shown near 1:1 instead of a 640-column window scaled down to nothing. */
static HWND g_sized[16];
static BOOL lstrcmpi_n(const char *a, const char *b, int n)      /* case-insensitive, n chars */
{
    int i;
    for (i = 0; i < n; i++) {
        char x = a[i], y = b[i];
        if (x >= 'a' && x <= 'z') x -= 32;
        if (y >= 'a' && y <= 'z') y -= 32;
        if (x != y) return FALSE;
    }
    return TRUE;
}
static void apply_initial_size(HWND hwnd, int slotX)
{
    char key[48], val[24], *base, *p, path[128];
    HINSTANCE inst;
    int i, w = 0, h = 0, free = -1;
    for (i = 0; i < 16; i++) {
        if (g_sized[i] == hwnd) return;
        if (free < 0 && (g_sized[i] == NULL || !IsWindow(g_sized[i]))) free = i;
    }
    if (free < 0) return;
    g_sized[free] = hwnd;
    /* A program whose main window is a dialog template (Task List, Sound Recorder...) laid its
       controls out once, for its own size: resizing it only crops or strands them. */
    if (GetClassName(hwnd, key, sizeof(key)) > 0 && lstrcmp(key, "#32770") == 0) return;
    if (!(GetWindowLong(hwnd, GWL_STYLE) & WS_THICKFRAME)) return;
    inst = (HINSTANCE)GetWindowWord(hwnd, GWW_HINSTANCE);
    if (!inst || !GetModuleFileName(inst, path, sizeof(path))) return;
    base = path;
    for (p = path; *p; p++) if (*p == '\\' || *p == ':') base = p + 1;
    for (p = base; *p && *p != '.'; p++) ;
    *p = 0;
    wsprintf(key, "Size.%s", (LPSTR)base);
    if (!GetProfileString("PVMon", key, "", val, sizeof(val)) || !val[0]) {
        /* No per-module size: most Windows programs lay out to whatever window they get, so a
           window the width of the phone shows at 1:1 instead of a 640-column window scaled down.
           Programs that draw a fixed layout (Solitaire, Hearts, Minesweeper, Calculator...) are
           listed in KeepSize and left alone. */
        char keep[128], *k;
        GetProfileString("PVMon", "KeepSize", "", keep, sizeof(keep));
        for (k = keep; *k; ) {
            char *e = k; int n;
            while (*e && *e != ' ' && *e != ',') e++;
            n = (int)(e - k);
            if (n == lstrlen(base) && lstrcmpi_n(k, base, n)) return;
            k = e; while (*k == ' ' || *k == ',') k++;
        }
        if (!GetProfileString("PVMon", "DefaultSize", "", val, sizeof(val)) || !val[0]) return;
    }
    for (p = val; *p >= '0' && *p <= '9'; p++) w = w * 10 + (*p - '0');
    if (*p == 'x') for (p++; *p >= '0' && *p <= '9'; p++) h = h * 10 + (*p - '0');
    if (w < 100 || h < 60) return;
    SetWindowPos(hwnd, NULL, slotX, 0, min(w, (int)SLOT_W), min(h, GetSystemMetrics(SM_CYSCREEN)),
                 SWP_NOZORDER | SWP_NOACTIVATE);
}

/* Fixed-layout programs (the hook's rule, mirrored): a dialog-template main window, or a module
   in [PVMon] KeepSize. They are never resized, only kept inside their column. */
static BOOL fixed_layout(HWND hwnd)
{
    char cls[24], path[128], keep[128], *base, *p, *k;
    HINSTANCE inst;
    if (GetClassName(hwnd, cls, sizeof(cls)) > 0 && lstrcmp(cls, "#32770") == 0) return TRUE;
    if (!(GetWindowLong(hwnd, GWL_STYLE) & WS_THICKFRAME)) return TRUE;   /* not user-resizable: never reflows */
    inst = (HINSTANCE)GetWindowWord(hwnd, GWW_HINSTANCE);
    if (!inst || !GetModuleFileName(inst, path, sizeof(path))) return FALSE;
    base = path;
    for (p = path; *p; p++) if (*p == '\\' || *p == ':') base = p + 1;
    for (p = base; *p && *p != '.'; p++) ;
    *p = 0;
    GetProfileString("PVMon", "KeepSize", "", keep, sizeof(keep));
    for (k = keep; *k; ) {
        char *e = k; int n;
        while (*e && *e != ' ' && *e != ',') e++;
        n = (int)(e - k);
        if (n == lstrlen(base) && lstrcmpi_n(k, base, n)) return TRUE;
        k = e; while (*k == ' ' || *k == ',') k++;
    }
    return FALSE;
}

static void park(HWND hwnd, int slot)
{
    RECT rc;
    int slotX = (int)SLOT_W * (slot + 1);         /* slot 0 sits right of the shell column */
    int screenH = GetSystemMetrics(SM_CYSCREEN);
    apply_initial_size(hwnd, slotX);
    GetWindowRect(hwnd, &rc);
    if (IsZoomed(hwnd)) {
        /* The hook makes "maximised" mean the phone frame at the top of the column, so a zoomed
           window is left zoomed (its maximise box toggles back). Only a window zoomed past the
           frame, which means the hook missed it, is restored and sized to the frame by hand. */
        if (rc.right - rc.left <= (int)g_shellW && rc.bottom - rc.top <= (int)g_shellH &&
            rc.left >= slotX && rc.right <= slotX + (int)SLOT_W) return;
        ShowWindow(hwnd, SW_RESTORE);
        SetWindowPos(hwnd, NULL, slotX, 0, (int)g_shellW, min(max_height_for(hwnd), (int)g_shellH),
                     SWP_NOZORDER | SWP_NOACTIVATE);
        return;
    }
    /* The invariant's last line of defence: a resizable program that has sized itself past the
       phone frame (the hook clamps every path it sees) is brought back to it; a fixed-layout
       program is only kept inside its 640-wide column. */
    {
        BOOL fixed = fixed_layout(hwnd);
        int maxW = fixed ? (int)SLOT_W : (int)g_shellW;
        int maxH = fixed ? screenH : min((int)g_shellH, max_height_for(hwnd));
        if (rc.right - rc.left > maxW || rc.bottom - rc.top > maxH) {
            SetWindowPos(hwnd, NULL, slotX, 0,
                         min(rc.right - rc.left, maxW), min(rc.bottom - rc.top, maxH),
                         SWP_NOZORDER | SWP_NOACTIVATE);
            return;
        }
    }
    if (rc.left < slotX || rc.left >= slotX + (int)SLOT_W || rc.top < 0) {
        SetWindowPos(hwnd, NULL, slotX, 0, 0, 0,
                     SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
    }
}

/* One line describing a window: both rectangles, so the host can draw the real chrome from the
   window rectangle at its own scale and the client area inside it at the scale that fits. */
static void describe(HWND hwnd, char *line, const char *tag, int slot)
{
    RECT wr, rc; POINT pt; char title[24];
    GetWindowRect(hwnd, &wr);
    GetClientRect(hwnd, &rc);
    pt.x = rc.left; pt.y = rc.top;
    ClientToScreen(hwnd, &pt);
    title[0] = 0;
    GetWindowText(hwnd, title, sizeof(title));
    wsprintf(line, "%s %d %d %d %d %d %d %d %d %d %s", (LPSTR)tag, slot,
             wr.left, wr.top, wr.right - wr.left, wr.bottom - wr.top,
             pt.x, pt.y, rc.right - rc.left, rc.bottom - rc.top, (LPSTR)title);
}

/* Tell the host whether a text control has the keyboard focus, so it can offer the soft keyboard
   when one does and put it away when none does. Windows 3.1 has no soft keyboard of its own. */
static int g_lastKbd = -1;
static void report_focus(void)
{
    HWND f = GetFocus();
    char cls[24];
    int want = 0;
    if (f && GetClassName(f, cls, sizeof(cls)) > 0) {
        if (lstrcmpi(cls, "Edit") == 0 || lstrcmpi(cls, "ComboBox") == 0 || lstrcmpi(cls, "tty") == 0) want = 1;
        else {                             /* a combo box's edit child reports as Edit already */
            char pcls[24]; HWND parent = GetParent(f);
            if (parent && GetClassName(parent, pcls, sizeof(pcls)) > 0 && lstrcmpi(pcls, "ComboBox") == 0) want = 1;
        }
    }
    if (!want) {
        /* programs that take keys without an edit control (a DOS box, Paintbrush's text tool,
           Terminal): [PVMon] KeyboardApps=WINOA386 TERMINAL ... by module of the active window */
        HWND a = GetActiveWindow();
        if (a) {
            char path[128], mod[16], list[128], *base, *p, *k; int n;
            HINSTANCE inst = (HINSTANCE)GetWindowWord(a, GWW_HINSTANCE);
            if (inst && GetModuleFileName(inst, path, sizeof(path))) {
                base = path;
                for (p = path; *p; p++) if (*p == '\\' || *p == ':') base = p + 1;
                for (n = 0; base[n] && base[n] != '.' && n < 15; n++) mod[n] = base[n];
                mod[n] = 0;
                GetProfileString("PVMon", "KeyboardApps", "", list, sizeof(list));
                for (k = list; *k; ) {
                    char *e = k;
                    while (*e && *e != ' ' && *e != ',') e++;
                    if ((int)(e - k) == lstrlen(mod) && lstrcmpi_n(k, mod, (int)(e - k))) { want = 1; break; }
                    k = e; while (*k == ' ' || *k == ',') k++;
                }
            }
        }
    }
    if (want != g_lastKbd) { g_lastKbd = want; dbg(want ? "PVK 1" : "PVK 0"); }
}

static void publish_layout(void)
{
    RECT wr;
    char state[256], line[128];
    int i, slot;

    collect_apps();

    /* First pass: assign slots and park applications, so the second pass reports where they
       actually ended up. Owned windows go into their owner's column too: Windows usually centres
       a dialog on its owner, but some applications place theirs in screen coordinates, and a
       dialog left in the shell column would show through on the desktop. */
    for (i = 0; i < g_nWnds; i++)
        if (g_wnds[i].kind == 'S' && !IsIconic(g_wnds[i].hwnd)) {
            RECT src;
            GetWindowRect(g_wnds[i].hwnd, &src);
            if (g_arrangePending) arrange_shell();          /* its column changed while it was an icon */
            else if (IsZoomed(g_wnds[i].hwnd) &&
                     (src.right > (int)g_shellW || src.bottom > (int)g_shellH - ICON_ROW)) {
                /* the hook makes the shell's maximised rectangle its column; a shell zoomed past
                   it means the hook was not there, so fall back to restore-and-arrange */
                ShowWindow(g_wnds[i].hwnd, SW_RESTORE);
                arrange_shell();
            }
        }
    for (i = 0; i < g_nWnds; i++)
        if (g_wnds[i].kind == 'A' || g_wnds[i].kind == 'I') {
            slot = slot_of(g_wnds[i].hwnd);
            if (slot >= 0 && g_wnds[i].kind == 'A') park(g_wnds[i].hwnd, slot);
        }
    /* Windows arranges minimised icons along the bottom of the 970-row screen, but the visible
       shell column is only as tall as the phone shows, so icons are moved up into the free row
       at the bottom of the column. Windows keeps drawing them; only where changes. */
    {
        /* Icons sit in cells of SM_CXICONSPACING (WIN.INI IconSpacing=100) across the column, so
           the centred label under each fits inside the column too; a fourth icon starts a second
           row above. The position goes through SetWindowPlacement, which is how USER itself
           places an icon, so the icon title follows it (a bare SetWindowPos left titles behind). */
        int n = 0, cell = GetSystemMetrics(SM_CXICONSPACING), per;
        if (cell < 64) cell = 100;
        per = (int)g_shellW / cell; if (per < 1) per = 1;
        for (i = 0; i < g_nWnds; i++) {
            RECT rc; WINDOWPLACEMENT wp; int x, y, cx = GetSystemMetrics(SM_CXICON);
            if (g_wnds[i].kind != 'I' && !(g_wnds[i].kind == 'S' && IsIconic(g_wnds[i].hwnd))) continue;
            GetWindowRect(g_wnds[i].hwnd, &rc);
            x = (n % per) * cell + (cell - cx) / 2;
            y = (int)g_shellH - ICON_ROW + 4 - (n / per) * ICON_ROW;
            if (y < 0) y = 0;
            if (rc.left != x || rc.top != y) {
                wp.length = sizeof(wp);
                if (GetWindowPlacement(g_wnds[i].hwnd, &wp)) {
                    wp.flags |= WPF_SETMINPOSITION; wp.ptMinPosition.x = x; wp.ptMinPosition.y = y;
                    wp.showCmd = SW_SHOWMINNOACTIVE;
                    SetWindowPlacement(g_wnds[i].hwnd, &wp);
                } else
                    SetWindowPos(g_wnds[i].hwnd, NULL, x, y, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
            }
            n++;
        }
    }
    for (i = 0; i < g_nWnds; i++)
        if (g_wnds[i].kind == 'O') {
            RECT rc, orc;
            int slotX, colR, frameH, w, h, x, y;
            BOOL fresh = owned_seen(g_wnds[i].hwnd);
            GetWindowRect(g_wnds[i].hwnd, &rc);
            w = rc.right - rc.left; h = rc.bottom - rc.top;
            slot = owner_slot(g_wnds[i].owner);
            if (slot < 0) {
                /* owned by the shell (or by something in the desktop column): it must be inside
                   the shell column, which is the only part of the desktop the phone shows */
                if (rc.left >= 0 && rc.right <= (int)g_shellW && rc.top >= 0 && rc.bottom <= (int)g_shellH) continue;
                GetWindowRect(g_wnds[i].owner, &orc);
                if (orc.left >= (int)SLOT_W) continue;          /* owner parked elsewhere: not ours */
                x = ((int)g_shellW - w) / 2; y = (orc.top + orc.bottom - h) / 2;
                slotX = 0; colR = (int)g_shellW; frameH = (int)g_shellH;
            } else {
                slotX = (int)SLOT_W * (slot + 1); colR = slotX + (int)SLOT_W;
                frameH = GetSystemMetrics(SM_CYSCREEN);
                if (!fresh && rc.left >= slotX && rc.right <= colR) continue;
                /* The hook places dialogs at birth where they do not cover their owner (below it
                   when the column has room, else to its right), so the owner's captured client
                   area no longer shows the dialog a second time. This is the fallback for
                   dialogs it did not see (CW_USEDEFAULT, or an owner parked since), once each. */
                GetWindowRect(g_wnds[i].owner, &orc);
                if (orc.bottom + h <= frameH)   { x = orc.left;  y = orc.bottom; }
                else if (orc.right + w <= colR) { x = orc.right; y = orc.top; }
                else { x = (orc.left + orc.right - w) / 2; y = (orc.top + orc.bottom - h) / 2; }
            }
            if (x + w > colR) x = colR - w;
            if (x < slotX) x = slotX;
            if (y + h > frameH) y = frameH - h;
            if (y < 0) y = 0;
            if (x != rc.left || y != rc.top)
                SetWindowPos(g_wnds[i].hwnd, NULL, x, y, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
            if (w > (int)g_shellW) report_wide(g_wnds[i].hwnd, w, h);
        }

    /* A compact fingerprint of the layout, published only when it changes. */
    state[0] = 0;
    for (i = g_nWnds - 1; i >= 0; i--) {
        GetWindowRect(g_wnds[i].hwnd, &wr);
        wsprintf(line, "%c%x:%d,%d,%d,%d;", g_wnds[i].kind, (unsigned)g_wnds[i].hwnd,
                 wr.left, wr.top, wr.right, wr.bottom);
        if (lstrlen(state) + lstrlen(line) < sizeof(state) - 2) lstrcat(state, line);
    }
    if (lstrcmp(state, g_lastPub) == 0) return;
    lstrcpy(g_lastPub, state);

    wsprintf(line, "PVB %d", g_nWnds);
    dbg(line);
    for (i = g_nWnds - 1; i >= 0; i--) {          /* back to front, so the host draws in order */
        switch (g_wnds[i].kind) {
        case 'A':
            slot = slot_of(g_wnds[i].hwnd);
            if (slot < 0) { describe(g_wnds[i].hwnd, line, "PVX", -1); break; }   /* no room */
            describe(g_wnds[i].hwnd, line, "PVW", slot);
            break;
        case 'O':
            describe(g_wnds[i].hwnd, line, "PVO", owner_slot(g_wnds[i].owner));
            break;
        case 'T': {
            char cls[24]; int n;
            describe(g_wnds[i].hwnd, line, "PVT", -1);
            /* transients have no title worth showing; report the class instead */
            GetClassName(g_wnds[i].hwnd, cls, sizeof(cls));
            n = lstrlen(line);
            if (n + lstrlen(cls) + 2 < 128) { line[n] = ' '; lstrcpy(line + n + 1, cls); }
            break;
        }
        case 'S':
            describe(g_wnds[i].hwnd, line, "PVS", -1);
            break;
        case 'I': {
            char title[24];
            title[0] = 0;
            GetWindowText(g_wnds[i].hwnd, title, sizeof(title));
            wsprintf(line, "PVI %d %s", slot_of(g_wnds[i].hwnd), (LPSTR)title);
            break;
        }
        }
        dbg(line);
    }
    dbg("PVE");
}

/* Printing. WIN.INI names C:\PRINT.PS as the PDF Printer's port, so the PostScript driver and
   Print Manager write each job there. Once the file can be opened exclusively (the spooler is
   done) it is sent to the host through the debug channel, base64 in short lines, and deleted;
   the host turns it into a PDF and offers the download. */
#define PRINT_FILE "C:\\PRINT.PRN"
static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void ship_print_job(void)
{
    OFSTRUCT of;
    HFILE f;
    static unsigned char buf[72];
    char line[8 + 96 + 1];
    long size; int n, i, o;
    if (OpenFile(PRINT_FILE, &of, OF_EXIST) == HFILE_ERROR) return;
    f = OpenFile(PRINT_FILE, &of, OF_READ | OF_SHARE_EXCLUSIVE);
    if (f == HFILE_ERROR) { dbg("pvmon: print file present, still open"); return; }   /* being written */
    size = _llseek(f, 0L, 2); _llseek(f, 0L, 0);
    if (size <= 0) { _lclose(f); return; }
    wsprintf(line, "PVP-BEGIN %ld", size); dbg(line);
    while ((n = _lread(f, buf, sizeof(buf))) > 0) {
        lstrcpy(line, "PVP ");
        for (i = 0, o = 4; i < n; i += 3) {
            unsigned long v = ((unsigned long)buf[i] << 16) | ((i + 1 < n ? buf[i + 1] : 0) << 8) | (i + 2 < n ? buf[i + 2] : 0);
            line[o++] = b64[(v >> 18) & 63]; line[o++] = b64[(v >> 12) & 63];
            line[o++] = i + 1 < n ? b64[(v >> 6) & 63] : '=';
            line[o++] = i + 2 < n ? b64[v & 63] : '=';
        }
        line[o] = 0; dbg(line);
    }
    _lclose(f);
    dbg("PVP-END");
    OpenFile(PRINT_FILE, &of, OF_DELETE);
}

/* Commands from the host: it writes a command and argument into two adapter registers and we
   acknowledge by clearing the command. The argument is a slot. */
#define CMD_ACTIVATE 1
#define CMD_RESTORE  2
#define CMD_CLOSE    3
#define CMD_MINIMIZE 4
#define CMD_RUN      5     /* WinExec the string in R_CMDSTR (a command line) */
#define CMD_REPUBLISH 6    /* host restored a snapshot: tell it everything again */
#define CMD_SCROLL   7     /* arg: slot | direction << 8 (1 up, 2 down, 3 left, 4 right), lines in bits 12+ */
#define CMD_SHELLSIZE 8    /* arg: shell column height; the host knows the real viewport, we do not */
#define CMD_SETPOS   9     /* string "x,y": put the pointer there (absolute, for a tap) */
#define CMD_CURSOR   10    /* arg 0: hide the pointer (touch screen), 1: show it */

static BOOL g_hideCursor = FALSE;
static void enforce_cursor(void)
{
    int c = ShowCursor(FALSE);                       /* returns the new display count */
    if (g_hideCursor) { while (c >= 0) c = ShowCursor(FALSE); }
    else              { while (c <  0) c = ShowCursor(TRUE); if (c == 0) ShowCursor(TRUE), ShowCursor(FALSE); }
    if (!g_hideCursor) ShowCursor(TRUE);             /* undo the probe */
}

/* See CMD_SCROLL. */
static HWND scroll_target(HWND top, DWORD want)
{
    HWND f = GetFocus(), t, mdi, active, child;
    char c[16];
    if (f) {
        for (t = f; GetParent(t); ) t = GetParent(t);
        if (t == top && (GetWindowLong(f, GWL_STYLE) & want)) return f;
    }
    for (mdi = GetWindow(top, GW_CHILD); mdi; mdi = GetWindow(mdi, GW_HWNDNEXT))
        if (GetClassName(mdi, c, sizeof(c)) > 0 && lstrcmpi(c, "MDIClient") == 0) break;
    if (mdi) {
        active = (HWND)(WORD)SendMessage(mdi, WM_MDIGETACTIVE, 0, 0L);
        if (active && IsWindow(active)) {
            if (GetWindowLong(active, GWL_STYLE) & want) return active;
            for (child = GetWindow(active, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT))
                if (IsWindowVisible(child) && (GetWindowLong(child, GWL_STYLE) & want)) return child;
            if (f && IsChild(active, f)) return f;          /* a focused list without bars still scrolls */
        }
    }
    for (child = GetWindow(top, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT))
        if (IsWindowVisible(child) && (GetWindowLong(child, GWL_STYLE) & want)) return child;
    return top;
}

static void run_host_command_1(void)
{
    unsigned cmd = rd(R_CMD), arg;
    HWND hwnd;
    if (!cmd) return;
    arg = rd(R_CMDARG);
    wr(R_CMD, 0);
    if (cmd == CMD_SHELLSIZE) {
        /* The shell column is arranged to the height the host can actually show (browser
           toolbars vary), so the desktop fills the phone edge to edge with no letterboxing. */
        char b[64];
        if (arg >= 300 && arg <= (unsigned)GetSystemMetrics(SM_CYSCREEN)) g_shellH = arg;
        hook_set_shell();
        arrange_shell();
        wsprintf(b, "PVD %u %u %d v%d", g_shellW, g_shellH, GetSystemMetrics(SM_CYCAPTION), PVMON_VERSION);
        dbg(b);
        g_lastPub[0] = 0;
        heartbeat();
        return;
    }
    if (cmd == CMD_REPUBLISH) {
        char b[64];
        wsprintf(b, "PVD %u %u %d v%d", g_shellW, g_shellH, GetSystemMetrics(SM_CYCAPTION), PVMON_VERSION);
        dbg(b);
        dbg("PVA");
        g_lastPub[0] = 0;
        return;
    }
    if (cmd == CMD_SCROLL) {
        /* Two-finger scrolling from the host: arg = slot | direction << 8 | lines << 12, slot byte
           15 meaning the shell (Program Manager's active group). The thing that scrolls is found in order: the
           focused control if it is inside the window and has a scroll bar; the active MDI child
           (a Program Manager group, a File Manager directory window) or the first of its children
           with a scroll bar; the first child of the window with a scroll bar; the window itself.
           Ordinary WM_VSCROLL/WM_HSCROLL line messages, so every program scrolls its own way. */
        unsigned slotn = arg & 0xFF, dir = (arg >> 8) & 0xF, lines = (arg >> 12) & 0xF, k;
        HWND top, target;
        UINT msg = (dir <= 2) ? WM_VSCROLL : WM_HSCROLL;
        WPARAM sb = (dir == 1 || dir == 3) ? SB_LINEUP : SB_LINEDOWN;
        if (slotn == 15) top = FindWindow("Progman", NULL);
        else if (slotn >= MAX_SLOTS) return;
        else top = g_slotWnd[slotn];
        if (!top || !IsWindow(top) || IsIconic(top)) return;
        target = scroll_target(top, (msg == WM_VSCROLL) ? WS_VSCROLL : WS_HSCROLL);
        if (!lines) lines = 3;
        for (k = 0; k < lines; k++) SendMessage(target, msg, sb, 0L);
        SendMessage(target, msg, SB_ENDSCROLL, 0L);
        return;
    }
    if (cmd == CMD_CURSOR) {
        /* ShowCursor keeps a display count: drive it to -1 (hidden) or 0 (shown) and keep it
           there in poll(), since applications that ShowCursor(TRUE) would bring it back. */
        g_hideCursor = (arg == 0);
        return;
    }
    if (cmd == CMD_SETPOS) {
        /* A tap wants the pointer exactly at one point. Steering a relative PS/2 mouse there
           overshoots whenever the guest is busy; SetCursorPos does not. The driver reports the
           new position through MoveCursor, which is the host's cue to press the button. */
        char buf[24]; int n = 0, x = 0, y = 0; unsigned b;
        while (n < (int)sizeof(buf) - 1 && (b = rd(R_CMDSTR) & 0xFF) != 0) buf[n++] = (char)b;
        buf[n] = 0;
        for (n = 0; buf[n] && buf[n] != ','; n++) x = x * 10 + (buf[n] - '0');
        if (buf[n] == ',') for (n++; buf[n]; n++) y = y * 10 + (buf[n] - '0');
        SetCursorPos(x, y);
        /* Report the new position ourselves. With a 386 enhanced DOS session running, USER only
           calls the display driver's MoveCursor on the next mouse interrupt, so the host would
           otherwise wait a second for confirmation of a move that has already happened. */
        {
            POINT pt;
            GetCursorPos(&pt);
            wr(R_CURSOR_X, (unsigned)pt.x);
            wr(R_CURSOR_Y, (unsigned)pt.y);     /* writing Y is what the host sees as a report */
        }
        return;
    }
    if (cmd == CMD_RUN) {
        char cmdline[128];
        int n = 0;
        unsigned b;
        while (n < (int)sizeof(cmdline) - 1 && (b = rd(R_CMDSTR) & 0xFF) != 0) cmdline[n++] = (char)b;
        cmdline[n] = 0;
        if (n) {
            char out[160];
            wsprintf(out, "pvmon: run %s -> %u", (LPSTR)cmdline, WinExec(cmdline, SW_SHOWNORMAL));
            dbg(out);
        }
        return;
    }
    if (arg >= MAX_SLOTS) return;
    hwnd = g_slotWnd[arg];
    if (!hwnd || !IsWindow(hwnd)) return;
    switch (cmd) {
    case CMD_ACTIVATE:
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        BringWindowToTop(hwnd);
        SetActiveWindow(hwnd);
        break;
    case CMD_RESTORE:
        ShowWindow(hwnd, SW_RESTORE);
        SetActiveWindow(hwnd);
        break;
    case CMD_CLOSE:
        PostMessage(hwnd, WM_CLOSE, 0, 0L);
        break;
    case CMD_MINIMIZE:
        ShowWindow(hwnd, SW_MINIMIZE);
        break;
    }
    g_lastPub[0] = 0;                               /* force a fresh publish */
}

/* Every handled command is followed by a heartbeat, so the host sees at once that the guest
   took it (and can tell a wedged guest from a slow one). */
static void run_host_command(void)
{
    if (!rd(R_CMD)) return;
    run_host_command_1();
    heartbeat();
}

/* Find dialogs that overflow the screen and reflow them. */
static HWND g_wideDlg;

BOOL CALLBACK __export FindWideDialog(HWND hwnd, LPARAM lParam)
{
    char cls[16];
    RECT rc;
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return TRUE;
    if (GetClassName(hwnd, cls, sizeof(cls)) <= 0) return TRUE;
    if (lstrcmp(cls, "#32770") != 0) return TRUE;
    GetWindowRect(hwnd, &rc);
    /* lParam is the width of the column the dialog must fit: the shell column for dialogs in
       it, which is what the phone shows as the desktop. Dialogs that belong to an application are
       composited over it at their own scale and must not be touched, wherever they happen to be
       when we see them (Hearts creates its welcome dialog in the desktop column first). */
    if (g_shellW) {
        /* Only the shell's own dialogs (Run, its Browse, Exit Windows...) are reflowed: an owner
           chain ending at Program Manager. An unowned dialog window is a program (Task List) and
           is parked in a slot like any other, never reflowed. */
        HWND o = GetWindow(hwnd, GW_OWNER);
        char ocls[16];
        int hops;
        if (rc.left >= (int)SLOT_W || !o) return TRUE;
        for (hops = 0; o && hops < 8 && GetWindow(o, GW_OWNER); hops++) o = GetWindow(o, GW_OWNER);
        if (GetClassName(o, ocls, sizeof(ocls)) <= 0 || lstrcmp(ocls, "Progman") != 0) return TRUE;
    }
    if (rc.right - rc.left > (int)lParam - 2 * DLG_MARGIN || rc.left < 0 || rc.right > (int)lParam) {
        g_wideDlg = hwnd; return FALSE;
    }
    return TRUE;
}

static void check_dialogs(void)
{
    FARPROC proc;
    int screenW = g_shellW ? (int)g_shellW : GetSystemMetrics(SM_CXSCREEN);
    g_wideDlg = NULL;
    proc = MakeProcInstance((FARPROC)FindWideDialog, g_hInst);
    if (!proc) return;
    EnumWindows((WNDENUMPROC)proc, (LPARAM)screenW);
    FreeProcInstance(proc);
    if (g_wideDlg) reflow_dialog(g_wideDlg, screenW);
}

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
    g_prevW = GetSystemMetrics(SM_CXSCREEN);
    g_prevH = GetSystemMetrics(SM_CYSCREEN);
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
    g_hostW = w; g_hostH = h;
    if (g_dlgReflow) check_dialogs();
    if (g_shellW) {
        static unsigned n;
        run_host_command();
        if (++n % LAYOUT_EVERY == 0 || g_lastPub[0] == 0) { publish_layout(); report_focus(); enforce_cursor(); }
        if (n % HEARTBEAT_POLLS == 0) { heartbeat(); ship_print_job(); }   /* about once a second */
    }
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
        g_dlgReflow = GetProfileInt("PVMon", "DialogReflow", 1) != 0;
        g_shellW = (unsigned)GetProfileInt("PVMon", "ShellWidth", 0);
        g_shellH = (unsigned)GetProfileInt("PVMon", "ShellHeight", 0);
        /* The screen is now one row of columns, so the shell column is the full screen height
           unless WIN.INI says otherwise. */
        if (!g_shellH) g_shellH = (unsigned)GetSystemMetrics(SM_CYSCREEN);
        /* The screen is now one row of columns, so the shell column is the full screen height
           unless SYSTEM.INI says otherwise. */
        if (!g_shellH) g_shellH = (unsigned)GetSystemMetrics(SM_CYSCREEN);
        if (g_shellW) {
            char b[64];
            /* The caption height lets the host tell the caption row of the chrome apart from
               the menu row below it, so each can be composited on its own terms. */
            wsprintf(b, "PVD %u %u %d v%d", g_shellW, g_shellH, GetSystemMetrics(SM_CYCAPTION), PVMON_VERSION);
            dbg(b);
        }
        if (g_live) { dbg("pvmon: live re-mode enabled"); find_user_state(); }
        if (g_shellW) install_hook();
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
        if (wParam == IDT_ARRANGE) {
            /* Arrange the shell as soon as Program Manager and its first group window exist,
               rather than after a fixed delay: the user otherwise watches it resize. */
            static int tries;
            HWND pm = FindWindow("Progman", NULL), mdi = pm ? GetWindow(pm, GW_CHILD) : NULL;
            if ((mdi && GetWindow(mdi, GW_CHILD)) || ++tries > ARRANGE_GIVEUP) {
                KillTimer(hwnd, IDT_ARRANGE);
                arrange_shell();
                dbg("PVA");                          /* host: the desktop is ready to show */
            }
        }
        else poll(hwnd);
        return 0;
    case WM_ENDSESSION:
        if (wParam) KillTimer(hwnd, IDT_POLL);
        return 0;
    case WM_DESTROY:
        remove_hook();
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
    g_hInst = hInst;
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
