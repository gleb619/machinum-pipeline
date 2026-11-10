# Project memory: a journal the next session reads instead of rediscovering

Long sessions here end with knowledge that exists only in a transcript: why the router
retries the way it does, which Biome rule fights the TS config, what a checkpoint actually
contains, how many seconds the sample suite really takes. The next agent re-derives it, or
guesses. This is the store for it.

## What is running

| | |
| --- | --- |
| Service | [ai-memory](https://github.com/akitaonrails/ai-memory) 3.4.4, `akitaonrails/ai-memory` |
| Container | **1** — `mt-memory` (embedded store, markdown wiki, no database container) |
| Port | `127.0.0.1:49375` — HTTP API, MCP at `/mcp`, browser at `/web`, health at `/healthz` |
| Storage | `deploy/memory/data/` (bind mount), wiki as plain markdown under `data/wiki/` |
| Cost of a write | zero LLM calls, zero API keys |
| Compose | `deploy/memory/docker-compose.yml` |
| Scope | workspace `default`, project `machinum-pipeline` |

```bash
cd deploy/memory
cp .env.example .env
docker run --rm akitaonrails/ai-memory:3.4.4 generate-auth-token   # paste into .env
mkdir -p data && docker compose up -d
curl -s localhost:49375/healthz            # {"status":"ok"}
cd ../.. && scripts/journal-seed.sh        # ~11 pages from the repo's own docs
```

`data/` must be writable by uid 1000 (the image's user, normally you). If Docker created the
empty directory as root, delete it and make it yourself before the first `up` — otherwise the
container dies with `Permission denied: opening serve lock /data/.serve.lock`.

## Isolated from the other project journals, on purpose

`machinum-sft` runs its own copy of this stack (`msft-memory`, `:49374`). They are two
independent instances:

| | this repo | machinum-sft |
| --- | --- | --- |
| container | `mt-memory` | `msft-memory` |
| port | 49375 | 49374 |
| volume | `deploy/memory/data/` | `deploy/memory/data/` (its own) |
| token | `deploy/memory/.env` | its own |
| project | `machinum-pipeline` | `data` |

Nothing is shared, so a page about the translation pipeline can never surface while someone
works on the fine-tune, and one stack can be down without touching the other. Backup is
`cp -a deploy/memory/data/`; version control, if wanted, is `git init deploy/memory/data/wiki`.

## Using it

```bash
scripts/memory.sh status                    # health, page counts
scripts/memory.sh briefing 12               # most recently updated pages — do this first
scripts/memory.sh query "checkpoint resume" 8
scripts/memory.sh read projects/machinum-pipeline/tech.md
scripts/memory.sh write projects/machinum-pipeline/<slug>.md decision "routing,cost" < note.md
```

The client is a thin `curl` wrapper (bash + `jq`), so it works for every agent — native
subagents, `at` agents in a worktree, a bare shell — without MCP wiring.

## What belongs in it

| Write a page | Keep it in the repo instead |
| --- | --- |
| a decision **and the alternative it rejected**, with the reason | code, types, file-by-file layout (`docs/steering/`) |
| a trap as symptom → cause → fix, with the command that proves it | a how-to that a new contributor needs (commit it) |
| measured numbers: timings, token counts, memory, file sizes | transient state: what is in progress, what is next (`at kanban`) |
| a link plus the one sentence saying why it matters | secrets, tokens, transcripts, personal data |

Rules of thumb:

- **One page per idea.** `projects/machinum-pipeline/<slug>.md`, `kind` = `decision` |
  `gotcha` | `rule` | `fact` | `reference` | `note`, tags are lowercase and comma-separated.
- **Query before writing.** Update the same path rather than adding a near-duplicate; the
  store is an upsert by path, and a second page on the same topic splits the recall.
- **A page is not a log.** If it reads like a diary of the session, it belongs in the session
  summary or `docs/plans/`, not here.
- `scripts/journal-seed.sh` re-seeds the repo-derived pages by path; editing those in the
  wiki is pointless — change the source doc and re-seed.

## Failure modes seen so far

- **Wrong project name is silent.** The API accepts any `workspace`/`project` and happily
  creates an empty scope, so a typo looks like a healthy server with zero pages. The client
  pins both; if `status` shows 0 pages while `briefing` shows some, something passed its own
  scope.
- **Pinned image.** `latest` broke the sibling stack once. Bump deliberately and re-check
  `/admin/status` (`counts.pages_*`) after the upgrade.
- **Loopback only.** The container binds `127.0.0.1`; do not proxy it, do not open it to the
  LAN. The token in `.env` is the only thing standing between a port scan and your journal.
