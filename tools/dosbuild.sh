#!/usr/bin/env bash
# Run a DOS batch file headlessly under DOSBox-X with <root> mounted as C:.
# Usage: tools/dosbuild.sh <root-dir> <BATFILE.BAT> [timeout-seconds]
# The batch file's stdout should be redirected to a file inside <root> by the
# batch file itself (DOSBox-X does not forward DOS console output to the host).
set -euo pipefail
ROOT=$(cd "$1" && pwd); BAT=$2; TO=${3:-300}
CONF=$(mktemp -t dosbuild).conf
cat > "$CONF" <<'C'
[sdl]
output=surface
[dosbox]
machine=svga_s3
memsize=32
[cpu]
cputype=pentium
core=dynamic
cycles=max
[dos]
xms=true
ems=true
umb=true
C
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout "$TO" dosbox-x -conf "$CONF" -nogui -silent -fastlaunch \
  -c "MOUNT C $ROOT" -c "C:" -c "CALL $BAT" -c "EXIT" >/dev/null 2>&1 || { echo "dosbox-x exited $? (timeout=$TO s)"; }
rm -f "$CONF"
