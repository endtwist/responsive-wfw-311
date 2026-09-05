#!/usr/bin/env bash
# Build WINSOCK.DLL (Win16 NE, Windows Sockets 1.1 over the paravirtual socket device) with Open
# Watcom via tools/watcom.sh. Output: guest/winsock/build/WINSOCK.DLL
#
# Two things here are not like the other guest builds:
#
#  -zw (lower case), not -zW. It gives every far function the windowed prologue -- `push ds / pop
#  ax / nop` ahead of the frame -- which is the three bytes the loader overwrites with this DLL's
#  own data segment when it fixes up an entry point. Without it an exported function runs with the
#  calling program's DS and every static in winsock.c reads as that program's memory. __export in
#  the source would do the same, but it also writes an export record into the object, and then the
#  linker's ordinals below are refused with a warning and the DLL gets whatever ordinals the
#  linker felt like. This way the ordinals are ours and the build is silent.
#
#  Ordinals, not names. A program of this era imports Winsock by ordinal out of its vendor's
#  WINSOCK.LIB, and an ordinal that is missing is not a failed call, it is a program that will not
#  load at all. So the whole 1.1 table is exported at its documented number, including the ones
#  that only answer WSAEOPNOTSUPP. PvTick and PvDefaultBlockingHook are exported too, at numbers
#  well clear of the standard ones: USER calls both from inside whichever task is running, and only
#  a real entry point gets its prologue patched to load our data segment.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build; cp winsock.c build/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build && $W wcc -bt=windows -bd -ms -zw -zu -zc -ox -zq -we -i=/watcom/h -i=/watcom/h/win winsock.c \
  && { [ -f winsock.o ] && mv winsock.o winsock.obj || true; } \
  && $W wlink system windows_dll name WINSOCK.DLL option heapsize=4096 file winsock.obj \
       export accept.1 export bind.2 export closesocket.3 export connect.4 \
       export getpeername.5 export getsockname.6 export getsockopt.7 \
       export htonl.8 export htons.9 export inet_addr.10 export inet_ntoa.11 \
       export ioctlsocket.12 export listen.13 export ntohl.14 export ntohs.15 \
       export recv.16 export recvfrom.17 export select.18 export send.19 export sendto.20 \
       export setsockopt.21 export shutdown.22 export socket.23 \
       export gethostbyaddr.51 export gethostbyname.52 \
       export getprotobyname.53 export getprotobynumber.54 \
       export getservbyname.55 export getservbyport.56 export gethostname.57 \
       export WSAAsyncSelect.101 export WSAAsyncGetHostByAddr.102 \
       export WSAAsyncGetHostByName.103 export WSAAsyncGetProtoByNumber.104 \
       export WSAAsyncGetProtoByName.105 export WSAAsyncGetServByPort.106 \
       export WSAAsyncGetServByName.107 export WSACancelAsyncRequest.108 \
       export WSASetBlockingHook.109 export WSAUnhookBlockingHook.110 \
       export WSAGetLastError.111 export WSASetLastError.112 \
       export WSACancelBlockingCall.113 export WSAIsBlocking.114 \
       export WSAStartup.115 export WSACleanup.116 \
       export __WSAFDIsSet.151 export WSARecvEx.1107 \
       export PvTick.1200 export PvDefaultBlockingHook.1201 \
       export WEP.1000 resident \
       library /watcom/lib286/win/windows.lib libpath /watcom/lib286 libpath /watcom/lib286/win )
ls -la build/WINSOCK.DLL
python3 ordinals.py build/WINSOCK.DLL
