#!/usr/bin/env bash
# Build PVHOOK.DLL (system-wide CBT hook) with Open Watcom via tools/watcom.sh.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build; cp pvhook.c build/
W=$(cd ../.. && pwd)/tools/watcom.sh
( cd build && $W wcc -bt=windows -bd -ms -zW -zu -zc -ox -zq -i=/watcom/h -i=/watcom/h/win pvhook.c \
  && { [ -f pvhook.o ] && mv pvhook.o pvhook.obj || true; } \
  && $W wlink system windows_dll name PVHOOK.DLL option heapsize=1024 file pvhook.obj \
       export PvCbtProc,PvHookInstall,PvHookRemove,WEP \
       library /watcom/lib286/win/windows.lib libpath /watcom/lib286 libpath /watcom/lib286/win )
ls -la build/PVHOOK.DLL
