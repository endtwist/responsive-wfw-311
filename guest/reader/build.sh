#!/usr/bin/env bash
# Build PAGE.EXE (Win16 NE, the guest's page reader) with Open Watcom via tools/watcom.sh.
# The icon is compiled in so tools/grpadd.py has one to put in the Program Manager group.
# Output: guest/reader/build/PAGE.EXE
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build
python3 mkico.py build/page.ico
cp page.c page.rc cinepak.c cinepak.h build/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build && for f in page cinepak; do \
    $W wcc -bt=windows -ml -zW -zc -ox -zq -wx -i=/watcom/h -i=/watcom/h/win $f.c \
    && { [ -f $f.o ] && mv $f.o $f.obj || true; }; done \
  && $W wlink system windows name PAGE.EXE option stack=16384 option heapsize=8192 \
       file page.obj file cinepak.obj \
       library /watcom/lib286/win/windows.lib libpath /watcom/lib286 libpath /watcom/lib286/win \
  && $W wrc -q -bt=windows -i=/watcom/h -i=/watcom/h/win page.rc PAGE.EXE )
ls -la build/PAGE.EXE
