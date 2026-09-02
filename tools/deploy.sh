#!/usr/bin/env bash
# Production deploy to Vercel (project responsive-wfw-311, team joshuagross-projects).
#
# The disk image and boot snapshot are not in git (Microsoft-derived), so there is no Git
# integration: this deploys the working tree with the Vercel CLI. image/current.json names the
# image/snapshot pair; this script checks both exist, splits the image into zstd part files
# (tools/split-image.py; Vercel Hobby caps a file at 100 MB and the image is 245 MB) and records
# them in current.json, points .vercelignore at exactly that snapshot and parts directory (so a
# stale stamped pair next to it is not uploaded), checks the v86 wasm and BIOSes are built, then
# runs `vercel --prod`. Redeploying after an image rebuild is just running this again.
#
# Usage: tools/deploy.sh            (from anywhere; needs `npx vercel@latest whoami` to succeed)
#        tools/deploy.sh --preview  (preview deployment instead of production)
set -euo pipefail
cd "$(dirname "$0")/.."

SCOPE=joshuagross-projects   # the "joshuagross" account: its team slug (the CLI rejects the bare user name as a scope)
PROJECT=responsive-wfw-311

[ -f image/current.json ] || { echo "image/current.json missing: run image/build-image.sh first" >&2; exit 1; }
IMG=$(node -p 'JSON.parse(require("fs").readFileSync("image/current.json","utf8")).image')
STATE=$(node -p 'JSON.parse(require("fs").readFileSync("image/current.json","utf8")).state')
for f in "image/$IMG" "image/$STATE" v86/build/v86.wasm v86/bios/seabios.bin v86/bios/vgabios.bin; do
  [ -s "$f" ] || { echo "missing: $f" >&2; exit 1; }
done
case "$IMG" in work-phone-*.img) ;; *) echo "current.json image '$IMG' is not a stamped work-phone-*.img" >&2; exit 1;; esac
case "$STATE" in boot-*.state.gz) ;; *) echo "current.json state '$STATE' is not a stamped boot-*.state.gz" >&2; exit 1;; esac

PARTS=parts/${IMG%.img}
python3 tools/split-image.py "image/$IMG"
[ "$(ls "image/$PARTS" | wc -l | tr -d ' ')" = "$(( $(stat -f %z "image/$IMG") / 262144 ))" ] || { echo "image/$PARTS is incomplete" >&2; exit 1; }
grep -q '"parts"' image/current.json || { echo "current.json has no parts entry" >&2; exit 1; }

# Pin .vercelignore to the current pair (the only two image/ lines that change).
sed -i '' -e "s#^!image/parts/work-phone-.*\$#!image/$PARTS#" -e "s#^!image/boot-.*\.state\.gz\$#!image/$STATE#" .vercelignore
grep -q "^!image/$PARTS\$" .vercelignore && grep -q "^!image/$STATE\$" .vercelignore \
  || { echo ".vercelignore does not name the current pair" >&2; exit 1; }

echo "deploying $PARTS + $STATE ($(du -sh "image/$PARTS" | cut -f1), $(du -h "image/$STATE" | cut -f1))"
npx -y vercel@latest whoami >/dev/null 2>&1 || { echo "not logged in: run  npx vercel@latest login" >&2; exit 1; }
[ -f .vercel/project.json ] || npx -y vercel@latest link --yes --scope "$SCOPE" --project "$PROJECT"

if [ "${1:-}" = "--preview" ]; then
  npx -y vercel@latest deploy --yes --scope "$SCOPE"
else
  npx -y vercel@latest deploy --prod --yes --scope "$SCOPE"
fi
