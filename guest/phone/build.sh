#!/usr/bin/env bash
# Build PHONE.EXE (Win16 NE, the simulated phone) with Open Watcom via tools/watcom.sh.
# The .rc carries the icon so the Program Manager item (tools/grpadd.py, which reads
# RT_GROUP_ICON out of the executable) has one to show.
# Output: guest/phone/build/PHONE.EXE
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build
python3 mkico.py build/phone.ico
cp phone.c phone.rc build/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build && $W wcc -bt=windows -ml -zW -zc -ox -zq -i=/watcom/h -i=/watcom/h/win phone.c \
  && { [ -f phone.o ] && mv phone.o phone.obj || true; } \
  && $W wlink system windows name PHONE.EXE option stack=8192 option heapsize=4096 file phone.obj \
       library /watcom/lib286/win/windows.lib libpath /watcom/lib286 libpath /watcom/lib286/win \
  && $W wrc -q -bt=windows -i=/watcom/h -i=/watcom/h/win phone.rc PHONE.EXE )
ls -la build/PHONE.EXE
