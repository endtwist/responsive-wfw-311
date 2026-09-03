/* ABOUT.EXE - the first-run note for responsive-wfw311, as a native Win16 program.
 *
 * A fixed-layout window (WS_POPUP | WS_CAPTION | WS_SYSMENU: no thick frame, so PVHOOK's
 * geometry invariant keeps it at its natural size instead of reflowing it) sized to the phone
 * frame: 352 guest pixels wide, its height measured from the text at the shipped system font
 * (PVSYS.FON, MS Sans Serif at 20 px / 120 dpi) and clamped to the screen USER reports.
 * Everything is stock: a static for the text, an auto checkbox, a default push button, the
 * system font, COLOR_WINDOW behind them. No custom drawing.
 *
 * First run only. WIN.INI [windows] run=ABOUT.EXE starts it at every Windows start; it exits
 * immediately, without creating a window, once [PVMon] AboutShown is set. Any command-line
 * argument ("ABOUT.EXE /show", which is what the Program Manager item in Main uses) shows it
 * regardless of the flag. OK writes the flag from the checkbox, which is checked by default.
 *
 * Build: guest/about/build.sh  (Open Watcom via tools/watcom.sh)
 */
#include <windows.h>

#define ID_OK   1
#define ID_HIDE 2

#define FRAME_W  352      /* the phone column, in guest pixels */
#define MARGIN    10
#define GAP        8

static char szClass[] = "PVAbout";
static char szTitle[] = "Welcome to Windows";
static char szIniApp[] = "PVMon";
static char szIniKey[] = "AboutShown";

/* Wrapped by the static control itself (DT_WORDBREAK), so the line breaks below are only
   paragraph breaks. Every gesture named here is one web/app.js actually implements. */
static char szText[] =
    "Your finger is the mouse.\r\n"
    "\r\n"
    "Tap to click; tap twice for a double-click.  One tap opens an icon in Program Manager.\r\n"
    "\r\n"
    "Hold, then drag, to move a window, an icon or a selection; a plain drag scrolls a list "
    "instead.  Hold still, then lift, for a right-click.\r\n"
    "\r\n"
    "Two fingers scroll; pinch to magnify a window's contents, then two fingers move them "
    "about.\r\n"
    "\r\n"
    "Drag a title bar to move a window; swipe a menu bar sideways if it runs off the screen.  "
    "A menu or a dialog too big for the screen is dragged with one finger, anywhere on it.\r\n"
    "\r\n"
    "Hold a title bar for the keyboard.  Its top row adds Esc, Tab, arrows, Ctrl, Alt, Del, "
    "F1-F10, Home, End, PgUp, PgDn and Ins.";

static char szHide[] = "&Don't show this again";
static char szOK[] = "OK";

static HWND hText = 0, hHide = 0, hOK = 0;
static HBRUSH hbrBack = 0;
static int done = 0;

/* Height of szText when wrapped to cx pixels, at the system font; *pLine gets one row's height. */
static int TextHeight(HWND hwnd, int cx, int *pLine)
{
    HDC hdc;
    HFONT hOld;
    RECT rc;
    TEXTMETRIC tm;
    hdc = GetDC(hwnd);
    hOld = SelectObject(hdc, GetStockObject(SYSTEM_FONT));
    GetTextMetrics(hdc, &tm);
    rc.left = 0; rc.top = 0; rc.right = cx; rc.bottom = 1;
    DrawText(hdc, szText, -1, &rc, DT_LEFT | DT_WORDBREAK | DT_CALCRECT | DT_NOPREFIX);
    SelectObject(hdc, hOld);
    ReleaseDC(hwnd, hdc);
    if (pLine) *pLine = tm.tmHeight + tm.tmExternalLeading;
    return rc.bottom - rc.top;
}

static void SaveFlag(void)
{
    WriteProfileString(szIniApp, szIniKey,
                       (hHide && SendMessage(hHide, BM_GETCHECK, 0, 0L)) ? "1" : "0");
}

LRESULT CALLBACK __export WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_CTLCOLOR:
        /* the statics and the checkbox sit on the window's own background */
        if (HIWORD(lParam) == CTLCOLOR_STATIC || HIWORD(lParam) == CTLCOLOR_BTN) {
            SetBkColor((HDC)wParam, GetSysColor(COLOR_WINDOW));
            SetTextColor((HDC)wParam, GetSysColor(COLOR_WINDOWTEXT));
            return (LRESULT)hbrBack;
        }
        break;
    case WM_COMMAND:
        if (wParam == ID_OK) { SaveFlag(); DestroyWindow(hwnd); return 0; }
        break;
    case WM_CHAR:
        if (wParam == VK_RETURN || wParam == VK_ESCAPE) { SaveFlag(); DestroyWindow(hwnd); return 0; }
        break;
    case WM_CLOSE:
        SaveFlag();
        DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        done = 1;
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

int PASCAL WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow)
{
    WNDCLASS wc;
    MSG msg;
    HWND hwnd;
    RECT rc;
    int cw, ch, ex, ey, w, h, x, y, ty, cy, by, bw, bh, lh;
    LPSTR p;
    DWORD style = WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN;

    /* an argument (the Program Manager item passes /show) always shows the note */
    for (p = lpCmd; p && *p == ' '; p++) ;
    if ((!p || !*p) && GetProfileInt(szIniApp, szIniKey, 0)) return 0;

    if (!hPrev) {
        wc.style = 0; wc.lpfnWndProc = WndProc; wc.cbClsExtra = 0; wc.cbWndExtra = 0;
        wc.hInstance = hInst;
        wc.hIcon = LoadIcon(hInst, MAKEINTRESOURCE(1));
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
        wc.lpszMenuName = NULL; wc.lpszClassName = szClass;
        if (!RegisterClass(&wc)) return 0;
    }
    hbrBack = GetStockObject(WHITE_BRUSH);

    /* the frame is 352 guest pixels wide whatever the border metrics are */
    rc.left = 0; rc.top = 0; rc.right = 100; rc.bottom = 100;
    AdjustWindowRect(&rc, style, FALSE);
    ex = (rc.right - rc.left) - 100; ey = (rc.bottom - rc.top) - 100;
    cw = FRAME_W - ex;

    hwnd = CreateWindow(szClass, szTitle, style, 0, 0, FRAME_W, 100, NULL, NULL, hInst, NULL);
    if (!hwnd) return 0;

    ty = TextHeight(hwnd, cw - 2 * MARGIN, &lh);
    bh = lh + 10;                                    /* a period push button: text plus room */
    bw = 5 * lh;
    ch = MARGIN + ty + 2 * GAP + lh + 6 + GAP + bh + MARGIN;
    h = ch + ey;
    if (h > GetSystemMetrics(SM_CYSCREEN) - 8) { h = GetSystemMetrics(SM_CYSCREEN) - 8; ch = h - ey; }
    w = FRAME_W;
    x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2; if (x < 0) x = 0;
    y = (GetSystemMetrics(SM_CYSCREEN) - h) / 3; if (y < 0) y = 0;
    MoveWindow(hwnd, x, y, w, h, FALSE);

    cy = ch - MARGIN - bh - GAP - (lh + 6);
    by = ch - MARGIN - bh;
    hText = CreateWindow("static", szText, WS_CHILD | WS_VISIBLE | SS_LEFT,
                         MARGIN, MARGIN, cw - 2 * MARGIN, ty, hwnd, (HMENU)-1, hInst, NULL);
    hHide = CreateWindow("button", szHide, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
                         MARGIN, cy, cw - 2 * MARGIN, lh + 6, hwnd, (HMENU)ID_HIDE, hInst, NULL);
    hOK = CreateWindow("button", szOK, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                       cw - MARGIN - bw, by, bw, bh, hwnd, (HMENU)ID_OK, hInst, NULL);
    SendMessage(hHide, BM_SETCHECK, 1, 0L);          /* dismissing it once is enough */

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
    SetFocus(hOK);
    BringWindowToTop(hwnd);

    while (!done && GetMessage(&msg, NULL, 0, 0)) {
        if (msg.message == WM_KEYDOWN && msg.wParam == VK_TAB) {
            SetFocus(GetFocus() == hOK ? hHide : hOK);
            continue;
        }
        if (msg.message == WM_KEYDOWN && (msg.wParam == VK_RETURN || msg.wParam == VK_ESCAPE)) {
            SaveFlag(); DestroyWindow(hwnd); continue;
        }
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return 0;
}
