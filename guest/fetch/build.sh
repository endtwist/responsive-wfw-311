#!/usr/bin/env bash
# Build FETCH.EXE (Win16 NE, the guest's web client) with Open Watcom via tools/watcom.sh.
# The icon is compiled in so tools/grpadd.py has one to put in the Program Manager group.
# Output: guest/fetch/build/FETCH.EXE
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build
python3 mkico.py build/fetch.ico
cp fetch.c fetch.rc build/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build && $W wcc -bt=windows -ml -zW -zc -ox -zq -i=/watcom/h -i=/watcom/h/win fetch.c \
  && { [ -f fetch.o ] && mv fetch.o fetch.obj || true; } \
  && $W wlink system windows name FETCH.EXE option stack=16384 option heapsize=8192 file fetch.obj \
       library /watcom/lib286/win/windows.lib libpath /watcom/lib286 libpath /watcom/lib286/win \
  && $W wrc -q -bt=windows -i=/watcom/h -i=/watcom/h/win fetch.rc FETCH.EXE )
ls -la build/FETCH.EXE
