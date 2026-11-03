---
name: mt
description: Use when a project contains mt.json, a .mt/ directory or pipelines/*.ts built with `definePipeline`, or when the user asks to build, run, resume, debug or test a machinum-pipeline (`mt`) ETL pipeline for long-form text (books, chapters, translation), manage LLM secrets in the mt vault (embed/vlt/keepass refs, master key), start `mt serve` / `mt router`, or install this skill with `mt skill`.
---
<!-- skill-version: 1.14.0 | 2026-11-03 -->
<!-- last reviewed against: packages/cli (commands, index.ts), packages/core (annotation, dsl, config, vault, engine), packages/waypoint (URI schemes), packages/tools (llm-picker, mock LLM, splitters), docs/guiding/{lifecycle,vault,installation,mock-tools}.md, docs/steering/{cli,core,waypoint,tools}.md -->

# mt (machinum-pipeline) for coding agents

`mt` is a TypeScript ETL engine for long-form text. Data flows
`Source (URI) -> [Tool -> Tool -> ...] -> Target (URI)`, every step is checkpointed, and a failed or
paused run resumes where it stopped. Pipelines are ordinary TS modules.

Check the binary first: `mt --version`. On Linux `/usr/bin/mt` is the tape tool, not this one. If
`mt --help` prints tape usage, use the wrapper name (`mt-cli`) or the full path to the binary.

## Project layout

```
mt.json              project config (committed)
mt.local.json        optional, gitignored; pulled in via "imports": ["./mt.local.json"]
.env                 secrets.envFile (gitignored); process.env always wins over it
pipelines/*.ts       pipeline modules (default export = the pipeline)
.mt/                 state dir (gitignored)
  runs/<runId>/      state.json, context.json, events.jsonl, run.log, logs/, dead-letter.jsonl, artifacts/
  cache/             content-hash memo for cacheable tools
  vault.json         vault entries (refs only, never plaintext keys)
  master.key         master key for the embedded secret store (0600, gitignored, back it up)
```

`mt init` scaffolds `mt.json`, `.mt/`, `.gitignore` entries and `.mt/master.key`.

`mt.json` keys you will touch: `project.name`, `pipelines[]`, `uris{}` (named aliases),
`settings.llm.{tool,model,use}`, `settings.constants.<NAME>` (tunable overrides, below), `secrets.envFile`,
`imports[]`, `defaults.{retry,onError,concurrency}`,
`scripts.{install,start,end,stop,exit,resume,error}` (paths to hook pipelines), `router.port`.

## Pipeline DSL

```ts
import { definePipeline } from 'mt'          // legacy: '@mt/core'
import { chapterDoc } from 'mt/tools'        // legacy: '@mt/tools'
import 'mt/waypoint'                         // REQUIRED side effect: registers URI schemes

export default definePipeline({ id: 'translate', retry: { max: 3, backoffMs: 1000, strategy: 'exp' }, onError: 'fail-run' })
  .from('jsonl://./input/*.jsonl')           // Source: URI string (preferred) or instance
  .flatMap(async (item) => [item])           // 1 -> N
  .subflow('#paragraphs')                    // 1 -> N; same as 'paragraphs://' (bare 'paragraphs' is rejected)
  .subflow('#chunks', 'ladder')              // 1 -> N + auto-publish into chunks://ladder
  .tap(async (ex) => console.log(ex.id))     // observe full Exchange, stream unchanged
  .log('debug')                              // sugar over .tap(): logs '[debug] <id> <item>'
  .use(chapterDoc, { onError: 'skip-item' }) // Tool step; per-step retry/onError override
  .batch(5)                                  // group into items[] (default size 5; flushes remainder)
  .batch({ size: 3, slide: true })           // sliding windows (overlapping)
  .batch(scopePipeline)                      // packages of 5 run through a nested scope (batch://group|members|return)
  .subflow(otherPipeline)                    // inline nested pipeline, same Runner
  .fork(childPipeline)                       // sequential: child Runner per envelope
  .fork('views', [branchA, branchB])         // parallel: branches per envelope, deterministic merge
  .to('md://./out')                          // Target
```

- Data carrier is the Exchange `{ id, item, items?, meta, variables }`. Cardinality changes ONLY via
  `.batch/.flatMap`, or the string form `.subflow('<splitter>', '<namespace>?')`
  (`'paragraphs://'`, `'#paragraphs'`, or a buffer URI like `'paragraphs://ladder'`; the same
  spellings work for `chunks`, `paragraphs`, `lines`, `words`, `tokens` and `series`) which
  resolves a registered splitter and fans out 1 -> N. When the splitter scheme is an entity
  buffer (`chapters`, `paragraphs`, `chunks`, `tokens`, `lines`, `words`, `batches`), the
  produced envelopes are also auto-published into `<scheme>://<namespace>` for the next stage;
  the namespace is the optional second argument and defaults to `default` (`chunks://` ==
  `chunks://default`). `series` has no buffer. Import `mt/tools` (or any `@mt/tools` symbol) to
  register `chunks`, `paragraphs`, `lines`, `words`, `tokens` and `series`. Bare `'paragraphs'`
  is rejected.
  The `series` splitter parses chapter markdown, emits numbered `ChapterDoc` parts with `series`
  frontmatter only when the chapter is large enough, and otherwise returns the original markdown
  as one unchanged item. Its size threshold is the tunable `SERIES_SPLIT_TARGET_CHARS` (see
  below). The `chunks` splitter parses chapter markdown into core `Chunk` entities using the
  chunk-size chain (`MT_CHUNK_SIZE`). Source ids are stable; the engine never mints them.
- Use `.fork()` for per-envelope child-Runner nesting, **not** for splitting: a split is an inline
  transformation of the current stream. `.fork(pipeline)` runs the child sequentially per envelope.
  `.fork(name, [branchA, branchB])` runs every branch concurrently per envelope via real
  `Promise.allSettled`, each on an isolated deep-cloned envelope, with one checkpoint node per
  parent/branch and a deterministic declaration-order merge; a branch failure fails the run after
  all branches settle.
- `onError`: `fail-run` (default) | `skip-item` | `dead-letter` (-> `.mt/runs/<id>/dead-letter.jsonl`).
- Pipelines are real modules: plain `import`, `console.log`, conditionals work. No build step.
- `id` defaults to the file name. `mt resume` refuses with `pipelineId mismatch` if it changed.

### URI schemes (from `mt/waypoint`)

| URI | Use |
|---|---|
| `jsonl://./f.jsonl` | JSON lines; source accepts globs; each line `{ "item": ... }` |
| `md://./dir` or `md://./f.md` | Markdown files / single file; source `?split=chunks\|paragraphs\|lines` fans each file out with that registered splitter; target `?series=true` runs the registered `series` splitter before writing (same as `.subflow('#series')`) |
| `chapter://./en/` | language-folder chapter layout |
| `hs://http://...` | HTTP source |
| `schema-doc://`, `git://`, `range://`, `void://` | schema docs, git worktree wrapper, range source, discard target |
| `console://?format=auto&prefix=…&envelope=true&stream=stderr` | terminal target sink; `format` = `auto`/`json`/`pretty`, optional prefix/envelope/stream; target-only |
| `chunks://<ns>` … `words://<ns>` | typed ladder buffers, source-only; fill with `.subflow('#chunks', 'ladder')` and read with `.from('chunks://ladder')` (omitted ns = `default`) |
| `@name` | alias from `mt.json` `"uris": { "en": "md://./chapters/en" }` -> `.to('@en')` |

Custom steps: a Tool is `{ name, version, invoke(exchange, ctx), cacheable? }`; set `cacheable: true`
for content-hash memoization in `.mt/cache/`. Use `defineWaypoint` for custom Sources/Targets.

### Runtime annotations

One mechanism, four sealed kinds: `tool` (`TL###`), `waypoint` (`WT###`), `useCase` (`UC###`)
carry an ID; `category([...])` carries a non-empty list of lowercase kebab-case names
(e.g. `category(['validator', 'markdown'])`). Annotations are frozen records attached to runtime
values; the annotated value's shape does not change. `annotations` is **optional** on `defineTool` —
user-defined tools may omit it entirely.

```ts
import {
  annotate,
  annotationsOf,
  category,
  defineTool,
  listAnnotations,
  tool,
  useCase,
  waypoint,
} from 'mt'

const myTool = defineTool({
  name: 'chapter-validator',
  version: '1.0.0',
  mdDescription: '…',
  invoke: async (ex) => ex,
  // optional: user tools may omit `annotations` entirely
  annotations: [
    tool('TL200', { refs: ['UC055'] }),
    useCase('UC055'),
    category(['validator', 'markdown']),
  ],
})

annotate(myWaypointFactory, waypoint('WT900', { meta: { schemes: ['mine'], direction: 'source' } }))

annotationsOf(myTool)            // annotations on one value
listAnnotations('useCase')       // process-wide registry, optionally filtered by kind
```

- `annotate(target, ...annotations)` returns the same value; at most one annotation per kind.
- `tool(id, spec?)`, `waypoint(id, spec?)`, `useCase(id, spec?)` validate the ID (`^PREFIX\d{3,}$`)
  and freeze the record. `category([...], spec?)` takes a non-empty list of lowercase kebab-case
  names (deduped, frozen) and has no `id`. `spec` accepts `name`, `description`, `refs` and `meta`.
- `annotationsOf(target)` reads the annotations on one value; `listAnnotations(kind?)` reads the
  process-wide registry. Use-case IDs may repeat across implementations; tool/waypoint IDs should
  be unique. `annotationOf(target, 'category')` narrows to the category record.

## CLI

All commands run from the project root. Exit code 0 ok, 1 error/usage (messages on stderr).

| Command | What it does |
|---|---|
| `mt init [--settings <json>\|-s] [--force] [--no-master-key]` | scaffold project; `--settings` also writes `pipelines/example.ts`; `--force` overwrites |
| `mt run <pipeline.ts>` | run in foreground; runs `scripts.start/end/error/stop/exit` hooks; Ctrl-C pauses |
| `mt explain <pipeline.ts> [--pipeline <name>] [--json]` | import the module but describe the declared dataflow without running it; no `GlobalContext`/`.env`/vault, no run id or `.mt` writes |
| `mt install [--pipeline <name>]` | run the `scripts.install` hook pipeline |
| `mt resume <runId> [pipeline.ts]` | resume from the first non-done node; file comes from `state.json` unless given |
| `mt ls runs` | table of runs (id, pipeline, state, start) |
| `mt inspect <runId>` | checkpoint tree, events, metadata |
| `mt info [--json] [--runs <n>]` | read-only project/state report: effective `mt.json` (imports + defaults, credential-looking values masked), `.mt` sizes/run health/slow steps, runtime + secrets-presence booleans; no pipeline import or writes |
| `mt tool <name> [--pipeline <file>]` | run one tool standalone: JSON Exchange on stdin, JSON on stdout |
| `mt serve [--port N\|0] [--host H] [--no-router] [-d\|--detach]` | admin API + UI + SSE, with the router LLM gateway embedded on the same port (`--no-router` disables); detached state in `.mt/backend/{pid,server.log}` |
| `mt router [--port N] [--host H] [--mock] [--log-dir D] [-d]` | standalone keyless LLM gateway, API-only (also embedded in `mt serve`); token only via `MT_ROUTER_TOKEN` |
| `mt vault <sub>` | secrets, see below |
| `mt skill [...]` | print/install this file, see below |
| `mt --help`, `mt --version` | |

Examples:

```bash
mt init && mt run ./pipelines/example.ts
mt explain ./pipelines/example.ts             # flow, events and log paths; no execution
mt explain ./pipelines/example.ts --json      # same, machine-readable
mt info                                       # effective config (secrets masked) + .mt state
mt info --json                                # stable schemaVersion: 1 document
mt info --runs 0                              # every run in the report
mt ls runs
mt resume 8f3a1c2e                      # after a crash or Ctrl-C
echo '{"item":"hello"}' | mt tool <name>      # name from a tool step of a pipeline in mt.json
```

### Explain a pipeline before running it

`mt explain <pipeline.ts> [--pipeline <name>] [--json]` imports the same runnable `mt run` would use
and prints:

- dataflow and per-step cardinality; step-effective retry/`onError` (pipeline/step values win over project fallbacks), tool-step `concurrency` (ordered `mapConcurrent`, output order preserved), cacheable/idempotent flags
  (cacheable tools later memoize under `.mt/cache/<hash>.json`; explain writes none);
- declared pipeline `envDefaults` (`defineProcess().config({ env })`; applied only when the key is unset in `process.env`/mt.json env) and the declared `mt.json` LLM pick (env `MT_LLM_TOOL`/`MT_LLM_MODEL` override it);
- nested `fork`/`subflow`/`batch` scopes and their checkpoint-node patterns;
- lifecycle hooks, state machine, event order/types and every run artifact path (`state.json`,
  `context.json`, `events.jsonl`, `run.log`, `logs/<stepId>.log`, `dead-letter.jsonl`, `artifacts/`);
- warnings for unresolved URI aliases, duplicate/default pipeline ids, and hand-built invalid steps.

It is read-only at the runtime level: the module is imported (top-level code runs), but no
`GlobalContext`, `.env` or vault is loaded, no Runner/source/tool/target/hook starts, and no run id or
`.mt/runs/<runId>/` directory is created. Import-time stdout is redirected to stderr, so `--json`
stdout is always one parseable JSON document. Markdown by default; `--json` is stable
(`schemaVersion: 1`). Run it from the project root: like `mt run`, it resolves `mt.json` and relative
URIs from the current working directory.

### Install `mt`

```bash
curl -fsSL https://raw.githubusercontent.com/gleb619/machinum-pipeline/main/docs/install.sh -o install.sh
sh install.sh --dry-run                         # read the plan first
sh install.sh --user-master-key                 # released binary -> ~/.local/bin/mt (verified sha256)
sh install.sh --docker --yes                    # wrapper around ghcr.io/gleb619/machinum-pipeline
sh install.sh --name mt-cli                     # Linux: avoid /usr/bin/mt (tape tool)
```

Docker by hand: `docker run --rm -v "$PWD":/work -v ~/.mt:/home/mt/.mt ghcr.io/gleb619/machinum-pipeline run ./pipelines/p.ts`.
Never `sudo` the installer; never pipe it to a shell without reading it. Full guide: `docs/guiding/installation.md`.

### Install this skill into an agent folder

```bash
mt skill > .agent/skills/mt/SKILL.md      # stdout carries only the file; notices go to stderr
mt skill --install                        # -> .agent/skills/mt/SKILL.md (cwd)
mt skill --install --target claude        # .claude/skills/mt/SKILL.md
mt skill --install ~/proj/.codex/skills/mt  # explicit dir
mt skill --out ./SKILL.md [--force]       # atomic write, refuses to overwrite without --force
mt skill --path                           # skill-version and where the embedded copy came from
```

Presets: `agents` (`.agent/skills/mt/`, default), `claude` (`.claude/skills/mt/`),
`codex` (`.codex/skills/mt/`), `opencode` (`.opencode/skills/mt/`). Re-run after upgrading `mt`.

## Secrets and vault

Hard rules:

1. NEVER put API keys in `mt.json`, pipelines, vault files, `.env` committed to git, logs or chat.
2. A vault `apiKey` / `apiKeys[]` is a reference only: `embed:<name>`, `vlt:<name>` or
   `keepass:<title|uuid>`. Plaintext is rejected at load/save with an error naming the entry.
3. Never pass passwords or secret values as CLI argument values where a file/stdin/prompt exists.
   Do not print `--reveal` output into transcripts.
4. Never commit `.mt/`, `vault.json`, `*.vault.json`, `*.kdbx`, `*.embed.json`, `*.key`. `mt init` and
   `mt vault init` add these to `.gitignore`; verify with `git check-ignore -v .mt/master.key`.

Backends:

| Ref | Backend | Config |
|---|---|---|
| `embed:<name>` | built-in AES-256-GCM store (default) | `MT_EMBED_PATH`, `MT_EMBED_PASSWORD(_FILE)` or master key file |
| `vlt:<name>` | external `vlt` CLI | `MT_VLT=false` disables |
| `keepass:<title\|uuid>` | KeePass `.kdbx` | `MT_KEEPASS_PATH`, `MT_KEEPASS_PASSWORD(_FILE)`, `MT_KEEPASS_KEY_FILE`; `MT_KEEPASS=false` disables |

Master key resolution (first hit wins): `MT_EMBED_PASSWORD` > `MT_EMBED_PASSWORD_FILE` >
`<project>/.mt/master.key` > `~/.mt/master.key` > public built-in default (only obfuscates, warns).
Existing install without a key: `mt vault master-key generate --rekey` (add `--user` for the global one).
CI/Docker: mount a secret and set `MT_EMBED_PASSWORD_FILE`; never bake a key into an image. The
Docker image generates `$MT_HOME/master.key` on first run (needs a persistent `~/.mt` mount).

```bash
mt vault list | show <name> [--reveal] | rm <name> | path | init
mt vault add or --provider openrouter --models a,b --default-model a   # key via hidden prompt; stored as embed:or, only the ref hits vault.json
mt vault master-key generate [--user] [--path <f>] [--force] [--rekey] | status | show-path
mt vault embed-init | embed-add <name> [--secret v] [--kid k] | embed-list | embed-status
mt vault embed-rekey [--new-password-file f]          # change master password
mt vault embed-rotate <name> [--value-file f]          # replace a secret value, ref stays valid
mt vault embed-keyring generate|add|list|use|retire|rm|rotate [--kid k] [--reencrypt] [--force]
mt vault keepass-init | keepass-add <title> --secret v | keepass-list | keepass-status
mt vault vlt-install | vlt-status
```

`mt vault add --user` targets `~/.mt/vault.json`; default is `<project>/.mt/vault.json`; `MT_VAULT=<path>`
overrides both. Project entries override user entries by name. Entry names contain no `/`.
Losing `master.key` makes embedded secrets unrecoverable.

### Use a vault entry for the LLM

```jsonc
// mt.json
{ "settings": { "llm": { "use": "vault://my-openrouter/openai/gpt-4o-mini" } } }
```

`vault://<entry>[/<model>]` (alias `@vault/<entry>[/<model>]`). Model may contain `:` and `/`; it defaults
to the entry's `defaultModel`. Same via env `MT_LLM_USE` (mt.json wins). Refs resolve lazily at tool
call time, in memory only.

## LLM backends and tests (mock)

One pick configures every LLM tool: env `MT_LLM_TOOL` (or `settings.llm.tool`) =
`mock` (default, offline) | `router` | `openrouter-free` | `openrouter-pool` | `ollama`.
`MT_LLM_MODEL`, `MT_LLM_PROVIDER`, `MT_LLM_BASE_URL`, `MT_ROUTER_URL` (default `http://localhost:7777`),
`MT_ROUTER_TOKEN`, `OPENROUTER_API_KEYS` (comma pool), `MT_OLLAMA_URL` also apply.

Offline pipeline for tests:

```ts
import { definePipeline, defineProcess } from 'mt'
import { createSummaryTool, mockLlm } from 'mt/tools'
import 'mt/waypoint'

export default defineProcess()
  .install(mockLlm({ source: (req) => `mock: ${req.messages.at(-1)?.content}` }))
  .config({ env: { MT_CHUNK_SIZE: '40' } }) // pipeline-scoped env defaults; real process.env always wins
  .pipeline(definePipeline().from('jsonl://./input.jsonl').use(createSummaryTool()).to('md://./out'))
```

`defineProcess().config({ env })` sets pipeline-scoped env defaults (e.g. split defaults for
`chunkSplit`): the Runner applies them to the run env only for keys not already set in
`process.env` or the mt.json env.

`MT_LLM_TOOL=ollama mt run ...` runs the same file against a real backend. Run offline smoke tests with
`mt router --mock` (no keys, no network). An explicit `call`/`translate` argument on a tool beats everything.

## Tunable constants (`constants` overrides)

Text-processing tuning constants (chunk targets, reserves, concurrency, verification thresholds —
export names from `@mt/tools` `constants.ts`, e.g. `DEFAULT_CHUNK_TARGET`, `SERIES_SPLIT_TARGET_CHARS`, `DEFAULT_MAX_TOKENS`,
`DEFAULT_OUTPUT_RESERVE`, `DEFAULT_CHUNK_CONCURRENCY`, `MIN_CYRILLIC_RATIO`, `MAX_UNTRANSLATED_SHARE`)
resolve per call, first defined wins:

1. per-call `constants` variable on the Exchange: `setVariable(ex, 'constants', { DEFAULT_CHUNK_TARGET: 250 })`
2. mt.json `settings.constants.<NAME>` (flat key): `{ "settings": { "constants": { "DEFAULT_CHUNK_TARGET": 250 } } }`
3. env `MT_CONST_<NAME>` (`MT_CONST_DEFAULT_CHUNK_TARGET=250 mt run ...`)
4. built-in constant

An invalid value throws an error naming its source (`variable constants.DEFAULT_CHUNK_TARGET`,
`settings.constants.DEFAULT_CHUNK_TARGET`, `env MT_CONST_DEFAULT_CHUNK_TARGET`); an absent value falls
through. An explicit tool-factory option (e.g. `chunkSize`) still beats the chain.

## Run lifecycle, events, resume

`pending -> running -> done | failed`; Ctrl-C is `running -> paused -> resumed -> running`, and
`mt resume` re-runs a failed/paused run. `checkpoint` is a legal transition target but the current
Runner never enters it. `paused -> done` is illegal.

- Order per event: run-level events write `state.json` + `context.json`, then append `events.jsonl`,
  then notify listeners. `step-done` appends `events.jsonl` then notifies listeners; its checkpoint
  persist is scheduled/coalesced (not before the event).
- Event types: `started`, `step-done` (with `stepId`), `paused`, `resumed`, `done`, `failed` (with `error`).
- The checkpoint tree lives in `.mt/runs/<id>/state.json`; with the source cursor it is the resume
  source of truth. Resume keeps the run id and emits no new `started`.
- File writes are atomic (temp then rename); safe to kill the process.
- Watch live: `tail -f .mt/runs/<id>/events.jsonl`, `mt inspect <id>`, or `mt serve` (`GET /api/runs`,
  SSE at `/api/runs/<id>/events?stream=true`).

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `mt` prints tape usage | `/usr/bin/mt` shadows the binary | use `mt-cli` or the full path |
| URI scheme not resolved | missing `import 'mt/waypoint'` | add the side-effect import |
| `pipelineId mismatch` on resume | pipeline `id` changed | restore the id, or start a new run |
| resume says no pipeline file | run predates recorded `pipelineFile` | `mt resume <id> <pipeline.ts>` |
| `apiKey ... plaintext` rejected | raw key in vault | `mt vault add --api-key` (moves it to `embed:`) or use a ref |
| warning about built-in default password | no master key | `mt vault master-key generate --rekey` |
| cannot decrypt embedded secret | wrong/lost master key or removed `kid` | restore `master.key` / `MT_EMBED_PASSWORD`; check `mt vault embed-status` |
| `vlt` session expired | vlt locked | `vlt login`, retry |
| 401 / 429 from LLM | keys missing or pool exhausted | check vault refs, `OPENROUTER_API_KEYS`, router status |
| missing package in the standalone binary | binary has no project `node_modules` | install deps next to the pipeline; native addons (`.node`) are unsupported |
| port busy | `mt serve` default taken | `--port <p>` or `--port 0` |
| behaviour matches old code | stale `mt` binary | rebuild/upgrade the binary |

## Do / Don't

Do:
- Use `mt explain <pipeline.ts>` to inspect the declared flow, effective policy and output paths before a real run.
- Use `mt info` to check the effective config and state-dir size before/after runs.
- Read `mt.json` and an existing pipeline before writing a new one; copy its imports.
- Keep pipelines deterministic and idempotent; use `cacheable` tools for LLM-heavy steps.
- Test offline first (`MT_LLM_TOOL=mock` or `mockLlm`), then switch the backend by env.
- Prefer URI aliases in `mt.json` so output locations are retargetable.
- After a failure, `mt inspect <id>` then `mt resume <id>`; do not delete `.mt/runs`.

Don't:
- Don't hand-edit `.mt/runs/*/state.json` (it holds the checkpoint tree).
- Don't print, log, commit or echo secrets, master keys, `--reveal` output or `.env` contents.
- Don't add `.batch/.flatMap/.subflow('<entity-type>')` casually: they change cardinality for every later step.
- Don't run `mt serve`/`mt router` bound to a non-loopback host without `MT_ROUTER_TOKEN`.
- Don't assume a flag exists: run `mt <command> --help` when unsure.
