/* LCD.EXE - the screen controls for responsive-wfw311, as a native Win16 program.
 *
 * The host can draw the composite through a shader that makes it look like the passive-matrix
 * panel of a 1992 laptop (web/app.js, ?lcd=1). This is the control panel for it, and it is a
 * Windows program rather than page chrome for the same reason everything else here is: the only
 * interface this system has is Windows' own.
 *
 * A fixed-layout window (WS_POPUP | WS_CAPTION | WS_SYSMENU: no thick frame, so PVHOOK leaves it
 * at its natural size) with an auto checkbox for the screen itself and two scroll bars for
 * brightness and contrast, which is what Windows 3.1 has instead of sliders -- Control Panel's
 * own Colour and Desktop dialogs use exactly these. Every control is stock, the font is the
 * system font, and nothing is custom-drawn.
 *
 * The settings go to the host on the debug channel, "PVLCD <on> <brightness> <contrast>", the
 * same way PVMON reports everything else, and are kept in WIN.INI [PVMon] so they survive a
 * restart: the host asks for them at startup by running this program with /report, which sends
 * one line and exits without a window.
 *
 * Build: guest/lcd/build.sh  (Open Watcom via tools/watcom.sh)
 */
#include <windows.h>
#include <conio.h>            /* outpw: the adapter registers, as in PVMON */

#define ID_ON     1
#define ID_BRIGHT 2
#define ID_CONTR  3
#define ID_CLOSE  4

#define FRAME_W  352      /* the phone column, in guest pixels */
#define MARGIN    12
#define GAP        10
#define ROW       28
#define BAR       22

static char szClass[] = "PVLcd";
static char szTitle[] = "Screen";
static char szIni[]   = "PVMon";

static HWND hOn, hBright, hContr;
static int  g_on = 0, g_bright = 50, g_contr = 50;

/* The adapter's debug register: one byte a write, a newline ends the line. This is the same
   channel PVMON uses, and the host reads it with the rest of the protocol. */
#define R_INDEX 0x1CE
#define R_DATA  0x1CF
#define R_DEBUG 0x16
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

static void report(void)
{
    char line[64];
    wsprintf(line, "PVLCD %d %d %d", g_on, g_bright, g_contr);
    dbg(line);
}
static void save(void)
{
    char v[8];
    wsprintf(v, "%d", g_on);      WriteProfileString(szIni, "Lcd", v);
    wsprintf(v, "%d", g_bright);  WriteProfileString(szIni, "LcdBright", v);
    wsprintf(v, "%d", g_contr);   WriteProfileString(szIni, "LcdContrast", v);
}
static void load(void)
{
    g_on     = GetProfileInt(szIni, "Lcd", 0);
    g_bright = GetProfileInt(szIni, "LcdBright", 50);
    g_contr  = GetProfileInt(szIni, "LcdContrast", 50);
    if (g_bright < 0 || g_bright > 100) g_bright = 50;
    if (g_contr  < 0 || g_contr  > 100) g_contr  = 50;
}

/* A scroll bar's own arithmetic: the arrows move it a step, the page areas a page, and dragging
   the thumb reports the position. Windows 3.1 gives no other slider, and this is exactly how
   Control Panel drives its own. */
static int bar_pos(HWND bar, int code, int pos, int now)
{
    switch (code) {
    case SB_LINEUP:        now -= 2; break;
    case SB_LINEDOWN:      now += 2; break;
    case SB_PAGEUP:        now -= 10; break;
    case SB_PAGEDOWN:      now += 10; break;
    case SB_TOP:           now = 0; break;
    case SB_BOTTOM:        now = 100; break;
    case SB_THUMBPOSITION:
    case SB_THUMBTRACK:    now = pos; break;
    default: return now;
    }
    if (now < 0) now = 0;
    if (now > 100) now = 100;
    SetScrollPos(bar, SB_CTL, now, TRUE);
    return now;
}

static void label(HWND parent, HINSTANCE inst, const char *text, int y, int w)
{
    CreateWindow("static", text, WS_CHILD | WS_VISIBLE | SS_LEFT,
                 MARGIN, y, w, 20, parent, (HMENU)-1, inst, NULL);
}

LRESULT CALLBACK __export WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_CREATE: {
        HINSTANCE inst = ((LPCREATESTRUCT)lParam)->hInstance;
        int w = FRAME_W - 2 * MARGIN, y = MARGIN;
        HFONT f = (HFONT)GetStockObject(SYSTEM_FONT);
        hOn = CreateWindow("button", "&LCD screen", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
                           MARGIN, y, w, ROW, hwnd, (HMENU)ID_ON, inst, NULL);
        y += ROW + GAP;
        label(hwnd, inst, "&Brightness", y, w); y += 20 + 2;
        hBright = CreateWindow("scrollbar", "", WS_CHILD | WS_VISIBLE | WS_TABSTOP | SBS_HORZ,
                               MARGIN, y, w, BAR, hwnd, (HMENU)ID_BRIGHT, inst, NULL);
        y += BAR + GAP;
        label(hwnd, inst, "&Contrast", y, w); y += 20 + 2;
        hContr = CreateWindow("scrollbar", "", WS_CHILD | WS_VISIBLE | WS_TABSTOP | SBS_HORZ,
                              MARGIN, y, w, BAR, hwnd, (HMENU)ID_CONTR, inst, NULL);
        y += BAR + GAP + 4;
        CreateWindow("button", "&Close", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                     FRAME_W - MARGIN - 96, y, 96, ROW, hwnd, (HMENU)ID_CLOSE, inst, NULL);
        {   /* the system font on every control, or they come up in the old bitmap face */
            HWND c;
            for (c = GetWindow(hwnd, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT))
                SendMessage(c, WM_SETFONT, (WPARAM)f, 0L);
        }
        SetScrollRange(hBright, SB_CTL, 0, 100, FALSE);
        SetScrollRange(hContr, SB_CTL, 0, 100, FALSE);
        SetScrollPos(hBright, SB_CTL, g_bright, TRUE);
        SetScrollPos(hContr, SB_CTL, g_contr, TRUE);
        SendMessage(hOn, BM_SETCHECK, g_on ? 1 : 0, 0L);
        return 0;
    }
    case WM_COMMAND:
        if (wParam == ID_ON) {
            g_on = (int)SendMessage(hOn, BM_GETCHECK, 0, 0L);
            report(); save();
        } else if (wParam == ID_CLOSE) {
            DestroyWindow(hwnd);
        }
        return 0;
    case WM_HSCROLL: {
        HWND bar = (HWND)HIWORD(lParam);
        if (bar == hBright) g_bright = bar_pos(bar, LOWORD(wParam), HIWORD(wParam), g_bright);
        else if (bar == hContr) g_contr = bar_pos(bar, LOWORD(wParam), HIWORD(wParam), g_contr);
        else return 0;
        report();
        /* WIN.INI is written on the release, not on every pixel of a drag: a scroll bar sends
           SB_THUMBTRACK continuously and each write is file I/O. */
        if (LOWORD(wParam) == SB_THUMBPOSITION || LOWORD(wParam) == SB_ENDSCROLL) save();
        return 0;
    }
    case WM_DESTROY:
        save();
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
    /* "/report" is how the host asks for the settings at startup: one line on the debug channel
       and no window at all, so a page reload comes up with the screen the user left. */
    if (cmd && (cmd[0] == '/' || cmd[0] == '-') && (cmd[1] == 'r' || cmd[1] == 'R')) {
        report();
        return 0;
    }

    if (!prev) {
        wc.style = 0; wc.lpfnWndProc = WndProc; wc.cbClsExtra = 0; wc.cbWndExtra = 0;
        wc.hInstance = inst; wc.hIcon = LoadIcon(NULL, IDI_APPLICATION);
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = (HBRUSH)GetStockObject(LTGRAY_BRUSH);
        wc.lpszMenuName = NULL; wc.lpszClassName = szClass;
        if (!RegisterClass(&wc)) return 0;
    }
    h = MARGIN + ROW + GAP + (20 + 2 + BAR + GAP) * 2 + 4 + ROW + MARGIN
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
