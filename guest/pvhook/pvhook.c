/* PVHOOK.DLL - system-wide CBT hook for the responsive-wfw311 paravirtual desktop.
 *
 * PVMON parks application windows in their own 640-column slots and sizes them to the phone,
 * but it can only do so after a window exists and has been painted, and on a slow guest the
 * window (and its dialogs) are visible in the desktop column for a moment first. A CBT hook sees
 * HCBT_CREATEWND before the window is shown and can rewrite its position and size in the
 * CREATESTRUCT, so windows are born where they belong. System-wide hooks must live in a DLL.
 *
 *   - top-level application windows: moved to the staging column (slot 0's column, x = 640) and,
 *     unless their module is listed in [PVMon] KeepSize, sized to [PVMon] DefaultSize
 *     (or Size.<MODULE>). PVMON assigns the real slot on its next poll; a move between slot
 *     columns is invisible since no view shows them directly.
 *   - owned windows (dialogs, message boxes): centred on their owner, which is already in a slot.
 *   - the shell, menus, and other transients are left alone.
 *
 * Build: guest/pvhook/build.sh (Open Watcom, wlink system windows_dll).
 */
#include <windows.h>

#define SLOT_W 640

static HINSTANCE g_hInst;
static HHOOK g_hook;
static BOOL g_installed;

static BOOL same_i(const char *a, const char *b, int n)
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

static void module_base(HWND hwnd, char *out, int outlen)
{
    char path[128], *base, *p; int n;
    HINSTANCE inst = (HINSTANCE)GetWindowWord(hwnd, GWW_HINSTANCE);
    out[0] = 0;
    if (!inst || !GetModuleFileName(inst, path, sizeof(path))) return;
    base = path;
    for (p = path; *p; p++) if (*p == '\\' || *p == ':') base = p + 1;
    for (n = 0; base[n] && base[n] != '.' && n < outlen - 1; n++) out[n] = base[n];
    out[n] = 0;
}

static BOOL in_list(const char *key, const char *name)
{
    char list[160], *k;
    GetProfileString("PVMon", key, "", list, sizeof(list));
    for (k = list; *k; ) {
        char *e = k; int n;
        while (*e && *e != ' ' && *e != ',') e++;
        n = (int)(e - k);
        if (n == lstrlen(name) && same_i(k, name, n)) return TRUE;
        k = e; while (*k == ' ' || *k == ',') k++;
    }
    return FALSE;
}

static BOOL parse_size(const char *val, int *w, int *h)
{
    const char *p = val; *w = 0; *h = 0;
    for (; *p >= '0' && *p <= '9'; p++) *w = *w * 10 + (*p - '0');
    if (*p != 'x') return FALSE;
    for (p++; *p >= '0' && *p <= '9'; p++) *h = *h * 10 + (*p - '0');
    return *w >= 100 && *h >= 60;
}

LRESULT CALLBACK __export PvCbtProc(int code, WPARAM wParam, LPARAM lParam)
{
    if (code == HCBT_CREATEWND) {
        HWND hwnd = (HWND)wParam;
        LPCBT_CREATEWND cbt = (LPCBT_CREATEWND)lParam;
        LPCREATESTRUCT cs = cbt->lpcs;
        char cls[24], mod[16], key[32], val[24];
        int w, h;
        unsigned shellW = GetProfileInt("PVMon", "ShellWidth", 0);
        if (!shellW) goto pass;                                   /* not the phone layout */
        if (cs->style & WS_CHILD) goto pass;
        if (GetClassName(hwnd, cls, sizeof(cls)) <= 0) goto pass;
        if (cls[0] == '#' || lstrcmp(cls, "Progman") == 0 || lstrcmp(cls, "ComboLBox") == 0 ||
            lstrcmp(cls, "PVMonitor") == 0 || lstrcmp(cls, "tooltips_class") == 0) goto pass;
        if (cs->hwndParent && IsWindow(cs->hwndParent)) {
            /* owned: centre on the owner (already in its slot); dialogs placed in screen
               coordinates by their program would otherwise land in the desktop column */
            RECT orc; int slotX;
            GetWindowRect(cs->hwndParent, &orc);
            w = cs->cx; h = cs->cy;
            if (w <= 0 || h <= 0) goto pass;                      /* CW_USEDEFAULT: let Windows decide */
            if (orc.left < (int)SLOT_W) {
                /* owner is the shell: Windows would centre this on the 2560-wide screen, far off
                   the desktop column; centre it in the column instead (PVMON reflows if too wide) */
                slotX = 0;
                cs->x = ((int)shellW - w) / 2;
                cs->y = (orc.top + orc.bottom - h) / 2;
                if (cs->x + w > (int)shellW) cs->x = (int)shellW - w;
                if (cs->x < 0) cs->x = 0;
                if (cs->y < 0) cs->y = 0;
                goto pass;
            }
            slotX = (orc.left / SLOT_W) * SLOT_W;
            cs->x = (orc.left + orc.right - w) / 2;
            cs->y = (orc.top + orc.bottom - h) / 2;
            if (cs->x + w > slotX + SLOT_W) cs->x = slotX + SLOT_W - w;
            if (cs->x < slotX) cs->x = slotX;
            if (cs->y < 0) cs->y = 0;
            goto pass;
        }
        /* a top-level application window: born in the staging column, phone-sized */
        module_base(hwnd, mod, sizeof(mod));
        wsprintf(key, "Size.%s", (LPSTR)mod);
        if (GetProfileString("PVMon", key, "", val, sizeof(val)) && parse_size(val, &w, &h)) {
            cs->cx = w; cs->cy = h;
        } else if (!in_list("KeepSize", mod) &&
                   GetProfileString("PVMon", "DefaultSize", "", val, sizeof(val)) && parse_size(val, &w, &h)) {
            if (cs->cx == CW_USEDEFAULT || cs->cx > w) cs->cx = w;
            if (cs->cy == CW_USEDEFAULT || cs->cy > h) cs->cy = h;
        }
        cs->x = SLOT_W; cs->y = 0;
    }
pass:
    return CallNextHookEx(g_hook, code, wParam, lParam);
}

/* Install/remove, called by PVMON. */
BOOL FAR PASCAL __export PvHookInstall(void)
{
    if (g_installed) return TRUE;
    g_hook = SetWindowsHookEx(WH_CBT, (HOOKPROC)PvCbtProc, g_hInst, NULL);
    g_installed = g_hook != NULL;
    return g_installed;
}

void FAR PASCAL __export PvHookRemove(void)
{
    if (g_installed) UnhookWindowsHookEx(g_hook);
    g_installed = FALSE;
}

int FAR PASCAL LibMain(HINSTANCE hInst, WORD wDataSeg, WORD cbHeap, LPSTR lpCmdLine)
{
    g_hInst = hInst;
    return 1;
}

int FAR PASCAL __export WEP(int nParam) { return 1; }
