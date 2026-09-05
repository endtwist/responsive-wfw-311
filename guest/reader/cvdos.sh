#!/usr/bin/env bash
# Run the real 16-bit build of cinepak.c under DOSBox-X and check it decodes exactly what the host
# build does. The host harness proves the decoder; this proves the compiler and the huge pointers.
#
#   guest/reader/cvdos.sh clip.avi
#
# Needs dosbox-x on PATH and Docker for tools/watcom.sh.
set -euo pipefail
cd "$(dirname "$0")"
AVI=${1:?usage: cvdos.sh clip.avi}
AVI=$(cd "$(dirname "$AVI")" && pwd)/$(basename "$AVI")
W=$(cd ../.. && pwd)/tools/watcom.sh
OUT=build/dos

mkdir -p $OUT
cp cinepak.c cinepak.h cvdos.c $OUT/
( cd $OUT
  for f in cinepak cvdos; do
    $W wcc -bt=dos -ml -ox -wx -zq $f.c
    [ -f $f.o ] && mv $f.o $f.obj
  done
  $W wlink system dos name CVDOS.EXE file cvdos.obj file cinepak.obj >/dev/null )

# The frames and the table, in the shape CVDOS.EXE reads, plus the host's own answer
python3 -c "
import sys; sys.path.insert(0, '.')
import cvcheck
cvcheck.dos_kit('$AVI', cvcheck.channel_luts()[0], '$OUT')" >/dev/null
cc -O2 -o $OUT/cvtest cvtest.c cinepak.c
$OUT/cvtest "$AVI" $OUT/LUT.BIN $OUT/host.raw | tail -n +2 > $OUT/host-sums.txt

rm -f $OUT/SUMS.TXT
D=$(cd $OUT && pwd)
SDL_VIDEODRIVER=dummy dosbox-x -silent -exit -nolog \
  -c "mount c $D" -c "c:" -c "CVDOS.EXE" -c "exit" >/dev/null 2>&1
tr -d '\r' < $OUT/SUMS.TXT | grep -v ticks > $OUT/dos-sums.txt

if diff -q $OUT/host-sums.txt $OUT/dos-sums.txt >/dev/null; then
    echo "16-bit and host agree on all $(wc -l < $OUT/dos-sums.txt | tr -d ' ') frames"
    grep ticks $OUT/SUMS.TXT
else
    echo "MISMATCH:"; diff $OUT/host-sums.txt $OUT/dos-sums.txt | head
    exit 1
fi
