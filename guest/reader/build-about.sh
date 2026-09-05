#!/usr/bin/env bash
# Build ABOUT.EXE: the same reader as PAGE.EXE, built with -dSHELL_ABOUT so its shell is two
# tabs over two bundles fetched from the site instead of an address bar. One renderer, two programs.
# The icon is compiled in so tools/grpadd.py has one to put in the Program Manager group.
# Output: guest/reader/build/ABOUT.EXE
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build-about
python3 mkico.py build-about/page.ico
cp page.c page.rc cinepak.c cinepak.h build-about/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build-about && for f in page cinepak; do \
    $W wcc -bt=windows -dSHELL_ABOUT -ml -zW -zc -ox -zq -wx -i=/watcom/h -i=/watcom/h/win $f.c \
    && { [ -f $f.o ] && mv $f.o $f.obj || true; }; done \
  && $W wlink system windows name ABOUT.EXE option stack=16384 option heapsize=8192 \
       file page.obj file cinepak.obj \
       library /watcom/lib286/win/windows.lib libpath /watcom/lib286 libpath /watcom/lib286/win \
  && $W wrc -q -bt=windows -i=/watcom/h -i=/watcom/h/win page.rc ABOUT.EXE )
ls -la build-about/ABOUT.EXE
