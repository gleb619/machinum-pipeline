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
PIDS=""
cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  for p in $PIDS; do
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$p" 2>/dev/null || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
cd "$WORK"

# Minimal PATH: only coreutils dirs; fail if node is still reachable there
SAFE_PATH="/usr/bin:/bin"
if PATH="$SAFE_PATH" command -v node >/dev/null 2>&1; then
  echo "note: node exists in $SAFE_PATH; using empty PATH dir instead"
  mkdir bin && ln -s "$(command -v dirname)" bin/dirname && SAFE_PATH="$WORK/bin"
fi
run() { env -i HOME="$WORK" PATH="$SAFE_PATH" "$BIN" "$@"; }

echo "1/8 --help"
run --help | grep -q "Usage: mt" 
echo "2/8 init"
run init >/dev/null
test -f mt.json && test -d .mt

echo "3/8 run pipeline importing 'mt' + 'mt/tools' (no node_modules)"
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

echo "4/8 legacy @mt/core specifier also resolves"
sed -e "s#from 'mt'#from '@mt/core'#" -e "s#'mt/tools'#'@mt/tools'#" -e "s#'mt/waypoint'#'@mt/waypoint'#" \
  pipelines/p.ts > pipelines/legacy.ts
rm -rf chapters .mt/runs
run run ./pipelines/legacy.ts >/dev/null
test "$(ls chapters/en/*.md | wc -l)" -ge 2

echo "5/8 pipeline with relative .ts helper + package from its own node_modules + embedded zod fallback"
mkdir -p lib node_modules/smoke-dep
echo 'export const helper = (s: string): string => `helper:${s}`' > lib/helper.ts
echo '{"name":"smoke-dep","version":"1.0.0","type":"module","main":"index.js"}' > node_modules/smoke-dep/package.json
echo 'export const dep = (s) => `dep:${s}`' > node_modules/smoke-dep/index.js
cat > pipelines/third.ts <<'TS'
import { writeFileSync } from 'node:fs'
import { definePipeline } from 'mt'
import 'mt/waypoint'
import { dep } from 'smoke-dep'
import { z } from 'zod'
import { helper } from '../lib/helper'

export default definePipeline()
  .from('jsonl://./jsonl/*.jsonl')
  .tap(async () => {
    writeFileSync('proof.txt', `${helper('a')}|${dep('b')}|${z.string().parse('c')}`)
  })
TS
rm -rf .mt/runs
run run ./pipelines/third.ts >/dev/null
test "$(cat proof.txt)" = "helper:a|dep:b|c"

# --- serve ---------------------------------------------------------------
start_server() { # $1 = log file ; sets SERVER_PID and BASE
  : > "$1"
  env -i HOME="$WORK" PATH="$SAFE_PATH" "$BIN" serve --port 0 --host 127.0.0.1 >"$1" 2>&1 &
  SERVER_PID=$!
  PIDS="$PIDS $SERVER_PID"
  BASE=""
  for _ in $(seq 1 50); do
    BASE="$(grep -o 'http://127\.0\.0\.1:[0-9]*' "$1" | head -1 || true)"
    [ -n "$BASE" ] && break
    kill -0 "$SERVER_PID" 2>/dev/null || { cat "$1"; echo "serve exited early"; exit 1; }
    sleep 0.2
  done
  [ -n "$BASE" ] || { cat "$1"; echo "serve did not start"; exit 1; }
}

echo "6/8 mt serve: health, runs API, SQLite, SSE, UI, pause/resume"
mkdir -p .mt/runs/smoke-run
echo '{"state":"running"}' > .mt/runs/smoke-run/state.json
echo '{"type":"started"}' > .mt/runs/smoke-run/events.jsonl
# parked run for the pause/resume probe: without this the run would end before the API calls land
cat > pipelines/slow.ts <<'TS'
import { definePipeline } from 'mt'
import 'mt/waypoint'

export default definePipeline()
  .from('jsonl://./jsonl/*.jsonl')
  .tap(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15000))
  })
TS
start_server serve.log
test "$(curl -sf "$BASE/api/health")" = '{"status":"ok"}'
curl -sf "$BASE/api/runs" | grep -q '"id":"smoke-run"'
curl -sf "$BASE/api/runs/smoke-run" | grep -q '"state":"running"'
test -f .mt/mt.sqlite   # bun:sqlite opened
curl -sf -X POST -H 'content-type: application/json' -d '{"a":1}' "$BASE/api/runs/smoke-run/items" \
  | grep -q '"received":true'
curl -sf "$BASE/api/runs/smoke-run/events" | grep -q 'event: started'
# SSE stream mode stays open: connect, expect the replayed event, then time out (curl rc 28)
set +e
SSE="$(curl -sN --max-time 2 "$BASE/api/runs/smoke-run/events?stream=true")"
RC=$?
set -e
test "$RC" -eq 28
echo "$SSE" | grep -q 'event: started'
curl -sf "$BASE/" | grep -qi '<div id="app">'
ASSET="$(curl -sf "$BASE/" | grep -o '/assets/[^"]*\.js' | head -1)"
curl -sfI "$BASE$ASSET" | grep -qi 'text/javascript'
curl -sf "$BASE/some/spa/route" | grep -qi '<div id="app">'   # SPA fallback
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/nope")" = 404
# a run started via the API is registered live: pause -> resume must answer 200, not 404
STARTED="$(curl -sf -X POST -H 'content-type: application/json' -d '{"pipeline":"pipelines/slow.ts"}' "$BASE/api/runs/start")"
SRID="$(printf '%s' "$STARTED" | grep -o '"runId":"[^"]*"' | cut -d'"' -f4)"
[ -n "$SRID" ] || { echo "runs/start returned no runId: $STARTED"; exit 1; }
curl -sf -X POST "$BASE/api/runs/$SRID/pause" | grep -q '"state":"paused"'
curl -sf "$BASE/api/runs/$SRID" | grep -q '"state":"paused"'
curl -sf -X POST "$BASE/api/runs/$SRID/resume" | grep -q '"state":"running"'
curl -sf "$BASE/api/runs/$SRID" | grep -q '"state":"running"'
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/runs/nope/pause")" = 404
kill "$SERVER_PID"
for _ in $(seq 1 25); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$SERVER_PID" 2>/dev/null; then echo "serve did not stop on SIGTERM"; exit 1; fi

echo "7/8 mt serve --detach (re-execs the binary), then stop via pid file"
rm -rf .mt/backend
run serve --detach --port 0 --host 127.0.0.1 | grep -q "Backend PID"
DPID="$(cat .mt/backend/pid)"
PIDS="$PIDS $DPID"
DBASE=""
for _ in $(seq 1 50); do
  DBASE="$(grep -o 'http://127\.0\.0\.1:[0-9]*' .mt/backend/server.log 2>/dev/null | head -1 || true)"
  [ -n "$DBASE" ] && break
  sleep 0.2
done
[ -n "$DBASE" ] || { cat .mt/backend/server.log; echo "detached serve did not start"; exit 1; }
curl -sf "$DBASE/api/health" | grep -q ok
kill "$DPID"
for _ in $(seq 1 25); do kill -0 "$DPID" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$DPID" 2>/dev/null; then echo "detached serve did not stop"; exit 1; fi

echo "8/8 no stray processes"
for p in $PIDS; do if kill -0 "$p" 2>/dev/null; then echo "leaked pid $p"; exit 1; fi; done

echo "smoke OK"
