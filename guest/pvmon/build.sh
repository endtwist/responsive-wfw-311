#!/usr/bin/env bash
# Build PVMON.EXE (Win16 NE) with Open Watcom via tools/watcom.sh. Output: guest/pvmon/build/PVMON.EXE
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build; cp pvmon.c build/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build && $W wcc -bt=windows -ms -zW -zc -ox -zq -i=/watcom/h -i=/watcom/h/win pvmon.c \
  && { [ -f pvmon.o ] && mv pvmon.o pvmon.obj || true; } \
  && $W wlink system windows name PVMON.EXE option stack=8192 option heapsize=1024 file pvmon.obj \
       library /watcom/lib286/win/windows.lib libpath /watcom/lib286 libpath /watcom/lib286/win )
ls -la build/PVMON.EXE
