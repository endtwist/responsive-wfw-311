#!/usr/bin/env bash
# Build image/work.img from image/wfw311-base.img + image/changes/.
#   changes/system/*   -> C:\WINDOWS\SYSTEM
#   changes/windows/*  -> C:\WINDOWS
#   changes/root/*     -> C:\
#   changes/games/*    -> C:\GAMES  (games=1, default; each known game also gets a Program Manager
#                         item in the Games group via tools/grpadd.py: SKI.EXE "SkiFree" is in the
#                         repo — see SPEC 2026-09-02)
#   changes-local/*    -> the same four destinations, an OPTIONAL untracked overlay for media that
#                         must not be committed (Josh's Best of Microsoft Entertainment Pack floppy:
#                         changes-local/games/ = the games, changes-local/system/ = VBRUN100.DLL +
#                         THREED.VBX, changes-local/windows/ = the games' .WAVs/.MIDs, which
#                         sndPlaySound only finds in C:\WINDOWS, and ENTPACK.INI). Absent on a
#                         fresh clone and the build is unaffected — see SPEC 2026-09-03.
# then apply SYSTEM.INI edits via tools/inied.py.
# Usage: image/build-image.sh [display=svga256|vga|pvdisp] [res=1|2|3] [dpi=96|120] [boot=win|pvtest|dos] [load=PVMON.EXE] [out=file.img]
#        Desktop mode (SPEC 2026-09-02) is a runtime switch (CMD_DESKTOP): the image is always the phone layout.
#        [fakescreen=1|0] ([PVMon] FakeScreen: USER reports the phone frame as the screen, SPEC 2026-09-02) [hookclamp=1|0] (0 = PVHOOK measuring mode, never ship)
#        [spooler=yes|no] [printer=PSCRIPT|TTY]  -- which of the two installed printers is the default:
#        "PDF Printer" (PSCRIPT.DRV, HP LaserJet III PostScript, graphics) or "Text Printer" (TTY.DRV,
#        Generic / Text Only); both print to the file port C:\PRINT.PRN, which PVMON ships to the host.
#        [games=1|0]  -- install changes/games/ as C:\GAMES with Program Manager items (default 1)
set -euo pipefail
cd "$(dirname "$0")"
DISPLAY_DRV=vga; RES=1; DPI=96; BOOT=win; IMG=work.img; LOAD=; LIVE=0; SHELLW=0; SHELLH=0; SYSFONT=; MOUSEDRV=; SOUND=; SPOOLER=yes; PRINTER=PSCRIPT; FAKESCREEN=1; HOOKCLAMP=1; GAMES=1
for a in "$@"; do case $a in display=*) DISPLAY_DRV=${a#*=};; res=*) RES=${a#*=};; dpi=*) DPI=${a#*=};; boot=*) BOOT=${a#*=};; out=*) IMG=${a#*=};; load=*) LOAD=${a#*=};; live=*) LIVE=${a#*=};; shellw=*) SHELLW=${a#*=};; sysfont=*) SYSFONT=${a#*=};; shellh=*) SHELLH=${a#*=};; mouse=*) MOUSEDRV=${a#*=};; sound=*) SOUND=${a#*=};; spooler=*) SPOOLER=${a#*=};; printer=*) PRINTER=${a#*=};; fakescreen=*) FAKESCREEN=${a#*=};; hookclamp=*) HOOKCLAMP=${a#*=};; games=*) GAMES=${a#*=};; esac; done
OFF=16384; M="-i $IMG@@$OFF"
cp wfw311-base.img $IMG
shopt -s nullglob
for f in changes/system/*;  do mcopy -o $M "$f" ::/WINDOWS/SYSTEM/; done
for f in changes/windows/*; do mcopy -o $M "$f" ::/WINDOWS/; done
for f in changes/root/*;    do mcopy -o $M "$f" ::/; done
# Optional untracked overlay (changes-local/): same layout, applied after the tracked changes so a
# clone without it still builds. Only files are copied; games/ is handled with changes/games below.
for f in changes-local/system/*;  do if [ -f "$f" ]; then mcopy -o $M "$f" ::/WINDOWS/SYSTEM/; fi; done
for f in changes-local/windows/*; do if [ -f "$f" ]; then mcopy -o $M "$f" ::/WINDOWS/; fi; done
for f in changes-local/root/*;    do if [ -f "$f" ]; then mcopy -o $M "$f" ::/; fi; done
TMP=$(mktemp -d)
# Games: C:\GAMES plus one Program Manager item per known game (GAMES.GRP is binary; tools/grpadd.py
# rewrites it with the icon taken from the executable). SkiFree (SKI.EXE, 1991, free from its author,
# ski.ihoc.net) is in the repo under changes/games/; the Best of Microsoft Entertainment Pack games
# come from the untracked changes-local/games/ overlay (Josh's own floppy, SPEC 2026-09-03) and are
# installed whenever that directory is present. Unknown files are copied, no item.
if [ "$GAMES" = 1 ]; then
  GAMEDIRS=; for d in changes/games changes-local/games; do [ -d "$d" ] && [ -n "$(ls -A "$d")" ] && GAMEDIRS="$GAMEDIRS $d"; done
fi
if [ "$GAMES" = 1 ] && [ -n "${GAMEDIRS# }" ]; then
  mmd $M ::/GAMES 2>/dev/null || true
  for d in $GAMEDIRS; do for f in $d/*; do if [ -f "$f" ]; then mcopy -o $M "$f" ::/GAMES/; fi; done; done
  mcopy -n $M ::/WINDOWS/GAMES.GRP $TMP/GAMES.GRP
  # title strings are the ones the pack's own SETUP writes (BOWEP.MST CreateProgmanItem)
  for g in "SKI.EXE:SkiFree" "JEZZBALL.EXE:JezzBall" "TETRIS.EXE:Tetris" "TETRAVEX.EXE:TetraVex" \
           "TRIPEAKS.EXE:TriPeaks" "TUTSTOMB.EXE:Tut's Tomb" "FREECELL.EXE:Free Cell" "GOLF.EXE:Golf" \
           "CHIPS.EXE:Chip's Challenge" "RODENT.EXE:Rodent's Revenge" "PIPE.EXE:Pipe Dream" \
           "TP.EXE:Taipei" "BLAKJAK.EXE:Dr. Black Jack"; do
    exe=${g%%:*}; title=${g#*:}
    for d in $GAMEDIRS; do
      if [ -f "$d/$exe" ]; then python3 ../tools/grpadd.py $TMP/GAMES.GRP "$title" "C:\\GAMES\\$exe" --exe "$d/$exe"; break; fi
    done
  done
  mcopy -o $M $TMP/GAMES.GRP ::/WINDOWS/GAMES.GRP
fi

# The guest's web client (guest/fetch): Windows for Workgroups shipped no HTTP client, so this is
# one, and it is a Windows program for the same reason everything else here is. It needs Trumpet's
# WINSOCK.DLL, so it goes in after the Trumpet block and takes its own item in Main.
if [ -f changes/windows/FETCH.EXE ]; then
  mcopy -n $M ::/WINDOWS/MAIN.GRP $TMP/MAIN.FET 2>/dev/null || true
  python3 ../tools/grpadd.py $TMP/MAIN.FET "Fetch" "FETCH.EXE" --exe changes/windows/FETCH.EXE
  mcopy -o $M $TMP/MAIN.FET ::/WINDOWS/MAIN.GRP
fi

# The first-run note (SPEC 2026-09-03): "Read Me First" in Main shows it again after it has been
# dismissed (ABOUT.EXE on its own honours [PVMon] AboutShown; the argument overrides it).
if [ -f changes/windows/ABOUT.EXE ] || [ -f changes/windows/LCD.EXE ]; then
  mcopy -n $M ::/WINDOWS/MAIN.GRP $TMP/MAIN.GRP
  [ -f changes/windows/ABOUT.EXE ] && python3 ../tools/grpadd.py $TMP/MAIN.GRP "Read Me First" "ABOUT.EXE /show" --exe changes/windows/ABOUT.EXE
  # The screen controls for the host's LCD filter (guest/lcd): a Windows program, because that is
  # the only kind of interface this system has.
  [ -f changes/windows/LCD.EXE ] && python3 ../tools/grpadd.py $TMP/MAIN.GRP "Screen" "LCD.EXE" --exe changes/windows/LCD.EXE
  mcopy -o $M $TMP/MAIN.GRP ::/WINDOWS/MAIN.GRP
fi

# Every group laid out for the phone: three icons across, the window the width of Program Manager's
# client and maximised, so no group has a horizontal scroll bar (tools/grpadd.py --relayout).
# Only Main is open: Program Manager restores whatever each group was left as, and a fresh install
# leaves them all open, which in one phone column means every group stacked on top of the one that
# matters. The rest come up as icons along the bottom of Program Manager, where they belong.
for g in MAIN ACCESSOR GAMES STARTUP APPLICAT NETWORK; do
  if mcopy -n $M "::/WINDOWS/$g.GRP" "$TMP/$g.GRP" 2>/dev/null; then
    [ "$g" = MAIN ] && ICONIC= || ICONIC=--iconic
    python3 ../tools/grpadd.py "$TMP/$g.GRP" --relayout $ICONIC && mcopy -o $M "$TMP/$g.GRP" "::/WINDOWS/$g.GRP"
  fi
done
# boot=win (default): AUTOEXEC runs WIN in a loop, so PVMON's exit-to-DOS resize comes straight
# back up at the new mode. boot=pvtest: run the DOS adapter test first, then WIN. boot=dos: prompt.
{
  # C:\GAMES on the PATH so a game can also be started by name from a DOS box or File Manager.
  # (It is not what makes their sound work: the Entertainment Pack games call sndPlaySound with a
  # bare file name and the lookup does not reach C:\GAMES, so changes-local/windows/ stages the
  # .WAVs and .MIDs into C:\WINDOWS as well — SPEC 2026-09-03.)
  printf 'C:\\WINDOWS\\SMARTDRV.EXE\r\n@ECHO OFF\r\nPROMPT $P$G\r\nPATH C:\\WINDOWS;C:\\DOS;C:\\GAMES;\r\nSET TEMP=C:\\TEMP\r\n'
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
H=$SHELLH; [ "$H" = 0 ] && H=760
# SkiFree (module SKI) draws its slope in whatever client it gets: the whole phone frame (the hook
# clamps to the runtime shell height). The Entertainment Pack games all have fixed playfields, so
# they are KeepSize at their natural size and the host scales them; the two exceptions are Tetris
# (born CW_USEDEFAULT in both axes, so it would fill a 640 slot: 352x470 gives a normally
# proportioned well at 1:1) and Dr. Black Jack (a 96 dpi layout whose button row falls off the
# bottom of its own 576x456 window at 120 dpi: +44 px brings it back). SPEC 2026-09-03.
python3 ../tools/winini.py $TMP/WIN.INI desktop.IconSpacing=100 desktop.IconTitleWrap=1 \
  windows.MouseSpeed=0 windows.MouseThreshold1=0 windows.MouseThreshold2=0 \
  windows.Beep=no \
  PVMon.Live=$LIVE PVMon.FakeScreen=$FAKESCREEN PVMon.HookClamp=$HOOKCLAMP PVMon.ShellWidth=$SHELLW PVMon.ShellHeight=$SHELLH PVMon.Size.WINOA386=${W}x360 PVMon.Size.CLOCK=${W}x${W} PVMon.Size.PBRUSH=640x424 Paintbrush.width=536 Paintbrush.height=300 PVMon.Size.SKI=${W}x${H} PVMon.Size.TETRIS=${W}x470 PVMon.Size.BLAKJAK=576x500 "PVMon.KeyboardApps=WINOA386 TERMINAL WRITE CARDFILE CALENDAR RECORDER NOTEPAD" PVMon.TapOpens=1 PVMon.DefaultSize=${W}x600 "PVMon.KeepSize=SOL MSHEARTS WINMINE CALC CHARMAP SOUNDREC TASKMAN WINVER PIFEDIT PACKAGER PBRUSH JEZZBALL TETRIS TETRAVEX TRIPEAKS TUTSTOMB FREECELL GOLF CHIPS RODENT PIPE TP BLAKJAK" \
  "Windows Help.M_WindowPosition=[640,0,${W},600,0]" "Windows Help.H_WindowPosition=[640,0,${W},400,0]" \
  "windows.spooler=$SPOOLER" \
  "windows.device=$( [ "$PRINTER" = TTY ] && echo "Text Printer,TTY" || echo "PDF Printer,PSCRIPT" ),C:\\PRINT.PRN" \
  "devices.PDF Printer=PSCRIPT,C:\\PRINT.PRN" \
  "devices.Text Printer=TTY,C:\\PRINT.PRN" \
  "PrinterPorts.PDF Printer=PSCRIPT,C:\\PRINT.PRN,15,45" \
  "PrinterPorts.Text Printer=TTY,C:\\PRINT.PRN,15,45" \
  "Ports.C:\\PRINT.PRN=" \
  "PSCRIPT,C:\\PRINT.PRN::device=HP LaserJet III PostScript" \
  "PostScript,C:\\PRINT.PRN::device=HP LaserJet III PostScript" \
  "windows.load=$( [ "$LOAD" = - ] && echo || echo "$LOAD" )" \
  "windows.run=$( [ -f changes/windows/ABOUT.EXE ] && echo ABOUT.EXE )"
# sound=1: Windows' own event sounds. The stock WIN.INI already lists the WAVs in [Sounds]; what
# it lacks is the master switch the Sound applet writes ([Sound] Enable), without which MMSYSTEM
# plays none of them. The names are asserted here too so a rebuilt image always has the same set
# (SPEC 2026-09-03). All five WAVs ship with WFW 3.11 in C:\WINDOWS.
if [ -n "$SOUND" ]; then
  python3 ../tools/winini.py $TMP/WIN.INI Sound.Enable=1 \
    "Sounds.SystemStart=chimes.wav, Windows Start" \
    "Sounds.SystemExit=chimes.wav, Windows Exit" \
    "Sounds.SystemDefault=ding.wav, Default Beep" \
    "Sounds.SystemAsterisk=ding.wav, Asterisk" \
    "Sounds.SystemQuestion=ding.wav, Question" \
    "Sounds.SystemExclamation=ding.wav, Exclamation" \
    "Sounds.SystemHand=ding.wav, Critical Stop" \
    "Sounds.RingIn=ringin.wav, Incoming Call" \
    "Sounds.RingOut=ringout.wav, Outgoing Call"
  # MIDIMAP.CFG is left exactly as shipped: its current setup (the 16-bit field at offset 6) is
  # 7, "Ad Lib general", whose channel entries name the "Ad Lib" port - the one port this machine
  # has. The other setups name Roland or Creative ports and produce "The current MIDI Mapper setup
  # refers to a MIDI device that is not installed" (all nine were tried; SPEC 2026-09-03).
fi
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
python3 ../tools/winini.py $TMP/PROGMAN.INI "Settings.Window=0 0 $W $(( ${SHELLH:-760} - 88 )) 1"
mcopy -o $M $TMP/PROGMAN.INI ::/WINDOWS/PROGMAN.INI
rm -rf $TMP
echo "built $IMG: display=$DISPLAY_DRV res=$RES dpi=$DPI boot=$BOOT load=$LOAD live=$LIVE fakescreen=$FAKESCREEN hookclamp=$HOOKCLAMP"
# Immutable builds: a running session must never see its disk change underneath it (a snapshot
# restored from one build over another build's image gives "Segment Load Failure"). Each build is
# cloned to a stamped name and current.json names the image and the matching boot snapshot the
# page should use; old stamped builds are pruned, keeping the last few for sessions still open.
STAMP=$(date +%Y%m%d-%H%M%S); BASE=${IMG%.img}
cp -c "$IMG" "$BASE-$STAMP.img" 2>/dev/null || cp "$IMG" "$BASE-$STAMP.img"
printf '{"image":"%s","state":"%s"}\n' "$BASE-$STAMP.img" "boot-$STAMP.state.gz" > current.json
# Prune every stamped build, not just this base name: an experiment built with out=nettest.img used
# to escape the pruner entirely, and sixteen of those left 4 GB behind. Parts directories are pruned
# with them -- tools/split-image.py writes one per deploy (22 MB) and never removed the old ones,
# which is where 748 MB went.
ls -t *-[0-9]*-[0-9]*.img 2>/dev/null | tail -n +4 | while read f; do
  st=${f%.img}; st=${st##*-[a-z]}; st=$(echo "$f" | sed 's/.*-\([0-9]\{8\}-[0-9]\{6\}\)\.img/\1/')
  rm -f "$f" "boot-$st.state.gz"
  rm -rf "parts/${f%.img}"
done
# Parts belong to an image: if the image has gone, so have they. Keeping the newest three by date
# was wrong -- it left 65 MB of chunks for images that no longer existed, and none for the one that
# did.
for d in parts/*-[0-9]*-[0-9]*; do
  [ -d "$d" ] || continue
  [ -f "${d#parts/}.img" ] || rm -rf "$d"
done
echo "current: $BASE-$STAMP.img + boot-$STAMP.state.gz"
