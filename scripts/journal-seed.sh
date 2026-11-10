#!/usr/bin/env bash
# Seed the project journal from the repo's own notes.
#
#   scripts/journal-seed.sh             # write/update every page
#   scripts/journal-seed.sh --dry-run   # print what it would write
#
# The journal is the place for what a session *learned*; the repo docs are the place for what
# the code *is*. Seeding copies the second into the first only where the file is small enough
# to be a page and stable enough to be worth recalling verbatim (rules, the domain model, the
# doc map). The four large reference files — steering/tools.md (124 KB), core.md (54 KB),
# cli.md (31 KB), router.md (19 KB) — are deliberately NOT seeded: grep them, do not recall
# them, and they change under the journal's feet. `navigation.md` says so.
#
# Requires the stack in deploy/memory/ to be running: `write-page` is an HTTP call, not a
# local write. Idempotent: a page is upserted by path.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MEMORY="$REPO/scripts/memory.sh"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# source file | wiki page | kind | tags
PAGES=(
  "AGENTS.md|projects/machinum-pipeline/agents-rules.md|rule|agents,rules,workflow,memory"
  "docs/README.md|projects/machinum-pipeline/docs-map.md|reference|docs,map,layout"
  "docs/change-workflow.md|projects/machinum-pipeline/change-workflow.md|rule|workflow,commits,guard,merge"
  "docs/steering/product.md|projects/machinum-pipeline/product.md|reference|domain,exchange,flow"
  "docs/steering/structure.md|projects/machinum-pipeline/structure.md|reference|packages,imports,uris"
  "docs/steering/tech.md|projects/machinum-pipeline/tech.md|reference|toolchain,biome,tests,env"
  "docs/steering/tui.md|projects/machinum-pipeline/tui.md|reference|tui,http,admin-api"
  "docs/steering/mcp.md|projects/machinum-pipeline/mcp.md|reference|mcp,tools,server"
  "docs/steering/extensions.md|projects/machinum-pipeline/extensions.md|reference|chrome,vscode,extension"
  "docs/layout.md|projects/machinum-pipeline/layout.md|reference|ui,components,tui-contract"
)

NAVIGATION=$(cat <<'MD'
# Where to look in this repo, and what not to read whole

The journal holds what previous sessions learned. The repo holds what the code is. When the
two disagree about a file's contents, the file wins — this page is a map, not a copy.

## Read on demand, never recall

| File | Size | Why not a page |
| --- | --- | --- |
| `docs/steering/tools.md` | ~124 KB | one section per tool; grep for the tool's name, read that section only |
| `docs/steering/core.md` | ~54 KB | the DSL/engine types; grep the symbol you need |
| `docs/steering/cli.md` | ~31 KB | command surface; `mt <cmd> --help` is faster |
| `docs/steering/router.md` | ~19 KB | OpenRouter proxy; only relevant inside `packages/router` |
| `docs/steering/webui.md` | ~15 KB | admin API/SSE; only relevant inside `packages/webui` |

## Seeded here (small, stable, worth recalling)

`agents-rules.md`, `docs-map.md`, `change-workflow.md`, `product.md`, `structure.md`,
`tech.md`, `tui.md`, `mcp.md`, `extensions.md`, `layout.md`.

## Not documentation at all

- The board is `at kanban` (and `docs/kanban.md` is a generated mirror, uncommitted).
- Plans live in `docs/plans/` while they are live; a finished plan's *decision* belongs here.
- Samples are `samples/` + `docs/guiding/samples.md`; they are executable documentation.
MD
)

if [ "$DRY_RUN" -eq 1 ]; then
  for entry in "${PAGES[@]}"; do
    IFS='|' read -r src page kind tags <<<"$entry"
    printf 'would write %-52s <- %-28s (%s bytes, kind=%s)\n' \
      "$page" "${src}" "$(wc -c <"$REPO/$src")" "$kind"
  done
  printf 'would write %-52s <- %-28s (%s bytes, kind=%s)\n' \
    "projects/machinum-pipeline/navigation.md" "(generated)" "${#NAVIGATION}" "reference"
  exit 0
fi

for entry in "${PAGES[@]}"; do
  IFS='|' read -r src page kind tags <<<"$entry"
  if [ ! -f "$REPO/$src" ]; then
    echo "journal-seed: missing $src — a seeded doc moved; fix the table in $0" >&2
    exit 2
  fi
  "$MEMORY" write "$page" "$kind" "$tags" <"$REPO/$src"
done

printf '%s\n' "$NAVIGATION" | "$MEMORY" write \
  "projects/machinum-pipeline/navigation.md" reference "navigation,docs,sizes"

echo "journal-seed: $(( ${#PAGES[@]} + 1 )) pages in the journal"
