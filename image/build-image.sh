#!/usr/bin/env bash
# Build image/work.img from image/wfw311-base.img + image/changes/.
#   changes/system/*   -> C:\WINDOWS\SYSTEM
#   changes/windows/*  -> C:\WINDOWS
#   changes/root/*     -> C:\
# then apply SYSTEM.INI edits via tools/inied.py.
# Usage: image/build-image.sh [display=svga256|vga|pvdisp] [res=1|2|3] [dpi=96|120] [boot=win|pvtest|dos] [load=PVMON.EXE] [out=file.img]
set -euo pipefail
cd "$(dirname "$0")"
DISPLAY_DRV=vga; RES=1; DPI=96; BOOT=win; IMG=work.img; LOAD=; LIVE=0; SHELLW=0; SHELLH=0; SYSFONT=; MOUSEDRV=; SOUND=
for a in "$@"; do case $a in display=*) DISPLAY_DRV=${a#*=};; res=*) RES=${a#*=};; dpi=*) DPI=${a#*=};; boot=*) BOOT=${a#*=};; out=*) IMG=${a#*=};; load=*) LOAD=${a#*=};; live=*) LIVE=${a#*=};; shellw=*) SHELLW=${a#*=};; sysfont=*) SYSFONT=${a#*=};; shellh=*) SHELLH=${a#*=};; mouse=*) MOUSEDRV=${a#*=};; sound=*) SOUND=${a#*=};; esac; done
OFF=16384; M="-i $IMG@@$OFF"
cp wfw311-base.img $IMG
shopt -s nullglob
for f in changes/system/*;  do mcopy -o $M "$f" ::/WINDOWS/SYSTEM/; done
for f in changes/windows/*; do mcopy -o $M "$f" ::/WINDOWS/; done
for f in changes/root/*;    do mcopy -o $M "$f" ::/; done
TMP=$(mktemp -d)
# boot=win (default): AUTOEXEC runs WIN in a loop, so PVMON's exit-to-DOS resize comes straight
# back up at the new mode. boot=pvtest: run the DOS adapter test first, then WIN. boot=dos: prompt.
{
  printf 'C:\\WINDOWS\\SMARTDRV.EXE\r\n@ECHO OFF\r\nPROMPT $P$G\r\nPATH C:\\WINDOWS;C:\\DOS;\r\nSET TEMP=C:\\TEMP\r\n'
  case $BOOT in
    win)    printf ':WINLOOP\r\nPVDPI\r\nWIN\r\nGOTO WINLOOP\r\n';;
    pvtest) printf 'PVTEST\r\nWIN\r\n';;
    dos)    ;;
  esac
} > $TMP/AUTOEXEC.BAT
mcopy -o $M $TMP/AUTOEXEC.BAT ::/AUTOEXEC.BAT
mcopy -n $M ::/WINDOWS/SYSTEM.INI $TMP/SYSTEM.INI
python3 ../tools/inied.py $TMP/SYSTEM.INI display=$DISPLAY_DRV res=$RES dpi=$DPI ${SYSFONT:+sysfont=$SYSFONT} ${MOUSEDRV:+mousedrv=$MOUSEDRV} ${SOUND:+sound=$SOUND}
mcopy -o $M $TMP/SYSTEM.INI ::/WINDOWS/SYSTEM.INI
# DPI variants for PVDPI.EXE to choose between at each Windows start (SPEC 2.6).
# Fonts must match the DPI PVDISP.DRV reports from HOST_DPI or text metrics go wrong.
for d in 96 120; do
  cp $TMP/SYSTEM.INI $TMP/SYSTEM.$d
  python3 ../tools/inied.py $TMP/SYSTEM.$d display=$DISPLAY_DRV res=$RES dpi=$d ${SYSFONT:+sysfont=$SYSFONT} ${MOUSEDRV:+mousedrv=$MOUSEDRV} ${SOUND:+sound=$SOUND}
  mcopy -o $M $TMP/SYSTEM.$d ::/WINDOWS/SYSTEM.$d
done
# WIN.INI: [windows] load= (companion utility), e.g. load=PVMON.EXE; load=- clears it
mcopy -n $M ::/WINDOWS/WIN.INI $TMP/WIN.INI
# Program Manager lays icon captions out on a fixed pixel spacing; the stock 77 is sized for
# 96 dpi system fonts and captions collide once PVDPI selects the 120 dpi (8514) fonts.
# A real large-font install widens it, so do the same here, for both DPI settings.
# Mouse acceleration would break absolute pointing: the host turns a tap into relative motion
# from the cursor position the driver reports, which only lands correctly at a 1:1 mickey ratio.
python3 ../tools/winini.py $TMP/WIN.INI desktop.IconSpacing=100 desktop.IconTitleWrap=1 \
  windows.MouseSpeed=0 windows.MouseThreshold1=0 windows.MouseThreshold2=0 \
  PVMon.Live=$LIVE PVMon.ShellWidth=$SHELLW PVMon.ShellHeight=$SHELLH PVMon.MaxHeight.PBRUSH=480 PVMon.MaxHeight.WINFILE=600 PVMon.Size.WINOA386=400x340 \
  "windows.device=PDF Printer,PSCRIPT,C:\\PRINT.PS" \
  "devices.PDF Printer=PSCRIPT,C:\\PRINT.PS" \
  "PrinterPorts.PDF Printer=PSCRIPT,C:\\PRINT.PS,15,45" \
  "Ports.C:\\PRINT.PS=" \
  "PSCRIPT,C:\\PRINT.PS::device=HP LaserJet III PostScript" \
  "windows.load=$( [ "$LOAD" = - ] && echo || echo "$LOAD" )"
mcopy -o $M $TMP/WIN.INI ::/WINDOWS/WIN.INI
# File Manager remembers its window from its last run, which on this image was a 1024x768 session;
# opened in a 640-column slot that makes it a tall sliver scaled to nothing. Give it a sane default.
printf '[Settings]\r\nWindow=0,0,640,560, ,0\r\nFace=MS Sans Serif\r\nSize=10\r\n' > $TMP/WINFILE.INI
mcopy -o $M $TMP/WINFILE.INI ::/WINDOWS/WINFILE.INI
rm -rf $TMP
echo "built $IMG: display=$DISPLAY_DRV res=$RES dpi=$DPI boot=$BOOT load=$LOAD live=$LIVE"
