#!/usr/bin/env bash
# Smoke test for the single-file `mt` binary. Usage: scripts/smoke-bin.sh [--no-build]
# Runs the binary from an empty temp dir (no node_modules) with a PATH that has no node/bun/pnpm.
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$PKG/dist/bin/mt"

if [ "${1:-}" != "--no-build" ]; then
  (cd "$PKG" && pnpm build && bun scripts/build-bin.ts)
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

# Minimal PATH: only coreutils dirs; fail if node is still reachable there
SAFE_PATH="/usr/bin:/bin"
if PATH="$SAFE_PATH" command -v node >/dev/null 2>&1; then
  echo "note: node exists in $SAFE_PATH; using empty PATH dir instead"
  mkdir bin && ln -s "$(command -v dirname)" bin/dirname && SAFE_PATH="$WORK/bin"
fi
run() { env -i HOME="$WORK" PATH="$SAFE_PATH" "$BIN" "$@"; }

echo "1/4 --help"
run --help | grep -q "Usage: mt" 
echo "2/4 init"
run init >/dev/null
test -f mt.json && test -d .mt

echo "3/4 run pipeline importing 'mt' + 'mt/tools' (no node_modules)"
mkdir -p pipelines jsonl
printf '%s\n' \
  '{"item":{"title":"Chapter 1","body":"# Chapter 1\n\nHello world."}}' \
  '{"item":{"title":"Chapter 2","body":"# Chapter 2\n\nSecond one."}}' > jsonl/input.jsonl
cat > pipelines/p.ts <<'TS'
import { definePipeline } from 'mt'
import { chapterDoc } from 'mt/tools'
import 'mt/waypoint'

export default definePipeline()
  .from('jsonl://./jsonl/*.jsonl')
  .use(chapterDoc)
  .to('md://./chapters/en')
TS
run run ./pipelines/p.ts >/dev/null
test "$(ls chapters/en/*.md | wc -l)" -ge 2

echo "4/4 legacy @mt/core specifier also resolves"
sed -e "s#from 'mt'#from '@mt/core'#" -e "s#'mt/tools'#'@mt/tools'#" -e "s#'mt/waypoint'#'@mt/waypoint'#" \
  pipelines/p.ts > pipelines/legacy.ts
rm -rf chapters .mt/runs
run run ./pipelines/legacy.ts >/dev/null
test "$(ls chapters/en/*.md | wc -l)" -ge 2

echo "smoke OK"
