/* FETCH.EXE - the guest's own web client, in native Win16 against the paravirtual socket.
 *
 * There is no TCP stack under this program any more. There used to be: COM2 was a SLIP line to the
 * host and Trumpet Winsock sat on top of it, and that worked, but it cost about 122 guest
 * instructions per byte received (238 with Microsoft's TCP/IP-32 over an emulated NE2000). At the
 * 31 MIPS this machine runs at, that is a ceiling of a couple of hundred KB/s, and all of it spent
 * on checksums and window bookkeeping for a link that is not lossy and is not even a link.
 *
 * So the stack moved to the other side of the emulator. The host fetches the URL, and the guest
 * reads the reply out of a 64 KB window of adapter memory: one `rep movsw` per byte, and the
 * per-byte cost stops being a protocol and becomes a memory copy. The device is four registers on
 * the same index/data pair the display adapter already uses (0x1CE/0x1CF):
 *
 *     0x30 CMD     1 = OPEN, 2 = READ, 3 = CLOSE      (written to execute)
 *     0x31 ARG     OPEN: length of the URL in the window; READ: how many bytes we want
 *     0x32 RESULT  OPEN: 0 accepted; READ: bytes actually placed in the window
 *     0x33 STATE   0 idle, 1 fetching, 2 data ready, 3 complete, 0xFF failed
 *
 * and the window itself is bank 0x70 of adapter memory, seen through the A0000 aperture. The
 * aperture's bank is the display driver's own register, so it is saved and put back around every
 * access, and every access is kept short.
 *
 * The rest of the program is unchanged, because none of it was ever about sockets: an overlapped
 * window with an edit control for the address, a multi-line read-only edit for what came back, the
 * whole reply streamed to C:\TEMP\FETCH.HTM as it arrives, and only the first 30 KB kept in memory
 * to show. That is the difference between a viewer with a 64 KB address space and one that can
 * fetch a whole 2026 page: nothing about the transfer is bounded by the segment, the window shows
 * as much as a stock edit control can hold, and Open hands the file to Write, which pages from
 * disk. It also makes a fetched page an ordinary file the rest of Windows can open.
 *
 * The reply is still a whole HTTP response -- status line, headers, blank line, body -- so it is
 * parsed exactly as it was when a socket delivered it.
 *
 * Draining happens on a Windows timer rather than in a loop. Windows 3.11 is cooperatively
 * multitasked: a program that spins waiting for the host stops the machine, including the host's
 * chance to answer. Each WM_TIMER takes everything the host has ready and then returns.
 *
 * Build: guest/fetch/build.sh  (Open Watcom via tools/watcom.sh)
 */
#include <windows.h>
#include <string.h>            /* _fmemcpy */
#include <conio.h>             /* inpw, outpw */
#include <i86.h>              /* _disable, _enable: the index register is shared with the mouse */

#define ID_URL    1
#define ID_GET    2
#define ID_STOP   3
#define ID_OPEN   4
#define ID_CLOSE  7
#define ID_STATUS 5
#define ID_BODY   6
#define IDT_PUMP  1
#define PUMP_MS   10           /* Windows rounds this up to the 18.2 Hz tick; that is fast enough */

#define MARGIN 10
#define ROW    26
#define GAP     8

/* ------------------------------------------------------------------ the adapter */
#define DISPI_INDEX  0x1CE
#define DISPI_DATA   0x1CF
#define R_DEBUG      0x16      /* the host's log, one byte per write, flushed by a newline */
#define R_PV_CMD     0x30
#define R_PV_ARG     0x31
#define R_PV_RESULT  0x32
#define R_PV_STATE   0x33
#define R_PV_DATA    0x34      /* read: the next two bytes of the staged block, advancing */
#define R_PV_CHAR    0x35      /* write: one byte of the URL, appended */

#define PVCMD_OPEN   1
#define PVCMD_READ   2
#define PVCMD_CLOSE  3

#define PVST_IDLE     0
#define PVST_FETCHING 1
#define PVST_DATA     2
#define PVST_DONE     3
#define PVST_ERROR    0xFF

#define PV_BLOCK   0xF000u     /* the most one READ may hand back: the device's own limit */
#define PV_CHUNK   0x2000u     /* copied out of the aperture this much at a time */

/* The adapter is programmed as an index write then a data access. PVMOUSE.DRV's interrupt handler
   writes the same index register (the cursor position, 1Dh..1Fh), so an interrupt landing between
   the two halves would read or write the wrong register. cli/popf around the pair hangs the system
   VM (a ring-3 popf does not restore IF the way the VMM's trapped cli expects), so the pair is
   checked instead: the index reads back, and if the handler moved it the access is repeated. This
   is the same rd/wr PVMON.EXE uses, and for the same reason. */
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

/* ------------------------------------------------------------------ state */
#define RAW_MAX  30000u              /* body bytes kept in memory, to show */
#define SHOW_MAX 34000u              /* those plus the line breaks this adds for readability */
#define HDR_MAX    600               /* enough for any reply header worth reading */
#define URL_MAX    600

static char szClass[] = "PVFetch";
static char szTitle[] = "Fetch";
static HWND hUrl, hGet, hStop, hClose, hStatus, hBody;
static HGLOBAL rawh;
static char FAR *raw;                /* the first RAW_MAX bytes of the body, for the window */
static unsigned rawn;
static HGLOBAL blkh;
static char FAR *blk;                /* PV_CHUNK bytes, copied out of the aperture and parsed */
static BOOL  pvOpen;                 /* a request is outstanding and must be closed */
static BOOL  pvTimer;
static BOOL  pumping;                /* WM_TIMER is not re-entered */
static HWND hOpen;
static HFILE hFile = HFILE_ERROR;    /* the whole body, as it arrives */
static char  savePath[96];
static DWORD bodyBytes;              /* how much of it there has been */
static char  hdr[HDR_MAX + 4];       /* the reply header, until the blank line */
static unsigned hdrN;
static BOOL  inBody;
static char  statusLine[64];         /* the first line of the reply, for the status text */

static void status(const char *s) { SetWindowText(hStatus, s); }

/* ------------------------------------------------------------------ the transfer
   Through ports, not memory. The adapter has a 64 KB aperture at A0000 and that would have been the
   obvious way to move a page, but a Windows application cannot reach it under the paravirtual
   display: a selector based there faults on the first write, which killed this program silently
   before a single register write got out. Ports are the one path a program is certain to have.

   The index register is set once per burst and the data register read in a loop -- `rep insw` in
   all but name, one instruction per two bytes, which is what makes this cost the guest nothing.
   Interrupts are off for the length of a burst because PVMOUSE's interrupt handler writes the same
   index register, and a mouse movement in the middle of one would leave the loop reading whatever
   register the mouse had selected. A burst is a few hundred microseconds; the mouse can wait. */
#define PV_BURST 512

static void drain(char FAR *dst, unsigned len)
{
    unsigned done = 0;
    while (done < len) {
        unsigned n = len - done, i;
        if (n > PV_BURST) n = PV_BURST;
        _disable();
        outpw(DISPI_INDEX, R_PV_DATA);
        for (i = 0; i + 1 < n; i += 2) {
            unsigned w = inpw(DISPI_DATA);
            dst[done + i] = (char)(w & 0xFF);
            dst[done + i + 1] = (char)((w >> 8) & 0xFF);
        }
        if (i < n) { unsigned w = inpw(DISPI_DATA); dst[done + i] = (char)(w & 0xFF); }
        _enable();
        done += n;
    }
}

static void send_url(const char *url, unsigned len)
{
    unsigned i;
    for (i = 0; i < len; i++) wr(R_PV_CHAR, (unsigned)(unsigned char)url[i]);
}

static void pv_close(void)
{
    if (!pvOpen) return;
    pvOpen = FALSE;
    wr(R_PV_CMD, PVCMD_CLOSE);
}

static void drop(HWND hwnd)
{
    if (pvTimer) { KillTimer(hwnd, IDT_PUMP); pvTimer = FALSE; }
    pv_close();
    if (hFile != HFILE_ERROR) { _lclose(hFile); hFile = HFILE_ERROR; }
    EnableWindow(hStop, FALSE);
    EnableWindow(hGet, TRUE);
}

/* The host wants a whole URL, and it parses it: no host, no port and no path are needed here any
   more. All this does is trim the leading space and supply the scheme the user did not type, so
   that "example.com" still works the way it did when this program dialled it itself. Either scheme
   is accepted and both mean the same thing: the guest asks for a document and the TLS, if any,
   happens off the device. */
static unsigned clean_url(const char *in, char *out)
{
    const char FAR *p = (const char FAR *)in;
    unsigned n = 0;
    while (*p == ' ' || *p == '\t') p++;
    if (!*p) return 0;
    if (_fstrnicmp(p, (const char FAR *)"http://", 7) && _fstrnicmp(p, (const char FAR *)"https://", 8)) {
        lstrcpy(out, "http://");
        n = 7;
    }
    while (*p && n < URL_MAX - 1) out[n++] = *p++;
    while (n && (out[n - 1] == ' ' || out[n - 1] == '\t')) n--;
    out[n] = 0;
    return n;
}

/* What the reply looks like in the window: the body's first RAW_MAX bytes, with bare line feeds
   turned into the carriage-return pair Windows needs, and the status line reported above. The
   headers never get here -- they are stripped as they arrive (consume) so the file on disk is the
   body and nothing else. */
static void present(void)
{
    HGLOBAL sh;
    char FAR *out;
    unsigned i, n = 0, col = 0;
    char line[80], size[40];

    raw[rawn] = 0;
    lstrcpy(line, statusLine[0] ? statusLine : "no reply");
    if (bodyBytes >= 1024L) wsprintf(size, " - %luK saved", (DWORD)(bodyBytes / 1024L));
    else wsprintf(size, " - %lu bytes saved", bodyBytes);
    if (lstrlen(line) + lstrlen(size) < (int)sizeof(line)) lstrcat(line, size);
    status(line);

    sh = GlobalAlloc(GMEM_MOVEABLE, (DWORD)SHOW_MAX + 2);
    if (!sh) return;
    out = (char FAR *)GlobalLock(sh);
    for (i = 0; i < rawn && n < SHOW_MAX - 4; i++) {
        if (raw[i] == '\n' && (i == 0 || raw[i - 1] != '\r')) { out[n++] = '\r'; col = 0; }
        else if (raw[i] == '\r') col = 0;
        if (raw[i] == '\t') { out[n++] = ' '; col++; continue; }
        out[n++] = raw[i];
        col++;
        /* A 2026 page is minified: the whole document can be one line tens of thousands of
           characters long, and a stock edit control shows a window into the middle of such a line
           rather than its start. Broken after a tag once the line is long enough, it reads. */
        if (col > 200 && raw[i] == '>') { out[n++] = '\r'; out[n++] = '\n'; col = 0; }
    }
    out[n] = 0;
    SetWindowText(hBody, out);
    SendMessage(hBody, EM_SETSEL, 0, MAKELONG(0, 0));   /* show the top of the page, not the caret */
    SendMessage(hBody, WM_VSCROLL, SB_TOP, 0L);
    GlobalUnlock(sh);
    GlobalFree(sh);
    EnableWindow(hOpen, bodyBytes != 0);
}

/* Everything that arrives: the header is collected until the blank line, the body goes straight to
   the file, and its first RAW_MAX bytes are also kept to show. */
static void take_body(const char *p, unsigned len)
{
    if (!len) return;
    if (hFile != HFILE_ERROR) _lwrite(hFile, (LPCSTR)p, len);
    bodyBytes += len;
    if (rawn < RAW_MAX) {
        unsigned room = RAW_MAX - rawn;                 /* unsigned: an int here holds 32767 */
        unsigned take = len < room ? len : room;
        _fmemcpy(raw + rawn, p, take);
        rawn += take;
    }
}
/* The header, which may be split across any number of blocks. Returns the offset in `buf` where
   the body starts, or `len` when the blank line has not been seen yet. */
static unsigned take_header(const char *buf, unsigned len)
{
    unsigned i, k;
    for (i = 0; i < len; i++) {
        if (hdrN < HDR_MAX) hdr[hdrN++] = buf[i];
        else { inBody = TRUE; return i; }               /* no blank line in 600 bytes: give up on it */
        if (hdrN >= 4 && hdr[hdrN - 4] == '\r' && hdr[hdrN - 3] == '\n'
                      && hdr[hdrN - 2] == '\r' && hdr[hdrN - 1] == '\n') { inBody = TRUE; }
        else if (hdrN >= 2 && hdr[hdrN - 2] == '\n' && hdr[hdrN - 1] == '\n') { inBody = TRUE; }
        if (inBody) {
            hdr[hdrN] = 0;
            for (k = 0; k < sizeof(statusLine) - 1 && hdr[k] && hdr[k] != '\r' && hdr[k] != '\n'; k++)
                statusLine[k] = hdr[k];
            statusLine[k] = 0;
            status(statusLine);
            return i + 1;
        }
    }
    return len;
}
static void consume(const char *buf, unsigned len)
{
    unsigned at = 0;
    if (!inBody) at = take_header(buf, len);
    if (inBody && at < len) take_body(buf + at, len - at);
}

/* ------------------------------------------------------------------ the fetch */
static void fetch_start(HWND hwnd)
{
    char raw_url[URL_MAX + 8], url[URL_MAX + 8], msg[200];
    unsigned len, res, st;

    drop(hwnd);
    GetWindowText(hUrl, raw_url, sizeof(raw_url));
    len = clean_url(raw_url, url);
    if (!len) { status("Type an address."); return; }
    SetWindowText(hBody, "");
    rawn = 0;
    hdrN = 0;
    inBody = FALSE;
    bodyBytes = 0;
    statusLine[0] = 0;
    EnableWindow(hOpen, FALSE);
    /* The reply goes here as it arrives. One name, overwritten each time: a viewer that littered
       C:\TEMP with a file per page would be a worse citizen than one that keeps the last. */
    hFile = _lcreat(savePath, 0);
    if (hFile == HFILE_ERROR) { status("Cannot write C:\\TEMP\\FETCH.HTM."); return; }

    dbg("fetch: open");
    dbg(url);
    send_url(url, len);                        /* the URL, a byte at a time, no terminator */
    wr(R_PV_ARG, len);
    wr(R_PV_CMD, PVCMD_OPEN);
    res = rd(R_PV_RESULT);
    if (res != 0) {
        wsprintf(msg, "The host refused that address (%u).", res);
        status(msg);
        _lclose(hFile); hFile = HFILE_ERROR;
        return;
    }
    pvOpen = TRUE;
    /* The host answers the OPEN write synchronously, so by now the state has already left idle.
       Still reading idle means nothing is listening on those registers at all. */
    st = rd(R_PV_STATE);
    if (st == PVST_IDLE) {
        status("No paravirtual socket on this host.");
        drop(hwnd);
        return;
    }
    wsprintf(msg, "Fetching %s...", (LPSTR)url);
    status(msg);
    EnableWindow(hGet, FALSE);
    EnableWindow(hStop, TRUE);
    if (SetTimer(hwnd, IDT_PUMP, PUMP_MS, NULL)) pvTimer = TRUE;
    else { status("No timer available."); drop(hwnd); }
}

/* One WM_TIMER: take everything the host has ready, then return to the message loop. The cap is
   only there so that a host stuck in "data ready" cannot keep this function from returning; at
   PV_BLOCK a block it is well over a megabyte, which is more than one tick's worth anyway. */
#define PV_MAX_BLOCKS 32
static void pv_pump(HWND hwnd)
{
    unsigned st, got, off, chunk;
    int blocks = 0;
    char msg[80];

    for (;;) {
        st = rd(R_PV_STATE);
        if (st == PVST_FETCHING) return;                  /* nothing yet; ask again next tick */
        if (st != PVST_DATA) break;
        if (++blocks > PV_MAX_BLOCKS) return;
        wr(R_PV_ARG, PV_BLOCK);
        wr(R_PV_CMD, PVCMD_READ);
        got = rd(R_PV_RESULT);
        if (got == 0 || got > PV_BLOCK) return;           /* nothing this time, or a bad count */
        for (off = 0; off < got; off += chunk) {
            chunk = got - off;
            if (chunk > PV_CHUNK) chunk = PV_CHUNK;
            drain(blk, chunk);
            consume(blk, chunk);
        }
        wsprintf(msg, "%lu bytes...", bodyBytes);
        status(msg);
    }
    /* complete, failed, or idle -- either way there is no more to come */
    drop(hwnd);
    present();
    if (st == PVST_ERROR) status("The host could not fetch that.");
    else if (st == PVST_IDLE && bodyBytes == 0) status("The host closed the request.");
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
    MoveWindow(hGet, MARGIN, y, 64, ROW, TRUE);
    MoveWindow(hStop, MARGIN + 64 + GAP, y, 64, ROW, TRUE);
    MoveWindow(hOpen, MARGIN + 2 * (64 + GAP), y, 64, ROW, TRUE);
    MoveWindow(hClose, r.right - MARGIN - 64, y, 64, ROW, TRUE);
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
        hOpen = CreateWindow("button", "&Open", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                             0, 0, 10, 10, hwnd, (HMENU)ID_OPEN, inst, NULL);
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
        EnableWindow(hOpen, FALSE);
        lstrcpy(savePath, "C:\\TEMP\\FETCH.HTM");
        rawh = GlobalAlloc(GMEM_MOVEABLE, (DWORD)RAW_MAX + 2);
        raw = rawh ? (char FAR *)GlobalLock(rawh) : NULL;
        blkh = GlobalAlloc(GMEM_MOVEABLE, (DWORD)PV_CHUNK);
        blk = blkh ? (char FAR *)GlobalLock(blkh) : NULL;
        if (!raw || !blk) { MessageBox(hwnd, "Out of memory.", szTitle, MB_OK | MB_ICONSTOP); return -1; }
        /* A selector over the A0000 aperture. An app cannot name segment A000 in protected mode,
           so it asks KERNEL for a descriptor and points it there, exactly as PVDISP.DRV does for
           its own screen selector. */
        return 0;
    }
    case WM_SIZE:
        layout(hwnd);
        return 0;
    case WM_SETFOCUS:
        SetFocus(hUrl);
        return 0;
    case WM_TIMER:
        if (wParam == IDT_PUMP && !pumping) {
            pumping = TRUE;
            pv_pump(hwnd);
            pumping = FALSE;
        }
        return 0;
    case WM_COMMAND:
        if (wParam == ID_GET) fetch_start(hwnd);
        else if (wParam == ID_STOP) { drop(hwnd); present(); status("Stopped."); }
        else if (wParam == ID_OPEN) {
            /* Write, not Notepad: Notepad gives up somewhere around 50 KB and a page is bigger
               than that. Write pages from disk and will read the file as text. */
            char cmd[128];
            wsprintf(cmd, "WRITE.EXE %s", (LPSTR)savePath);
            if (WinExec(cmd, SW_SHOW) < 32) status("Could not start Write.");
        }
        else if (wParam == ID_CLOSE) DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        drop(hwnd);
        if (rawh) { GlobalUnlock(rawh); GlobalFree(rawh); rawh = 0; raw = NULL; }
        if (blkh) { GlobalUnlock(blkh); GlobalFree(blkh); blkh = 0; blk = NULL; }
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
