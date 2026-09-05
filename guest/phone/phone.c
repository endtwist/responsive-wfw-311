/* PHONE.EXE - the simulated phone, for people on a desktop who will not get their phone out.
 *
 * This desktop is Windows 3.11 as it always was: a mouse, a wide screen, windows where you put
 * them. The interesting version is the phone -- windows stacked in a column, contents scaled to
 * fit, everything driven by a thumb -- and nobody is going to pick up their phone to look at it.
 * So this asks the host to pretend: it crops the live area to a phone-shaped frame in the middle
 * of the browser window and puts the mouse through the same gesture pipeline the fingers use.
 *
 * A Windows program rather than page furniture, for the same reason as everything else here: the
 * only interface this system has is Windows' own. It talks to the host the way LCD.EXE does, on
 * the adapter's debug channel -- "PVPHONE <on> <aspect>" -- and keeps its state in WIN.INI
 * [PVMon] so a page reload comes back to the frame the user left.
 *
 * It shows nothing on a real phone. The host reports its own size in the adapter's registers, and
 * a narrow one means there is nothing to simulate: the program exits without a window.
 *
 * Build: guest/phone/build.sh  (Open Watcom via tools/watcom.sh)
 */
#include <windows.h>
#include <conio.h>            /* outpw/inpw: the adapter registers, as in PVMON and LCD.EXE */

#define ID_ON     1
#define ID_A916   2
#define ID_A9195  3
#define ID_CLOSE  4

#define FRAME_W  352      /* the phone column, in guest pixels */
#define MARGIN    12
#define GAP        8
#define ROW       28

static char szClass[] = "PVPhone";
static char szTitle[] = "Phone";
static char szIni[]   = "PVMon";

static HWND hOn, hA916, hA9195;
static int  g_on = 0, g_aspect = 0;

/* The adapter. 0x10/0x11 are the HOST's viewport in host pixels, which is how a program inside
   the guest can know what it is being looked at on. 0x16 is the debug channel: one byte a write,
   a newline ends the line, and the host reads it with the rest of the protocol. */
#define R_INDEX 0x1CE
#define R_DATA  0x1CF
#define R_HOST_W 0x10
#define R_HOST_H 0x11
#define R_DEBUG  0x16

static unsigned rd(unsigned reg)
{
    outpw(R_INDEX, reg);
    return inpw(R_DATA);
}
static void dbg_ch(unsigned char c)
{
    outpw(R_INDEX, R_DEBUG);
    outpw(R_DATA, c);
}
static void dbg(const char *s)
{
    while (*s) dbg_ch((unsigned char)*s++);
    dbg_ch(10);
}

/* The same test the host makes (web/app.js narrow()): the shorter side under 600 host pixels is a
   phone, and there is nothing here for it. */
static int host_is_phone(void)
{
    unsigned w = rd(R_HOST_W), h = rd(R_HOST_H);
    if (!w || !h) return 0;                 /* no report: assume a desktop and show the window */
    return (w < h ? w : h) < 600;
}

static void report(void)
{
    char line[64];
    wsprintf(line, "PVPHONE %d %d", g_on, g_aspect);
    dbg(line);
}
static void save(void)
{
    char v[8];
    wsprintf(v, "%d", g_on);      WriteProfileString(szIni, "PhoneSim", v);
    wsprintf(v, "%d", g_aspect);  WriteProfileString(szIni, "PhoneAspect", v);
}
static void load(void)
{
    g_on     = GetProfileInt(szIni, "PhoneSim", 0) ? 1 : 0;
    g_aspect = GetProfileInt(szIni, "PhoneAspect", 0);
    if (g_aspect < 0 || g_aspect > 1) g_aspect = 0;
}

/* SS_LEFT wraps inside the control's own rectangle, so a note gets a tall one and a caption a
   single row. */
static void labelh(HWND parent, HINSTANCE inst, const char *text, int y, int w, int h)
{
    CreateWindow("static", text, WS_CHILD | WS_VISIBLE | SS_LEFT,
                 MARGIN, y, w, h, parent, (HMENU)-1, inst, NULL);
}
static void label(HWND parent, HINSTANCE inst, const char *text, int y, int w)
{
    labelh(parent, inst, text, y, w, 20);
}

LRESULT CALLBACK __export WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_CREATE: {
        HINSTANCE inst = ((LPCREATESTRUCT)lParam)->hInstance;
        int w = FRAME_W - 2 * MARGIN, y = MARGIN;
        HFONT f = (HFONT)GetStockObject(SYSTEM_FONT);
        hOn = CreateWindow("button", "&Phone frame", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
                           MARGIN, y, w, ROW, hwnd, (HMENU)ID_ON, inst, NULL);
        y += ROW + GAP;
        label(hwnd, inst, "Shape", y, w); y += 20 + 2;
        /* WS_GROUP on the first: the two are one radio group, and the arrow keys move between
           them the way every other 3.1 dialog behaves. */
        hA916 = CreateWindow("button", "&9:16", WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_GROUP | BS_AUTORADIOBUTTON,
                             MARGIN + 8, y, w - 8, ROW - 4, hwnd, (HMENU)ID_A916, inst, NULL);
        y += ROW - 2;
        hA9195 = CreateWindow("button", "9:19.5 (&tall)", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTORADIOBUTTON,
                              MARGIN + 8, y, w - 8, ROW - 4, hwnd, (HMENU)ID_A9195, inst, NULL);
        y += ROW - 2 + GAP;
        labelh(hwnd, inst, "The mouse becomes a finger. Drag to scroll, swipe in from the right "
                           "edge to change window, and swipe up from the bottom edge for the "
                           "switcher.", y, w, 76);
        y += 76 + GAP;
        CreateWindow("button", "&Close", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                     FRAME_W - MARGIN - 96, y, 96, ROW, hwnd, (HMENU)ID_CLOSE, inst, NULL);
        {   /* the system font on every control, or they come up in the old bitmap face */
            HWND c;
            for (c = GetWindow(hwnd, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT))
                SendMessage(c, WM_SETFONT, (WPARAM)f, 0L);
        }
        SendMessage(hOn, BM_SETCHECK, g_on ? 1 : 0, 0L);
        SendMessage(g_aspect ? hA9195 : hA916, BM_SETCHECK, 1, 0L);
        return 0;
    }
    case WM_CTLCOLOR:
        if (HIWORD(lParam) == CTLCOLOR_STATIC || HIWORD(lParam) == CTLCOLOR_BTN) {
            SetBkColor((HDC)wParam, GetSysColor(COLOR_WINDOW));
            SetTextColor((HDC)wParam, GetSysColor(COLOR_WINDOWTEXT));
            return (LRESULT)GetStockObject(WHITE_BRUSH);
        }
        break;
    case WM_COMMAND:
        switch (wParam) {
        case ID_ON:
            g_on = SendMessage(hOn, BM_GETCHECK, 0, 0L) ? 1 : 0;
            save(); report();
            return 0;
        case ID_A916:
        case ID_A9195:
            g_aspect = (wParam == ID_A9195) ? 1 : 0;
            save(); report();
            return 0;
        case ID_CLOSE:
            DestroyWindow(hwnd);
            return 0;
        }
        break;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

int PASCAL WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show)
{
    WNDCLASS wc;
    HWND hwnd;
    MSG msg;
    int h;

    load();

    /* /report: one line and out, so the host can ask what the frame was left set to without a
       window appearing. The same contract LCD.EXE has. */
    if (cmd && (cmd[0] == '/' || cmd[0] == '-')) {
        char c1 = cmd[1] >= 'A' && cmd[1] <= 'Z' ? (char)(cmd[1] + 32) : cmd[1];
        if (c1 == 'r') { report(); return 0; }
        if (c1 == 'o') {                                  /* /on and /off, for a URL that decided */
            char c2 = cmd[2] >= 'A' && cmd[2] <= 'Z' ? (char)(cmd[2] + 32) : cmd[2];
            if (c2 == 'n' || c2 == 'f') { g_on = (c2 == 'n'); save(); report(); return 0; }
        }
    }

    /* Nothing to simulate on a phone, and nothing worth showing either. */
    if (host_is_phone()) return 0;

    if (!prev) {
        wc.style = 0; wc.lpfnWndProc = WndProc; wc.cbClsExtra = 0; wc.cbWndExtra = 0;
        wc.hInstance = inst; wc.hIcon = LoadIcon(inst, MAKEINTRESOURCE(1));
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
        wc.lpszMenuName = NULL; wc.lpszClassName = szClass;
        if (!RegisterClass(&wc)) return 0;
    }
    h = MARGIN + ROW + GAP + 22 + (ROW - 2) * 2 + GAP + 76 + GAP + ROW + MARGIN
        + GetSystemMetrics(SM_CYCAPTION) + 2 * GetSystemMetrics(SM_CYBORDER);
    hwnd = CreateWindow(szClass, szTitle, WS_POPUP | WS_CAPTION | WS_SYSMENU,
                        0, 0, FRAME_W, h, NULL, NULL, inst, NULL);
    if (!hwnd) return 0;
    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
    report();                                  /* the host learns the state as the window opens */
    while (GetMessage(&msg, NULL, 0, 0)) {
        if (!IsDialogMessage(hwnd, &msg)) { TranslateMessage(&msg); DispatchMessage(&msg); }
    }
    return 0;
}
