/* WSTEST.EXE - does WINSOCK.DLL work?
 *
 * guest/winsock is a Winsock 1.1 implementation over the paravirtual socket device, and Fetch
 * cannot exercise it because Fetch talks to the device directly. So this does what any period
 * Winsock program does -- resolve a name, open a stream, write a request, read until the peer
 * closes -- and reports each step on the adapter's debug channel, where tools/probe.mjs prints it.
 * No window, no message loop worth the name: the point is the API, not the program.
 *
 * Build: guest/wstest/build.sh
 */
#include <windows.h>
#include <conio.h>

#define DISPI_INDEX 0x1CE
#define DISPI_DATA  0x1CF
#define R_DEBUG     0x16
static void dbg(const char *s)
{
    while (*s) { outpw(DISPI_INDEX, R_DEBUG); outpw(DISPI_DATA, (unsigned char)*s++); }
    outpw(DISPI_INDEX, R_DEBUG); outpw(DISPI_DATA, 10);
}

typedef unsigned int SOCKET;
#define INVALID_SOCKET ((SOCKET)~0)
#define SOCKET_ERROR   (-1)
#define AF_INET 2
#define SOCK_STREAM 1
struct sockaddr_in { short sin_family; unsigned short sin_port; unsigned long sin_addr; char sin_zero[8]; };
struct hostent { char FAR *h_name; char FAR * FAR *h_aliases; short h_addrtype; short h_length; char FAR * FAR *h_addr_list; };

int    PASCAL FAR WSAStartup(WORD, char FAR *);
int    PASCAL FAR WSACleanup(void);
SOCKET PASCAL FAR socket(int, int, int);
int    PASCAL FAR connect(SOCKET, struct sockaddr_in FAR *, int);
int    PASCAL FAR send(SOCKET, const char FAR *, int, int);
int    PASCAL FAR recv(SOCKET, char FAR *, int, int);
int    PASCAL FAR closesocket(SOCKET);
struct hostent FAR * PASCAL FAR gethostbyname(const char FAR *);
unsigned short PASCAL FAR htons(unsigned short);
int    PASCAL FAR WSAGetLastError(void);

int PASCAL WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show)
{
    char wsa[512], req[256], buf[1024], msg[96];
    struct sockaddr_in sa;
    struct hostent FAR *he;
    SOCKET s;
    long total = 0;
    int n;
    const char *host = (cmd && cmd[0]) ? cmd : "example.com";

    if (WSAStartup(0x0101, wsa) != 0) { dbg("wstest: WSAStartup failed"); return 0; }
    dbg("wstest: WSAStartup ok");

    he = gethostbyname(host);
    if (!he) { wsprintf(msg, "wstest: gethostbyname failed (%d)", WSAGetLastError()); dbg(msg); return 0; }
    dbg("wstest: gethostbyname ok");

    s = socket(AF_INET, SOCK_STREAM, 0);
    if (s == INVALID_SOCKET) { dbg("wstest: socket failed"); return 0; }

    sa.sin_family = AF_INET;
    sa.sin_port = htons(80);
    sa.sin_addr = *(unsigned long FAR *)he->h_addr_list[0];
    if (connect(s, &sa, sizeof(sa)) == SOCKET_ERROR) {
        wsprintf(msg, "wstest: connect failed (%d)", WSAGetLastError()); dbg(msg); return 0;
    }
    dbg("wstest: connect ok");

    n = wsprintf(req, "GET / HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n", (LPSTR)host);
    if (send(s, req, n, 0) == SOCKET_ERROR) { dbg("wstest: send failed"); return 0; }
    dbg("wstest: send ok");

    for (;;) {
        n = recv(s, buf, sizeof(buf), 0);
        if (n == 0) break;                         /* the peer closed: that is the end */
        if (n == SOCKET_ERROR) { wsprintf(msg, "wstest: recv error (%d)", WSAGetLastError()); dbg(msg); break; }
        if (total == 0) {
            int k = 0;
            while (k < n && k < 40 && buf[k] != '\r' && buf[k] != '\n') { msg[k] = buf[k]; k++; }
            msg[k] = 0;
            dbg("wstest: first line follows");
            dbg(msg);
        }
        total += n;
    }
    wsprintf(msg, "wstest: %ld bytes received", total);
    dbg(msg);
    closesocket(s);
    WSACleanup();
    dbg("wstest: done");
    return 0;
}
