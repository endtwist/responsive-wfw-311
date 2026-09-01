#!/usr/bin/env bash
# Run an Open Watcom tool (wcc, wcc386, wlink, wrc, wasm...) in Docker with the repo mounted at /src
# and the vendored Watcom tree (from ../386boot) at /watcom. Working dir = current dir mapped into /src.
# Usage: tools/watcom.sh wcc -bt=dos -ms foo.c
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
WATCOM=${WATCOM_DIR:-/Users/joshuagross/Source/386boot/wifi-dongle/tools/watcom}
REL=${PWD#"$REPO"}
docker run --rm --platform linux/amd64 -v "$REPO":/src -v "$WATCOM":/watcom -w "/src$REL" \
  -e WATCOM=/watcom -e "PATH=/watcom/binl64:/usr/bin:/bin" -e INCLUDE=/watcom/h debian:bookworm-slim "$@"
