#!/usr/bin/env bash
# Build image/work.img from image/wfw311-base.img + image/changes/.
#   changes/system/*   -> C:\WINDOWS\SYSTEM
#   changes/windows/*  -> C:\WINDOWS
#   changes/root/*     -> C:\
# then apply SYSTEM.INI edits via tools/inied.py.
# Usage: image/build-image.sh [display=svga256|vga|pvdisp] [res=1|2|3] [dpi=96|120]
set -euo pipefail
cd "$(dirname "$0")"
DISPLAY_DRV=svga256; RES=2; DPI=96
for a in "$@"; do case $a in display=*) DISPLAY_DRV=${a#*=};; res=*) RES=${a#*=};; dpi=*) DPI=${a#*=};; esac; done
IMG=work.img; OFF=16384; M="-i $IMG@@$OFF"
cp wfw311-base.img $IMG
shopt -s nullglob
for f in changes/system/*;  do mcopy -o $M "$f" ::/WINDOWS/SYSTEM/; done
for f in changes/windows/*; do mcopy -o $M "$f" ::/WINDOWS/; done
for f in changes/root/*;    do mcopy -o $M "$f" ::/; done
TMP=$(mktemp -d)
mcopy -n $M ::/WINDOWS/SYSTEM.INI $TMP/SYSTEM.INI
python3 ../tools/inied.py $TMP/SYSTEM.INI display=$DISPLAY_DRV res=$RES dpi=$DPI
mcopy -o $M $TMP/SYSTEM.INI ::/WINDOWS/SYSTEM.INI
rm -rf $TMP
echo "built $IMG: display=$DISPLAY_DRV res=$RES dpi=$DPI"
