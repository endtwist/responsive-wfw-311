/* FETCH.EXE - the guest's own web client, in native Win16 against Winsock.
 *
 * COM2 is a SLIP line to the host (web/net.js), Trumpet Winsock is the stack on top of it, and the
 * host turns each HTTP request the guest makes into a real one (api/fetch.js) -- which is how a
 * machine with no ciphers and about 35 MIPS reads a 2026 web site: it speaks plain HTTP/1.0 to a
 * terminal server that does not exist, and the TLS happens off the device.
 *
 * Windows for Workgroups shipped no HTTP client, so this is one, written the way one would have
 * been written then: an overlapped window with an edit control for the address, a multi-line edit
 * for what came back, and an asynchronous socket driven by WSAAsyncSelect so the 16-bit scheduler
 * is never blocked. Every control is stock and the font is the system font.
 *
 * WINSOCK.DLL is loaded and its entry points taken by ordinal rather than linked against an import
 * library, because there is no Winsock import library in this toolchain and the ordinals are the
 * ones the 1.1 specification fixes (socket = 23, connect = 4, ...). It also means the program still
 * starts when no stack is installed, and says so, instead of failing to load at all.
 *
 * Build: guest/fetch/build.sh  (Open Watcom via tools/watcom.sh)
 */
#include <windows.h>
#include <string.h>            /* _fmemcpy, _fmemset */

#define ID_URL    1
#define ID_GET    2
#define ID_STOP   3
#define ID_CLOSE  4
#define ID_STATUS 5
#define ID_BODY   6
#define WM_SOCKET (WM_USER + 100)

#define MARGIN 10
#define ROW    26
#define GAP     8

/* ------------------------------------------------------------------ Winsock, by ordinal */
typedef unsigned int SOCKET;
#define INVALID_SOCKET ((SOCKET)~0)
#define SOCKET_ERROR   (-1)
#define AF_INET         2
#define SOCK_STREAM     1
#define FD_READ         0x01
#define FD_WRITE        0x02
#define FD_CONNECT      0x10
#define FD_CLOSE        0x20
#define WSAEWOULDBLOCK  10035

struct sockaddr_in {
    short          sin_family;
    unsigned short sin_port;
    unsigned long  sin_addr;
    char           sin_zero[8];
};
struct hostent {
    char FAR *h_name;
    char FAR * FAR *h_aliases;
    short h_addrtype;
    short h_length;
    char FAR * FAR *h_addr_list;
};

typedef int         (PASCAL FAR *FN_startup)(WORD, char FAR *);
typedef int         (PASCAL FAR *FN_cleanup)(void);
typedef SOCKET      (PASCAL FAR *FN_socket)(int, int, int);
typedef int         (PASCAL FAR *FN_connect)(SOCKET, struct sockaddr_in FAR *, int);
typedef int         (PASCAL FAR *FN_send)(SOCKET, const char FAR *, int, int);
typedef int         (PASCAL FAR *FN_recv)(SOCKET, char FAR *, int, int);
typedef int         (PASCAL FAR *FN_close)(SOCKET);
typedef struct hostent FAR * (PASCAL FAR *FN_byname)(const char FAR *);
typedef unsigned long (PASCAL FAR *FN_inetaddr)(const char FAR *);
typedef unsigned short (PASCAL FAR *FN_htons)(unsigned short);
typedef int         (PASCAL FAR *FN_asyncsel)(SOCKET, HWND, unsigned int, long);
typedef int         (PASCAL FAR *FN_lasterr)(void);

static HINSTANCE    ws;                    /* WINSOCK.DLL */
static FN_startup   p_startup;
static FN_cleanup   p_cleanup;
static FN_socket    p_socket;
static FN_connect   p_connect;
static FN_send      p_send;
static FN_recv      p_recv;
static FN_close     p_closesocket;
static FN_byname    p_gethostbyname;
static FN_inetaddr  p_inet_addr;
static FN_htons     p_htons;
static FN_asyncsel  p_asyncselect;
static FN_lasterr   p_lasterror;

/* MAKELP(0, ordinal): a selector of zero and the ordinal as the offset is how Win16 asks for an
   entry point by number rather than by name. */
static FARPROC by_ord(HINSTANCE h, unsigned ord)
{
    return GetProcAddress(h, (LPCSTR)(unsigned long)ord);
}
static BOOL winsock_load(void)
{
    char buf[512];                          /* WSADATA: bigger than the struct, never read here */
    if (ws) return TRUE;
    ws = LoadLibrary("WINSOCK.DLL");
    if ((UINT)ws < 32) { ws = 0; return FALSE; }
    p_startup       = (FN_startup)  by_ord(ws, 115);
    p_cleanup       = (FN_cleanup)  by_ord(ws, 116);
    p_socket        = (FN_socket)   by_ord(ws, 23);
    p_connect       = (FN_connect)  by_ord(ws, 4);
    p_send          = (FN_send)     by_ord(ws, 19);
    p_recv          = (FN_recv)     by_ord(ws, 16);
    p_closesocket   = (FN_close)    by_ord(ws, 3);
    p_gethostbyname = (FN_byname)   by_ord(ws, 52);
    p_inet_addr     = (FN_inetaddr) by_ord(ws, 10);
    p_htons         = (FN_htons)    by_ord(ws, 9);
    p_asyncselect   = (FN_asyncsel) by_ord(ws, 101);
    p_lasterror     = (FN_lasterr)  by_ord(ws, 111);
    if (!p_startup || !p_socket || !p_connect || !p_send || !p_recv || !p_asyncselect) {
        FreeLibrary(ws); ws = 0; return FALSE;
    }
    if (p_startup(0x0101, buf) != 0) { FreeLibrary(ws); ws = 0; return FALSE; }
    return TRUE;
}

/* ------------------------------------------------------------------ state */
#define RAW_MAX  60000u              /* what one fetch may bring back */
#define SHOW_MAX 30000u              /* what an edit control will hold and still scroll */

static char szClass[] = "PVFetch";
static char szTitle[] = "Fetch";
static HWND hUrl, hGet, hStop, hClose, hStatus, hBody;
static SOCKET sock = INVALID_SOCKET;
static HGLOBAL rawh;
static char FAR *raw;                /* the response exactly as it arrived */
static unsigned rawn;
static char host[128], path[512];
static int  port;
static BOOL trunc;                   /* the reply was longer than RAW_MAX and was cut off */

static void status(const char *s) { SetWindowText(hStatus, s); }

static void drop(void)
{
    if (sock != INVALID_SOCKET) {
        p_asyncselect(sock, NULL, 0, 0);
        p_closesocket(sock);
        sock = INVALID_SOCKET;
    }
    EnableWindow(hStop, FALSE);
    EnableWindow(hGet, TRUE);
}

/* http://host[:port]/path, or host/path -- everything else is a name with no path. */
static BOOL split_url(const char *url)
{
    const char *p = url;
    int i;
    while (*p == ' ') p++;
    /* Either scheme is accepted and both mean the same thing here: the guest speaks HTTP and the
       host does the TLS, so https:// is not a lie, it just happens somewhere else. */
    if (!_fstrnicmp((const char FAR *)p, (const char FAR *)"http://", 7)) p += 7;
    else if (!_fstrnicmp((const char FAR *)p, (const char FAR *)"https://", 8)) p += 8;
    port = 80;
    for (i = 0; *p && *p != '/' && *p != ':' && i < (int)sizeof(host) - 1; p++) host[i++] = *p;
    host[i] = 0;
    if (!host[0]) return FALSE;
    if (*p == ':') {
        long n = 0;
        for (p++; *p >= '0' && *p <= '9'; p++) n = n * 10 + (*p - '0');
        port = (n > 0 && n <= 65535) ? (int)n : 80;
    }
    if (*p != '/') lstrcpy(path, "/");
    else { for (i = 0; *p && i < (int)sizeof(path) - 1; p++) path[i++] = *p; path[i] = 0; }
    return TRUE;
}

/* What the response looks like once it is in an edit control: the body only, with every bare line
   feed turned into the carriage-return pair Windows needs, and the status line reported above. */
static void present(void)
{
    HGLOBAL sh;
    char FAR *out;
    unsigned i = 0, n = 0, start = 0;
    char line[80];
    int k;

    raw[rawn < RAW_MAX ? rawn : RAW_MAX - 1] = 0;
    for (k = 0; k < (int)sizeof(line) - 40 && i < rawn && raw[i] != '\r' && raw[i] != '\n'; i++, k++)
        line[k] = raw[i];
    line[k] = 0;
    if (trunc) lstrcat(line, " - first 60K only");
    status(line[0] ? line : "no reply");

    for (i = 0; i + 3 < rawn; i++)
        if (raw[i] == '\r' && raw[i + 1] == '\n' && raw[i + 2] == '\r' && raw[i + 3] == '\n') { start = i + 4; break; }
    if (!start) for (i = 0; i + 1 < rawn; i++)
        if (raw[i] == '\n' && raw[i + 1] == '\n') { start = i + 2; break; }

    sh = GlobalAlloc(GMEM_MOVEABLE, (DWORD)SHOW_MAX + 2);
    if (!sh) return;
    out = (char FAR *)GlobalLock(sh);
    for (i = start; i < rawn && n < SHOW_MAX - 2; i++) {
        if (raw[i] == '\n' && (i == 0 || raw[i - 1] != '\r')) out[n++] = '\r';
        if (raw[i] == '\t') { out[n++] = ' '; continue; }
        out[n++] = raw[i];
    }
    out[n] = 0;
    SetWindowText(hBody, out);
    GlobalUnlock(sh);
    GlobalFree(sh);
}

static void fetch_start(HWND hwnd)
{
    char url[600], msg[200];
    struct sockaddr_in sa;
    struct hostent FAR *he;
    unsigned long addr;

    drop();
    if (!winsock_load()) {
        status("No Winsock: start Trumpet Winsock first.");
        return;
    }
    GetWindowText(hUrl, url, sizeof(url));
    if (!split_url(url)) { status("Type an address."); return; }
    SetWindowText(hBody, "");
    rawn = 0;
    trunc = FALSE;

    addr = p_inet_addr(host);
    if (addr == (unsigned long)-1) {
        wsprintf(msg, "Looking up %s...", (LPSTR)host);
        status(msg);
        he = p_gethostbyname(host);           /* Trumpet's resolver; the host answers in one packet */
        if (!he) { wsprintf(msg, "No such host: %s", (LPSTR)host); status(msg); return; }
        addr = *(unsigned long FAR *)he->h_addr_list[0];
    }
    sock = p_socket(AF_INET, SOCK_STREAM, 0);
    if (sock == INVALID_SOCKET) { status("No socket."); return; }
    if (p_asyncselect(sock, hwnd, WM_SOCKET, FD_CONNECT | FD_READ | FD_CLOSE) == SOCKET_ERROR) {
        status("WSAAsyncSelect failed."); drop(); return;
    }
    sa.sin_family = AF_INET;
    sa.sin_port = p_htons((unsigned short)port);
    sa.sin_addr = addr;
    _fmemset(sa.sin_zero, 0, sizeof(sa.sin_zero));
    wsprintf(msg, "Connecting to %s:%d...", (LPSTR)host, port);
    status(msg);
    EnableWindow(hGet, FALSE);
    EnableWindow(hStop, TRUE);
    if (p_connect(sock, &sa, sizeof(sa)) == SOCKET_ERROR && p_lasterror && p_lasterror() != WSAEWOULDBLOCK) {
        wsprintf(msg, "Cannot connect (error %d).", p_lasterror());
        status(msg); drop();
    }
}

static void send_request(void)
{
    char req[800];
    int n;
    /* HTTP/1.0 with an explicit close: the terminal server on the other end reads one request and
       answers it, and 1.0 is what a 1994 client would have sent anyway. */
    n = wsprintf(req, "GET %s HTTP/1.0\r\nHost: %s\r\nUser-Agent: WfWg 3.11 Fetch\r\nAccept: */*\r\nConnection: close\r\n\r\n",
                 (LPSTR)path, (LPSTR)host);
    if (p_send(sock, req, n, 0) == SOCKET_ERROR) { status("Could not send the request."); drop(); return; }
    status("Waiting for the reply...");
}

static void read_some(void)
{
    char buf[1024];
    int n, took = 0;
    char msg[80];
    /* Read until the socket says it has nothing left. WSAAsyncSelect's FD_READ is edge triggered:
       it is re-armed by a recv that comes back WSAEWOULDBLOCK, so a reader that stops early because
       it got a short read is never told about the rest. That, with the peer honouring the guest's
       2 KB window, is a deadlock -- the transfer stopped dead at exactly 2048 bytes. */
    for (;;) {
        n = p_recv(sock, buf, sizeof(buf), 0);
        if (n <= 0) break;                        /* 0 = the peer closed, SOCKET_ERROR = would block */
        took += n;
        if (rawn < RAW_MAX - 1) {
            int room = (int)(RAW_MAX - 1 - rawn);
            int take = n < room ? n : room;
            _fmemcpy(raw + rawn, buf, take);
            rawn += take;
        }
        /* Full. A 2026 front page is several hundred kilobytes and this machine reads a couple of
           kilobytes a second, so draining the rest to be polite would leave the window sitting on
           "59999 bytes..." for minutes with nothing to show. Hang up and show what arrived, which
           is what a client with a 64 KB address space would always have had to do. */
        if (rawn >= RAW_MAX - 1) {
            trunc = TRUE;
            drop();
            present();
            return;
        }
    }
    if (took) {
        wsprintf(msg, "%u bytes...", rawn);
        status(msg);
    }
}

/* ------------------------------------------------------------------ window */
static void layout(HWND hwnd)
{
    RECT r;
    int w, y;
    GetClientRect(hwnd, &r);
    w = r.right - 2 * MARGIN;
    y = MARGIN;
    MoveWindow(hUrl, MARGIN, y, w, ROW, TRUE);            y += ROW + GAP;
    MoveWindow(hGet, MARGIN, y, 72, ROW, TRUE);
    MoveWindow(hStop, MARGIN + 72 + GAP, y, 72, ROW, TRUE);
    MoveWindow(hClose, r.right - MARGIN - 72, y, 72, ROW, TRUE);
    y += ROW + GAP;
    MoveWindow(hStatus, MARGIN, y, w, 18, TRUE);          y += 18 + GAP;
    MoveWindow(hBody, MARGIN, y, w, r.bottom - y - MARGIN, TRUE);
}

LRESULT CALLBACK __export WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
    case WM_CREATE: {
        HINSTANCE inst = ((LPCREATESTRUCT)lParam)->hInstance;
        HFONT f = (HFONT)GetStockObject(SYSTEM_FONT);
        HWND c;
        hUrl = CreateWindow("edit", "http://example.com/",
                            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL,
                            0, 0, 10, 10, hwnd, (HMENU)ID_URL, inst, NULL);
        hGet = CreateWindow("button", "&Get", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                            0, 0, 10, 10, hwnd, (HMENU)ID_GET, inst, NULL);
        hStop = CreateWindow("button", "&Stop", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                             0, 0, 10, 10, hwnd, (HMENU)ID_STOP, inst, NULL);
        hClose = CreateWindow("button", "&Close", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                              0, 0, 10, 10, hwnd, (HMENU)ID_CLOSE, inst, NULL);
        hStatus = CreateWindow("static", "Ready.", WS_CHILD | WS_VISIBLE | SS_LEFT,
                               0, 0, 10, 10, hwnd, (HMENU)ID_STATUS, inst, NULL);
        hBody = CreateWindow("edit", "",
                             WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | WS_VSCROLL
                             | ES_MULTILINE | ES_AUTOVSCROLL | ES_READONLY,
                             0, 0, 10, 10, hwnd, (HMENU)ID_BODY, inst, NULL);
        for (c = GetWindow(hwnd, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT))
            SendMessage(c, WM_SETFONT, (WPARAM)f, 0L);
        SendMessage(hBody, EM_LIMITTEXT, 0, 0L);           /* 0 = as much as an edit will take */
        EnableWindow(hStop, FALSE);
        rawh = GlobalAlloc(GMEM_MOVEABLE, (DWORD)RAW_MAX);
        raw = rawh ? (char FAR *)GlobalLock(rawh) : NULL;
        if (!raw) { MessageBox(hwnd, "Out of memory.", szTitle, MB_OK | MB_ICONSTOP); return -1; }
        return 0;
    }
    case WM_SIZE:
        layout(hwnd);
        return 0;
    case WM_SETFOCUS:
        SetFocus(hUrl);
        return 0;
    case WM_COMMAND:
        if (wParam == ID_GET) fetch_start(hwnd);
        else if (wParam == ID_STOP) { drop(); status("Stopped."); }
        else if (wParam == ID_CLOSE) DestroyWindow(hwnd);
        return 0;
    case WM_SOCKET: {
        int event = (int)LOWORD(lParam), err = (int)HIWORD(lParam);
        char msg[80];
        if ((SOCKET)wParam != sock) return 0;
        if (err && event == FD_CONNECT) {
            wsprintf(msg, "Cannot connect (error %d).", err);
            status(msg); drop(); return 0;
        }
        if (event == FD_CONNECT) send_request();
        else if (event == FD_READ) read_some();
        else if (event == FD_CLOSE) { read_some(); drop(); present(); }
        return 0;
    }
    case WM_DESTROY:
        drop();
        if (rawh) { GlobalUnlock(rawh); GlobalFree(rawh); rawh = 0; raw = NULL; }
        if (ws) { if (p_cleanup) p_cleanup(); FreeLibrary(ws); ws = 0; }
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

    if (!prev) {
        wc.style = 0; wc.lpfnWndProc = WndProc; wc.cbClsExtra = 0; wc.cbWndExtra = 0;
        wc.hInstance = inst; wc.hIcon = LoadIcon(inst, "1");
        wc.hCursor = LoadCursor(NULL, IDC_ARROW);
        wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
        wc.lpszMenuName = NULL; wc.lpszClassName = szClass;
        if (!RegisterClass(&wc)) return 0;
    }
    hwnd = CreateWindow(szClass, szTitle, WS_OVERLAPPEDWINDOW,
                        CW_USEDEFAULT, CW_USEDEFAULT, 352, 560, NULL, NULL, inst, NULL);
    if (!hwnd) return 0;
    ShowWindow(hwnd, show ? show : SW_SHOW);
    UpdateWindow(hwnd);
    /* An address on the command line is fetched as soon as the window is up, which is what makes
       this reachable from the host's deep links and from a Program Manager item. */
    if (cmd && cmd[0]) {
        SetWindowText(hUrl, cmd);
        PostMessage(hwnd, WM_COMMAND, ID_GET, 0L);
    }
    while (GetMessage(&m, NULL, 0, 0)) {
        if (!IsDialogMessage(hwnd, &m)) { TranslateMessage(&m); DispatchMessage(&m); }
    }
    return 0;
}
