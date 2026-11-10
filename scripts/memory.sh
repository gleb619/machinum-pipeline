#!/usr/bin/env bash
# Project memory client for machinum-pipeline (ai-memory, loopback :49375).
#
#   scripts/memory.sh status                 # health + page counts
#   scripts/memory.sh briefing [N]           # N most recently updated pages (session start)
#   scripts/memory.sh query "text" [N]       # ranked search with snippets
#   scripts/memory.sh read <path>            # full page body
#   scripts/memory.sh write <path> <kind> [tags] < note.md
#
# Every call is one HTTP request to a loopback port. The journal is ISOLATED from
# machinum-sft's (:49374) on purpose: different container, volume, token and project, so a
# page written here can never be retrieved there, and vice versa.
#
# Env: AI_MEMORY_URL (default http://127.0.0.1:49375)
#      AI_MEMORY_WORKSPACE (default: default), AI_MEMORY_PROJECT (default: machinum-pipeline)
#      AI_MEMORY_ENV_FILE (default: deploy/memory/.env)
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${AI_MEMORY_ENV_FILE:-$REPO/deploy/memory/.env}
URL=${AI_MEMORY_URL:-http://127.0.0.1:49375}
WORKSPACE=${AI_MEMORY_WORKSPACE:-default}
PROJECT=${AI_MEMORY_PROJECT:-machinum-pipeline}
SCOPE="workspace=$WORKSPACE&project=$PROJECT"

die() { echo "memory: $*" >&2; exit 2; }
enc() { jq -rn --arg v "$1" '$v|@uri'; }

token() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE — cp deploy/memory/.env.example deploy/memory/.env and paste a token"
  local t
  t=$(grep -m1 '^AI_MEMORY_AUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)
  [ -n "$t" ] || die "$ENV_FILE has no AI_MEMORY_AUTH_TOKEN"
  printf '%s' "$t"
}

up_check() {
  curl -fsS -m 5 "$URL/healthz" >/dev/null 2>&1 \
    || die "$URL is not answering — (cd deploy/memory && docker compose up -d)"
}

cmd_status() {
  up_check
  printf 'health   %s\n' "$(curl -fsS -m 5 "$URL/healthz")"
  curl -fsS -m 20 -H "Authorization: Bearer $(token)" "$URL/admin/status?$SCOPE" \
    | jq -r '"version  \(.version)\npages    \(.counts.pages_latest) latest / \(.counts.pages_all) all\ndata     \(.data_dir)"'
}

cmd_briefing() {
  local n=${1:-12}
  up_check
  curl -fsS -m 20 -H "Authorization: Bearer $(token)" \
    "$URL/admin/recent?$SCOPE&limit=$n" \
    | jq -r 'if length == 0 then "(journal is empty — scripts/journal-seed.sh)" else
        .[] | "\(.updated_at[0:10])  \(.path)\n            \(.title)" end'
}

cmd_query() {
  local text=${1:-} n=${2:-8}
  [ -n "$text" ] || die 'query needs text: scripts/memory.sh query "checkpoint resume"'
  up_check
  curl -fsS -m 20 -H "Authorization: Bearer $(token)" \
    "$URL/admin/search?$SCOPE&limit=$n&q=$(enc "$text")" \
    | jq -r 'if length == 0 then "(no hits)" else
        .[] | "\(.path) — \(.title)\n    \(.snippet | gsub("<mark>|</mark>"; ""))" end'
}

cmd_read() {
  local path=${1:-}
  [ -n "$path" ] || die 'read needs a page path: scripts/memory.sh read projects/machinum-pipeline/tech.md'
  up_check
  curl -fsS -m 20 -H "Authorization: Bearer $(token)" \
    "$URL/admin/read-page?$SCOPE&path=$(enc "$path")" | jq -r '.body'
}

cmd_write() {
  local path=${1:-} kind=${2:-note} tags=${3:-}
  [ -n "$path" ] || die 'write needs <path> <kind> [tags], with the body on stdin'
  local body
  body=$(cat)
  [ -n "$body" ] || die 'write: empty body on stdin'
  # The store requires a markdown title; take the path's name when the caller forgot one.
  if [ "$(printf '%s\n' "$body" | head -1 | cut -c1-2)" != "# " ]; then
    body=$(printf '# %s\n\n%s' "$(basename "$path" .md)" "$body")
  fi
  up_check
  local payload
  payload=$(jq -n --arg ws "$WORKSPACE" --arg pr "$PROJECT" --arg p "$path" \
    --arg k "$kind" --arg t "$tags" --arg b "$body" \
    '{workspace: $ws, project: $pr, path: $p, kind: $k,
      tags: ($t | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))),
      body: $b}')
  printf '%s' "$payload" | curl -fsS -m 25 -X POST \
    -H "Authorization: Bearer $(token)" -H 'Content-Type: application/json' \
    --data-binary @- "$URL/admin/write-page" >/dev/null
  printf 'wrote %s (%s)\n' "$path" "$kind"
}

case "${1:-}" in
  status) shift; cmd_status "$@" ;;
  briefing) shift; cmd_briefing "$@" ;;
  query | search) shift; cmd_query "$@" ;;
  read | cat) shift; cmd_read "$@" ;;
  write) shift; cmd_write "$@" ;;
  -h | --help) sed -n '2,17p' "$0" ;;
  *) die "unknown command: ${1:-} (status|briefing|query|read|write)" ;;
esac
