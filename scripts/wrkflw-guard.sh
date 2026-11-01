#!/usr/bin/env bash
# Pre-merge CI guard: validate GitHub workflows and run what wrkflw can faithfully run in Docker.
# Usage: scripts/wrkflw-guard.sh [--quick] [--all] [--jobs "a b"]   (pnpm ci:local | pnpm ci:check)
# --quick: `wrkflw validate` only (no Docker, seconds) -- fast loop while editing workflows, NOT the merge gate.
# Also runs actionlint (local binary, else rhysd/actionlint in Docker); shellcheck/hadolint cmds are parsed from ci.yml.
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
    --jobs)
      [ $# -ge 2 ] || { echo "wrkflw-guard: --jobs needs a value" >&2; exit 2; }
      JOBS="$2"
      shift
      ;;
    -h | --help) sed -n "2,10p" "$0"; exit 0 ;;
    *) echo "wrkflw-guard: unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "${WRKFLW_GUARD_SKIP:-0}" = "1" ]; then
  echo "wrkflw-guard: !!! SKIPPED via WRKFLW_GUARD_SKIP=1 -- guard NOT run; merge note must say so !!!" >&2
  echo "wrkflw-guard: RESULT=SKIPPED (NOT green)"
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

read -r -a JOB_LIST <<< "$JOBS"
for job in ${JOB_LIST[@]+"${JOB_LIST[@]}"}; do
  step "job:$job" wrkflw run --runtime docker --job "$job" "$WORKFLOW"
done

# Faithful stand-ins for ci.yml jobs wrkflw's bare ubuntu image cannot run (no shellcheck/docker-in-docker).
# Commands/flags/image tags are DERIVED from ci.yml so the guard cannot drift from CI.
ci_step_run() { # job -> first single-line `run:` of that job
  sed -n "/^  $1:/,/^  [a-z][a-z0-9_-]*:/ s/^ *run: \\([^|>].*\\)$/\\1/p" "$WORKFLOW" | head -1
}
sc_docker() { docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable "$@"; }
run_shellcheck() {
  local cmds cmd
  cmds="$(ci_step_run shellcheck)"
  [ -n "$cmds" ] || { echo "wrkflw-guard: cannot derive shellcheck cmd from $WORKFLOW" >&2; return 1; }
  case "$cmds" in *shellcheck*) ;; *) echo "wrkflw-guard: derived cmd is not shellcheck: $cmds" >&2; return 1 ;; esac
  while IFS= read -r cmd; do
    local -a args
    read -r -a args <<< "${cmd#shellcheck }"
    echo "wrkflw-guard: shellcheck ${args[*]}"
    if command -v shellcheck > /dev/null 2>&1; then shellcheck "${args[@]}"; else sc_docker "${args[@]}"; fi || return 1
  done < <(printf '%s\n' "${cmds// && /$'\n'}")
}
run_hadolint() {
  local img
  img="$(grep -o 'hadolint/hadolint:[^ ]*' "$WORKFLOW" | head -1)"
  [ -n "$img" ] || { echo "wrkflw-guard: cannot derive hadolint image from $WORKFLOW" >&2; return 1; }
  docker run --rm -i "$img" < Dockerfile
}
# wrkflw validate misses unknown keys / bad ${{ }} expressions; actionlint catches them.
run_actionlint() {
  if command -v actionlint > /dev/null 2>&1; then
    actionlint -color=false .github/workflows/*.yml
  else
    docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 -color=false .github/workflows/ci.yml .github/workflows/release.yml
  fi
}
if [ "$QUICK" != "1" ]; then
  step actionlint run_actionlint
  step shellcheck run_shellcheck
  step hadolint run_hadolint
elif command -v actionlint > /dev/null 2>&1; then
  step actionlint run_actionlint
fi

mode=full
[ "$QUICK" = "1" ] && mode=quick
line="wrkflw-guard[$mode]:$SUMMARY total=$((SECONDS - start))s"
if [ "$FAILED" = "1" ]; then
  echo "$line RESULT=RED" >&2
  exit 1
fi
echo "$line RESULT=GREEN"
