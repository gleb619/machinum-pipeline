---
name: mt
description: Use when a project contains mt.json, a .mt/ directory or pipelines/*.ts built with `definePipeline`, or when the user asks to build, run, resume, debug or test a machinum-pipeline (`mt`) ETL pipeline for long-form text (books, chapters, translation), manage LLM secrets in the mt vault (embed/vlt/keepass refs, master key), start `mt serve` / `mt router`, or install this skill with `mt skill`.
---
<!-- skill-version: 1.20.1 | 2026-11-04 -->
<!-- last reviewed against: packages/cli (commands, index.ts), packages/core (annotation, dsl, config, vault, engine), packages/waypoint (URI schemes), packages/tools (llm-picker, mock LLM, splitters), docs/guiding/{lifecycle,vault,installation,mock-tools,remote-browser-translate,remote-run}.md, docs/steering/{cli,core,webui,waypoint,tools}.md -->

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
  remote/<projectId>.sync.json  last-synced SHA-256 map for `mt remote sync`
  remote/<projectId>/           server-side project mirror (source + .mt/runs/<id>/)
                                (remote run starts here; projectId is mandatory)
  workers/<workerId>.json       main-side mt worker registration (T205)
  worker/<mainId>/              worker-side project mirror (T205)
```

`mt init` scaffolds `mt.json`, `.mt/`, `.gitignore` entries and `.mt/master.key`.

`mt.json` keys you will touch: `project.name`, `pipelines[]`, `uris{}` (named aliases),
`settings.llm.{tool,model,use}`, `settings.constants.<NAME>` (tunable overrides, below), `secrets.envFile`,
`imports[]`, `defaults.{retry,onError,concurrency}`,
`scripts.{install,start,end,stop,exit,resume,error}` (paths to hook pipelines), `router.port`,
`serve.tokenRef` (secret ref for the admin-API bearer token; never plaintext),
`remote.{url,tokenRef,projectId,sync.{include,exclude,maxFileBytes,mode}}` (project sync peer;
tokenRef is a ref, mode `git` is reserved/deferred).

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
  .tap((ex) => log.info('msg', { id: ex.id })) // observe full Exchange, stream unchanged
  .log('debug')                              // sugar over .tap(): '<ISO-ms> [INFO] [debug] <id> <item>'
  .use(chapterDoc, { onError: 'skip-item' }) // Tool step; per-step retry/onError override
  .batch(5)                                  // group into items[] (default size 5; flushes remainder)
  .batch({ size: 3, slide: true })           // sliding windows (overlapping)
  .batch(scopePipeline)                      // packages of 5 run through a nested scope (batch://group|members|return)
  .subflow(otherPipeline)                    // inline nested pipeline, same Runner
  .fork(childPipeline)                       // sequential: child Runner per envelope
  .fork('views', [branchA, branchB])         // parallel: branches per envelope, deterministic merge
  .to('md://./out')                          // Target
```

- `log` (import from `'mt'` / `'@mt/core'`) — process-level console logger emitting the standard
  line (`<ISO-ms> [LEVEL] msg[ {meta}]`). `log(message, meta?)` is INFO; `log.info/warn/error/debug`
  mirror it (debug gated on `MT_DEBUG`). Prefer it over `console.log` in pipeline code, e.g.
  `.tap((ex) => log.info('msg', { key: value }))`.
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
| `hs://http://...` | HTTP source (`POST <path>` ingest). Shares the `mt serve` listener when run in the same process/port; `/health` and `/events` move under the ingest path when shared; `/api/*` ingest paths are rejected |
| `http://host/path` / `https://host/path` | HTTP target — one request per exchange; `?method=POST\|PUT\|PATCH\|DELETE`, `?bearer=ENV_NAME` (env/vault ref, never inline), `?timeoutMs=`, `?retries=`, `?batch=true` (body carries `items[]`), `?contentType=json\|item\|text`, `?header.X-Foo=bar`; `hs://` is source-only |
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
| `mt run <pipeline.ts>` | run in foreground; runs `scripts.start/end/error/stop/exit` hooks; Ctrl-C pauses. `--remote [url]` pushes, starts, streams, and pulls on a remote `mt serve` |
| `mt explain <pipeline.ts> [--pipeline <name>] [--json]` | import the module but describe the declared dataflow without running it; no `GlobalContext`/`.env`/vault, no run id or `.mt` writes |
| `mt install [--pipeline <name>]` | run the `scripts.install` hook pipeline |
| `mt resume <runId> [pipeline.ts]` | resume from the first non-done node; file comes from `state.json` unless given. `--remote [url]` re-attaches to a live remote run (unpauses when paused) |
| `mt ls runs` | table of runs (id, pipeline, state, start) |
| `mt inspect <runId>` | checkpoint tree, events, metadata |
| `mt info [--json] [--runs <n>]` | read-only project/state report: effective `mt.json` (imports + defaults, credential-looking values masked), `.mt` sizes/run health/slow steps, runtime + secrets-presence booleans; no pipeline import or writes |
| `mt tool <name> [--pipeline <file>]` | run one tool standalone: JSON Exchange on stdin, JSON on stdout |
| `mt worker --main <url> [--token-ref <ENV_OR_REF>] [--name N] [--tag a,b] [--max-runs N] [--allow-pipeline GLOB]` | dial out to a main `mt serve`: register, mirror the project into `.mt/worker/<mainId>/`, hold the signal stream, spawn child `mt run` per `run`; drain then exit 0 (T205) |
| `mt serve [--port N\|0] [--host H] [--no-router] [--token-ref <ENV_OR_REF>] [-d\|--detach]` | admin API + UI + SSE, with the router LLM gateway embedded on the same port (`--no-router` disables); `hs://` sources on that `host:port` reuse the same listener; `--token-ref` takes an env var name, `env:NAME`, or `vlt:`/`keepass:`/`embed:` ref (no plaintext `--token`); detached state in `.mt/backend/{pid,server.log}` |
| `mt remote sync [--push\|--pull] [--dry-run] [--prune] [--force] [--watch] [--url <url>] [--token-ref <ENV_OR_REF>] [--run <runId>] [--allow-version-mismatch]` | sync project sources to a remote `mt serve` mirror, or pull a run's outputs + `.mt/runs/<id>/`; `--watch` = push dev loop (300 ms debounce); conflict refuses unless `--force` |
| `mt router [--port N] [--host H] [--mock] [--log-dir D] [-d]` | standalone keyless LLM gateway, API-only (also embedded in `mt serve`); token only via `MT_ROUTER_TOKEN` |
| `mt vault <sub>` | secrets, see below |
| `mt skill [...]` | print/install this file, see below |
| `mt --help`, `mt --version` | |

Examples:

```bash
mt init && mt run ./pipelines/example.ts
mt run ./pipelines/example.ts --on gpu-box --remote http://main:7777   # worker routing
mt worker --main http://main:7777 --token-ref env:MT_MAIN_TOKEN --tag gpu,docker
mt explain ./pipelines/example.ts             # flow, events and log paths; no execution
mt explain ./pipelines/example.ts --json      # same, machine-readable
mt info                                       # effective config (secrets masked) + .mt state
mt info --json                                # stable schemaVersion: 1 document
mt info --runs 0                              # every run in the report
mt ls runs
mt resume 8f3a1c2e                      # after a crash or Ctrl-C
echo '{"item":"hello"}' | mt tool <name>      # name from a tool step of a pipeline in mt.json
mt remote sync --push --dry-run               # sync plan against remote.url from mt.json
mt remote sync --push --watch                 # mirror local edits to the remote
mt remote sync --pull --run <runId>           # pull target outputs + run state locally
```

### Project sync with a remote `mt serve` (T203)

`GET /api/sync/manifest` and `GET|PUT /api/sync/files` implement a content-addressed delta; the
same `mt remote sync` works CLI↔server and server↔server. Default source scope is `pipelines/**`,
`mt.json`, transitive local imports, and relative `jsonl://`/`md://` `.from(...)` inputs. `.env*`,
vault/KeePass/embed stores, `.git/`, `node_modules/`, `dist/` and `.mt/` never travel; the remote
resolves its own secrets. Caps: 20 MB/file, 64 MB/request, 500 MB/project. Writes are atomic.

```jsonc
// mt.json
{ "remote": { "url": "http://gpu-box:7777", "tokenRef": "env:MT_SERVE_TOKEN",
              "projectId": "my-book", "sync": { "include": ["pipelines/**", "chapters/**"],
              "exclude": ["tmp/**"], "maxFileBytes": 20971520 } } }
```

- `--push` (default) sends sources; `--pull` sends target outputs + `.mt/runs/<runId>/` (pass
  `--run` for one run). `--prune` deletes removed files; `--force` overwrites a both-changed file.
- Last successful hashes live in `.mt/remote/<projectId>.sync.json`; the server mirror is
  `<serveRoot>/.mt/remote/<projectId>/` (traversal, symlink and protected paths rejected).
- The CLI checks `/api/health.version` (exact major.minor) and `syncVersion: 1`;
  `--allow-version-mismatch` overrides only the version check.
- Deferred: `remote.sync.mode: "git"` and `--install` (remote `scripts.install`).

### Remote run (T204)

`mt run <pipeline.ts> --remote [url]` and `mt resume <runId> --remote [url]` execute on a remote
`mt serve`. `--remote` without a URL uses `mt.json remote.url`; `--token-ref` takes `env:NAME`,
`vlt:`/`keepass:`/`embed:` (never plaintext argv). Plain `mt run` stays local.

Lifecycle: health/version/capability preflight → T203 source push → `POST /api/runs/start` with
`projectId` + relative pipeline path → SSE `/api/runs/:id/events?stream=true` into the local
`DuplexLogger` (`Last-Event-ID` byte offsets on reconnect) → artifact pull every 5 s and once at the
terminal state → local `.mt/runs/<runId>/` mirror + target outputs. `done`/`paused` exit 0, `failed`
exit 1. First Ctrl+C posts `/pause` and exits after acknowledgement; second detaches. The CLI prints
`Resume: mt resume <id> --remote <url>`.

Server: optional `projectId` resolves the root to `<serveRoot>/.mt/remote/<projectId>/` with
traversal confinement; one active run per project id (`409` duplicate); `GET
/api/runs/:id/artifacts` returns the output manifest (target outputs + `.mt/runs/<id>/`). Uploading
a pipeline is remote code execution as the serve user: token-protect it, use an SSH tunnel/TLS, and
send only trusted projects. Secrets are never synced; the remote resolves its own vault/env.

### Worker mode (T205)

`mt worker --main <url>` is the dial-out side: no inbound port is needed. It registers with
`POST /api/workers`, mirrors the main project source scope (`GET /api/sync/manifest|files?scope=project`)
into `.mt/worker/<mainId>/`, and holds `GET /api/workers/:id/signals` (SSE with `Last-Event-ID` replay;
`?wait=25` long-poll fallback). Signals: `project-changed`, `run`, `resume`, `pause`, `cancel`, `drain`.

- Main `POST /api/runs/start` with `worker: "<id>"` or `tags: ["gpu"]` mints the run id, creates a
  main-side `.mt/runs/<id>/` record and sends `run {runId, pipeline}`. `mt run <p> --on <worker>
  --remote <main>` / `--tags a,b` does this from the CLI and follows the main SSE stream.
- The worker spawns `mt run <pipeline> --run-id <id> --report-to <mainUrl>` in the mirror, one child
  per run up to `--max-runs` (default 1); `--allow-pipeline` (default `pipelines/**`) gates paths.
  The child reports NDJSON batches to `POST /api/runs/:id/events`; main appends to its own
  `events.jsonl` and mirrors `state.json`, so `mt ls runs`, `mt inspect`, webui and TUI are unchanged.
- Child crash => run `failed`, worker survives. No heartbeat for 60 s (`MT_WORKER_TTL_MS`) => worker
  `lost`, its active runs `paused` (resumable, never silently failed). `drain` finishes active runs,
  then exits 0. The bearer token comes from `--token-ref`; children receive it only via
  `MT_WORKER_MAIN_TOKEN`, never argv.
- Worker outputs stay in the worker mirror in phase 1; only run state/events are mirrored to main.

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
`MT_ROUTER_TOKEN`, `MT_SERVE_TOKEN` (admin API bearer; a non-loopback `mt serve --host` requires it),
`OPENROUTER_API_KEYS` (comma pool), `MT_OLLAMA_URL` also apply.
`MT_INGEST_PARENT` (internal) puts a spawned `hs://` source in child mode: it registers its ingest
path with the parent `mt serve` (`POST /api/ingest/register`) instead of binding the declared port.

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

## Remote browser translation

`browserTranslate` can use a long-lived Chrome worker on another machine. The worker is the Node
`mt-browser-translate` bin (needs `playwright-core` + Chrome; not the single-file binary):
`mt-browser-translate --host 127.0.0.1 --port 8787 --token-file <file>`.
On the main machine: `ssh -N -L 8787:127.0.0.1:8787 user@remote`, then set
`MT_BROWSER_TRANSLATE_URL=http://127.0.0.1:8787` and `MT_BROWSER_TRANSLATE_TOKEN=<token>` (or pass
`remoteUrl` / `remoteToken` / `remoteRetries`). `browserTranslate` picks remote lazily and records
`transport: 'remote'` in its variable. Prefer env or `--token-file`; never put a real token on the CLI.
`hs://` is ingest-only (`POST` -> `{ received: true }`) and cannot return translations; router
`/api/translate` is an LLM-paid backend, not Chrome. Guide: `docs/guiding/remote-browser-translate.md`.

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
| port busy | `mt serve` default taken, or `hs://` collides with a foreign process | `--port <p>` / `--port 0`; `hs://` shares `mt serve` on the same `host:port` |
| `mt serve` refuses a non-loopback host | no admin-API token | `MT_SERVE_TOKEN`, `--token-ref <ENV_OR_REF>`, or bind `127.0.0.1` |
| `401 {"error":"Unauthorized"}` from `mt serve` | missing/wrong bearer token | send `Authorization: Bearer <secret>`; `GET /api/health` is open |
| sync conflict / both sides changed | remote diverged from the last-synced hash | inspect the reported paths, reconcile, then `--force` only if the local copy is the intended winner |
| `Remote mt version ... incompatible` | major.minor differs | install the same `mt` line on both ends, or `--allow-version-mismatch` for a deliberate one-off |
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
- Don't run `mt serve` bound to a non-loopback host without `MT_SERVE_TOKEN`/`--token-ref`, or `mt router` without `MT_ROUTER_TOKEN`.
- Don't assume a flag exists: run `mt <command> --help` when unsure.
