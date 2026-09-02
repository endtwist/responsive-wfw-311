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
 *     and the modules in [PVMon] KeepSize: the games, Calculator, Clock...) draw a layout of their
 *     own size and are never resized, only kept inside the frame; maximise leaves them as they are.
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
static BOOL g_installed;
static int g_shellW, g_shellH;       /* the phone frame, from PVMON (runtime) or WIN.INI */

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
    if (!g_shellW) g_shellW = GetProfileInt("PVMon", "ShellWidth", 0);
    return g_shellW;
}
static int shell_h(void)
{
    if (!g_shellH) g_shellH = GetProfileInt("PVMon", "ShellHeight", 0);
    if (!g_shellH) g_shellH = GetSystemMetrics(SM_CYSCREEN);
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
typedef struct { HWND hwnd; BOOL fixed; int maxH; } WinInfo;
#define MAX_INFO 24
static WinInfo g_info[MAX_INFO];

/* Windows being destroyed. PVMON's poll touches every top-level window (GetWindowText,
   SetWindowPos: cross-task SendMessages inside USER); one sent to a window whose task is on its
   way out never returns until something else wakes the scheduler (Print Manager's spooler-off
   box: PVMON froze until Ctrl+Esc). The hook sees HCBT_DESTROYWND first and remembers the last
   few, and PVMON skips them (PvHookIsDead) while IsWindow still says yes. */
static HWND g_dead[8]; static int g_deadAt;
static void mark_dead(HWND h) { g_dead[g_deadAt++ & 7] = h; }
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
        tmp.hwnd = NULL; tmp.fixed = lstrcmp(cls, "#32770") == 0 || !(style & WS_THICKFRAME); tmp.maxH = 0;
        return &tmp;
    }
    wi->hwnd = hwnd;
    /* A program whose main window is a dialog template (Task List, Sound Recorder, Character
       Map, WinVer...) laid its controls out for one size and never re-lays them; so did the
       modules listed in KeepSize (the games, Calculator, Clock, Paintbrush's toolbox...). */
    /* A window without WS_THICKFRAME cannot be resized by the user, so its program never lays out
       to a new size either (Windows Setup's Network Setup: clamped, its text and list were simply
       cut off). Only user-resizable windows reflow and are clamped; the rest keep their natural
       size and the host scales them to the phone. */
    if (!style) style = GetWindowLong(hwnd, GWL_STYLE);
    wi->fixed = lstrcmp(cls, "#32770") == 0 || !(style & WS_THICKFRAME) || in_list("KeepSize", mod);
    wsprintf(key, "MaxHeight.%s", (LPSTR)mod);
    h = GetProfileInt("PVMon", key, 0);
    wi->maxH = (h > 100) ? h : 0;
    wsprintf(line, "pvhook: %s class %s %s", (LPSTR)mod, (LPSTR)cls, (LPSTR)(wi->fixed ? "fixed layout" : "resizable"));
    pv_dbg(line);
    return wi;
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
    if (*owner && IsIconic(*owner)) return 0;
    if (IsIconic(h)) return 'I';
    if (*owner && IsWindow(*owner) && IsWindowVisible(*owner)) return 'O';
    return 'A';
}
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
        case 'T': describe(h, line, "PVT", -1); { int m = lstrlen(line); if (m + lstrlen(cls) + 2 < 128) { line[m] = ' '; lstrcpy(line + m + 1, cls); } } break;
        case 'O': { RECT orc; int hops; HWND o = owner;
                    for (hops = 0; o && hops < 8 && GetWindow(o, GW_OWNER); hops++) o = GetWindow(o, GW_OWNER);
                    GetWindowRect(o, &orc); describe(h, line, "PVO", col_slot(orc.left)); break; }
        case 'A': describe(h, line, rc.left >= SLOT_W ? "PVW" : "PVX", col_slot(rc.left)); break;
        case 'I': { char t[24]; t[0] = 0; GetWindowText(h, t, sizeof(t)); wsprintf(line, "PVI %d %s", -1, (LPSTR)t); break; }
        }
        pv_dbg(line);
    }
    pv_dbg("PVE");
}

/* Where an owned window goes so that it covers as little of its owner as possible: below the
   owner if the column has room, else to its right inside the 640-wide slot, else centred on it.
   The host draws owned windows as their own layers anchored over the owner, so the user sees one
   dialog centred on its program; what this buys is that the owner's own client area, which the
   host captures from the frame buffer, no longer contains the dialog too. Dialogs owned by the
   shell stay inside the shell column, which the phone shows as the desktop. */
static void place_owned(HWND owner, int w, int h, int FAR *px, int FAR *py)
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
        colX = (orc.left / SLOT_W) * SLOT_W; colR = colX + SLOT_W; frameH = GetSystemMetrics(SM_CYSCREEN);
        if (orc.bottom + h <= frameH)      { x = orc.left;  y = orc.bottom; }
        else if (orc.right + w <= colR)    { x = orc.right; y = orc.top; }
        else { x = (orc.left + orc.right - w) / 2; y = (orc.top + orc.bottom - h) / 2; }
    }
    if (x + w > colR) x = colR - w;
    if (x < colX) x = colX;
    if (y + h > frameH) y = frameH - h;
    if (y < 0) y = 0;
    *px = x; *py = y;
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

LRESULT CALLBACK __export PvCbtProc(int code, WPARAM wParam, LPARAM lParam)
{
    if (code == HCBT_SETFOCUS) {
        /* The host must know the moment a text control takes the focus: iOS only shows its
           keyboard inside the touch gesture that caused it, so a poll 100 ms later is too late. */
        HWND f = (HWND)wParam;
        char cls[24];
        if (f && GetClassName(f, cls, sizeof(cls)) > 0) {
            int want = 0;
            if (lstrcmpi(cls, "Edit") == 0 || lstrcmpi(cls, "ComboBox") == 0 || lstrcmpi(cls, "tty") == 0) want = 1;
            else {
                char pcls[24]; HWND parent = GetParent(f);
                if (parent && GetClassName(parent, pcls, sizeof(pcls)) > 0 && lstrcmpi(pcls, "ComboBox") == 0) want = 1;
            }
            /* Programs that take text in a window of their own class (Write's document, Cardfile's
               card, Terminal, a DOS box): the focused window is not one of the known non-text
               classes and its program is listed in [PVMon] KeyboardApps. */
            if (!want && !(lstrcmpi(cls, "Button") == 0 || lstrcmpi(cls, "Static") == 0 || lstrcmpi(cls, "ScrollBar") == 0 ||
                           lstrcmpi(cls, "ListBox") == 0 || lstrcmpi(cls, "ComboLBox") == 0 || cls[0] == '#' ||
                           lstrcmpi(cls, "MDIClient") == 0 || lstrcmp(cls, "PMGroup") == 0 || lstrcmp(cls, "Progman") == 0)) {
                HWND top = f; char mod[16]; int hops;
                for (hops = 0; hops < 8 && (GetWindowLong(top, GWL_STYLE) & WS_CHILD); hops++) top = GetParent(top);
                module_base(top, mod, sizeof(mod));
                if (mod[0] && in_list("KeyboardApps", mod)) want = 1;
            }
            pv_dbg(want ? "PVK 1" : "PVK 0");
        }
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
                RECT rc; int maxH = frame_h_for(wi, FALSE), w, ht;
                GetWindowRect(h, &rc);
                w = rc.right - rc.left; ht = rc.bottom - rc.top;
                if (w > shell_w() || ht > maxH) {
                    char line[80];
                    wsprintf(line, "pvhook: %s sized itself %dx%d, clamped to %dx%d", (LPSTR)cls, w, ht,
                             w > shell_w() ? shell_w() : w, ht > maxH ? maxH : ht);
                    pv_dbg(line);
                    SetWindowPos(h, NULL, rc.left, rc.top, w > shell_w() ? shell_w() : w, ht > maxH ? maxH : ht,
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
    if (code == HCBT_DESTROYWND && wParam && !(GetWindowLong((HWND)wParam, GWL_STYLE) & WS_CHILD)) mark_dead((HWND)wParam);
    if ((code == HCBT_ACTIVATE || code == HCBT_DESTROYWND || code == HCBT_SETFOCUS) && shell_w()) {
        char cls[24];
        HWND h = (HWND)wParam;
        if (code == HCBT_SETFOCUS) {                      /* the focus lands in a dialog once it is up */
            int hops;
            for (hops = 0; h && hops < 8 && (GetWindowLong(h, GWL_STYLE) & WS_CHILD); hops++) h = GetParent(h);
        }
        if (h && GetClassName(h, cls, sizeof(cls)) > 0 && lstrcmp(cls, "#32770") == 0 && !(GetWindowLong(h, GWL_STYLE) & WS_CHILD)) {
            if (code != HCBT_DESTROYWND && !GetWindow(h, GW_OWNER) && !shell_task(h) && !task_main_window(h) && IsWindowVisible(h)) {
                /* a dialog that is a program of its own (Task List) centred itself on the screen:
                   put it at the top of the column it fell in before it is reported */
                RECT rc; int colX;
                GetWindowRect(h, &rc);
                colX = rc.left < SLOT_W ? SLOT_W : (rc.left / SLOT_W) * SLOT_W;
                if (rc.left < SLOT_W || rc.right > colX + SLOT_W || rc.top < 0)
                    SetWindowPos(h, NULL, colX, 0, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
            }
            g_force = (code == HCBT_ACTIVATE) ? h : NULL;
            hook_publish(code == HCBT_DESTROYWND ? h : NULL);
            g_force = NULL;
        }
    }
    if (code == HCBT_CREATEWND) {
        HWND hwnd = (HWND)wParam;
        LPCBT_CREATEWND cbt = (LPCBT_CREATEWND)lParam;
        LPCREATESTRUCT cs = cbt->lpcs;
        char cls[24], mod[16], key[32], val[24];
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
            place_owned(cs->hwndParent, w, h, &cs->x, &cs->y);
            goto pass;
        }
        if (lstrcmp(cls, "#32770") == 0 && !shell_task(hwnd) && cs->cx > 0 && cs->cy > 0) {
            HWND o = task_main_window(hwnd);            /* WinOldAp's box belongs to the DOS window */
            if (o) { place_owned(o, cs->cx, cs->cy, &cs->x, &cs->y); goto pass; }
        }
        if (lstrcmp(cls, "#32770") == 0 && shell_task(hwnd) && cs->cx > 0 && cs->cy > 0) {
            cs->x = (shell_w() - cs->cx) / 2; cs->y = (shell_h() - cs->cy) / 2;
            if (cs->x < 0) cs->x = 0;
            if (cs->y < 0) cs->y = 0;
            goto pass;
        }
        /* a top-level application window: born in the staging column, phone-sized unless it
           draws a fixed layout */
        wi = learn(hwnd, cls, cs->hInstance, cs->style);
        module_base_i(cs->hInstance, mod, sizeof(mod));
        wsprintf(key, "Size.%s", (LPSTR)mod);
        if (GetProfileString("PVMon", key, "", val, sizeof(val)) && parse_size(val, &w, &h)) {
            cs->cx = w; cs->cy = h;
        } else if (!wi->fixed &&
                   GetProfileString("PVMon", "DefaultSize", "", val, sizeof(val)) && parse_size(val, &w, &h)) {
            if (cs->cx == CW_USEDEFAULT || cs->cx > w) cs->cx = w;
            if (cs->cy == CW_USEDEFAULT || cs->cy > h) cs->cy = h;
        }
        if (!wi->fixed && cs->cx != CW_USEDEFAULT) {              /* the invariant, at birth */
            if (cs->cx > shell_w()) cs->cx = shell_w();
            if (cs->cy > frame_h_for(wi, FALSE)) cs->cy = frame_h_for(wi, FALSE);
        }
        cs->x = SLOT_W; cs->y = 0;
    }
pass:
    return CallNextHookEx(g_cbt, code, wParam, lParam);
}

/* Maximise means "fill the column": the window really is zoomed, so the maximise box turns into
   the restore box and toggles back, but the zoomed rectangle is the phone frame at the top of the
   window's own column, never the whole screen. Fixed-layout programs keep their size and are only
   moved to the top of the column. */
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
    if (!isShell) wi = learn(hwnd, cls, NULL, 0);
    wp.length = sizeof(wp);
    if (!isShell && GetWindowPlacement(hwnd, &wp) && wp.rcNormalPosition.left >= SLOT_W)
        colX = (wp.rcNormalPosition.left / SLOT_W) * SLOT_W;   /* the column it lives in, even when iconic */
    if (isShell) { colX = 0; w = shell_w(); h = frame_h_for(NULL, TRUE); }
    else if (wi->fixed) {
        w = wp.rcNormalPosition.right - wp.rcNormalPosition.left;
        h = wp.rcNormalPosition.bottom - wp.rcNormalPosition.top;
        if (w < 100 || h < 60) return;                 /* still being built (Minesweeper sizes itself later) */
        if (w > SLOT_W) w = SLOT_W;
        if (h > GetSystemMetrics(SM_CYSCREEN)) h = GetSystemMetrics(SM_CYSCREEN);
    } else { w = shell_w(); h = frame_h_for(wi, FALSE); }
    mmi->ptMaxSize.x = w; mmi->ptMaxSize.y = h;
    mmi->ptMaxPosition.x = colX; mmi->ptMaxPosition.y = 0;
    if (!isShell && wi->fixed) return;                           /* the user may still drag-size these */
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
    if (GetClassName(hwnd, cls, sizeof(cls)) <= 0 || transient_class(cls)) return;
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
        else { colX = (orc.left / SLOT_W) * SLOT_W; colR = colX + SLOT_W; frameH = GetSystemMetrics(SM_CYSCREEN); }
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
    if (lstrcmp(cls, "Progman") == 0) {
        if (wp->cx > shell_w()) wp->cx = shell_w();
        if (wp->cy > shell_h()) wp->cy = shell_h();
        return;
    }
    {
        WinInfo *wi = learn(hwnd, cls, NULL, 0);
        int maxH;
        if (wi->fixed) return;                                   /* never resized, only kept in its column */
        maxH = frame_h_for(wi, FALSE);
        if (wp->cx > shell_w() || wp->cy > maxH) {
            char line[80];
            wsprintf(line, "pvhook: clamp %s %dx%d -> %dx%d", (LPSTR)cls, wp->cx, wp->cy,
                     wp->cx > shell_w() ? shell_w() : wp->cx, wp->cy > maxH ? maxH : wp->cy);
            pv_dbg(line);
        }
        if (wp->cx > shell_w()) wp->cx = shell_w();
        if (wp->cy > maxH) wp->cy = maxH;
    }
}

LRESULT CALLBACK __export PvCwpProc(int code, WPARAM wParam, LPARAM lParam)
{
    CWP16 FAR *m = (CWP16 FAR *)lParam;
    if (code >= 0 && m && g_shellW) {
        if (m->message == WM_GETMINMAXINFO && m->lParam) clamp_minmax(m->hwnd, (MINMAXINFO FAR *)m->lParam);
        else if (m->message == WM_WINDOWPOSCHANGING && m->lParam) clamp_windowpos(m->hwnd, (WINDOWPOS FAR *)m->lParam);
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
   so one click is converted once. */
LRESULT CALLBACK __export PvMouseProc(int code, WPARAM wParam, LPARAM lParam)
{
    MOUSEHOOKSTRUCT FAR *m = (MOUSEHOOKSTRUCT FAR *)lParam;
    if (code == HC_ACTION && m && g_tapOpens > 0 && m->hwnd) {
        char cls[16];
        if ((wParam == WM_LBUTTONUP || wParam == WM_NCLBUTTONUP) &&
            GetClassName(m->hwnd, cls, sizeof(cls)) > 0 && lstrcmp(cls, "PMGroup") == 0) {
            if (wParam == WM_LBUTTONUP && !IsIconic(m->hwnd)) {
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
    g_mouse = g_tapOpens > 0 ? SetWindowsHookEx(WH_MOUSE, (HOOKPROC)PvMouseProc, g_hInst, NULL) : NULL;
    g_installed = g_cbt != NULL;
    if (!g_cwp) pv_dbg("pvhook: WH_CALLWNDPROC hook failed");
    return g_installed;
}

/* The shell column's runtime size (the host knows the real viewport; PVMON relays it). */
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
