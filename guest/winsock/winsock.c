/* WINSOCK.DLL - Windows Sockets 1.1 for Windows for Workgroups 3.11, with no TCP stack under it.
 *
 * There is no IP on this machine any more. There used to be -- Trumpet over a SLIP line on COM2,
 * and Microsoft's TCP/IP-32 over an emulated NE2000 -- and both worked, and both cost more per
 * byte than the byte was worth: about 122 guest instructions for Trumpet and 238 for Microsoft,
 * against a budget of 31 MIPS. That is a ceiling of a couple of hundred KB/s, and every one of
 * those instructions goes on checksums and window bookkeeping for a link that is not lossy and is
 * not, in any physical sense, a link.
 *
 * So the stack lives on the other side of the emulator now. The host opens the connection and does
 * the fetch -- TLS included, which this machine could not do at any speed -- and the guest moves
 * bytes through a register on the display adapter's index/data pair: one `in` per two bytes, which
 * turns the per-byte cost from a protocol into a memory copy. Measured end to end that is 492 KB
 * in under 300 ms.
 *
 * FETCH.EXE already drives that device directly. This DLL is the same thing behind the API every
 * period program already speaks, so that a 1994 browser -- which knows how to call connect() and
 * recv() and nothing else -- gets the whole transfer rate without a line of its own changed. Put
 * in C:\WINDOWS it precedes C:\TRUMPET on the PATH and takes over from Trumpet without a setting
 * being touched.
 *
 * ---------------------------------------------------------------------------- the device
 * Index/data at 0x1CE/0x1CF, all sixteen bits wide, eight connection handles:
 *
 *   0x36 SEL     write: the handle 0..7 every other register below then refers to
 *   0x30 CMD     write: 1 open, 2 stage a read block, 3 close, 4 send
 *   0x31 ARG     write before CMD: 2 = bytes wanted, 4 = bytes to send
 *   0x32 RESULT  read after CMD: 2 = bytes actually staged, 1 = 0 accepted
 *   0x33 STATE   read: 0 idle, 1 working, 2 data ready, 3 peer closed (all delivered), 0xFF error
 *   0x34 DATA    read: the next two bytes of the staged block, little endian, advancing
 *   0x35 CHAR    write: one byte appended to the pending connect target
 *   0x37 SEND    write: two bytes appended to the outbound buffer, little endian
 *
 * A connection is: SEL a free handle, push "host:port" through CHAR, CMD=1, check RESULT; push the
 * request through SEND and CMD=4 with ARG = the count; then poll STATE, and on 2 set ARG, CMD=2,
 * read RESULT and drain that many bytes from DATA. CMD=3 releases the handle.
 *
 * ---------------------------------------------------------------------------- names
 * Nothing routes in this guest, so nothing here resolves anything: gethostbyname hands out an
 * address from 10.64.0.0/16 and remembers which name it gave it to, and connect() looks the
 * address back up and sends the *name* to the device, because the host is the one that can resolve
 * it. inet_addr and inet_ntoa agree with what was handed out, so a program that prints the address
 * it connected to prints something sane, and one that passes the address around gets back to the
 * right name. An address that was never handed out is sent as dotted quad and the host may make of
 * it what it likes.
 *
 * ---------------------------------------------------------------------------- the two hard parts
 * Asynchronous notification. WSAAsyncSelect has to PostMessage FD_CONNECT, FD_READ, FD_WRITE and
 * FD_CLOSE as they happen, and there is no interrupt from this device to hang that on, so the DLL
 * keeps a Windows timer (one per WSAStartup, so it belongs to a task that is running) and looks at
 * every registered socket on each tick. That is how the real DLLs did it too; theirs ticked on a
 * packet arriving and this one ticks on the clock.
 *
 * Blocking. A program that calls a blocking recv() expects the DLL to keep the machine alive while
 * it waits, because Windows 3.11 is cooperatively multitasked and a spin loop in one program stops
 * every other one -- including, here, the host's chance to answer. So every wait in this file goes
 * through the blocking hook, whose default does one PeekMessage/TranslateMessage/DispatchMessage,
 * and WSASetBlockingHook, WSAUnhookBlockingHook, WSAIsBlocking and WSACancelBlockingCall all mean
 * what the specification says they mean.
 *
 * ---------------------------------------------------------------------------- what is not here
 * Listening sockets: accept, listen and bind-to-a-port answer WSAEOPNOTSUPP, because the device
 * has no inbound path. Datagrams: SOCK_DGRAM answers WSAEPROTONOSUPPORT, for the same reason.
 * Everything in the ordinal list is still exported, because a program that imports an ordinal that
 * is not there does not fail at the call, it fails to load at all.
 *
 * Build: guest/winsock/build.sh (Open Watcom via tools/watcom.sh, wlink system windows_dll).
 */
#include <windows.h>
#include <winsock.h>
#include <string.h>            /* _fmemcpy, _fmemmove */
#include <conio.h>             /* inpw, outpw */
#include <i86.h>               /* _disable, _enable */

/* ------------------------------------------------------------------ the adapter */
#define DISPI_INDEX  0x1CE
#define DISPI_DATA   0x1CF
#define R_DEBUG      0x16      /* the host's log, one byte per write, flushed by a newline */
#define R_PV_CMD     0x30
#define R_PV_ARG     0x31
#define R_PV_RESULT  0x32
#define R_PV_STATE   0x33
#define R_PV_DATA    0x34
#define R_PV_CHAR    0x35
#define R_PV_SEL     0x36
#define R_PV_SEND    0x37

#define PVCMD_OPEN   1
#define PVCMD_READ   2
#define PVCMD_CLOSE  3
#define PVCMD_SEND   4

#define PVST_IDLE     0
#define PVST_WORKING  1
#define PVST_DATA     2
#define PVST_CLOSED   3
#define PVST_ERROR    0xFF

#define PV_BLOCK   0xF000u     /* the most one stage may hand back: the device's own limit */
#define PV_BURST   512         /* how long the index register is held for one drain */

/* The adapter is programmed as an index write then a data access, and PVMOUSE.DRV's interrupt
   handler writes the same index register (cursor position, 1Dh..1Fh). An interrupt landing between
   the two halves would read or write whichever register the mouse had selected. cli/popf around
   the pair hangs the system VM (a ring-3 popf does not restore IF the way the VMM's trapped cli
   expects), so the pair is checked instead: the index is read back, and the access repeated if the
   handler moved it. Identical to FETCH.EXE's and PVMON.EXE's, and for the same reason. */
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

static int g_trace;            /* WIN.INI [PVWinsock] Trace=1 */
static void dbg(const char *s)
{
    if (!g_trace) return;
    while (*s) wr(R_DEBUG, (unsigned char)*s++);
    wr(R_DEBUG, 10);
}

/* SEL is device-global: every register below it acts on the handle last selected. Nothing may run
   between selecting a handle and finishing with it, which under a cooperative scheduler means only
   that no function between the two may pump messages -- interrupts do not reach this code, and the
   rd/wr above already survive the one interrupt handler that shares the index register. Every
   sequence in this file is written that way, and sel() is called again at the head of each. */
static void sel(int h)
{
    int tries = 4;
    do { wr(R_PV_SEL, (unsigned)h); } while ((int)(rd(R_PV_SEL) & 7) != (h & 7) && --tries);
}

/* Out of the data register in bursts, `rep insw` in all but name: the index is set once and the
   data register read in a loop, one instruction per two bytes, which is what makes a megabyte cost
   the guest nothing. Interrupts are off for a burst because of the shared index register; a burst
   is a few hundred microseconds and the mouse can wait that long. */
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

/* And in, through SEND, two bytes at a time. Same discipline, same reason. */
static void stuff(const char FAR *src, unsigned len)
{
    unsigned done = 0;
    while (done < len) {
        unsigned n = len - done, i;
        if (n > PV_BURST) n = PV_BURST;
        _disable();
        outpw(DISPI_INDEX, R_PV_SEND);
        for (i = 0; i + 1 < n; i += 2)
            outpw(DISPI_DATA, (unsigned)(unsigned char)src[done + i]
                            | ((unsigned)(unsigned char)src[done + i + 1] << 8));
        if (i < n) outpw(DISPI_DATA, (unsigned)(unsigned char)src[done + i]);
        _enable();
        done += n;
    }
}

/* ------------------------------------------------------------------ sockets */
#define MAX_SOCK   8                   /* the device's eight handles, and no more */
#define RXCAP      16384u              /* buffered per socket: two device blocks' worth of slack */

#define ST_FREE    0
#define ST_UNBOUND 1                   /* created, never connected */
#define ST_CONNECT 2                   /* connect() issued, not yet reported to the program */
#define ST_OPEN    3                   /* connected */
#define ST_DEAD    4                   /* the device is finished with it: closed or failed */

typedef struct {
    int      state;
    HTASK    owner;
    BOOL     nonblock;
    BOOL     rdShut, wrShut;
    BOOL     peerClosed;               /* STATE reached 3: everything has been delivered */
    BOOL     failed;                   /* STATE reached 0xFF */
    u_long   peerAddr;                 /* network order */
    u_short  peerPort;                 /* network order */
    u_long   localAddr;
    u_short  localPort;
    HWND     hWnd;                     /* WSAAsyncSelect */
    u_int    wMsg;
    long     lEvent;
    long     posted;                   /* which of those have been posted and not re-armed */
    int      err;                      /* SO_ERROR */
    HGLOBAL  rxh;
    char FAR *rx;
    unsigned rxHead, rxTail;           /* a linear FIFO, compacted when it runs out of tail */
} SOCK;

static SOCK sk[MAX_SOCK];

/* One entry per WSAStartup: the timer that drives WSAAsyncSelect has to belong to a task that is
   still running, so each user of the DLL brings its own and takes it away again. */
typedef struct { HTASK task; int refs; UINT timer; } INST;
#define MAX_INST 8
static INST inst[MAX_INST];
static int g_err;                      /* WSAGetLastError, one for the DLL (see the report) */
static BOOL g_blocking;                /* a blocking call is in progress */
static BOOL g_cancel;                  /* WSACancelBlockingCall was called during it */
static FARPROC g_hook;                 /* the blocking hook, default below */

typedef BOOL (FAR PASCAL *BLOCKPROC)(void);

static void set_err(int e) { g_err = e; }
static int  fail(int e)    { g_err = e; return SOCKET_ERROR; }

static int idx_of(SOCKET s)
{
    if (s < 1 || s > MAX_SOCK) return -1;
    if (sk[s - 1].state == ST_FREE) return -1;
    return (int)(s - 1);
}
static SOCKET sock_of(int i) { return (SOCKET)(i + 1); }

/* ------------------------------------------------------------------ byte order and addresses */
u_short PASCAL FAR htons(u_short h) { return (u_short)((h << 8) | (h >> 8)); }
u_short PASCAL FAR ntohs(u_short n) { return (u_short)((n << 8) | (n >> 8)); }
u_long PASCAL FAR htonl(u_long h)
{
    return ((h & 0xFFL) << 24) | ((h & 0xFF00L) << 8) | ((h >> 8) & 0xFF00L) | ((h >> 24) & 0xFFL);
}
u_long PASCAL FAR ntohl(u_long n) { return htonl(n); }

/* The names this DLL has invented an address for. 10.64.0.0/16, in the order they were asked for,
   which is also what web/net.js hands out over the SLIP line, so the two agree by construction. */
#define MAX_NAMES  48
#define NAME_LEN   64
static char   nm_name[MAX_NAMES][NAME_LEN];
static u_long nm_addr[MAX_NAMES];      /* network order */
static int    nm_count;

static char up(char c) { return (c >= 'a' && c <= 'z') ? (char)(c - 32) : c; }

static int name_eq(const char FAR *a, const char *b)
{
    int i;
    for (i = 0; i < NAME_LEN; i++) {
        char x = up(a[i]), y = up(b[i]);
        if (x != y) return 0;
        if (!x) return 1;
    }
    return 0;
}
static u_long addr_for_index(int i)
{
    u_long h = 0x0A400000L + (u_long)(i + 1);      /* 10.64.0.1 upwards */
    return htonl(h);
}
/* The address this name has, inventing one the first time it is asked for. 0 when the table is
   full, which is not a condition any program of this era will meet. */
static u_long addr_for_name(const char FAR *name)
{
    int i, n;
    for (i = 0; i < nm_count; i++)
        if (name_eq(name, nm_name[i])) return nm_addr[i];
    if (nm_count >= MAX_NAMES) return 0;
    i = nm_count;
    for (n = 0; n < NAME_LEN - 1 && name[n]; n++) nm_name[i][n] = name[n];
    nm_name[i][n] = 0;
    nm_addr[i] = addr_for_index(i);
    nm_count++;
    return nm_addr[i];
}
static const char *name_for_addr(u_long a)
{
    int i;
    for (i = 0; i < nm_count; i++) if (nm_addr[i] == a) return nm_name[i];
    return NULL;
}

/* dotted quad, both ways. inet_addr answers INADDR_NONE for anything that is not four numbers, as
   a period program expects, so that "www.example.com" falls through to gethostbyname. */
unsigned long PASCAL FAR inet_addr(const char FAR *cp)
{
    u_long parts[4];
    int n = 0;
    const char FAR *p = cp;

    if (!p) return INADDR_NONE;
    while (*p == ' ' || *p == '\t') p++;
    for (;;) {
        u_long v = 0;
        int digits = 0;
        while (*p >= '0' && *p <= '9') { v = v * 10 + (u_long)(*p - '0'); p++; digits++; if (v > 255L) return INADDR_NONE; }
        if (!digits || n > 3) return INADDR_NONE;
        parts[n++] = v;
        if (*p != '.') break;
        p++;
    }
    while (*p == ' ' || *p == '\t') p++;
    if (*p || n != 4) return INADDR_NONE;
    return htonl((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]);
}

static void dotted(u_long netorder, char FAR *out)
{
    u_long h = ntohl(netorder);
    wsprintf(out, "%u.%u.%u.%u", (unsigned)((h >> 24) & 255), (unsigned)((h >> 16) & 255),
             (unsigned)((h >> 8) & 255), (unsigned)(h & 255));
}

static char inet_buf[20];
char FAR * PASCAL FAR inet_ntoa(struct in_addr in)
{
    dotted(in.s_addr, inet_buf);
    return (char FAR *)inet_buf;
}

/* ------------------------------------------------------------------ the device, per socket */
static void rx_compact(SOCK *s)
{
    if (s->rxHead == 0) return;
    if (s->rxHead == s->rxTail) { s->rxHead = s->rxTail = 0; return; }
    _fmemmove(s->rx, s->rx + s->rxHead, s->rxTail - s->rxHead);
    s->rxTail -= s->rxHead;
    s->rxHead = 0;
}
static unsigned rx_avail(SOCK *s) { return s->rxTail - s->rxHead; }

/* Everything the device has ready for this socket, into its buffer. Called from recv, select,
   ioctlsocket and the timer tick, and never anywhere that could yield in the middle of it. */
static void pump(int i)
{
    SOCK *s = &sk[i];
    unsigned st, want, got;
    int blocks = 0;

    if (s->state != ST_CONNECT && s->state != ST_OPEN) return;
    for (;;) {
        sel(i);
        st = rd(R_PV_STATE);
        if (st == PVST_ERROR) {
            s->failed = TRUE;
            s->peerClosed = TRUE;
            if (!s->err) s->err = (s->state == ST_CONNECT) ? WSAECONNREFUSED : WSAECONNRESET;
            return;
        }
        if (st == PVST_CLOSED) { s->peerClosed = TRUE; return; }
        if (st != PVST_DATA) return;                  /* working, or idle and nothing to take */
        rx_compact(s);
        want = RXCAP - s->rxTail;
        if (want == 0) return;                        /* full: the device holds the rest */
        if (want > PV_BLOCK) want = PV_BLOCK;
        sel(i);
        wr(R_PV_ARG, want);
        wr(R_PV_CMD, PVCMD_READ);
        got = rd(R_PV_RESULT);
        if (got == 0 || got > want) return;           /* nothing this time, or a count to distrust */
        drain(s->rx + s->rxTail, got);
        s->rxTail += got;
        if (++blocks >= 8) return;                    /* come back on the next tick; do not sit here */
    }
}

static void dev_close(int i)
{
    SOCK *s = &sk[i];
    if (s->state == ST_CONNECT || s->state == ST_OPEN || s->state == ST_DEAD) {
        sel(i);
        wr(R_PV_CMD, PVCMD_CLOSE);
    }
    if (s->rxh) { GlobalUnlock(s->rxh); GlobalFree(s->rxh); s->rxh = 0; s->rx = NULL; }
    s->state = ST_FREE;
}

/* ------------------------------------------------------------------ asynchronous notification */
static void post(int i, long event, int err)
{
    SOCK *s = &sk[i];
    if (!s->hWnd || !(s->lEvent & event)) return;
    if (s->posted & event) return;                    /* one message until the program re-arms it */
    s->posted |= event;
    PostMessage(s->hWnd, s->wMsg, (WPARAM)sock_of(i), WSAMAKESELECTREPLY((int)event, err));
}

/* What has become true of this socket since the last look. connect() is answered here rather than
   at the call so that a program written round WSAAsyncSelect gets its FD_CONNECT in a message, the
   way it is waiting for it. */
static void notify(int i)
{
    SOCK *s = &sk[i];
    if (s->state == ST_CONNECT) {
        if (s->failed) {
            s->state = ST_DEAD;
            post(i, FD_CONNECT, s->err ? s->err : WSAECONNREFUSED);
            return;
        }
        s->state = ST_OPEN;
        post(i, FD_CONNECT, 0);
        post(i, FD_WRITE, 0);
    }
    if (s->state != ST_OPEN) return;
    if (rx_avail(s)) post(i, FD_READ, 0);
    if (s->failed) { post(i, FD_CLOSE, s->err ? s->err : WSAECONNRESET); return; }
    if (s->peerClosed && !rx_avail(s)) post(i, FD_CLOSE, 0);
}

static void tick_all(HTASK task)
{
    int i;
    for (i = 0; i < MAX_SOCK; i++) {
        if (sk[i].state == ST_FREE) continue;
        if (task && sk[i].owner != task) continue;
        pump(i);
        notify(i);
    }
}

/* The timer's callback. It is exported (see build.sh) for the same reason PVHOOK's hook procedures
   are: USER calls it from whichever task pumped the message, and only an entry point in the module
   table gets its prologue patched to load this DLL's data segment. */
void FAR PASCAL PvTick(HWND hwnd, UINT msg, UINT id, DWORD now)
{
    int i;
    (void)hwnd; (void)msg; (void)now;
    for (i = 0; i < MAX_INST; i++)
        if (inst[i].refs && inst[i].timer == id) { tick_all(inst[i].task); return; }
    tick_all(0);
}

/* ------------------------------------------------------------------ blocking */
/* The default hook, and the whole reason a blocking program does not stop this machine: one
   message taken and dispatched per call, so the rest of Windows -- and the host's own chance to
   answer, which arrives as a timer message here -- keeps running inside somebody's blocking recv.
   Exported, because WSASetBlockingHook hands it back to programs that chain to it. */
BOOL FAR PASCAL PvDefaultBlockingHook(void)
{
    MSG m;
    if (PeekMessage(&m, NULL, 0, 0, PM_REMOVE)) {
        TranslateMessage(&m);
        DispatchMessage(&m);
        return TRUE;
    }
    return FALSE;
}

/* One turn of a blocking wait. FALSE when the wait must stop because WSACancelBlockingCall was
   called from inside the hook (which is the only place it can be called from). */
static BOOL block_turn(void)
{
    BLOCKPROC h = (BLOCKPROC)g_hook;
    if (h) (*h)();
    if (g_cancel) { g_cancel = FALSE; return FALSE; }
    return TRUE;
}
static void block_begin(void) { g_blocking = TRUE; g_cancel = FALSE; }
static void block_end(void)   { g_blocking = FALSE; g_cancel = FALSE; }

/* Everything that can block refuses to be re-entered from inside somebody's blocking call, which
   is what the specification says and also what keeps this file's device sequences whole. */
#define NO_REENTRY() do { if (g_blocking) return fail(WSAEINPROGRESS); } while (0)

/* ------------------------------------------------------------------ WSAStartup and friends */
static INST *inst_for(HTASK t)
{
    int i;
    for (i = 0; i < MAX_INST; i++) if (inst[i].refs && inst[i].task == t) return &inst[i];
    return NULL;
}

int PASCAL FAR WSAStartup(WORD wVersionRequested, LPWSADATA lpWSAData)
{
    HTASK t = GetCurrentTask();
    INST *in;
    int i;

    if (!lpWSAData) return WSAEFAULT;
    if (LOBYTE(wVersionRequested) < 1) return WSAVERNOTSUPPORTED;

    lpWSAData->wVersion = 0x0101;                  /* 1.1, low byte major, as the specification has it */
    lpWSAData->wHighVersion = 0x0101;
    lstrcpy(lpWSAData->szDescription, "Paravirtual Sockets 1.1 (responsive-wfw311)");
    lstrcpy(lpWSAData->szSystemStatus, "Host-side transport; no TCP stack in the guest.");
    lpWSAData->iMaxSockets = MAX_SOCK;
    lpWSAData->iMaxUdpDg = 0;
    lpWSAData->lpVendorInfo = NULL;

    if (!g_hook) g_hook = (FARPROC)PvDefaultBlockingHook;
    g_trace = GetProfileInt("PVWinsock", "Trace", 0);

    in = inst_for(t);
    if (in) { in->refs++; return 0; }
    for (i = 0; i < MAX_INST; i++) if (!inst[i].refs) break;
    if (i == MAX_INST) return WSAEMFILE;
    inst[i].task = t;
    inst[i].refs = 1;
    /* 10 ms is what this wants; Windows rounds it up to its own 55 ms tick and that is still four
       or five looks per redraw, which is faster than any program of this era consumes bytes. */
    inst[i].timer = SetTimer(NULL, 0, 10, (TIMERPROC)PvTick);
    if (!inst[i].timer) dbg("winsock: no timer; async notification is off for this task");
    dbg("winsock: startup");
    return 0;
}

int PASCAL FAR WSACleanup(void)
{
    HTASK t = GetCurrentTask();
    INST *in = inst_for(t);
    int i;

    if (!in) return fail(WSANOTINITIALISED);
    if (--in->refs > 0) return 0;
    for (i = 0; i < MAX_SOCK; i++)
        if (sk[i].state != ST_FREE && sk[i].owner == t) dev_close(i);
    if (in->timer) KillTimer(NULL, in->timer);
    in->timer = 0;
    in->task = 0;
    dbg("winsock: cleanup");
    return 0;
}

int PASCAL FAR WSAGetLastError(void) { return g_err; }
void PASCAL FAR WSASetLastError(int iError) { g_err = iError; }
BOOL PASCAL FAR WSAIsBlocking(void) { return g_blocking; }

int PASCAL FAR WSACancelBlockingCall(void)
{
    if (!g_blocking) return fail(WSAEINVAL);
    g_cancel = TRUE;
    return 0;
}

FARPROC PASCAL FAR WSASetBlockingHook(FARPROC lpBlockFunc)
{
    FARPROC prev = g_hook;
    if (lpBlockFunc) g_hook = lpBlockFunc;
    return prev;
}
int PASCAL FAR WSAUnhookBlockingHook(void)
{
    g_hook = (FARPROC)PvDefaultBlockingHook;
    return 0;
}

/* ------------------------------------------------------------------ socket, close, shutdown */
SOCKET PASCAL FAR socket(int af, int type, int protocol)
{
    int i;
    SOCK *s;

    if (g_blocking) { set_err(WSAEINPROGRESS); return INVALID_SOCKET; }
    if (af != AF_INET) { set_err(WSAEAFNOSUPPORT); return INVALID_SOCKET; }
    if (type != SOCK_STREAM) { set_err(WSAESOCKTNOSUPPORT); return INVALID_SOCKET; }
    if (protocol != 0 && protocol != IPPROTO_TCP) { set_err(WSAEPROTONOSUPPORT); return INVALID_SOCKET; }

    for (i = 0; i < MAX_SOCK; i++) if (sk[i].state == ST_FREE) break;
    if (i == MAX_SOCK) { set_err(WSAEMFILE); return INVALID_SOCKET; }

    s = &sk[i];
    _fmemset((char FAR *)s, 0, sizeof(SOCK));
    s->state = ST_UNBOUND;
    s->owner = GetCurrentTask();
    s->localAddr = 0;
    s->localPort = 0;
    return sock_of(i);
}

int PASCAL FAR closesocket(SOCKET sock)
{
    int i = idx_of(sock);
    NO_REENTRY();
    if (i < 0) return fail(WSAENOTSOCK);
    dev_close(i);
    return 0;
}

/* There is no half-close on the device: shutdown records what the program promised and stops the
   direction it named, and the connection itself goes when closesocket does. */
int PASCAL FAR shutdown(SOCKET sock, int how)
{
    int i = idx_of(sock);
    NO_REENTRY();
    if (i < 0) return fail(WSAENOTSOCK);
    if (how < 0 || how > 2) return fail(WSAEINVAL);
    if (how == 0 || how == 2) sk[i].rdShut = TRUE;
    if (how == 1 || how == 2) sk[i].wrShut = TRUE;
    return 0;
}

/* ------------------------------------------------------------------ connect */
static char cn_target[NAME_LEN + 24];

int PASCAL FAR connect(SOCKET sock, const struct sockaddr FAR *name, int namelen)
{
    int i = idx_of(sock);
    SOCK *s;
    const struct sockaddr_in FAR *sin = (const struct sockaddr_in FAR *)name;
    const char FAR *host;
    unsigned n, res, st;
    char quad[20], port[12];

    NO_REENTRY();
    if (i < 0) return fail(WSAENOTSOCK);
    s = &sk[i];
    if (s->state == ST_OPEN || s->state == ST_CONNECT) return fail(WSAEISCONN);
    if (s->state != ST_UNBOUND) return fail(WSAENOTCONN);
    if (!name || namelen < (int)sizeof(struct sockaddr_in)) return fail(WSAEFAULT);
    if (sin->sin_family != AF_INET) return fail(WSAEAFNOSUPPORT);

    s->rxh = GlobalAlloc(GMEM_MOVEABLE, (DWORD)RXCAP);
    s->rx = s->rxh ? (char FAR *)GlobalLock(s->rxh) : NULL;
    if (!s->rx) { if (s->rxh) { GlobalFree(s->rxh); s->rxh = 0; } return fail(WSAENOBUFS); }
    s->rxHead = s->rxTail = 0;

    /* The name if this DLL has one for the address, and the address itself if it does not: the
       host resolves either, and a name is what it would rather have, because a name is what the
       certificate on the far end is for. */
    s->peerAddr = sin->sin_addr.s_addr;
    s->peerPort = sin->sin_port;
    host = name_for_addr(s->peerAddr);
    if (!host) { dotted(s->peerAddr, quad); host = quad; }
    lstrcpy(cn_target, host);
    wsprintf(port, ":%u", (unsigned)ntohs(s->peerPort));
    lstrcat(cn_target, port);

    sel(i);
    for (n = 0; cn_target[n]; n++) wr(R_PV_CHAR, (unsigned)(unsigned char)cn_target[n]);
    wr(R_PV_ARG, n);
    wr(R_PV_CMD, PVCMD_OPEN);
    res = rd(R_PV_RESULT);
    st = rd(R_PV_STATE);
    dbg(cn_target);
    if (res != 0) {
        GlobalUnlock(s->rxh); GlobalFree(s->rxh); s->rxh = 0; s->rx = NULL;
        return fail(WSAECONNREFUSED);
    }
    /* The device answers the open synchronously, so the state has already left idle by now. Still
       idle means nothing is listening on these registers at all -- no device, no network. */
    if (st == PVST_IDLE) {
        GlobalUnlock(s->rxh); GlobalFree(s->rxh); s->rxh = 0; s->rx = NULL;
        return fail(WSAENETDOWN);
    }
    s->localAddr = htonl(0x0A00020FL);           /* 10.0.2.15, what web/net.js calls this guest */
    if (!s->localPort) s->localPort = htons((u_short)(1024 + (unsigned)i));
    s->state = ST_CONNECT;

    /* A non-blocking program is told to wait for the message it registered for, and gets it on the
       next tick; a blocking one is already connected as far as this device is concerned. */
    if (s->nonblock || s->hWnd) return fail(WSAEWOULDBLOCK);
    s->state = ST_OPEN;
    return 0;
}

/* ------------------------------------------------------------------ send and recv */
int PASCAL FAR send(SOCKET sock, const char FAR *buf, int len, int flags)
{
    int i = idx_of(sock);
    SOCK *s;
    unsigned n, sent = 0;

    NO_REENTRY();
    if (i < 0) return fail(WSAENOTSOCK);
    s = &sk[i];
    if (!buf) return fail(WSAEFAULT);
    if (flags & MSG_OOB) return fail(WSAEOPNOTSUPP);
    if (s->state == ST_CONNECT) s->state = ST_OPEN;      /* the open was accepted; it is connected */
    if (s->state != ST_OPEN) return fail(WSAENOTCONN);
    if (s->wrShut) return fail(WSAESHUTDOWN);
    if (s->failed) return fail(WSAECONNRESET);
    if (len < 0) return fail(WSAEINVAL);
    if (len == 0) return 0;

    /* One command per chunk, ARG naming the exact byte count, which is what the device asks for.
       An odd count goes out as a whole number of words with a zero in the top half of the last
       one, and the device is told to send one byte fewer than it was given: the pad has to be
       dropped on that side, since nothing the guest can write will take it back off the queue. */
    while (sent < (unsigned)len) {
        n = (unsigned)len - sent;
        if (n > PV_BLOCK) n = PV_BLOCK;
        if (n > 1 && (n & 1) && sent + n < (unsigned)len) n--;   /* keep every chunk but the last even */
        sel(i);
        stuff(buf + sent, n);
        wr(R_PV_ARG, n);
        wr(R_PV_CMD, PVCMD_SEND);
        sent += n;
    }
    /* No FD_WRITE here on purpose. It is posted once, when the connection comes up, and again only
       after a send that had to be refused for want of room -- and this one never refuses, because
       the device takes the whole buffer. A DLL that posted FD_WRITE after every send would put a
       program that sends on every FD_WRITE into a loop with itself. */
    return (int)sent;
}

int PASCAL FAR recv(SOCKET sock, char FAR *buf, int len, int flags)
{
    int i = idx_of(sock);
    SOCK *s;
    unsigned have, take;

    NO_REENTRY();
    if (i < 0) return fail(WSAENOTSOCK);
    s = &sk[i];
    if (!buf) return fail(WSAEFAULT);
    if (flags & MSG_OOB) return fail(WSAEOPNOTSUPP);
    if (s->state == ST_CONNECT) s->state = ST_OPEN;
    if (s->state != ST_OPEN) return fail(WSAENOTCONN);
    if (s->rdShut) return 0;
    if (len < 0) return fail(WSAEINVAL);
    if (len == 0) return 0;

    for (;;) {
        pump(i);
        have = rx_avail(s);
        if (have) break;
        if (s->failed) return fail(s->err ? s->err : WSAECONNRESET);
        if (s->peerClosed) return 0;                     /* the orderly end of a stream */
        if (s->nonblock) return fail(WSAEWOULDBLOCK);
        block_begin();
        for (;;) {
            if (!block_turn()) { block_end(); return fail(WSAEINTR); }
            pump(i);
            if (rx_avail(s) || s->peerClosed || s->failed) break;
        }
        block_end();
    }

    take = have < (unsigned)len ? have : (unsigned)len;
    _fmemcpy(buf, s->rx + s->rxHead, take);
    if (!(flags & MSG_PEEK)) {                           /* a peek consumes nothing */
        s->rxHead += take;
        if (s->rxHead == s->rxTail) s->rxHead = s->rxTail = 0;
        /* Level-triggered, the way a program expects: whatever is left, or arrives next, posts
           FD_READ again on the following tick. */
        s->posted &= ~FD_READ;
    }
    return (int)take;
}

/* Connectionless calls. The device is a stream transport and has no datagram path at all, so these
   exist to be exported and to say so. */
int PASCAL FAR sendto(SOCKET sock, const char FAR *buf, int len, int flags,
                      const struct sockaddr FAR *to, int tolen)
{
    (void)sock; (void)buf; (void)len; (void)flags; (void)to; (void)tolen;
    return fail(WSAEOPNOTSUPP);
}
int PASCAL FAR recvfrom(SOCKET sock, char FAR *buf, int len, int flags,
                        struct sockaddr FAR *from, int FAR *fromlen)
{
    /* A stream socket may legitimately be read with recvfrom; the address it fills in is the peer's. */
    int i = idx_of(sock), n;
    if (i < 0) return fail(WSAENOTSOCK);
    if (from && fromlen && *fromlen >= (int)sizeof(struct sockaddr_in)) {
        struct sockaddr_in FAR *sin = (struct sockaddr_in FAR *)from;
        _fmemset((char FAR *)sin, 0, sizeof(struct sockaddr_in));
        sin->sin_family = AF_INET;
        sin->sin_port = sk[i].peerPort;
        sin->sin_addr.s_addr = sk[i].peerAddr;
        *fromlen = sizeof(struct sockaddr_in);
    }
    n = recv(sock, buf, len, flags);
    return n;
}

/* ------------------------------------------------------------------ select */
int PASCAL FAR __WSAFDIsSet(SOCKET sock, fd_set FAR *set)
{
    u_int k;
    if (!set) return 0;
    for (k = 0; k < set->fd_count; k++) if (set->fd_array[k] == sock) return 1;
    return 0;
}

static BOOL sel_readable(int i)
{
    SOCK *s = &sk[i];
    pump(i);
    if (s->state == ST_DEAD) return TRUE;
    return rx_avail(s) != 0 || s->peerClosed || s->failed;
}
static BOOL sel_writable(int i)
{
    SOCK *s = &sk[i];
    if (s->state == ST_CONNECT) { pump(i); if (!s->failed) s->state = ST_OPEN; }
    return s->state == ST_OPEN && !s->failed && !s->wrShut;
}
static BOOL sel_except(int i) { pump(i); return sk[i].failed; }

/* One pass over the three sets, writing back only what is ready. The working sets are the DLL's
   own rather than locals: an fd_set is 130 bytes, this runs on whichever program's stack called
   in, and some of them have very little of it. */
static fd_set sel_r, sel_w, sel_e;

static int select_scan(fd_set FAR *rd_, fd_set FAR *wr_, fd_set FAR *ex_)
{
    u_int k;
    int i, n = 0;

    FD_ZERO(&sel_r); FD_ZERO(&sel_w); FD_ZERO(&sel_e);
    if (rd_) for (k = 0; k < rd_->fd_count; k++) {
        i = idx_of(rd_->fd_array[k]);
        if (i >= 0 && sel_readable(i)) { FD_SET(rd_->fd_array[k], &sel_r); n++; }
    }
    if (wr_) for (k = 0; k < wr_->fd_count; k++) {
        i = idx_of(wr_->fd_array[k]);
        if (i >= 0 && sel_writable(i)) { FD_SET(wr_->fd_array[k], &sel_w); n++; }
    }
    if (ex_) for (k = 0; k < ex_->fd_count; k++) {
        i = idx_of(ex_->fd_array[k]);
        if (i >= 0 && sel_except(i)) { FD_SET(ex_->fd_array[k], &sel_e); n++; }
    }
    if (n) {
        if (rd_) *rd_ = sel_r;
        if (wr_) *wr_ = sel_w;
        if (ex_) *ex_ = sel_e;
    }
    return n;
}

int PASCAL FAR select(int nfds, fd_set FAR *readfds, fd_set FAR *writefds, fd_set FAR *exceptfds,
                      const struct timeval FAR *timeout)
{
    DWORD start, limit;
    int n;

    (void)nfds;                                   /* Berkeley's descriptor count; the sets carry it here */
    NO_REENTRY();
    n = select_scan(readfds, writefds, exceptfds);
    if (n) return n;
    if (timeout && timeout->tv_sec == 0 && timeout->tv_usec == 0) {
        if (readfds) FD_ZERO(readfds);
        if (writefds) FD_ZERO(writefds);
        if (exceptfds) FD_ZERO(exceptfds);
        return 0;
    }

    start = GetTickCount();
    limit = timeout ? (DWORD)timeout->tv_sec * 1000L + (DWORD)(timeout->tv_usec / 1000L) : 0;
    block_begin();
    for (;;) {
        if (!block_turn()) { block_end(); return fail(WSAEINTR); }
        n = select_scan(readfds, writefds, exceptfds);
        if (n) { block_end(); return n; }
        if (timeout && GetTickCount() - start >= limit) break;
    }
    block_end();
    if (readfds) FD_ZERO(readfds);
    if (writefds) FD_ZERO(writefds);
    if (exceptfds) FD_ZERO(exceptfds);
    return 0;
}

/* ------------------------------------------------------------------ options and names */
int PASCAL FAR ioctlsocket(SOCKET sock, long cmd, u_long FAR *argp)
{
    int i = idx_of(sock);
    if (i < 0) return fail(WSAENOTSOCK);
    if (!argp) return fail(WSAEFAULT);
    switch (cmd) {
    case FIONBIO:
        sk[i].nonblock = (*argp != 0);
        return 0;
    case FIONREAD:
        pump(i);
        *argp = (u_long)rx_avail(&sk[i]);
        return 0;
    case SIOCATMARK:
        *argp = 1;                                /* no out-of-band data ever, so always at the mark */
        return 0;
    }
    return fail(WSAEINVAL);
}

/* Options are remembered where they mean something and accepted where they do not: a program that
   sets SO_LINGER or TCP_NODELAY and treats a refusal as fatal is commoner than one that needs the
   option honoured, and nothing below this API would honour it anyway. */
int PASCAL FAR setsockopt(SOCKET sock, int level, int optname, const char FAR *optval, int optlen)
{
    int i = idx_of(sock);
    (void)level; (void)optname; (void)optval; (void)optlen;
    if (i < 0) return fail(WSAENOTSOCK);
    return 0;
}

int PASCAL FAR getsockopt(SOCKET sock, int level, int optname, char FAR *optval, int FAR *optlen)
{
    int i = idx_of(sock);
    long v = 0;

    if (i < 0) return fail(WSAENOTSOCK);
    if (!optval || !optlen || *optlen < (int)sizeof(int)) return fail(WSAEFAULT);
    if (level == SOL_SOCKET) {
        switch (optname) {
        case SO_ERROR:   v = sk[i].err; sk[i].err = 0; break;
        case SO_TYPE:    v = SOCK_STREAM; break;
        case SO_SNDBUF:  v = PV_BLOCK; break;
        case SO_RCVBUF:  v = RXCAP; break;
        default:         v = 0; break;
        }
    }
    if (*optlen >= (int)sizeof(long)) { *(long FAR *)optval = v; *optlen = sizeof(long); }
    else { *(int FAR *)optval = (int)v; *optlen = sizeof(int); }
    return 0;
}

static int fill_addr(struct sockaddr FAR *out, int FAR *len, u_long addr, u_short port)
{
    struct sockaddr_in FAR *sin = (struct sockaddr_in FAR *)out;
    if (!out || !len || *len < (int)sizeof(struct sockaddr_in)) return SOCKET_ERROR;
    _fmemset((char FAR *)sin, 0, sizeof(struct sockaddr_in));
    sin->sin_family = AF_INET;
    sin->sin_port = port;
    sin->sin_addr.s_addr = addr;
    *len = sizeof(struct sockaddr_in);
    return 0;
}

int PASCAL FAR getsockname(SOCKET sock, struct sockaddr FAR *name, int FAR *namelen)
{
    int i = idx_of(sock);
    if (i < 0) return fail(WSAENOTSOCK);
    if (fill_addr(name, namelen, sk[i].localAddr, sk[i].localPort)) return fail(WSAEFAULT);
    return 0;
}
int PASCAL FAR getpeername(SOCKET sock, struct sockaddr FAR *name, int FAR *namelen)
{
    int i = idx_of(sock);
    if (i < 0) return fail(WSAENOTSOCK);
    if (sk[i].state != ST_OPEN && sk[i].state != ST_CONNECT) return fail(WSAENOTCONN);
    if (fill_addr(name, namelen, sk[i].peerAddr, sk[i].peerPort)) return fail(WSAEFAULT);
    return 0;
}

/* A client socket that binds before connecting is ordinary and must not be refused; a socket that
   asks for a particular local port to be listened on has nowhere to be listened on. */
int PASCAL FAR bind(SOCKET sock, const struct sockaddr FAR *name, int namelen)
{
    int i = idx_of(sock);
    const struct sockaddr_in FAR *sin = (const struct sockaddr_in FAR *)name;
    if (i < 0) return fail(WSAENOTSOCK);
    if (!name || namelen < (int)sizeof(struct sockaddr_in)) return fail(WSAEFAULT);
    if (sin->sin_family != AF_INET) return fail(WSAEAFNOSUPPORT);
    sk[i].localAddr = sin->sin_addr.s_addr;
    sk[i].localPort = sin->sin_port;
    return 0;
}
int PASCAL FAR listen(SOCKET sock, int backlog)
{
    (void)sock; (void)backlog;
    return fail(WSAEOPNOTSUPP);
}
SOCKET PASCAL FAR accept(SOCKET sock, struct sockaddr FAR *addr, int FAR *addrlen)
{
    (void)sock; (void)addr; (void)addrlen;
    set_err(WSAEOPNOTSUPP);
    return INVALID_SOCKET;
}

/* ------------------------------------------------------------------ WSAAsyncSelect */
int PASCAL FAR WSAAsyncSelect(SOCKET sock, HWND hWnd, u_int wMsg, long lEvent)
{
    int i = idx_of(sock);
    SOCK *s;
    if (i < 0) return fail(WSAENOTSOCK);
    s = &sk[i];
    s->hWnd = hWnd;
    s->wMsg = wMsg;
    s->lEvent = lEvent;
    s->posted = 0;
    /* Registering for events makes the socket non-blocking, exactly as the specification says, and
       is why a program that only ever uses messages never sits in a wait. */
    if (lEvent) {
        s->nonblock = TRUE;
        notify(i);                                 /* anything already true is posted at once */
    }
    return 0;
}

int PASCAL FAR WSACancelAsyncRequest(HANDLE hAsyncTaskHandle)
{
    /* Every asynchronous database request this DLL takes is finished before it returns (there is
       nothing to look up: see the header), so there is never one outstanding to cancel. */
    (void)hAsyncTaskHandle;
    return fail(WSAEINVAL);
}

/* ------------------------------------------------------------------ the database calls */
static struct hostent  he;
static char  FAR *he_aliases[1];
static char  FAR *he_addrs[2];
static u_long he_addr;
static char   he_name[NAME_LEN];
static char   hostname[NAME_LEN] = "pvguest";

static struct hostent FAR *make_hostent(const char FAR *name, u_long addr)
{
    int n;
    for (n = 0; n < NAME_LEN - 1 && name[n]; n++) he_name[n] = name[n];
    he_name[n] = 0;
    he_addr = addr;
    he_aliases[0] = NULL;
    he_addrs[0] = (char FAR *)&he_addr;
    he_addrs[1] = NULL;
    he.h_name = (char FAR *)he_name;
    he.h_aliases = he_aliases;
    he.h_addrtype = AF_INET;
    he.h_length = 4;
    he.h_addr_list = he_addrs;
    return (struct hostent FAR *)&he;
}

struct hostent FAR * PASCAL FAR gethostbyname(const char FAR *name)
{
    u_long a;
    if (!name || !*name) { set_err(WSAHOST_NOT_FOUND); return NULL; }
    a = inet_addr(name);
    if (a != INADDR_NONE) return make_hostent(name, a);
    a = addr_for_name(name);
    if (!a) { set_err(WSANO_RECOVERY); return NULL; }
    return make_hostent(name, a);
}

struct hostent FAR * PASCAL FAR gethostbyaddr(const char FAR *addr, int len, int type)
{
    u_long a;
    const char FAR *nm;
    char quad[20];
    if (!addr || len != 4 || type != AF_INET) { set_err(WSAHOST_NOT_FOUND); return NULL; }
    _fmemcpy((char FAR *)&a, addr, 4);
    nm = name_for_addr(a);
    if (!nm) { dotted(a, quad); nm = quad; }
    return make_hostent((const char FAR *)nm, a);
}

int PASCAL FAR gethostname(char FAR *name, int namelen)
{
    int n;
    if (!name || namelen <= 0) return fail(WSAEFAULT);
    for (n = 0; n < namelen - 1 && hostname[n]; n++) name[n] = hostname[n];
    name[n] = 0;
    return 0;
}

/* The services and protocols a program of this era looks up, which is a short list, and cheaper to
   answer than to explain the absence of. */
static struct servent  se;
static char FAR *se_aliases[1];
static char  se_name[16], se_proto[8];
static struct protoent pe;
static char FAR *pe_aliases[1];
static char  pe_name[8];

typedef struct { const char *name; int port; } SERV;
static SERV servs[] = {
    { "ftp", 21 }, { "telnet", 23 }, { "smtp", 25 }, { "gopher", 70 }, { "finger", 79 },
    { "http", 80 }, { "www", 80 }, { "pop3", 110 }, { "nntp", 119 }, { "https", 443 }, { NULL, 0 }
};
typedef struct { const char *name; int proto; } PROT;
static PROT prots[] = { { "ip", 0 }, { "icmp", 1 }, { "tcp", 6 }, { "udp", 17 }, { NULL, 0 } };

static struct servent FAR *make_servent(const char *name, int port, const char FAR *proto)
{
    int n;
    for (n = 0; n < (int)sizeof(se_name) - 1 && name[n]; n++) se_name[n] = name[n];
    se_name[n] = 0;
    lstrcpy(se_proto, "tcp");
    if (proto) for (n = 0; n < (int)sizeof(se_proto) - 1 && proto[n]; n++) { se_proto[n] = proto[n]; se_proto[n + 1] = 0; }
    se_aliases[0] = NULL;
    se.s_name = (char FAR *)se_name;
    se.s_aliases = se_aliases;
    se.s_port = (short)htons((u_short)port);
    se.s_proto = (char FAR *)se_proto;
    return (struct servent FAR *)&se;
}

struct servent FAR * PASCAL FAR getservbyname(const char FAR *name, const char FAR *proto)
{
    int i;
    if (!name) { set_err(WSANO_DATA); return NULL; }
    for (i = 0; servs[i].name; i++)
        if (name_eq(name, servs[i].name)) return make_servent(servs[i].name, servs[i].port, proto);
    set_err(WSANO_DATA);
    return NULL;
}
struct servent FAR * PASCAL FAR getservbyport(int port, const char FAR *proto)
{
    int i, p = (int)ntohs((u_short)port);
    for (i = 0; servs[i].name; i++)
        if (servs[i].port == p) return make_servent(servs[i].name, p, proto);
    set_err(WSANO_DATA);
    return NULL;
}

static struct protoent FAR *make_protoent(const char *name, int proto)
{
    int n;
    for (n = 0; n < (int)sizeof(pe_name) - 1 && name[n]; n++) pe_name[n] = name[n];
    pe_name[n] = 0;
    pe_aliases[0] = NULL;
    pe.p_name = (char FAR *)pe_name;
    pe.p_aliases = pe_aliases;
    pe.p_proto = (short)proto;
    return (struct protoent FAR *)&pe;
}
struct protoent FAR * PASCAL FAR getprotobyname(const char FAR *name)
{
    int i;
    if (!name) { set_err(WSANO_DATA); return NULL; }
    for (i = 0; prots[i].name; i++)
        if (name_eq(name, prots[i].name)) return make_protoent(prots[i].name, prots[i].proto);
    set_err(WSANO_DATA);
    return NULL;
}
struct protoent FAR * PASCAL FAR getprotobynumber(int number)
{
    int i;
    for (i = 0; prots[i].name; i++)
        if (prots[i].proto == number) return make_protoent(prots[i].name, number);
    set_err(WSANO_DATA);
    return NULL;
}

/* ------------------------------------------------------------------ the asynchronous database
   These answer out of the tables above, so there is nothing to wait for: the buffer is filled and
   the completion message posted before the call returns, which is a legal way to be asynchronous
   and the only honest one when the lookup is a table search. The handle is a serial number so that
   WSAGETASYNCERROR and the wParam a program compares against mean what it expects. */
static WORD async_next = 1;

static HANDLE async_done(HWND hWnd, u_int wMsg, int buflen, int err)
{
    HANDLE h;
    if (!async_next) async_next = 1;
    h = (HANDLE)async_next++;
    if (hWnd) PostMessage(hWnd, wMsg, (WPARAM)h, WSAMAKEASYNCREPLY(buflen, err));
    return h;
}

/* A hostent copied into the caller's buffer, laid out the way the specification requires: the
   structure first, then the things its pointers point at, all inside the one buffer. */
static int copy_hostent(struct hostent FAR *src, char FAR *buf, int buflen)
{
    struct hostent FAR *dst = (struct hostent FAR *)buf;
    char FAR *p;
    int nlen, need;

    nlen = lstrlen(src->h_name) + 1;
    need = sizeof(struct hostent) + 2 * sizeof(char FAR *) + sizeof(char FAR *) + 4 + nlen;
    if (buflen < need) return -need;
    p = buf + sizeof(struct hostent);
    dst->h_addrtype = src->h_addrtype;
    dst->h_length = src->h_length;
    dst->h_aliases = (char FAR * FAR *)p;
    *(char FAR * FAR *)p = NULL;
    p += sizeof(char FAR *);
    dst->h_addr_list = (char FAR * FAR *)p;
    ((char FAR * FAR *)p)[1] = NULL;
    p += 2 * sizeof(char FAR *);
    _fmemcpy(p, src->h_addr_list[0], 4);
    dst->h_addr_list[0] = p;
    p += 4;
    _fmemcpy(p, src->h_name, nlen);
    dst->h_name = p;
    return need;
}

HANDLE PASCAL FAR WSAAsyncGetHostByName(HWND hWnd, u_int wMsg, const char FAR *name,
                                        char FAR *buf, int buflen)
{
    struct hostent FAR *h = gethostbyname(name);
    int n;
    if (!h) return async_done(hWnd, wMsg, 0, WSAHOST_NOT_FOUND);
    n = copy_hostent(h, buf, buflen);
    if (n < 0) return async_done(hWnd, wMsg, -n, WSAENOBUFS);
    return async_done(hWnd, wMsg, n, 0);
}
HANDLE PASCAL FAR WSAAsyncGetHostByAddr(HWND hWnd, u_int wMsg, const char FAR *addr, int len,
                                        int type, char FAR *buf, int buflen)
{
    struct hostent FAR *h = gethostbyaddr(addr, len, type);
    int n;
    if (!h) return async_done(hWnd, wMsg, 0, WSAHOST_NOT_FOUND);
    n = copy_hostent(h, buf, buflen);
    if (n < 0) return async_done(hWnd, wMsg, -n, WSAENOBUFS);
    return async_done(hWnd, wMsg, n, 0);
}
/* The service and protocol structures are small and flat, so they are copied by hand the same way. */
static int copy_servent(struct servent FAR *src, char FAR *buf, int buflen)
{
    struct servent FAR *dst = (struct servent FAR *)buf;
    char FAR *p;
    int nlen = lstrlen(src->s_name) + 1, plen = lstrlen(src->s_proto) + 1;
    int need = sizeof(struct servent) + sizeof(char FAR *) + nlen + plen;
    if (buflen < need) return -need;
    p = buf + sizeof(struct servent);
    dst->s_aliases = (char FAR * FAR *)p;
    *(char FAR * FAR *)p = NULL;
    p += sizeof(char FAR *);
    _fmemcpy(p, src->s_name, nlen); dst->s_name = p; p += nlen;
    _fmemcpy(p, src->s_proto, plen); dst->s_proto = p;
    dst->s_port = src->s_port;
    return need;
}
static int copy_protoent(struct protoent FAR *src, char FAR *buf, int buflen)
{
    struct protoent FAR *dst = (struct protoent FAR *)buf;
    char FAR *p;
    int nlen = lstrlen(src->p_name) + 1;
    int need = sizeof(struct protoent) + sizeof(char FAR *) + nlen;
    if (buflen < need) return -need;
    p = buf + sizeof(struct protoent);
    dst->p_aliases = (char FAR * FAR *)p;
    *(char FAR * FAR *)p = NULL;
    p += sizeof(char FAR *);
    _fmemcpy(p, src->p_name, nlen);
    dst->p_name = p;
    dst->p_proto = src->p_proto;
    return need;
}
HANDLE PASCAL FAR WSAAsyncGetServByName(HWND hWnd, u_int wMsg, const char FAR *name,
                                        const char FAR *proto, char FAR *buf, int buflen)
{
    struct servent FAR *s = getservbyname(name, proto);
    int n;
    if (!s) return async_done(hWnd, wMsg, 0, WSANO_DATA);
    n = copy_servent(s, buf, buflen);
    if (n < 0) return async_done(hWnd, wMsg, -n, WSAENOBUFS);
    return async_done(hWnd, wMsg, n, 0);
}
HANDLE PASCAL FAR WSAAsyncGetServByPort(HWND hWnd, u_int wMsg, int port, const char FAR *proto,
                                        char FAR *buf, int buflen)
{
    struct servent FAR *s = getservbyport(port, proto);
    int n;
    if (!s) return async_done(hWnd, wMsg, 0, WSANO_DATA);
    n = copy_servent(s, buf, buflen);
    if (n < 0) return async_done(hWnd, wMsg, -n, WSAENOBUFS);
    return async_done(hWnd, wMsg, n, 0);
}
HANDLE PASCAL FAR WSAAsyncGetProtoByName(HWND hWnd, u_int wMsg, const char FAR *name,
                                         char FAR *buf, int buflen)
{
    struct protoent FAR *pr = getprotobyname(name);
    int n;
    if (!pr) return async_done(hWnd, wMsg, 0, WSANO_DATA);
    n = copy_protoent(pr, buf, buflen);
    if (n < 0) return async_done(hWnd, wMsg, -n, WSAENOBUFS);
    return async_done(hWnd, wMsg, n, 0);
}
HANDLE PASCAL FAR WSAAsyncGetProtoByNumber(HWND hWnd, u_int wMsg, int number,
                                           char FAR *buf, int buflen)
{
    struct protoent FAR *pr = getprotobynumber(number);
    int n;
    if (!pr) return async_done(hWnd, wMsg, 0, WSANO_DATA);
    n = copy_protoent(pr, buf, buflen);
    if (n < 0) return async_done(hWnd, wMsg, -n, WSAENOBUFS);
    return async_done(hWnd, wMsg, n, 0);
}

/* Microsoft's extension, and the one thing outside 1.1 worth having: recv with a flag that says
   whether what came back was the whole record. Streams have no records, so it never is. */
int PASCAL FAR WSARecvEx(SOCKET sock, char FAR *buf, int len, int FAR *flags)
{
    int n = recv(sock, buf, len, flags ? *flags : 0);
    if (flags) *flags = 0;
    return n;
}

/* ------------------------------------------------------------------ the module */
int FAR PASCAL LibMain(HINSTANCE hInst, WORD wDataSeg, WORD cbHeap, LPSTR lpCmdLine)
{
    (void)hInst; (void)wDataSeg; (void)cbHeap; (void)lpCmdLine;
    g_hook = (FARPROC)PvDefaultBlockingHook;
    return 1;
}

int FAR PASCAL WEP(int nParam)
{
    int i;
    (void)nParam;
    for (i = 0; i < MAX_SOCK; i++) if (sk[i].state != ST_FREE) dev_close(i);
    for (i = 0; i < MAX_INST; i++) if (inst[i].timer) { KillTimer(NULL, inst[i].timer); inst[i].timer = 0; }
    return 1;
}
