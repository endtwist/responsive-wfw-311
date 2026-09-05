#!/usr/bin/env bash
# Build GROSSIS.EXE (Win16 NE, the way out to the site this machine belongs to) with Open Watcom via tools/watcom.sh.
# tools/grpadd.py, which reads RT_GROUP_ICON out of the executable) has an icon to show.
# Output: guest/about/build/GROSSIS.EXE
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build
python3 mkico.py build/grossis.ico
cp grossis.c grossis.rc build/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build && $W wcc -bt=windows -ml -zW -zc -ox -zq -i=/watcom/h -i=/watcom/h/win grossis.c \
  && { [ -f grossis.o ] && mv grossis.o grossis.obj || true; } \
  && $W wlink system windows name GROSSIS.EXE option stack=8192 option heapsize=4096 file grossis.obj \
       library /watcom/lib286/win/windows.lib libpath /watcom/lib286 libpath /watcom/lib286/win \
  && $W wrc -q -bt=windows -i=/watcom/h -i=/watcom/h/win grossis.rc GROSSIS.EXE )
ls -la build/GROSSIS.EXE
