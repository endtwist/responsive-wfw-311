#!/usr/bin/env python3
"""What a built WINSOCK.DLL actually exports, read out of the NE header.

A Winsock DLL is right or wrong at its ordinals: a program imports `connect` as WINSOCK.4 out of
its vendor's import library, and if 4 is not there -- or is `bind` -- it does not fail at the call,
it fails to load, with a message box that says nothing useful. So the build ends by printing this,
and the numbers below are what the standard says they should be.

Usage: ordinals.py build/WINSOCK.DLL
"""
import struct
import sys

WANT = {
    1: 'ACCEPT', 2: 'BIND', 3: 'CLOSESOCKET', 4: 'CONNECT', 5: 'GETPEERNAME', 6: 'GETSOCKNAME',
    7: 'GETSOCKOPT', 8: 'HTONL', 9: 'HTONS', 10: 'INET_ADDR', 11: 'INET_NTOA', 12: 'IOCTLSOCKET',
    13: 'LISTEN', 14: 'NTOHL', 15: 'NTOHS', 16: 'RECV', 17: 'RECVFROM', 18: 'SELECT', 19: 'SEND',
    20: 'SENDTO', 21: 'SETSOCKOPT', 22: 'SHUTDOWN', 23: 'SOCKET',
    51: 'GETHOSTBYADDR', 52: 'GETHOSTBYNAME', 53: 'GETPROTOBYNAME', 54: 'GETPROTOBYNUMBER',
    55: 'GETSERVBYNAME', 56: 'GETSERVBYPORT', 57: 'GETHOSTNAME',
    101: 'WSAASYNCSELECT', 102: 'WSAASYNCGETHOSTBYADDR', 103: 'WSAASYNCGETHOSTBYNAME',
    104: 'WSAASYNCGETPROTOBYNUMBER', 105: 'WSAASYNCGETPROTOBYNAME',
    106: 'WSAASYNCGETSERVBYPORT', 107: 'WSAASYNCGETSERVBYNAME', 108: 'WSACANCELASYNCREQUEST',
    109: 'WSASETBLOCKINGHOOK', 110: 'WSAUNHOOKBLOCKINGHOOK', 111: 'WSAGETLASTERROR',
    112: 'WSASETLASTERROR', 113: 'WSACANCELBLOCKINGCALL', 114: 'WSAISBLOCKING',
    115: 'WSASTARTUP', 116: 'WSACLEANUP', 151: '__WSAFDISSET',
}


def names(d, off):
    """A resident or non-resident name table: length-prefixed name, then its ordinal."""
    out = []
    p = off
    while p < len(d) and d[p]:
        n = d[p]
        out.append((struct.unpack_from('<H', d, p + 1 + n)[0], d[p + 1:p + 1 + n].decode('latin1')))
        p += n + 3
    return out


def entries(d, off, length):
    """The entry table, as {ordinal: exported?}. Bundles of like entries, a zero count ending it."""
    got = {}
    p, o = off, 1
    while p < off + length:
        cnt, typ = d[p], d[p + 1]
        p += 2
        if cnt == 0:
            break
        for _ in range(cnt):
            if typ == 0:                       # a run of unused ordinals
                pass
            elif typ == 0xFF:                  # movable segment: flags, int 3Fh, segment, offset
                got[o] = bool(d[p] & 1)
                p += 6
            else:                              # fixed segment: flags, offset
                got[o] = bool(d[p] & 1)
                p += 3
            o += 1
    return got


def main(path):
    d = open(path, 'rb').read()
    ne = struct.unpack_from('<H', d, 0x3C)[0]
    if d[ne:ne + 2] != b'NE':
        sys.exit('%s is not an NE image' % path)
    ent = entries(d, ne + struct.unpack_from('<H', d, ne + 0x04)[0],
                  struct.unpack_from('<H', d, ne + 0x06)[0])
    tab = dict(names(d, ne + struct.unpack_from('<H', d, ne + 0x26)[0]))
    tab.update(dict(names(d, struct.unpack_from('<I', d, ne + 0x2C)[0])))

    bad = 0
    for o in sorted(WANT):
        nm = tab.get(o)
        ok = nm == WANT[o] and ent.get(o)
        if not ok:
            bad += 1
            print('  ordinal %-4d wanted %-24s got %s%s'
                  % (o, WANT[o], nm or '(nothing)', '' if ent.get(o) else ' (not an entry point)'))
    extra = sorted(o for o in tab if o and o not in WANT)
    print('%d of %d Winsock 1.1 ordinals in place%s'
          % (len(WANT) - bad, len(WANT), '' if not extra else
             '; also ' + ', '.join('%s.%d' % (tab[o], o) for o in extra)))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'build/WINSOCK.DLL'))
