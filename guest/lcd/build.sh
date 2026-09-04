#!/usr/bin/env bash
# Build LCD.EXE (Win16 NE, the first-run gesture note) with Open Watcom via tools/watcom.sh.
# tools/grpadd.py, which reads RT_GROUP_ICON out of the executable) has an icon to show.
# Output: guest/about/build/LCD.EXE
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build
python3 mkico.py build/lcd.ico
cp lcd.c lcd.rc build/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build && $W wcc -bt=windows -ml -zW -zc -ox -zq -i=/watcom/h -i=/watcom/h/win lcd.c \
  && { [ -f lcd.o ] && mv lcd.o lcd.obj || true; } \
  && $W wlink system windows name LCD.EXE option stack=8192 option heapsize=4096 file lcd.obj \
       library /watcom/lib286/win/windows.lib libpath /watcom/lib286 libpath /watcom/lib286/win \
  && $W wrc -q -bt=windows -i=/watcom/h -i=/watcom/h/win lcd.rc LCD.EXE )
ls -la build/LCD.EXE
