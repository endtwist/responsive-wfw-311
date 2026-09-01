#!/usr/bin/env bash
# Build PVDPI.EXE (16-bit DOS) with Open Watcom via tools/watcom.sh.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build; cp pvdpi.c build/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build && $W wcc -bt=dos -ms -ox -zq -i=/watcom/h pvdpi.c \
  && { [ -f pvdpi.o ] && mv pvdpi.o pvdpi.obj || true; } \
  && $W wlink system dos name PVDPI.EXE file pvdpi.obj )
ls -la build/PVDPI.EXE
