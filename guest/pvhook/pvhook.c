/* PVHOOK.DLL - system-wide hooks for the responsive-wfw311 paravirtual desktop.
 *
 * One geometry invariant, enforced here at every path a window's rectangle can change:
 *
 *   No top-level window is ever larger than the phone frame (ShellWidth wide, at most the shell
 *   column's height), and every window lives inside its column: the shell in the desktop column
 *   (x = 0), applications in a 640-wide slot column to the right, owned windows (dialogs, message
 *   boxes) in their owner's column, placed where they do not cover the owner when there is room.
 *
 * The paths:
 *   - birth: HCBT_CREATEWND rewrites the CREATESTRUCT before the window exists, so it is born in
 *     the staging column (x = 640), phone-sized ([PVMon] DefaultSize / Size.<MODULE>).
 *   - maximise: WM_GETMINMAXINFO (a WH_CALLWNDPROC hook) sets the maximised size and position to
 *     "fill the column", so a maximised window is a real, zoomed window that the maximise box
 *     toggles back, and never the 2560-column screen.
 *   - any resize, by the program or the user: WM_WINDOWPOSCHANGING clamps cx/cy; owned windows
 *     are kept inside their owner's column.
 *   - fixed-layout programs (dialog-template main windows such as Task List and Sound Recorder,
 *     and any window without WS_THICKFRAME: Network Setup, Character Map) draw a layout of their
 *     own size and are never resized, only kept inside the frame; wider than a column they take
 *     two (PVMON). Maximise changes nothing for them (see clamp_minmax).
 *   - [PVMon] KeepSize modules with a thick frame (the games, Paintbrush, Packager) are not
 *     shrunk to the phone's width or DefaultSize, but a program that merely sizes itself to the
 *     2560-column screen (Paintbrush: 1280x892) is still clamped to one 640 slot and the shell
 *     height; maximise is a no-op for them too.
 *
 * PVMON loads this DLL, installs the hooks, and tells it the shell column's runtime height
 * (PvHookSetShell); it keeps its own poll-time parking as the fallback for anything created before
 * the hooks were in. System-wide hooks must live in a DLL, and a DLL's data segment is shared by
 * every task, so the tables here are visible from whichever program the hook runs in.
 *
 * Build: guest/pvhook/build.sh (Open Watcom, wlink system windows_dll).
 */
#include <windows.h>
#include <conio.h>

#define SLOT_W   640
#define ICON_ROW  88         /* rows at the bottom of the shell column kept free for minimised icons (icon + 2-line label) */

static HINSTANCE g_hInst;
static HHOOK g_cbt, g_cwp, g_mouse;
static int g_tapOpens = -1;          /* [PVMon] TapOpens: a single tap opens Program Manager items */
static int g_traceClip = 0;          /* [PVMon] TraceClip=1: log cursor clip changes from the mouse hook (diagnostic) */
static BOOL g_installed;
static int g_shellW, g_shellH;       /* the phone frame, from PVMON (runtime) or WIN.INI */
/* [PVMon] HookClamp=0 switches the size clamps off (WM_GETMINMAXINFO, WM_WINDOWPOSCHANGING, the
   HCBT_ACTIVATE self-size clamp, the CW_USEDEFAULT birth position) and logs what USER would have
   done instead: the measuring mode for FakeScreen (SPEC 2026-09-02). Birth sizing stays. */
static int g_hookClamp = 1;
/* The frame buffer's real height (PvHookSetReal, from PVMON). Under FakeScreen GetSystemMetrics
   answers the phone frame, but the slot columns are as tall as the frame buffer: an owned dialog
   goes below its owner only if the real column has room, or Notepad's Open box (318 tall under a
   600-tall owner in a 760 frame) lands centred on its owner and is captured twice. */
static int g_realH;
static int real_h(void) { return g_realH ? g_realH : GetSystemMetrics(SM_CYSCREEN); }
/* Desktop mode (PvHookSetDesktop, from PVMON on the host's CMD_DESKTOP): a wide viewport shows the
   whole screen 1:1, so there is no phone frame to keep windows inside, no slot columns and nothing
   to clamp. shell_w() answers 0 and every geometry path below passes the message through untouched;
   only the focus report (PVK) keeps running. A runtime switch, since a browser window is resized
   and a tablet rotated: the same hook serves both modes without a rebuild. */
static int g_desktop;

/* The WH_CALLWNDPROC hook's lParam points at the message's parameters as SendMessage pushed
   them (Windows 3.1 has no CWPSTRUCT typedef of its own). */
typedef struct { LPARAM lParam; WPARAM wParam; UINT message; HWND hwnd; } CWP16;

static BOOL same_i(const char FAR *a, const char FAR *b, int n)
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

static void module_base_i(HINSTANCE inst, char FAR *out, int outlen)
{
    char path[128]; char FAR *base; char FAR *p; int n;
    out[0] = 0;
    if (!inst || !GetModuleFileName(inst, path, sizeof(path))) return;
    base = path;
    for (p = path; *p; p++) if (*p == '\\' || *p == ':') base = p + 1;
    for (n = 0; base[n] && base[n] != '.' && n < outlen - 1; n++) out[n] = base[n];
    out[n] = 0;
}
static void module_base(HWND hwnd, char FAR *out, int outlen)
{
    module_base_i((HINSTANCE)GetWindowWord(hwnd, GWW_HINSTANCE), out, outlen);
}

/* The WIN.INI lists are read once (PvHookInstall / PvHookSetShell), never inside a hook call:
   GetProfileString does file I/O that can yield, and yielding from HCBT_SETFOCUS inside USER's
   menu loop left Write with all input dead (Notepad, whose Edit class needs no list, survived). */
static char g_keepList[160], g_kbdList[160];
static void load_lists(void)
{
    GetProfileString("PVMon", "KeepSize", "", g_keepList, sizeof(g_keepList));
    GetProfileString("PVMon", "KeyboardApps", "", g_kbdList, sizeof(g_kbdList));
}
static BOOL in_list(const char FAR *key, const char FAR *name)
{
    char FAR *list = lstrcmpi(key, "KeepSize") == 0 ? g_keepList : g_kbdList; char FAR *k;
    for (k = list; *k; ) {
        char FAR *e = k; int n;
        while (*e && *e != ' ' && *e != ',') e++;
        n = (int)(e - k);
        if (n == lstrlen(name) && same_i(k, name, n)) return TRUE;
        k = e; while (*k == ' ' || *k == ',') k++;
    }
    return FALSE;
}

static BOOL parse_size(const char FAR *val, int FAR *w, int FAR *h)
{
    const char FAR *p = val; *w = 0; *h = 0;
    for (; *p >= '0' && *p <= '9'; p++) *w = *w * 10 + (*p - '0');
    if (*p != 'x') return FALSE;
    for (p++; *p >= '0' && *p <= '9'; p++) *h = *h * 10 + (*p - '0');
    return *w >= 100 && *h >= 60;
}

#define PV_DISPI_INDEX 0x1CE
#define PV_DISPI_DATA  0x1CF
#define PV_REG_DEBUG   0x16
/* Index then data: PVMOUSE.DRV's interrupt handler writes the same index register, so the index
   is rewritten before every byte and read back after (no cli: a ring-3 cli/popf pair hung the
   system VM, see PVMON's rd/wr). */
static void pv_dbg(const char FAR *s)
{
    int tries;
    for (;; s++) {
        unsigned c = *s ? (unsigned char)*s : 10;
        for (tries = 4; tries; tries--) {
            outpw(PV_DISPI_INDEX, PV_REG_DEBUG);
            outpw(PV_DISPI_DATA, c);
            if (inpw(PV_DISPI_INDEX) == PV_REG_DEBUG) break;
        }
        if (!*s) break;
    }
}

static int shell_w(void)
{
    if (g_desktop) return 0;                                   /* desktop mode: nothing is clamped */
    if (!g_shellW) g_shellW = GetProfileInt("PVMon", "ShellWidth", 0);
    return g_shellW;
}
static int shell_h(void)
{
    if (!g_shellH) g_shellH = GetProfileInt("PVMon", "ShellHeight", 0);
    if (!g_shellH) g_shellH = GetSystemMetrics(SM_CYSCREEN);   /* boot: nothing is faked yet */
    return g_shellH;
}

/* Menus, drop-downs, the Alt+Tab switcher, icon titles: placed by Windows where they belong. */
static BOOL transient_class(const char FAR *cls)
{
    return lstrcmp(cls, "#32768") == 0 || lstrcmp(cls, "#32771") == 0 || lstrcmp(cls, "#32772") == 0 ||
           lstrcmp(cls, "ComboLBox") == 0 || lstrcmp(cls, "tooltips_class") == 0 ||
           lstrcmp(cls, "PVMonitor") == 0;
}

/* What we know about a top-level window, learned at birth (or on first sight) so the
   per-message hook never has to read WIN.INI. */
typedef struct { HWND hwnd; BOOL fixed; BOOL keep; int maxH; } WinInfo;
#define MAX_INFO 24
static WinInfo g_info[MAX_INFO];
/* Window handles are recycled: a record learned for one program's window must not answer for
   the next program that gets the handle (Solitaire born with a closed Notepad's handle would be
   "resizable" and clamped to 352). Forgotten at creation and destruction. */
static void forget_tiles(HWND hwnd);
static void forget(HWND hwnd)
{
    int i;
    for (i = 0; i < MAX_INFO; i++) if (g_info[i].hwnd == hwnd) g_info[i].hwnd = NULL;
    forget_tiles(hwnd);
}

/* Windows being destroyed. PVMON's poll touches every top-level window (GetWindowText,
   SetWindowPos: cross-task SendMessages inside USER); one sent to a window whose task is on its
   way out never returns until something else wakes the scheduler (Print Manager's spooler-off
   box: PVMON froze until Ctrl+Esc). The hook sees HCBT_DESTROYWND first and remembers the last
   few, and PVMON skips them (PvHookIsDead) while IsWindow still says yes. */
static HWND g_dead[8]; static int g_deadAt;
static BOOL g_dirty;             /* the hook published a list: PVMON must publish again after it */
static void mark_dead(HWND h) { g_dead[g_deadAt++ & 7] = h; }
/* Window handles are recycled quickly: a program launched right after another closed can get the
   dead one's handle, and PVMON would never publish it (Control Panel after File Manager, Media
   Player after Sound Recorder: launch timeouts). Creation clears the mark. */
static void unmark_dead(HWND h) { int i; for (i = 0; i < 8; i++) if (g_dead[i] == h) g_dead[i] = NULL; }
BOOL FAR PASCAL __export PvHookTakeDirty(void) { BOOL d = g_dirty; g_dirty = FALSE; return d; }
BOOL FAR PASCAL __export PvHookIsDead(HWND h)
{
    int i;
    for (i = 0; i < 8; i++) if (g_dead[i] == h) return TRUE;
    return FALSE;
}

static WinInfo *learn(HWND hwnd, const char FAR *cls, HINSTANCE inst, DWORD style)
{
    char mod[16], key[32], line[80];
    int i, free = -1, h;
    WinInfo *wi;
    static WinInfo tmp;
    for (i = 0; i < MAX_INFO; i++) {
        if (g_info[i].hwnd == hwnd) return &g_info[i];
        if (free < 0 && (g_info[i].hwnd == NULL || !IsWindow(g_info[i].hwnd))) free = i;
    }
    if (free < 0) free = 0;
    wi = &g_info[free];
    if (!inst) inst = (HINSTANCE)GetWindowWord(hwnd, GWW_HINSTANCE);
    mod[0] = 0;
    if (inst) module_base_i(inst, mod, sizeof(mod));
    if (!mod[0]) {
        /* Windows sends WM_GETMINMAXINFO from inside CreateWindow, before the window's instance
           is known; do not remember an answer given without it (only the class is known) */
        if (!style) style = GetWindowLong(hwnd, GWL_STYLE);
        tmp.hwnd = NULL; tmp.fixed = lstrcmp(cls, "#32770") == 0 || !(style & WS_THICKFRAME); tmp.keep = FALSE; tmp.maxH = 0;
        return &tmp;
    }
    wi->hwnd = hwnd;
    /* A program whose main window is a dialog template (Task List, Sound Recorder, Character
       Map, WinVer...) laid its controls out for one size and never re-lays them. A window without
       WS_THICKFRAME cannot be resized by the user, so its program never lays out to a new size
       either (Windows Setup's Network Setup: clamped, its text and list were simply cut off).
       These are fixed: never resized, the host scales them. */
    if (!style) style = GetWindowLong(hwnd, GWL_STYLE);
    wi->fixed = lstrcmp(cls, "#32770") == 0 || !(style & WS_THICKFRAME);
    /* A resizable window of a KeepSize module (the games, Paintbrush, Packager) draws a layout of
       its own size too: it is not shrunk to the phone or DefaultSize, but it is still held to one
       640 slot and the frame height (Paintbrush opens at half the 2560-column screen). */
    wi->keep = !wi->fixed && in_list("KeepSize", mod);
    wsprintf(key, "MaxHeight.%s", (LPSTR)mod);
    h = GetProfileInt("PVMon", key, 0);
    wi->maxH = (h > 100) ? h : 0;
    wsprintf(line, "pvhook: %s class %s %s", (LPSTR)mod, (LPSTR)cls, (LPSTR)(wi->fixed ? "fixed layout" : wi->keep ? "keep size" : "resizable"));
    pv_dbg(line);
    return wi;
}

/* The widest a resizable window may be: the phone's width, or one slot for a KeepSize module. */
static int max_w_for(const WinInfo FAR *wi)
{
    return (wi && wi->keep) ? SLOT_W : shell_w();
}

/* The frame a top-level window must fit: the shell column for the shell and anything owned by a
   window in the desktop column, else the phone frame inside its 640-wide slot column. */
static int frame_h_for(const WinInfo FAR *wi, BOOL isShell)
{
    int h = shell_h();
    if (isShell) return h - ICON_ROW;
    if (wi && wi->maxH && wi->maxH < h) return wi->maxH;
    return h;
}

/* Program Manager's Exit Windows box (and any other dialog its task puts up without an owner) is
   system modal: Windows centres it on the 2560-column screen and, while it is up, PVMON's timer
   never fires, so PVMON cannot park it. It has to be kept in the shell column from inside the
   shell's own task, which is where this hook runs. */
static BOOL shell_task(HWND hwnd)
{
    HWND pm = FindWindow("Progman", NULL);
    return pm && GetWindowTask(hwnd) == GetWindowTask(pm);
}

/* Keep the rectangle (x,y,w,h) inside a column; TRUE if it moved. */
static BOOL clamp_into(int FAR *x, int FAR *y, int w, int h, int colX, int colR, int frameH)
{
    int ox = *x, oy = *y;
    if (*x + w > colR) *x = colR - w;
    if (*x < colX) *x = colX;
    if (*y + h > frameH) *y = frameH - h;
    if (*y < 0) *y = 0;
    return *x != ox || *y != oy;
}

/* The window an unowned dialog "belongs" to: another visible top-level window of the same task
   (WinOldAp's "Application still active" box is owned by nothing but belongs to the DOS window;
   Task List's is a task of its own and has none). */
static HWND task_main_window(HWND hwnd)
{
    HTASK t = GetWindowTask(hwnd);
    HWND h;
    char c[24];
    for (h = GetWindow(GetDesktopWindow(), GW_CHILD); h; h = GetWindow(h, GW_HWNDNEXT)) {
        if (h == hwnd || !IsWindowVisible(h) || GetWindowTask(h) != t) continue;
        if (GetClassName(h, c, sizeof(c)) <= 0 || transient_class(c) || lstrcmp(c, "#32770") == 0) continue;
        if (GetWindow(h, GW_OWNER)) continue;
        return h;
    }
    return NULL;
}

/* PVMON publishes the layer list from its timer, but a system-modal box (Exit Windows, WinOldAp's
   "Application still active") holds the task lock and PVMON's timer never fires while it is up.
   The hook runs inside the locked task, so it publishes the list itself whenever a dialog window
   is activated or destroyed. Same lines as PVMON's publish_layout; slots are read off the
   columns PVMON parks windows in (slot n lives at x = 640 * (n + 1)). */
static int col_slot(int x) { return x >= SLOT_W ? x / SLOT_W - 1 : -1; }
static void describe(HWND hwnd, char FAR *line, const char FAR *tag, int slot)
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
static HWND dialog_owner(HWND hwnd, const char FAR *cls)
{
    HWND o = GetWindow(hwnd, GW_OWNER);
    if (!o && lstrcmp(cls, "#32770") == 0) o = task_main_window(hwnd);
    return o;
}
static HWND g_force;      /* the window being activated: not yet marked visible, but on its way */
static char hook_kind(HWND h, HWND skip, char FAR *cls, HWND FAR *owner)
{
    if (h == skip || (!IsWindowVisible(h) && h != g_force) || GetClassName(h, cls, 24) <= 0) return 0;
    if (lstrcmp(cls, "PVMonitor") == 0 || lstrcmp(cls, "#32772") == 0) return 0;
    if (transient_class(cls)) return 'T';
    if (lstrcmp(cls, "Progman") == 0) return 'S';
    *owner = dialog_owner(h, cls);
    if (*owner && IsIconic(*owner)) {
        /* a dialog of an iconic program has nothing to be drawn over; the shell's (Exit Windows
           from the minimised Program Manager's icon menu) lives in the desktop column and is
           reported: leaving it out was the "PVO -1 line missing" case */
        char oc[16];
        if (GetClassName(*owner, oc, sizeof(oc)) <= 0 || lstrcmp(oc, "Progman") != 0) return 0;
    }
    if (IsIconic(h)) return 'I';
    if (*owner && IsWindow(*owner) && IsWindowVisible(*owner)) return 'O';
    return 'A';
}

/* ---------------------------------------------------------------------------- popup tiles ---
   A menu or drop-down is placed by USER directly over the window it belongs to, and Windows 3.1
   keeps no backing store: the pixels underneath are gone until their owner repaints, which is
   what the masking and hold hacks in the host compositor exist to hide. The screen is wider than
   the part the host shows -- the adapter's pitch has always been 4096 pixels while the visible
   part is 2560 -- so a popup is moved into that off-screen margin and given a tile of its own.
   It paints there, destroys nobody's pixels, and the host draws it over the item it belongs to
   from the anchor published with it. */
#define VIS_W  2560            /* the part of the screen the host composites */
#define VIS_H  970             /* ...and how much of it is visible; below that is tile space */
/* Tiles live BELOW the visible rows, never beside them. They were beside them first, in the
   columns between 2560 and the 4096-pixel pitch, which cost nothing in memory -- but it made the
   screen 4096 wide, and the frame buffer is converted to pixels a dirty row at a time: every row
   became 1.6x more work for the phone, on every frame, whether a popup existed or not. Below the
   visible rows the width stays 2560 and a row costs what it always did. */
#define TILE_W 512
#define TILES  3               /* a menu, its submenu, and one to spare */
#define TILE_Y VIS_H           /* popups: one row of tiles straight under the visible screen */
#define TILE_H 280             /* ...and the dialogs start after them */
#define SCREEN_H 1792          /* the whole screen: visible rows, popup tiles, dialog tiles.
                                  Every row of it is a row of the pixel buffer the browser keeps
                                  (width x height x 4 bytes), and a phone kills a tab that asks
                                  for too much: this is as tall as the tiles actually need. */
/* Dialogs are wider than a popup tile and there are more of them, so they get the strip below the
   visible rows: six columns of SLOT_W, each the full height of the off-screen area. A dialog that
   does not fit one stays where it would have gone, in its owner's column, and the compositor's
   older masking still covers it. */
#define DLG_W  SLOT_W
#define DLG_TILES 4
#define DLG_Y  (VIS_H + TILE_H)
typedef struct { HWND hwnd; int ax, ay; } Popup;
static Popup g_popup[TILES];
static Popup g_dlg[DLG_TILES];
static int popup_tile(HWND h, int ax, int ay)
{
    int i, free = -1;
    for (i = 0; i < TILES; i++) {
        if (g_popup[i].hwnd == h) { g_popup[i].ax = ax; g_popup[i].ay = ay; return i; }
        if (free < 0 && (!g_popup[i].hwnd || !IsWindow(g_popup[i].hwnd) || !IsWindowVisible(g_popup[i].hwnd)))
            free = i;
    }
    if (free < 0) return -1;                       /* all busy: leave this one where USER put it */
    g_popup[free].hwnd = h; g_popup[free].ax = ax; g_popup[free].ay = ay;
    return free;
}
/* Window handles are recycled. A tile entry left behind by a window that has gone would answer
   for whatever program is given the handle next -- and everything that asks "is this window in a
   tile?" would then leave the new window alone: unclamped, unfitted, drifting a few pixels off
   the column (Program Manager published at 3,8 instead of 0,0). Entries die with their window,
   at creation and destruction, and a lookup checks the window is still there. */
static void forget_tiles(HWND hwnd)
{
    int i;
    for (i = 0; i < TILES; i++) if (g_popup[i].hwnd == hwnd) g_popup[i].hwnd = NULL;
    for (i = 0; i < DLG_TILES; i++) if (g_dlg[i].hwnd == hwnd) g_dlg[i].hwnd = NULL;
}
static BOOL popup_anchor(HWND h, int FAR *ax, int FAR *ay)
{
    int i;
    if (!h || !IsWindow(h)) return FALSE;
    for (i = 0; i < TILES; i++)
        if (g_popup[i].hwnd == h) { *ax = g_popup[i].ax; *ay = g_popup[i].ay; return TRUE; }
    for (i = 0; i < DLG_TILES; i++)
        if (g_dlg[i].hwnd == h) { *ax = g_dlg[i].ax; *ay = g_dlg[i].ay; return TRUE; }
    return FALSE;
}
/* A tile below the visible rows for an owned window. The anchor is where it would have been put
   in its owner's column, which is what the host still uses to decide where to draw it. */
static int dialog_tile(HWND h, int ax, int ay)
{
    int i, free = -1;
    for (i = 0; i < DLG_TILES; i++) {
        if (g_dlg[i].hwnd == h) { g_dlg[i].ax = ax; g_dlg[i].ay = ay; return i; }
        if (free < 0 && (!g_dlg[i].hwnd || !IsWindow(g_dlg[i].hwnd) || !IsWindowVisible(g_dlg[i].hwnd)))
            free = i;
    }
    if (free < 0) return -1;
    g_dlg[free].hwnd = h; g_dlg[free].ax = ax; g_dlg[free].ay = ay;
    return free;
}
/* PVMON publishes the same window list from its own poll, so it needs the anchors too. */
BOOL FAR PASCAL __export PvHookPopupAnchor(HWND h, int FAR *ax, int FAR *ay) { return popup_anchor(h, ax, ay); }

static void hook_publish(HWND skip)
{
    HWND h, first, owner = NULL; int n = 0; char line[128], cls[24], k;
    RECT rc;
    first = GetWindow(GetDesktopWindow(), GW_CHILD);
    for (h = first; h; h = GetWindow(h, GW_HWNDNEXT)) if (hook_kind(h, skip, cls, &owner)) n++;
    wsprintf(line, "PVB %d", n); pv_dbg(line);
    for (h = first ? GetWindow(first, GW_HWNDLAST) : NULL; h; h = GetWindow(h, GW_HWNDPREV)) {
        owner = NULL;
        k = hook_kind(h, skip, cls, &owner);
        if (!k) continue;
        GetWindowRect(h, &rc);
        switch (k) {
        case 'S': describe(h, line, "PVS", -1); break;
        case 'T': describe(h, line, "PVT", -1);
                  { int m = lstrlen(line), ax, ay;
                    if (m + lstrlen(cls) + 2 < 128) { line[m] = ' '; lstrcpy(line + m + 1, cls); m = lstrlen(line); }
                    /* where it would have popped up: the host draws it over the item it belongs
                       to, not at the tile it actually paints in */
                    if (popup_anchor(h, &ax, &ay) && m + 24 < 128) wsprintf(line + m, " @%d,%d", ax, ay); }
                  break;
        case 'O': { RECT orc; int hops, ax, ay, m; HWND o = owner;
                    for (hops = 0; o && hops < 8 && GetWindow(o, GW_OWNER); hops++) o = GetWindow(o, GW_OWNER);
                    GetWindowRect(o, &orc); describe(h, line, "PVO", col_slot(orc.left));
                    m = lstrlen(line);
                    /* parked in a tile below the visible rows: say where it belongs */
                    if (popup_anchor(h, &ax, &ay) && m + 24 < 128) wsprintf(line + m, " @%d,%d", ax, ay);
                    break; }
        case 'A': describe(h, line, rc.left >= SLOT_W ? "PVW" : "PVX", col_slot(rc.left)); break;
        case 'I': { char t[24]; t[0] = 0; GetWindowText(h, t, sizeof(t)); wsprintf(line, "PVI %d %s", -1, (LPSTR)t); break; }
        }
        pv_dbg(line);
    }
    pv_dbg("PVE");
    g_dirty = TRUE;
}

/* Where an owned window goes so that it covers as little of its owner as possible: below the
   owner if the column has room, else to its right inside the 640-wide slot, else centred on it.
   The host draws owned windows as their own layers anchored over the owner, so the user sees one
   dialog centred on its program; what this buys is that the owner's own client area, which the
   host captures from the frame buffer, no longer contains the dialog too. Dialogs owned by the
   shell stay inside the shell column, which the phone shows as the desktop. */
static void place_owned(HWND dlg, HWND owner, int w, int h, int FAR *px, int FAR *py)
{
    RECT orc;
    int colX, colR, frameH, x, y;
    GetWindowRect(owner, &orc);
    if (IsIconic(owner)) { orc.left = 0; orc.top = 0; orc.right = shell_w(); orc.bottom = shell_h(); }
    if (orc.left < SLOT_W) {                          /* the shell's, or something in the desktop column */
        colX = 0; colR = shell_w(); frameH = shell_h();
        x = (orc.left + orc.right - w) / 2;
        y = (orc.top + orc.bottom - h) / 2;
    } else {
        colX = (orc.left / SLOT_W) * SLOT_W; colR = colX + SLOT_W; frameH = real_h();
        if (orc.bottom + h <= frameH)      { x = orc.left;  y = orc.bottom; }
        else if (orc.right + w <= colR)    { x = orc.right; y = orc.top; }
        else { x = (orc.left + orc.right - w) / 2; y = (orc.top + orc.bottom - h) / 2; }
    }
    if (x + w > colR) x = colR - w;
    if (x < colX) x = colX;
    if (y + h > frameH) y = frameH - h;
    if (y < 0) y = 0;
    *px = x; *py = y;
    /* ...and then it goes to a tile below the visible rows instead, so it paints without taking
       its owner's pixels with it. What was computed above is kept as the anchor: the host still
       decides where an owned window is drawn, and the anchor is what tells it which column and
       which owner the dialog belongs to. */
    if (dlg && w <= DLG_W && h <= (int)(SCREEN_H - DLG_Y)) {
        int t = dialog_tile(dlg, x, y);
        if (t >= 0) { *px = t * DLG_W; *py = DLG_Y; }
    }
}

/* A MessageBox wider than the phone (Print Manager's "has been turned off" is 924 wide at the
   20 px font): USER lays its text out on one or two long lines. The box is a plain dialog with
   Static and Button children, so it can be re-laid natively: the text control is narrowed to the
   phone and its wrapped height measured with DrawText, the buttons move down by the growth and are
   re-centred, and the box itself becomes ShellWidth wide and that much taller. Done at
   HCBT_ACTIVATE, before the box has painted. Only USER's own dialogs (message boxes) qualify;
   programs' dialogs are laid out by their templates and are left alone (reported by PVQ). */
static void fix_msgbox(HWND dlg)
{
    RECT dr, cr, r; HWND h, txt = NULL, btn[8];
    char cls[16], text[512];
    int w, frameW, newClientW, availW, oldH, newH, delta, i, n = 0, left = 0x7fff, right = -0x7fff, shift, x, colX, colR;
    GetWindowRect(dlg, &dr); w = dr.right - dr.left;
    if (w <= shell_w()) return;
    GetClientRect(dlg, &cr);
    frameW = w - cr.right;
    newClientW = shell_w() - frameW;
    for (h = GetWindow(dlg, GW_CHILD); h; h = GetWindow(h, GW_HWNDNEXT)) {
        if (GetClassName(h, cls, sizeof(cls)) <= 0) continue;
        if (lstrcmpi(cls, "Static") == 0) {
            if ((GetWindowLong(h, GWL_STYLE) & 0x0F) == SS_ICON) continue;
            if (GetWindowTextLength(h) > 0) txt = h;
        } else if (lstrcmpi(cls, "Button") == 0 && n < 8) btn[n++] = h;
    }
    if (!txt || !n) return;
    GetWindowRect(txt, &r);
    ScreenToClient(dlg, (POINT FAR *)&r); ScreenToClient(dlg, (POINT FAR *)&r.right);
    availW = newClientW - r.left - 8;
    if (availW < 60) return;
    oldH = r.bottom - r.top;
    {
        HDC hdc = GetDC(txt);
        HFONT f = (HFONT)SendMessage(txt, WM_GETFONT, 0, 0L), old = NULL;
        RECT m;
        if (!hdc) return;
        if (f) old = SelectObject(hdc, f);
        GetWindowText(txt, text, sizeof(text));
        m.left = 0; m.top = 0; m.right = availW; m.bottom = 0;
        DrawText(hdc, text, -1, &m, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX | DT_EXPANDTABS);
        newH = m.bottom;
        if (old) SelectObject(hdc, old);
        ReleaseDC(txt, hdc);
    }
    delta = newH > oldH ? newH - oldH : 0;
    SetWindowPos(txt, NULL, r.left, r.top, availW, newH, SWP_NOZORDER | SWP_NOACTIVATE);
    for (i = 0; i < n; i++) {
        GetWindowRect(btn[i], &r);
        ScreenToClient(dlg, (POINT FAR *)&r); ScreenToClient(dlg, (POINT FAR *)&r.right);
        if (r.left < left) left = r.left;
        if (r.right > right) right = r.right;
    }
    shift = (newClientW - (right - left)) / 2 - left;
    for (i = 0; i < n; i++) {
        GetWindowRect(btn[i], &r);
        ScreenToClient(dlg, (POINT FAR *)&r);
        SetWindowPos(btn[i], NULL, r.left + shift, r.top + delta, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
    }
    if (dr.left < SLOT_W) { colX = 0; colR = shell_w(); }
    else { colX = (dr.left / SLOT_W) * SLOT_W; colR = colX + SLOT_W; }
    x = dr.left;
    if (x + shell_w() > colR) x = colR - shell_w();
    if (x < colX) x = colX;
    SetWindowPos(dlg, NULL, x, dr.top, shell_w(), dr.bottom - dr.top + delta, SWP_NOZORDER | SWP_NOACTIVATE);
    wsprintf(text, "pvhook: message box %dx%d -> %dx%d (text +%d)", w, dr.bottom - dr.top, shell_w(), dr.bottom - dr.top + delta, delta);
    pv_dbg(text);
}

/* PVK: what has the focus, not a guess from the window title.
 *
 * The host used to decide whether to raise the soft keyboard from a regex over window titles
 * (`MS-DOS|^Notepad|...|High Score|Name|Enter `) plus a per-app veto list. Every new dialog needed
 * a new entry (JezzBall's high-score box was the last), and a game on the veto list vetoed its own
 * text dialog. The line below reports the facts Windows itself exposes about the focused window,
 * and the host decides from those:
 *
 *     PVK <0|1> <class> <flags>
 *
 * <class> is the focused window's class ('-' if it has none, spaces mapped to '_'), <flags> a
 * string of letters:
 *     e  class Edit
 *     r  ... with ES_READONLY (takes no typing)
 *     c  class ComboBox, or the Edit child of one
 *     t  class tty (the WinOldAp DOS grabber)
 *     n  a class that is known never to take text (Button, Static, ScrollBar, ListBox, ComboLBox,
 *        a #NNNNN system class, MDIClient, PMGroup, Progman)
 *     k  the focused window's program is in [PVMon] KeyboardApps
 *     a  the focused window owns the caret  (PVMON only: see caret_owner(), the caret is created
 *        by the app's WM_SETFOCUS handler, which has not run yet when this hook fires)
 * want = (e|c|t|k|a) && !r && !n. The old `PVK 0`/`PVK 1` prefix is unchanged, so a host that
 * only reads the digit still works, and a class the guest cannot classify is learned by the host
 * (caption-hold while it has the focus) rather than added to a table here.
 */
#define PV_ES_READONLY 0x0800L
static BOOL pv_nontext_class(const char FAR *cls)
{
    return lstrcmpi(cls, "Button") == 0 || lstrcmpi(cls, "Static") == 0 || lstrcmpi(cls, "ScrollBar") == 0 ||
           lstrcmpi(cls, "ListBox") == 0 || lstrcmpi(cls, "ComboLBox") == 0 || cls[0] == '#' ||
           lstrcmpi(cls, "MDIClient") == 0 || lstrcmp(cls, "PMGroup") == 0 || lstrcmp(cls, "Progman") == 0;
}
/* Fills cls (>= 24 bytes) and fl (>= 12 bytes); returns want. caretOwner is the window that owns
   the caret, or NULL when unknown (the hook) -- never a reason to say "no". */
static int focus_report(HWND f, HWND caretOwner, char FAR *cls, char FAR *fl)
{
    int n = 0, text = 0, no = 0; char FAR *p;
    cls[0] = 0; fl[0] = 0;
    if (!f || GetClassName(f, cls, 24) <= 0) { lstrcpy(cls, "-"); return 0; }
    for (p = cls; *p; p++) if (*p == ' ') *p = '_';
    if (lstrcmpi(cls, "Edit") == 0) {
        fl[n++] = 'e'; text = 1;
        if (GetWindowLong(f, GWL_STYLE) & PV_ES_READONLY) { fl[n++] = 'r'; no = 1; }
    }
    if (lstrcmpi(cls, "ComboBox") == 0) { fl[n++] = 'c'; text = 1; }
    else if (!text) {                              /* a combo box's edit child reports as Edit already */
        char pcls[24]; HWND parent = GetParent(f);
        if (parent && GetClassName(parent, pcls, sizeof(pcls)) > 0 && lstrcmpi(pcls, "ComboBox") == 0) { fl[n++] = 'c'; text = 1; }
    }
    if (lstrcmpi(cls, "tty") == 0) { fl[n++] = 't'; text = 1; }
    if (pv_nontext_class(cls)) { fl[n++] = 'n'; no = 1; }
    if (!no) {
        /* Programs that take text in a window of their own class (Write's document, Cardfile's
           card, Terminal, a DOS box). The caret below is the general form of this; the list stays
           as the fallback for when the caret cannot be located in USER's data. */
        HWND top = f; char mod[16]; int hops;
        for (hops = 0; hops < 8 && (GetWindowLong(top, GWL_STYLE) & WS_CHILD); hops++) top = GetParent(top);
        module_base(top, mod, sizeof(mod));
        if (mod[0] && in_list("KeyboardApps", mod)) { fl[n++] = 'k'; text = 1; }
        if (caretOwner && caretOwner == f) { fl[n++] = 'a'; text = 1; }
    }
    fl[n] = 0;
    if (!n) { fl[0] = '-'; fl[1] = 0; }
    return text && !no;
}
static void focus_line(HWND f, HWND caretOwner, char FAR *out)
{
    char cls[24], fl[12];
    int want = focus_report(f, caretOwner, cls, fl);
    wsprintf(out, "PVK %d %s %s", want, (LPSTR)cls, (LPSTR)fl);
}

LRESULT CALLBACK __export PvCbtProc(int code, WPARAM wParam, LPARAM lParam)
{
    if (code == HCBT_SETFOCUS) {
        /* The host must know the moment a text control takes the focus: iOS only shows its
           keyboard inside the touch gesture that caused it, so a poll 100 ms later is too late. */
        HWND f = (HWND)wParam;
        if (f) { char line[64]; focus_line(f, NULL, line); pv_dbg(line); }
    }
    if (code == HCBT_ACTIVATE && shell_w()) {
        HWND h = (HWND)wParam;
        char cls[24];
        if (h && !(GetWindowLong(h, GWL_STYLE) & WS_CHILD) && !IsIconic(h) && !IsZoomed(h) &&
            !GetWindow(h, GW_OWNER) && GetClassName(h, cls, sizeof(cls)) > 0 &&
            !transient_class(cls) && lstrcmp(cls, "Progman") != 0 && lstrcmp(cls, "#32770") != 0) {
            WinInfo *wi = learn(h, cls, NULL, 0);
            if (wi->fixed) {
                /* never resized, but it must sit in one column: Task List centres itself on the
                   2560-column screen (x = 1095) and would straddle two slots */
                RECT rc; int colX;
                GetWindowRect(h, &rc);
                colX = rc.left < SLOT_W ? SLOT_W : (rc.left / SLOT_W) * SLOT_W;
                if (rc.left < SLOT_W || rc.right > colX + SLOT_W || rc.top < 0)
                    SetWindowPos(h, NULL, colX, 0, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
            }
            if (!wi->fixed) {
                RECT rc; int maxH = frame_h_for(wi, FALSE), maxW = max_w_for(wi), w, ht;
                GetWindowRect(h, &rc);
                w = rc.right - rc.left; ht = rc.bottom - rc.top;
                if (w > maxW || ht > maxH) {
                    char line[80];
                    wsprintf(line, "pvhook: %s sized itself %dx%d, %s to %dx%d", (LPSTR)cls, w, ht,
                             (LPSTR)(g_hookClamp ? "clamped" : "NOT clamped (HookClamp=0)"),
                             w > maxW ? maxW : w, ht > maxH ? maxH : ht);
                    pv_dbg(line);
                    if (g_hookClamp)
                        SetWindowPos(h, NULL, rc.left, rc.top, w > maxW ? maxW : w, ht > maxH ? maxH : ht,
                                     SWP_NOZORDER | SWP_NOACTIVATE);
                }
            }
        }
    }
    if (code == HCBT_ACTIVATE && shell_w()) {
        HWND h = (HWND)wParam;
        char cls[24], mod[16];
        if (h && GetClassName(h, cls, sizeof(cls)) > 0 && lstrcmp(cls, "#32770") == 0 && !(GetWindowLong(h, GWL_STYLE) & WS_CHILD)) {
            module_base(h, mod, sizeof(mod));
            if (lstrcmpi(mod, "USER") == 0) fix_msgbox(h);        /* a MessageBox */
        }
    }
    if (code == HCBT_DESTROYWND && wParam && !(GetWindowLong((HWND)wParam, GWL_STYLE) & WS_CHILD)) {
        /* Tell the host the moment a top-level window is going, BEFORE Windows erases the area to
           the desktop colour: the compositor measured the erase reaching it ~200 ms before the
           shell's next publish, which is the grey flash on a close. The rectangle is what will be
           uncovered; the host holds those pixels until the window behind has actually painted. */
        HWND dw = (HWND)wParam;
        forget_tiles(dw);                    /* its tile is free, and the handle will be reused */
        if (IsWindowVisible(dw) && !IsIconic(dw)) {
            RECT dr; char db[80];
            GetWindowRect(dw, &dr);
            wsprintf(db, "PVZ %d %d %d %d", dr.left, dr.top, dr.right - dr.left, dr.bottom - dr.top);
            pv_dbg(db);
        }
        mark_dead(dw); forget(dw);
    }
    if ((code == HCBT_ACTIVATE || code == HCBT_DESTROYWND || code == HCBT_SETFOCUS) && shell_w()) {
        char cls[24];
        HWND h = (HWND)wParam;
        if (code == HCBT_SETFOCUS) {                      /* the focus lands in a dialog once it is up */
            int hops;
            for (hops = 0; h && hops < 8 && (GetWindowLong(h, GWL_STYLE) & WS_CHILD); hops++) h = GetParent(h);
        }
        if (h && GetClassName(h, cls, sizeof(cls)) > 0 && lstrcmp(cls, "#32770") == 0 && !(GetWindowLong(h, GWL_STYLE) & WS_CHILD)) {
            if (code != HCBT_DESTROYWND && !GetWindow(h, GW_OWNER) && !shell_task(h) && !task_main_window(h)) {
                /* a dialog that is a program of its own (Task List) centred itself on the screen:
                   put it at the top of the column it fell in before it is reported */
                RECT rc; int colX;
                GetWindowRect(h, &rc);
                colX = rc.left < SLOT_W ? SLOT_W : (rc.left / SLOT_W) * SLOT_W;
                if (rc.left < SLOT_W || rc.right > colX + SLOT_W || rc.top < 0)
                    SetWindowPos(h, NULL, colX, 0, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
            }
            /* A dialog being activated, or taking the focus (WM_INITDIALOG, before it is shown), is
               not yet marked visible: report it anyway, it is on its way up. Publishing only at
               activation left the last list without Exit Windows when the focus landed after. */
            g_force = (code != HCBT_DESTROYWND) ? h : NULL;
            hook_publish(code == HCBT_DESTROYWND ? h : NULL);
            g_force = NULL;
        }
    }
    if (code == HCBT_CREATEWND) { unmark_dead((HWND)wParam); forget((HWND)wParam); }
    if (code == HCBT_CREATEWND) {
        HWND hwnd = (HWND)wParam;
        LPCBT_CREATEWND cbt = (LPCBT_CREATEWND)lParam;
        LPCREATESTRUCT cs = cbt->lpcs;
        char cls[24], mod[16], key[64], val[24];
        int w, h;
        WinInfo *wi;
        if (!shell_w()) goto pass;                                /* not the phone layout */
        if (cs->style & WS_CHILD) goto pass;
        if (GetClassName(hwnd, cls, sizeof(cls)) <= 0) goto pass;
        if (transient_class(cls) || lstrcmp(cls, "Progman") == 0) goto pass;
        if (cs->hwndParent && IsWindow(cs->hwndParent)) {
            /* owned: dialogs placed by Windows relative to their owner, or in screen coordinates
               by their program, would otherwise land anywhere on the 2560-column screen */
            w = cs->cx; h = cs->cy;
            if (w <= 0 || h <= 0) goto pass;                      /* CW_USEDEFAULT: let Windows decide */
            place_owned(hwnd, cs->hwndParent, w, h, &cs->x, &cs->y);
            goto pass;
        }
        if (lstrcmp(cls, "#32770") == 0 && !shell_task(hwnd) && cs->cx > 0 && cs->cy > 0) {
            HWND o = task_main_window(hwnd);            /* WinOldAp's box belongs to the DOS window */
            if (o) { place_owned(hwnd, o, cs->cx, cs->cy, &cs->x, &cs->y); goto pass; }
        }
        if (lstrcmp(cls, "#32770") == 0 && shell_task(hwnd) && cs->cx > 0 && cs->cy > 0) {
            int ax = (shell_w() - cs->cx) / 2, ay = (shell_h() - cs->cy) / 2, t;
            if (ax < 0) ax = 0;
            if (ay < 0) ay = 0;
            cs->x = ax; cs->y = ay;
            /* the shell's own dialogs tile too: their copy in the desktop column is what the
               compositor used to have to paint over */
            if (cs->cx <= DLG_W && cs->cy <= (int)(SCREEN_H - DLG_Y) && (t = dialog_tile(hwnd, ax, ay)) >= 0) {
                cs->x = t * DLG_W; cs->y = DLG_Y;
            }
            goto pass;
        }
        /* a top-level application window: born in the staging column, phone-sized unless it
           draws a fixed layout */
        wi = learn(hwnd, cls, cs->hInstance, cs->style);
        module_base_i(cs->hInstance, mod, sizeof(mod));
        wsprintf(key, "Size.%s", (LPSTR)mod);
        if (GetProfileString("PVMon", key, "", val, sizeof(val)) && parse_size(val, &w, &h)) {
            cs->cx = w; cs->cy = h;
        } else if (!wi->fixed && !wi->keep &&
                   GetProfileString("PVMon", "DefaultSize", "", val, sizeof(val)) && parse_size(val, &w, &h)) {
            if (cs->cx == CW_USEDEFAULT || cs->cx > w) cs->cx = w;
            if (cs->cy == CW_USEDEFAULT || cs->cy > h) cs->cy = h;
        }
        if (!wi->fixed && cs->cx != CW_USEDEFAULT) {              /* the invariant, at birth */
            if (cs->cx > max_w_for(wi)) cs->cx = max_w_for(wi);
            if (cs->cy > frame_h_for(wi, FALSE)) cs->cy = frame_h_for(wi, FALSE);
        }
        if (cs->cx == CW_USEDEFAULT || cs->x == CW_USEDEFAULT) {
            wsprintf(key, "pvhook: %s born CW_USEDEFAULT %s%s", (LPSTR)mod, (LPSTR)(cs->x == CW_USEDEFAULT ? "pos " : ""),
                     (LPSTR)(cs->cx == CW_USEDEFAULT ? "size" : ""));
            pv_dbg(key);
            if (!g_hookClamp && cs->x == CW_USEDEFAULT) goto pass;    /* measuring: USER's cascade, PVMON parks it */
        }
        cs->x = SLOT_W; cs->y = 0;
    }
pass:
    return CallNextHookEx(g_cbt, code, wParam, lParam);
}

/* Maximise means "fill the column": the window really is zoomed, so the maximise box turns into
   the restore box and toggles back, but the zoomed rectangle is the phone frame at the top of the
   window's own column, never the whole screen. For fixed-layout and KeepSize programs (Solitaire,
   Hearts, Minesweeper, Calculator, Character Map, Sound Recorder, Media Player, Task List...)
   maximise is a no-op: the zoomed rectangle is the window's own normal rectangle, size and
   position, so nothing visible changes and restore puts back the same. (Before, the zoomed size
   was the normal size but at the top of the column, and PVMON's park then "restored" a zoomed
   Solitaire wider than the phone to 352: clipped cards, and the restore box had nothing to do.) */
static void clamp_minmax(HWND hwnd, MINMAXINFO FAR *mmi)
{
    char cls[24];
    BOOL isShell;
    WinInfo *wi = NULL;
    WINDOWPLACEMENT wp;
    int colX = SLOT_W, w, h;
    if (GetWindowLong(hwnd, GWL_STYLE) & WS_CHILD) return;
    if (GetWindow(hwnd, GW_OWNER)) return;                       /* dialogs do not maximise */
    if (GetClassName(hwnd, cls, sizeof(cls)) <= 0 || transient_class(cls)) return;
    isShell = lstrcmp(cls, "Progman") == 0;
    if (!g_hookClamp) {
        /* measuring: what USER offers (its defaults come from the screen metrics), once per change */
        static HWND lastH; static int lastX, lastY;
        if (hwnd != lastH || mmi->ptMaxSize.x != lastX || mmi->ptMaxSize.y != lastY) {
            char line[96];
            lastH = hwnd; lastX = mmi->ptMaxSize.x; lastY = mmi->ptMaxSize.y;
            wsprintf(line, "pvhook: minmax %s default max %dx%d at %d,%d track %dx%d (not clamped)", (LPSTR)cls,
                     mmi->ptMaxSize.x, mmi->ptMaxSize.y, mmi->ptMaxPosition.x, mmi->ptMaxPosition.y,
                     mmi->ptMaxTrackSize.x, mmi->ptMaxTrackSize.y);
            pv_dbg(line);
        }
        return;
    }
    if (!isShell) wi = learn(hwnd, cls, NULL, 0);
    wp.length = sizeof(wp);
    if (!isShell && GetWindowPlacement(hwnd, &wp) && wp.rcNormalPosition.left >= SLOT_W)
        colX = (wp.rcNormalPosition.left / SLOT_W) * SLOT_W;   /* the column it lives in, even when iconic */
    if (isShell) { colX = 0; w = shell_w(); h = frame_h_for(NULL, TRUE); }
    else if (wi->fixed || wi->keep) {
        int maxW = wi->fixed ? 2 * SLOT_W : SLOT_W, maxH = wi->fixed ? real_h() : frame_h_for(wi, FALSE);
        w = wp.rcNormalPosition.right - wp.rcNormalPosition.left;
        h = wp.rcNormalPosition.bottom - wp.rcNormalPosition.top;
        if (w < 100 || h < 60) return;                 /* still being built (Minesweeper sizes itself later) */
        if (w > maxW) w = maxW;
        if (h > maxH) h = maxH;
        mmi->ptMaxSize.x = w; mmi->ptMaxSize.y = h;
        mmi->ptMaxPosition.x = wp.rcNormalPosition.left; mmi->ptMaxPosition.y = wp.rcNormalPosition.top;
        if (wi->keep) { mmi->ptMaxTrackSize.x = maxW; mmi->ptMaxTrackSize.y = maxH; }   /* drag-sizing stays in the slot */
        return;
    }
    else { w = shell_w(); h = frame_h_for(wi, FALSE); }
    mmi->ptMaxSize.x = w; mmi->ptMaxSize.y = h;
    mmi->ptMaxPosition.x = colX; mmi->ptMaxPosition.y = 0;
    mmi->ptMaxTrackSize.x = w; mmi->ptMaxTrackSize.y = h;
}

/* WM_WINDOWPOSCHANGING, when it reaches this hook: applications are clamped to the frame; owned
   windows are kept inside their owner's column (the shell column for the shell's dialogs, which
   is what the phone shows as the desktop: a Windows-centred message box would otherwise sit at
   x = 1100). Observed: USER 3.1 sends WM_GETMINMAXINFO through a path this hook sees (dozens of
   times per window) but its SetWindowPos-internal WM_WINDOWPOSCHANGING does not arrive here, so
   the size invariant for programs that size themselves after creation (PIF Editor, Packager) is
   enforced at HCBT_ACTIVATE above and by PVMON's park() instead; this stays as belt and braces. */
static void clamp_windowpos(HWND hwnd, WINDOWPOS FAR *wp)
{
    char cls[24];
    HWND owner;
    if ((wp->flags & SWP_NOSIZE) && (wp->flags & SWP_NOMOVE)) return;
    if (GetWindowLong(hwnd, GWL_STYLE) & WS_CHILD) return;
    if (IsIconic(hwnd) || (wp->cx <= 64 && wp->cy <= 64 && !(wp->flags & SWP_NOSIZE))) return;  /* icons */
    /* A dialog already parked in a tile is left alone: the clamps below are the column's, not
       its. A popup is NOT skipped here -- Windows keeps one menu window and shows it again and
       again at a new place each time, so it has to be re-tiled (and its anchor updated) on every
       show. Skipping it left the menu painting where USER put it, over the window it belongs to,
       while the host drew it a second time at the anchor of the menu before it. */
    { int i;
      for (i = 0; i < DLG_TILES; i++) if (g_dlg[i].hwnd == hwnd && IsWindow(hwnd)) return; }
    if (GetClassName(hwnd, cls, sizeof(cls)) <= 0) return;
    if (transient_class(cls)) {
        /* Menus and drop-downs are relocated, not clamped: each gets a tile in the off-screen
           margin (popup_tile above). PVMON's own window shares the class test but is never a
           popup, and a menu wider than a tile stays where USER put it. */
        if (!(wp->flags & SWP_NOMOVE) && wp->x >= 0 && wp->x < VIS_W && lstrcmp(cls, "PVMonitor") != 0) {
            int w = (wp->flags & SWP_NOSIZE) ? 0 : wp->cx, t;
            if (!w) { RECT rc; GetWindowRect(hwnd, &rc); w = rc.right - rc.left; }
            if (w > 0 && w <= TILE_W && (t = popup_tile(hwnd, wp->x, wp->y)) >= 0) {
                wp->x = t * TILE_W;
                wp->y = TILE_Y;
            }
        }
        return;
    }
    owner = GetWindow(hwnd, GW_OWNER);
    if (!owner && lstrcmp(cls, "#32770") == 0 && !shell_task(hwnd)) owner = task_main_window(hwnd);
    if (owner && IsWindow(owner)) {
        RECT orc, rc; int colX, colR, frameH, x, y, w, h;
        GetWindowRect(owner, &orc);
        if (IsIconic(owner)) return;                             /* owner in the icon row: leave it */
        GetWindowRect(hwnd, &rc);
        w = (wp->flags & SWP_NOSIZE) ? rc.right - rc.left : wp->cx;
        h = (wp->flags & SWP_NOSIZE) ? rc.bottom - rc.top : wp->cy;
        x = (wp->flags & SWP_NOMOVE) ? rc.left : wp->x;
        y = (wp->flags & SWP_NOMOVE) ? rc.top : wp->y;
        if (orc.left < SLOT_W) { colX = 0; colR = shell_w(); frameH = shell_h(); }
        else { colX = (orc.left / SLOT_W) * SLOT_W; colR = colX + SLOT_W; frameH = real_h(); }
        if (x + w > colR) x = colR - w;
        if (x < colX) x = colX;
        if (y + h > frameH) y = frameH - h;
        if (y < 0) y = 0;
        if (x != ((wp->flags & SWP_NOMOVE) ? rc.left : wp->x) || y != ((wp->flags & SWP_NOMOVE) ? rc.top : wp->y)) {
            wp->x = x; wp->y = y; wp->flags &= ~SWP_NOMOVE;
        }
        return;
    }
    if (lstrcmp(cls, "#32770") == 0 && shell_task(hwnd)) {
        RECT rc; int x, y, w, h;
        GetWindowRect(hwnd, &rc);
        w = (wp->flags & SWP_NOSIZE) ? rc.right - rc.left : wp->cx;
        h = (wp->flags & SWP_NOSIZE) ? rc.bottom - rc.top : wp->cy;
        x = (wp->flags & SWP_NOMOVE) ? rc.left : wp->x;
        y = (wp->flags & SWP_NOMOVE) ? rc.top : wp->y;
        if (x >= SLOT_W) { x = (shell_w() - w) / 2; y = (shell_h() - h) / 2; }   /* centred on the screen by Windows */
        if (clamp_into(&x, &y, w, h, 0, shell_w(), shell_h()) || x != ((wp->flags & SWP_NOMOVE) ? rc.left : wp->x) || y != ((wp->flags & SWP_NOMOVE) ? rc.top : wp->y)) {
            wp->x = x; wp->y = y; wp->flags &= ~SWP_NOMOVE;
        }
        return;
    }
    if (wp->flags & SWP_NOSIZE) return;
    if (!g_hookClamp) return;
    if (lstrcmp(cls, "Progman") == 0) {
        if (wp->cx > shell_w()) wp->cx = shell_w();
        if (wp->cy > shell_h()) wp->cy = shell_h();
        return;
    }
    {
        WinInfo *wi = learn(hwnd, cls, NULL, 0);
        int maxH, maxW;
        if (wi->fixed) return;                                   /* never resized, only kept in its column */
        maxH = frame_h_for(wi, FALSE); maxW = max_w_for(wi);
        if (wp->cx > maxW || wp->cy > maxH) {
            char line[80];
            wsprintf(line, "pvhook: clamp %s %dx%d -> %dx%d", (LPSTR)cls, wp->cx, wp->cy,
                     wp->cx > maxW ? maxW : wp->cx, wp->cy > maxH ? maxH : wp->cy);
            pv_dbg(line);
        }
        if (wp->cx > maxW) wp->cx = maxW;
        if (wp->cy > maxH) wp->cy = maxH;
    }
}

LRESULT CALLBACK __export PvCwpProc(int code, WPARAM wParam, LPARAM lParam)
{
    CWP16 FAR *m = (CWP16 FAR *)lParam;
    if (code >= 0 && m && shell_w()) {
        if (m->message == WM_GETMINMAXINFO && m->lParam) clamp_minmax(m->hwnd, (MINMAXINFO FAR *)m->lParam);
        else if (m->message == WM_WINDOWPOSCHANGING && m->lParam) clamp_windowpos(m->hwnd, (WINDOWPOS FAR *)m->lParam);
        else if (m->message == WM_WINDOWPOSCHANGED && m->lParam) {
            /* a resizable program that has just sized itself past the frame (Terminal fits 80
               columns of its font: 1916 wide): tell PVMON at once rather than at its next poll */
            WINDOWPOS FAR *wp = (WINDOWPOS FAR *)m->lParam;
            /* A menu or drop-down has just been shown or hidden. Nothing activates when a menu
               pops up, so the CBT hook never fires and the host only learns of it at PVMON's next
               poll -- a couple of hundred milliseconds during which the popup is already painted
               in the frame buffer and is composited as part of the window it popped up over, at
               the guest's own coordinates: off the right edge of a phone-wide column. When the
               report finally lands the host draws it as its own layer, shifted left to fit, and
               the menu appears to jump. The same delay in reverse leaves a ghost behind when it
               closes. Publishing here costs one window walk and happens before the popup paints. */
            char pcls[24];
            if ((wp->flags & (SWP_SHOWWINDOW | SWP_HIDEWINDOW)) && g_shellW &&
                GetClassName(m->hwnd, pcls, sizeof(pcls)) > 0 &&
                (lstrcmp(pcls, "#32768") == 0 || lstrcmp(pcls, "ComboLBox") == 0))
                hook_publish(NULL);
            if (!(wp->flags & SWP_NOSIZE) && (wp->cx > shell_w() || wp->cy > shell_h()) &&
                !(GetWindowLong(m->hwnd, GWL_STYLE) & WS_CHILD) && !GetWindow(m->hwnd, GW_OWNER)) {
                HWND mon = FindWindow("PVMonitor", NULL);
                if (mon) PostMessage(mon, WM_USER + 1, (WPARAM)m->hwnd, 0L);
            }
        }
    }
    return CallNextHookEx(g_cwp, code, wParam, lParam);
}

/* Single tap opens (Josh): a phone has no double-tap worth asking for. When a left click ends in
   the client area of a Program Manager group window, a double-click at the same point is posted
   right behind it; Program Manager's own handler opens the item under the cursor and does nothing
   on empty space. Captions, scroll bars and frames are non-client and are left alone (a converted
   caption click would maximise the group). A click on a minimised group's icon (an iconic PMGroup,
   hit-tested as caption) gets a non-client double-click, which is how Windows restores an icon.
   WH_MOUSE sees the message as the task retrieves it; HC_NOREMOVE (a PeekMessage look) is skipped
   so one click is converted once.
   Only a click is converted: the button must have gone down in the same group window, within the
   double-click distance (SM_CX/CYDOUBLECLK) and time of the release. A hold-to-drag on a group
   (down, moves, up somewhere else: an icon dragged, a selection) used to get a WM_LBUTTONDBLCLK
   at its release point, which, on a group's client, Program Manager took as a double-click on
   whatever was under the finger. */
static HWND g_tapWnd; static POINT g_tapPt; static DWORD g_tapTick;
LRESULT CALLBACK __export PvMouseProc(int code, WPARAM wParam, LPARAM lParam)
{
    MOUSEHOOKSTRUCT FAR *m = (MOUSEHOOKSTRUCT FAR *)lParam;
    if (code == HC_ACTION && m && !g_desktop) {
        /* FakeScreen casualty (SPEC 2026-09-02): Paintbrush confines the pointer to the visible
           image while a tool is down, ClipCursor(image rect INTERSECT screen rect), and takes the
           screen from GetSystemMetrics -- the phone frame, which its window at x=640 is outside
           of. USER gets an empty rectangle, pins the pointer at (-1,-1) and reports it hidden, and
           every stroke became a straight line from the press to the image's corner. The hook runs
           in the painting task on the first mouse message after the press: undo the empty clip
           (NULL = the real desktop rectangle) and put the pointer back where the press was; a
           move USER generated at the pinned position (off the real screen) is swallowed. */
        RECT rc; GetClipCursor(&rc);
        if (rc.right <= rc.left || rc.bottom <= rc.top) {
            char b[96];
            ClipCursor(NULL);
            if (g_tapWnd == m->hwnd || m->hwnd == GetCapture()) SetCursorPos(g_tapPt.x, g_tapPt.y);
            wsprintf(b, "pvhook: empty cursor clip undone at msg %04X, pointer back to %d,%d", wParam, g_tapPt.x, g_tapPt.y);
            pv_dbg(b);
        }
        if (wParam == WM_MOUSEMOVE && (m->pt.x < 0 || m->pt.y < 0)) return 1;   /* the pinned position: not a movement */
    }
    if (code == HC_ACTION && m && g_traceClip) {
        /* [PVMon] TraceClip=1: log the cursor clip rectangle whenever a mouse message finds it changed
           (the hook runs in the receiving task, so it sees a clip PVMON's poll cannot) */
        static RECT last; RECT rc; GetClipCursor(&rc);
        if (rc.left != last.left || rc.top != last.top || rc.right != last.right || rc.bottom != last.bottom) {
            char b[120], cls[16]; last = rc; cls[0] = 0; GetClassName(m->hwnd, cls, sizeof(cls));
            wsprintf(b, "pvhook: clip %d,%d-%d,%d at msg %04X %s pt %d,%d", rc.left, rc.top, rc.right, rc.bottom, wParam, (LPSTR)cls, m->pt.x, m->pt.y);
            pv_dbg(b);
        }
    }
    if (code == HC_ACTION && m && g_tapOpens > 0 && !g_desktop && m->hwnd) {   /* phone layout only: a mouse double-clicks by itself */
        char cls[16];
        if (wParam == WM_LBUTTONDOWN || wParam == WM_NCLBUTTONDOWN) {
            g_tapWnd = m->hwnd; g_tapPt = m->pt; g_tapTick = GetTickCount();
        } else if (wParam == WM_MOUSEMOVE && g_tapWnd == m->hwnd) {
            int dx = m->pt.x - g_tapPt.x, dy = m->pt.y - g_tapPt.y;
            if (dx < 0) dx = -dx; if (dy < 0) dy = -dy;
            if (dx > GetSystemMetrics(SM_CXDOUBLECLK) / 2 || dy > GetSystemMetrics(SM_CYDOUBLECLK) / 2) g_tapWnd = NULL;   /* moved: a drag, not a tap */
        } else if ((wParam == WM_LBUTTONUP || wParam == WM_NCLBUTTONUP) &&
            g_tapWnd == m->hwnd && GetTickCount() - g_tapTick < GetDoubleClickTime() * 2 &&
            GetClassName(m->hwnd, cls, sizeof(cls)) > 0 && lstrcmp(cls, "PMGroup") == 0) {
            int dx = m->pt.x - g_tapPt.x, dy = m->pt.y - g_tapPt.y;
            if (dx < 0) dx = -dx; if (dy < 0) dy = -dy;
            g_tapWnd = NULL;
            if (dx > GetSystemMetrics(SM_CXDOUBLECLK) / 2 || dy > GetSystemMetrics(SM_CYDOUBLECLK) / 2) { /* a drag ended here: leave it */ }
            else if (wParam == WM_LBUTTONUP && !IsIconic(m->hwnd)) {
                POINT pt = m->pt;
                ScreenToClient(m->hwnd, &pt);
                PostMessage(m->hwnd, WM_LBUTTONDBLCLK, MK_LBUTTON, MAKELONG(pt.x, pt.y));
            } else if (wParam == WM_NCLBUTTONUP && IsIconic(m->hwnd) && m->wHitTestCode == HTCAPTION) {
                PostMessage(m->hwnd, WM_NCLBUTTONDBLCLK, HTCAPTION, MAKELONG(m->pt.x, m->pt.y));
            }
        }
    }
    return CallNextHookEx(g_mouse, code, wParam, lParam);
}

/* Install/remove, called by PVMON. */
BOOL FAR PASCAL __export PvHookInstall(void)
{
    if (g_installed) return TRUE;
    shell_w(); shell_h(); load_lists();
    g_cbt = SetWindowsHookEx(WH_CBT, (HOOKPROC)PvCbtProc, g_hInst, NULL);
    g_cwp = SetWindowsHookEx(WH_CALLWNDPROC, (HOOKPROC)PvCwpProc, g_hInst, NULL);
    g_tapOpens = GetProfileInt("PVMon", "TapOpens", 1);
    g_traceClip = GetProfileInt("PVMon", "TraceClip", g_traceClip);
    g_hookClamp = GetProfileInt("PVMon", "HookClamp", 1);
    if (!g_hookClamp) pv_dbg("pvhook: HookClamp=0, size clamps off (measuring)");
    g_mouse = g_tapOpens > 0 ? SetWindowsHookEx(WH_MOUSE, (HOOKPROC)PvMouseProc, g_hInst, NULL) : NULL;
    g_installed = g_cbt != NULL;
    if (!g_cwp) pv_dbg("pvhook: WH_CALLWNDPROC hook failed");
    return g_installed;
}

/* The shell column's runtime size (the host knows the real viewport; PVMON relays it). */
void FAR PASCAL __export PvHookSetReal(int w, int h) { if (h > 0) g_realH = h; }
/* Desktop mode on (1) or off (0): see g_desktop. */
void FAR PASCAL __export PvHookSetDesktop(int on)
{
    if ((on != 0) == (g_desktop != 0)) return;
    g_desktop = on != 0;
    pv_dbg(g_desktop ? "pvhook: desktop mode, geometry clamps off" : "pvhook: phone mode, geometry clamps on");
}
void FAR PASCAL __export PvHookSetShell(int w, int h)
{
    if (w > 0) g_shellW = w;
    if (h > 0) g_shellH = h;
    load_lists();
}

void FAR PASCAL __export PvHookRemove(void)
{
    if (g_cbt) UnhookWindowsHookEx(g_cbt);
    if (g_cwp) UnhookWindowsHookEx(g_cwp);
    if (g_mouse) UnhookWindowsHookEx(g_mouse);
    g_cbt = g_cwp = g_mouse = NULL;
    g_installed = FALSE;
}

int FAR PASCAL LibMain(HINSTANCE hInst, WORD wDataSeg, WORD cbHeap, LPSTR lpCmdLine)
{
    g_hInst = hInst;
    return 1;
}

int FAR PASCAL __export WEP(int nParam) { return 1; }
