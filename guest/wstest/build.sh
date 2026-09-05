#!/usr/bin/env bash
# Build WSTEST.EXE (Win16 NE): the smallest program that proves guest/winsock's WINSOCK.DLL works.
# The Winsock entry points are imported from WINSOCK.DLL by ordinal at load time, which also checks
# the DLL's export table is right. Output: guest/wstest/build/WSTEST.EXE
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build
cp wstest.c build/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build && $W wcc -bt=windows -ml -zW -zc -ox -zq -i=/watcom/h -i=/watcom/h/win wstest.c \
  && { [ -f wstest.o ] && mv wstest.o wstest.obj || true; } \
  && $W wlink system windows name WSTEST.EXE option stack=8192 option heapsize=4096 file wstest.obj \
       import WSAStartup WINSOCK.115 import WSACleanup WINSOCK.116 \
       import socket WINSOCK.23 import connect WINSOCK.4 import send WINSOCK.19 \
       import recv WINSOCK.16 import closesocket WINSOCK.3 import gethostbyname WINSOCK.52 \
       import htons WINSOCK.9 import WSAGetLastError WINSOCK.111 \
       library /watcom/lib286/win/windows.lib libpath /watcom/lib286 libpath /watcom/lib286/win )
ls -la build/WSTEST.EXE
