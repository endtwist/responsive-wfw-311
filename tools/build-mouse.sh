#!/usr/bin/env bash
# Build PVMOUSE.DRV (the DDK PS/2 mouse driver with paravirtual absolute pointing) from
# guest/mouse/port with the DDK toolchain under headless DOSBox-X, like tools/build-driver.sh.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
DDK=$REPO/guest/ddk/ddk31/iso/WIN31/DDK/286
VC=$REPO/guest/ddk/ddk31/iso/VISUALC/US/VC152C/MSVC15/BIN
SP=${SCRATCH:-/private/tmp/claude-501/-Users-joshuagross-Source-responsive-wfw311/dfcf137d-e687-46c9-884b-142e7d597f17/scratchpad}
ROOT=$SP/drvroot
mkdir -p "$ROOT/TOOLS" "$ROOT/VCBIN" "$ROOT/MOUSE"
[ -f "$ROOT/INC/CMACROS.INC" ] || cp -R "$DDK/INC" "$ROOT/INC"
[ -f "$ROOT/LIB/LIBW.LIB" ]    || cp -R "$DDK/LIB" "$ROOT/LIB"
[ -f "$ROOT/TOOLS/MASM.EXE" ]  || cp "$DDK/TOOLS/"*.EXE "$ROOT/TOOLS/"
[ -f "$ROOT/VCBIN/RC.EXE" ]    || for t in RC.EXE RCPP.EXE RCPP.ERR DOSXNT.EXE MAPSYM.EXE; do [ -f "$VC/$t" ] && cp "$VC/$t" "$ROOT/VCBIN/"; done; true
rm -f "$ROOT/MOUSE/"*
cp "$REPO/guest/mouse/port/"* "$ROOT/MOUSE/"
perl -pi -e 's/\r?\n/\r\n/' "$ROOT/MOUSE/"*
cat > "$ROOT/BUILD.BAT" <<'B'
@ECHO OFF
SET PATH=C:\TOOLS;C:\VCBIN
SET LIB=C:\LIB
SET INCLUDE=C:\INC
CD \MOUSE
MAKE MAKEFILE > \BUILD.TXT
ECHO MAKE-EXIT >> \BUILD.TXT
B
rm -f "$ROOT/BUILD.TXT"
"$REPO/tools/dosbuild.sh" "$ROOT" BUILD.BAT 600
tr -d '\r' < "$ROOT/BUILD.TXT" | grep -i -E "error|warning [^0]|fatal|cannot|not found|Severe  Errors *[1-9]|Unresolved|MAKE-EXIT" | grep -v "0 Warning Errors" | head -40 || true
[ -f "$ROOT/MOUSE/MOUSE.DRV" ] && cp "$ROOT/MOUSE/MOUSE.DRV" "$REPO/guest/mouse/build/PVMOUSE.DRV" && ls -l "$REPO/guest/mouse/build/PVMOUSE.DRV"
