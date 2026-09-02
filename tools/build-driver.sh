#!/usr/bin/env bash
# Build PVDISP.DRV from guest/driver/port with the genuine DDK toolchain under headless DOSBox-X.
# Stages a DOS-friendly tree in the scratch dir (8.3 names, CRLF), runs MAKE, copies results back to
# guest/driver/build/. Usage: tools/build-driver.sh [clean]
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
DDK=$REPO/guest/ddk/ddk31/iso/WIN31/DDK/286
VC=$REPO/guest/ddk/ddk31/iso/VISUALC/US/VC152C/MSVC15/BIN
SP=${SCRATCH:-/private/tmp/claude-501/-Users-joshuagross-Source-responsive-wfw311/dfcf137d-e687-46c9-884b-142e7d597f17/scratchpad}
ROOT=$SP/drvroot
[ "${1:-}" = clean ] && rm -rf "$ROOT"
mkdir -p "$ROOT/TOOLS" "$ROOT/VCBIN" "$ROOT/DRV/OBJ"
[ -f "$ROOT/INC/CMACROS.INC" ] || cp -R "$DDK/INC" "$ROOT/INC"
[ -f "$ROOT/LIB/LIBW.LIB" ]    || cp -R "$DDK/LIB" "$ROOT/LIB"
[ -f "$ROOT/TOOLS/MASM.EXE" ]  || { cp "$DDK/TOOLS/"*.EXE "$ROOT/TOOLS/"; cp "$REPO/guest/ddk/ddk31/iso/WIN31/INTLDDK/J_DDKE/286/TOOLS/EXE2BIN.EXE" "$ROOT/TOOLS/"; }
[ -f "$ROOT/VCBIN/RC.EXE" ]    || for t in RC.EXE RCPP.EXE RCPP.ERR DOSXNT.EXE MAPSYM.EXE; do [ -f "$VC/$t" ] && cp "$VC/$t" "$ROOT/VCBIN/"; done; true
# sync sources (CRLF for the DOS tools)
rsync -a --delete --exclude OBJ "$REPO/guest/driver/port/" "$ROOT/DRV/"
# res=192 (or any RESnnn directory) swaps in a scaled set of the system bitmaps: Windows sizes its
# captions, scroll bars and check boxes from these, so this is how the chrome gets thumb-sized
# with nothing but Windows' own pixels. config.bin/fonts.bin stay the RES96 ones.
RESSET=96; for a in "$@"; do case $a in res=*) RESSET=${a#*=};; esac; done
if [ "$RESSET" != 96 ]; then cp "$REPO/guest/driver/port/RES$RESSET/"*.BMP "$ROOT/DRV/RES96/"; echo "using RES$RESSET bitmaps"; fi
find "$ROOT/DRV" -type f ! -path '*/OBJ/*' \( -iname '*.asm' -o -iname '*.inc' -o -iname '*.mac' -o -iname '*.blt' -o -iname '*.var' \
  -o -iname '*.mak' -o -iname 'makefile' -o -iname '*.def' -o -iname '*.rc' -o -iname '*.rcv' -o -iname '*.h' -o -iname 'lnkcmd*' -o -iname '*.pub' \) \
  -exec perl -pi -e 's/\r?\n/\r\n/' {} +
cat > "$ROOT/BUILD.BAT" <<'B'
@ECHO OFF
SET PATH=C:\TOOLS;C:\VCBIN
SET LIB=C:\LIB
SET INCLUDE=C:\INC
CD \DRV\MAK
MAKE V731VGA.MAK > \BUILD.TXT
ECHO MAKE-EXIT >> \BUILD.TXT
B
rm -f "$ROOT/BUILD.TXT"
"$REPO/tools/dosbuild.sh" "$ROOT" BUILD.BAT 900
tr -d '\r' < "$ROOT/BUILD.TXT" | grep -i -E "error|warning [^0]|fatal|cannot|not found|Severe  Errors *[1-9]|Unresolved|MAKE-EXIT" | grep -v "0 Warning Errors" | head -40 || true
mkdir -p "$REPO/guest/driver/build"
for f in DRV SYM MAP; do
  src=$(ls "$ROOT/DRV/MAK/"*.$f 2>/dev/null | head -1) || true
  [ -n "${src:-}" ] && cp "$src" "$REPO/guest/driver/build/PVDISP.${f}"
done
ls -la "$REPO/guest/driver/build/" 2>/dev/null
