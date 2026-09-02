#!/usr/bin/env bash
# Build image/work.img from image/wfw311-base.img + image/changes/.
#   changes/system/*   -> C:\WINDOWS\SYSTEM
#   changes/windows/*  -> C:\WINDOWS
#   changes/root/*     -> C:\
# then apply SYSTEM.INI edits via tools/inied.py.
# Usage: image/build-image.sh [display=svga256|vga|pvdisp] [res=1|2|3] [dpi=96|120] [boot=win|pvtest|dos] [load=PVMON.EXE] [out=file.img]
set -euo pipefail
cd "$(dirname "$0")"
DISPLAY_DRV=vga; RES=1; DPI=96; BOOT=win; IMG=work.img; LOAD=; LIVE=0; SHELLW=0; SHELLH=0; SYSFONT=; MOUSEDRV=; SOUND=; SPOOLER=yes; PRINTER=PSCRIPT
for a in "$@"; do case $a in display=*) DISPLAY_DRV=${a#*=};; res=*) RES=${a#*=};; dpi=*) DPI=${a#*=};; boot=*) BOOT=${a#*=};; out=*) IMG=${a#*=};; load=*) LOAD=${a#*=};; live=*) LIVE=${a#*=};; shellw=*) SHELLW=${a#*=};; sysfont=*) SYSFONT=${a#*=};; shellh=*) SHELLH=${a#*=};; mouse=*) MOUSEDRV=${a#*=};; sound=*) SOUND=${a#*=};; spooler=*) SPOOLER=${a#*=};; printer=*) PRINTER=${a#*=};; esac; done
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
# [PVMon] geometry: PVHOOK.DLL enforces one invariant (no top-level window wider than the shell
# column or taller than it), so the per-app keys are exceptions only: Size.* for programs whose
# natural size is not the frame, KeepSize for fixed-layout programs that must never be resized
# (dialog-template main windows such as Task List are detected by class and need no key).
W=$SHELLW; [ "$W" = 0 ] && W=352
python3 ../tools/winini.py $TMP/WIN.INI desktop.IconSpacing=100 desktop.IconTitleWrap=1 \
  windows.MouseSpeed=0 windows.MouseThreshold1=0 windows.MouseThreshold2=0 \
  PVMon.Live=$LIVE PVMon.ShellWidth=$SHELLW PVMon.ShellHeight=$SHELLH PVMon.MaxHeight.PBRUSH=480 PVMon.Size.PBRUSH=${W}x480 PVMon.Size.WINOA386=${W}x360 PVMon.Size.CLOCK=${W}x${W} "PVMon.KeyboardApps=WINOA386 TERMINAL" PVMon.DefaultSize=${W}x600 "PVMon.KeepSize=SOL MSHEARTS WINMINE CALC CHARMAP SOUNDREC TASKMAN WINVER PIFEDIT PACKAGER" \
  "Windows Help.M_WindowPosition=[640,0,${W},600,0]" "Windows Help.H_WindowPosition=[640,0,${W},400,0]" \
  "windows.spooler=$SPOOLER" \
  "windows.device=PDF Printer,$PRINTER,C:\\PRINT.PRN" \
  "devices.PDF Printer=$PRINTER,C:\\PRINT.PRN" \
  "PrinterPorts.PDF Printer=$PRINTER,C:\\PRINT.PRN,15,45" \
  "Ports.C:\\PRINT.PRN=" \
  "PSCRIPT,C:\\PRINT.PRN::device=HP LaserJet III PostScript" \
  "PostScript,C:\\PRINT.PRN::device=HP LaserJet III PostScript" \
  "windows.load=$( [ "$LOAD" = - ] && echo || echo "$LOAD" )"
mcopy -o $M $TMP/WIN.INI ::/WINDOWS/WIN.INI
# File Manager remembers its window from its last run, which on this image was a 1024x768 session;
# opened in a 640-column slot that makes it a tall sliver scaled to nothing. Give it a sane default.
# Window= x,y,w,h, , ,showcmd; dir1= x,y,w,h,split,-1,showcmd(3 = maximised),0,view,sort,attr,path
# (format read back from a WINFILE.INI the guest itself saved after maximising the directory window)
printf '[Settings]\r\nWindow=640,0,%s,600, , ,1\r\nFace=MS Sans Serif\r\nSize=10\r\ndir1=0,0,%s,400,-1,-1,3,0,201,1905,71,C:\\*.*\r\n' $W $(( W - 8 )) > $TMP/WINFILE.INI
mcopy -o $M $TMP/WINFILE.INI ::/WINDOWS/WINFILE.INI
# Programs that restore a saved window rectangle after creation (Program Manager, Windows Help
# above) would be born in the slot and then move and resize in steps, each step captured by the
# host as a torn frame; their saved rectangles are pre-written to the phone rect so the restore
# is a no-op. PVMON still arranges the shell to the runtime column height.
mcopy -n $M ::/WINDOWS/PROGMAN.INI $TMP/PROGMAN.INI
python3 ../tools/winini.py $TMP/PROGMAN.INI "Settings.Window=0 0 $W $(( ${SHELLH:-760} - 76 )) 1"
mcopy -o $M $TMP/PROGMAN.INI ::/WINDOWS/PROGMAN.INI
rm -rf $TMP
echo "built $IMG: display=$DISPLAY_DRV res=$RES dpi=$DPI boot=$BOOT load=$LOAD live=$LIVE"
# Immutable builds: a running session must never see its disk change underneath it (a snapshot
# restored from one build over another build's image gives "Segment Load Failure"). Each build is
# cloned to a stamped name and current.json names the image and the matching boot snapshot the
# page should use; old stamped builds are pruned, keeping the last few for sessions still open.
STAMP=$(date +%Y%m%d-%H%M%S); BASE=${IMG%.img}
cp -c "$IMG" "$BASE-$STAMP.img" 2>/dev/null || cp "$IMG" "$BASE-$STAMP.img"
printf '{"image":"%s","state":"%s"}\n' "$BASE-$STAMP.img" "boot-$STAMP.state.gz" > current.json
ls -t $BASE-*.img 2>/dev/null | tail -n +4 | while read f; do rm -f "$f" "boot-${f#$BASE-}"; rm -f "boot-$(basename "${f#$BASE-}" .img).state.gz"; done
echo "current: $BASE-$STAMP.img + boot-$STAMP.state.gz"
