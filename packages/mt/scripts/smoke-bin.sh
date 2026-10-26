#!/usr/bin/env bash
# Smoke test for the single-file `mt` binary.
# Usage: scripts/smoke-bin.sh [--no-build] [--bin <path>]
#   --no-build  do not rebuild the binary (use the one that is there)
#   --bin <p>   smoke the binary at <p> instead of dist/bin/mt (cross targets)
# Runs the binary from an empty temp dir (no node_modules) with a PATH that has no node/bun/pnpm.
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$PKG/dist/bin/mt"
BUILD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --) ;; # pnpm forwards a literal `--` before run-script arguments
    --bin)
      shift
      [ $# -gt 0 ] || { echo "--bin needs a path" >&2; exit 2; }
      BIN="$1"
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$BUILD" = 1 ]; then
  (cd "$PKG" && pnpm build && bun scripts/build-bin.ts)
fi

[ -x "$BIN" ] || { echo "binary not found or not executable: $BIN" >&2; exit 1; }
echo "smoke binary: $BIN"

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

echo "1/15 --help"
run --help | grep -q "Usage: mt"
echo "2/15 init"
run init >/dev/null
test -f mt.json && test -d .mt

echo "3/15 run pipeline importing 'mt' + 'mt/tools' (no node_modules)"
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

echo "4/15 legacy @mt/core specifier also resolves"
sed -e "s#from 'mt'#from '@mt/core'#" -e "s#'mt/tools'#'@mt/tools'#" -e "s#'mt/waypoint'#'@mt/waypoint'#" \
  pipelines/p.ts > pipelines/legacy.ts
rm -rf chapters .mt/runs
run run ./pipelines/legacy.ts >/dev/null
test "$(ls chapters/en/*.md | wc -l)" -ge 2

echo "5/15 pipeline with relative .ts helper + package from its own node_modules + embedded zod fallback"
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

echo "6/15 the project's own zod wins over the embedded one (per-import resolution)"
mkdir -p node_modules/zod
echo '{"name":"zod","version":"3.0.0","type":"module","main":"index.js"}' > node_modules/zod/package.json
cat > node_modules/zod/index.js <<'JS'
export const z = { string: () => ({ parse: (v) => `project:${v}` }) }
JS
rm -rf .mt/runs
run run ./pipelines/third.ts >/dev/null
test "$(cat proof.txt)" = "helper:a|dep:b|project:c"
rm -rf node_modules/zod

echo "7/15 package whose entry point is in a subdirectory resolves"
mkdir -p node_modules/subpkg/lib
echo '{"name":"subpkg","version":"1.0.0","type":"module","main":"lib/index.js"}' > node_modules/subpkg/package.json
echo 'export const v = "subpkg"' > node_modules/subpkg/lib/index.js
cat > pipelines/subpkg.ts <<'TS'
import { writeFileSync } from 'node:fs'
import { definePipeline } from 'mt'
import 'mt/waypoint'
import { v } from 'subpkg'

export default definePipeline()
  .from('jsonl://./jsonl/*.jsonl')
  .tap(async () => { writeFileSync('subpkg.txt', v) })
TS
rm -rf .mt/runs
run run ./pipelines/subpkg.ts >/dev/null
test "$(cat subpkg.txt)" = "subpkg"

echo "8/15 missing package and native addon fail with the binary's limitation hint"
cat > pipelines/missing.ts <<'TS'
import { definePipeline } from 'mt'
import 'mt/waypoint'
import { v } from 'definitely-not-installed'

export default definePipeline()
  .from('jsonl://./jsonl/*.jsonl')
  .tap(async () => { console.log(v) })
TS
set +e
MISSING_OUT="$(run run ./pipelines/missing.ts 2>&1)"
MISSING_RC=$?
set -e
test "$MISSING_RC" -ne 0
printf '%s' "$MISSING_OUT" | grep -q "definitely-not-installed"
printf '%s' "$MISSING_OUT" | grep -q "not supported by the binary"

# A compiled addon (`.node`) is resolvable but not loadable: the raw Bun error ("To load Node-API
# modules, use require()" / "invalid ELF header") does not say the binary cannot do it.
mkdir -p node_modules/fake-addon/build/Release
echo '{"name":"fake-addon","version":"1.0.0","main":"build/Release/addon.node"}' \
  > node_modules/fake-addon/package.json
printf '\177ELF\002\001\001' > node_modules/fake-addon/build/Release/addon.node
cat > pipelines/addon.ts <<'TS'
import { definePipeline } from 'mt'
import 'mt/waypoint'
import addon from 'fake-addon'

export default definePipeline()
  .from('jsonl://./jsonl/*.jsonl')
  .tap(async () => { console.log(addon) })
TS
set +e
ADDON_OUT="$(run run ./pipelines/addon.ts 2>&1)"
ADDON_RC=$?
set -e
test "$ADDON_RC" -ne 0
printf '%s' "$ADDON_OUT" | grep -q "Native addons are not supported by the \`mt\` binary"

echo "9/15 token counter runs in the binary (tiktoken wasm -> gpt-tokenizer shim)"
mkdir -p jsonl-text
printf '%s\n' '{"item":"Hello world, this is a test of the token counter."}' > jsonl-text/in.jsonl
cat > pipelines/tokens.ts <<'TS'
import { definePipeline } from 'mt'
import { tokenCounter } from 'mt/tools'
import 'mt/waypoint'

export default definePipeline()
  .from('jsonl://./jsonl-text/*.jsonl')
  .use(tokenCounter)
TS
rm -rf .mt/runs
run run ./pipelines/tokens.ts >/dev/null

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

start_router() { # $1 = log file ; sets ROUTER_PID and RBASE
  : > "$1"
  env -i HOME="$WORK" PATH="$SAFE_PATH" "$BIN" router --mock --port 0 --host 127.0.0.1 >"$1" 2>&1 &
  ROUTER_PID=$!
  PIDS="$PIDS $ROUTER_PID"
  RBASE=""
  for _ in $(seq 1 50); do
    RBASE="$(grep -o 'http://127\.0\.0\.1:[0-9]*' "$1" | head -1 || true)"
    [ -n "$RBASE" ] && break
    kill -0 "$ROUTER_PID" 2>/dev/null || { cat "$1"; echo "router exited early"; exit 1; }
    sleep 0.2
  done
  [ -n "$RBASE" ] || { cat "$1"; echo "router did not start"; exit 1; }
}

echo "10/15 mt serve: health, runs API, SQLite, SSE, UI, pause/resume"
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
# the events endpoint streams, so read it with a timeout instead of piping into grep
EVENTS="$(curl -sf --max-time 2 "$BASE/api/runs/smoke-run/events" || true)"
echo "$EVENTS" | grep -q 'event: started'
# SSE stream mode stays open: connect, expect the replayed event, then time out.
# The timeout exit code differs between curl builds (28 on glibc, 23 on alpine), so only the
# failure and the replayed event are asserted.
set +e
SSE="$(curl -sN --max-time 2 "$BASE/api/runs/smoke-run/events?stream=true")"
RC=$?
set -e
test "$RC" -ne 0
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

echo "11/15 mt serve --detach (re-execs the binary), then stop via pid file"
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

echo "12/15 mt router --help is documented"
run router --help | grep -q "Usage: mt router"
run --help | grep -q "Start LLM router proxy"

echo "13/15 mt router --mock: proxy API, dashboard JSON and embedded assets (no network, no keys)"
start_router router.log
curl -sf "$RBASE/api/health" | grep -q '"mockMode":true'
curl -sf -X POST -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}' \
  "$RBASE/api/chat/completions" | grep -q 'Mock response from Mt Router'
curl -sf -X POST -H 'content-type: application/json' -d '{"text":"hello","targetLang":"fr"}' \
  "$RBASE/api/translate" | grep -q '\[MOCK\] hello'
curl -sf "$RBASE/api/dashboard" | grep -q '"budgetLimit"'
curl -sf "$RBASE/api/pool" | grep -q '"mockMode":true'
curl -sf "$RBASE/api/logs" | grep -q '"entries"'
curl -sf "$RBASE/api/translate/health" | grep -q '"availableClients"'
curl -sf "$RBASE/api/translate/config" | grep -q '"supportedLanguages"'
curl -sf "$RBASE/" | grep -q '<div id="app'   # the dashboard div carries a class
curl -sf "$RBASE/app.js" | grep -q 'useDashboard'
test "$(curl -s -o /dev/null -w '%{http_code}' "$RBASE/api/nope")" = 404
kill "$ROUTER_PID"
for _ in $(seq 1 25); do kill -0 "$ROUTER_PID" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$ROUTER_PID" 2>/dev/null; then echo "router did not stop on SIGTERM"; exit 1; fi

echo "14/15 mt router --detach (re-execs the binary), then stop via pid file"
rm -rf .mt/router
run router --detach --mock --port 0 --host 127.0.0.1 | grep -q "Router PID"
RPID="$(cat .mt/router/pid)"
PIDS="$PIDS $RPID"
RDBASE=""
for _ in $(seq 1 50); do
  RDBASE="$(grep -o 'http://127\.0\.0\.1:[0-9]*' .mt/router/server.log 2>/dev/null | head -1 || true)"
  [ -n "$RDBASE" ] && break
  sleep 0.2
done
[ -n "$RDBASE" ] || { cat .mt/router/server.log; echo "detached router did not start"; exit 1; }
curl -sf "$RDBASE/api/health" | grep -q '"mockMode":true'
kill "$RPID"
for _ in $(seq 1 25); do kill -0 "$RPID" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$RPID" 2>/dev/null; then echo "detached router did not stop"; exit 1; fi

echo "15/15 no stray processes"
for p in $PIDS; do if kill -0 "$p" 2>/dev/null; then echo "leaked pid $p"; exit 1; fi; done

echo "smoke OK"
