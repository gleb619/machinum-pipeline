#!/usr/bin/env bash
# Pre-merge CI guard: validate GitHub workflows and run what wrkflw can faithfully run in Docker.
# Usage: scripts/wrkflw-guard.sh [--quick] [--all] [--jobs "a b"]   (pnpm ci:local | pnpm ci:check)
# --quick: `wrkflw validate` only (no Docker, seconds) -- fast loop while editing workflows, NOT the merge gate.
# Env:   WRKFLW_JOBS        space-separated ci.yml jobs to run in Docker (default: skill-drift)
#        WRKFLW_GUARD_ALL=1 same as --all: run every ci.yml job (heavy; most fail under wrkflw today)
#        WRKFLW_GUARD_SKIP=1 loud opt-out (only when wrkflw/docker truly cannot run; say so in merge note)
# See docs/change-workflow.md ("wrkflw guard") for what wrkflw can and cannot emulate.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

WORKFLOW=.github/workflows/ci.yml
JOBS="${WRKFLW_JOBS:-skill-drift}"
ALL="${WRKFLW_GUARD_ALL:-0}"
QUICK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --all) ALL=1 ;;
    --jobs) shift; JOBS="${1:?--jobs needs a value}" ;;
    -h | --help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "wrkflw-guard: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "${WRKFLW_GUARD_SKIP:-0}" = "1" ]; then
  echo "wrkflw-guard: !!! SKIPPED via WRKFLW_GUARD_SKIP=1 -- guard NOT run; merge note must say so !!!" >&2
  echo "wrkflw-guard: SKIPPED (not green)"
  exit 0
fi

fail() { echo "wrkflw-guard: FAIL: $*" >&2; exit 1; }

command -v wrkflw > /dev/null 2>&1 \
  || fail "wrkflw not found on PATH. Install: https://github.com/bahdotsh/wrkflw/releases (musl binary -> ~/.local/bin)"
[ "$QUICK" = "1" ] || command -v docker > /dev/null 2>&1 || fail "docker not found on PATH (wrkflw runs jobs in Docker)"
[ "$QUICK" = "1" ] || docker info > /dev/null 2>&1 || fail "docker daemon unreachable (start docker / check permissions)"

if [ "$ALL" = "1" ]; then
  JOBS="$(sed -n '/^jobs:/,$ s/^  \([a-z][a-z0-9_-]*\):[[:space:]]*$/\1/p' "$WORKFLOW" | tr '\n' ' ')"
fi

SUMMARY=""
start=$SECONDS
step() { # name cmd...
  local name=$1 t=$SECONDS
  shift
  echo "wrkflw-guard: >>> $name"
  if "$@"; then
    SUMMARY="$SUMMARY $name=ok($((SECONDS - t))s)"
  else
    SUMMARY="$SUMMARY $name=FAIL($((SECONDS - t))s)"
    FAILED=1
  fi
}
FAILED=0

step validate wrkflw validate

if [ "$QUICK" = "1" ]; then
  JOBS=""
fi

for job in $JOBS; do
  step "job:$job" wrkflw run --runtime docker --job "$job" "$WORKFLOW"
done

# Faithful stand-ins for ci.yml jobs wrkflw's bare ubuntu image cannot run (no shellcheck/docker-in-docker).
run_shellcheck() {
  local files=(docs/install.sh docker/entrypoint.sh)
  if command -v shellcheck > /dev/null 2>&1; then
    shellcheck -s sh "${files[@]}" && shellcheck -s bash scripts/wrkflw-guard.sh
  else
    docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable -s sh "${files[@]}" \
      && docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable -s bash scripts/wrkflw-guard.sh
  fi
}
if [ "$QUICK" != "1" ]; then
  step shellcheck run_shellcheck
  step hadolint bash -c 'docker run --rm -i hadolint/hadolint:v2.12.0 < Dockerfile'
fi

mode=full
[ "$QUICK" = "1" ] && mode=quick
line="wrkflw-guard[$mode]:$SUMMARY total=$((SECONDS - start))s"
if [ "$FAILED" = "1" ]; then
  echo "$line RESULT=RED" >&2
  exit 1
fi
echo "$line RESULT=GREEN"
