#!/usr/bin/env bash
# Build UASM (MASM-compatible assembler) natively on macOS into tools/uasm/GccUnixR/uasm.
# Upstream master does not build cleanly with Apple clang; this applies the minimal fixes.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d uasm ]; then git clone --depth 1 https://github.com/Terraspace/UASM uasm; fi
cd uasm
mkdir -p stubs
cat > stubs/direct.h <<'H'
/* Stub for the Windows-only <direct.h> so dbgcv.c builds on macOS. */
#include <unistd.h>
#include <strings.h>
#ifndef _MAX_PATH
#define _MAX_PATH 4096
#endif
#define _getcwd getcwd
#define _memicmp(a,b,n) strncasecmp((const char*)(a),(const char*)(b),(n))
static char *_pgmptr = "uasm";
H
# pointer-difference hard errors in CodeView writer (char* - uint_8*)
grep -q '(uint_8\*)s - cv.ps' dbgcv.c || sed -i.orig 's/(unsigned short)(s - cv.ps - 2)/(unsigned short)((uint_8*)s - cv.ps - 2)/; s/length += (s - start);/length += ((uint_8*)s - start);/' dbgcv.c
make -f ClangOSX64.mak -j8 inc_dirs="-IH -Istubs" \
  extra_c_flags="-DNDEBUG -O2 -std=gnu99 -funsigned-char -fwritable-strings -Wno-everything -Wno-error=implicit-function-declaration -Wno-error=int-conversion -Wno-error=incompatible-pointer-types -Wno-error=incompatible-function-pointer-types"
./GccUnixR/uasm -h | head -1
