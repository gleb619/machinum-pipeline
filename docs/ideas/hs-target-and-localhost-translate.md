# Ideas: remote execution via `mt serve` + reserved local translation domain

Status: section 1b **Implemented 2026-11-04** (T200 — `http://` / `https://` target, `hs://` stays
source-only); the rest is idea only. Captured 2026-11-03. Context refreshed 2026-11-03 (evening)
against the tree after the `@mt/backend`→`@mt/webui` / `@mt/frontend`→`@mt/components` renames and
the T197 router-embedding work. **Decision: `hs://` stays source-only; `http://` / `https://` become a target too** (client role,
`?method=` selects the verb), alongside remote execution via `mt serve` (section 1). No `replyTo`
correlation protocol. WT003 goes `✓ —` → `✓ ✓` for `http`; `hs` remains `✓ —`. The translate worker is
an in-repo tool (see Cost note).

## 1. Remote run: ship the pipeline, run it remotely, get results locally

The `http://` target (1b) moves *data* one exchange at a time; it does not solve "run this pipeline on
that machine" (Chrome, Docker, Playwright, GPU live there). It also has no request/response story
(`replyTo`, correlation, idempotency would be bolted on), so remote execution below is the primary path
and the target is the generic building block (call webhooks, hit the remote admin API, push to
another `hs://` source).

### User story

1. Author the pipeline locally (`pipelines/translate.ts`, plain TS module).
2. Remote PC runs `mt serve --host 0.0.0.0 --port 7777 --token-ref MT_SERVE_TOKEN` (token-protected; the remote box has the heavy
   toolchain: headless Chrome / Playwright / Docker / GPU Ollama).
3. Locally: `mt run translate.ts --remote http://remote:7777` (name TBD: `--remote` / `mt remote run`).
   **Automatic**: the CLI first syncs the project to the remote (delta only, section 1a), then starts
   the run remotely and streams progress. No manual copy, rsync or git push.
4. Everything heavy (browserTranslate's Chrome, container tools, Playwright) launches **on the remote**.
5. When the run is `done`, the CLI pulls the outputs back; the user only sees results locally
   (`.mt/runs/<id>/` mirror + target files in their local project).

```text
local                                         remote (mt serve)
mt run p.ts --remote URL
  ── sync: manifest diff, push changed ───▶  mirror in .mt/remote/<projectId>/ (sandboxed root)
  ── POST /api/runs/start {projectId,..} ──▶  Runner (Chrome / Docker / Playwright launch here)
  ◀─ GET  /api/runs/:id/events (SSE) ──────  progress → local DuplexLogger
  ◀─ sync back: manifest diff, pull ───────  target outputs + run dir → local project
```

### What exists today (verified in tree)

- `mt serve` (`packages/cli/src/commands/serve.ts` → `@mt/webui/standalone`) already serves
  `POST /api/runs/start`, `GET /api/runs`, `/api/runs/:id`, `/api/runs/:id/events` (SSE tail of
  `events.jsonl`), `pause` / `resume`, `GET /api/pipelines`, `GET /api/health`.
- `start.ts` runs `loadGlobalContext(process.cwd())` + `importPipelineModule` for a path **already on
  the remote disk**, confined to the project root (`resolveInsideRoot`). So today the pipeline has to
  be pre-copied by hand (rsync/git) and only a project-relative path is accepted.
- Admin API auth landed in T202: `MT_SERVE_TOKEN` (or `mt.json -> serve.tokenRef`) enables
  `Authorization: Bearer` on `/api/*`, and a non-loopback bind without a token refuses to start.
  The token resolver accepts `env:` / `vlt:` / `keepass:` / `embed:` refs; health and static UI stay open.

### Gaps to design

- **Auth** — done (T202): bearer token on the admin API (`MT_SERVE_TOKEN`, vault/`embed:` ref,
  constant-time SHA-256 compare, mandatory when `--host` is non-loopback). TLS still terminates via
  reverse proxy / SSH tunnel (`ssh -L 7777:localhost:7777 remote`); follow-ups (T203-T205) build on it.
- **Sync**: built-in `mt` project sync between two `mt` servers, see 1a. Replaces manual upload; start
  takes a `projectId` (mirror root) rather than a bare path. Size cap + path-traversal guard (reuse
  `resolveInsideRoot`).
- **Code execution trust**: uploading a pipeline = remote arbitrary code execution as the serve user.
  Acceptable only for the user's own machines behind the token; never expose publicly. Document it.
- **Secrets**: do not ship `.env`/vault. Remote uses its **own** vault/embed store (`mt.json →
  secrets`, `vlt:`/`keepass:`/`embed:` refs resolve remotely); bundle carries refs only.
- **Results back**: new `GET /api/runs/:id/artifacts` (tar/zip stream) or per-file
  `GET /api/runs/:id/files/*`; CLI materialises targets locally. Alternatively write targets remotely and
  let the user pull — but the stated goal is results land locally.
- **Local sources**: a remote pipeline can't read local `jsonl://./in.jsonl`; inputs travel in the bundle
  (small) or via a local `hs://` the remote posts to (not the primary path; large inputs are an open
  question).
- **Lifecycle**: `--remote` run is detached from the CLI process: Ctrl+C = pause (remote
  `POST /pause`), `mt resume <runId> --remote URL` re-attaches the SSE stream. Remote `Runner` registry
  already tracks live runs (`runner-registry.ts`).
- **Where heavy tools run**: nothing special — they run wherever the Runner runs. The remote needs
  Chrome (`browserTranslate`), Docker, Playwright installed; `mt` could print a capability list at
  `GET /api/health` so the CLI fails fast if a tool's prerequisite is missing remotely.
- **UI**: webui/TUI (`docs/layout.md`) show remote runs for free once they list from the remote
  `mt serve`; the TUI/web `baseUrl` already points at any `mt serve`.

### 1b. `http://` / `https://` as target (`?method=`) — Implemented 2026-11-04 (T200)

Today only a source is registered (`registerSource('http'|'hs', createHttpSource)` in
`packages/waypoint/src/http-server.ts`, `direction: 'source'`). Add `registerTarget('http', …)` and
`('https', …)` (same WT003 id, second annotation with `direction: 'target'`, like `jsonl.ts`/`md.ts`).
`hs://` is deliberately **not** registered as a target: in `.from()` it means "listen", keep that
meaning unambiguous. Role is positional: `.from('http://…')` still listens (legacy), `.to('http://…')`
sends.

**Shipped** in `packages/waypoint/src/http-target.ts` (`createHttpTarget`): one request per
exchange, `X-MT-Exchange-Id` idempotency key, retry with backoff for network errors / 429 / 5xx
(`Retry-After` honoured), 4xx and 3xx fail the item, `checkpoint()` counts 2xx-acked exchanges,
masked URLs in log lines. `?capture=<variable>` stayed out of scope — the response body is
discarded (terminal target).

```ts
.to('http://remote:7777/api/runs/start?method=POST&bearer=MT_REMOTE_TOKEN')
```

Query params (all optional):

| Param | Default | Meaning |
|---|---|---|
| `method` | `POST` | HTTP verb: `POST` `PUT` `PATCH` `DELETE` (`GET`/`HEAD` rejected: body-less) |
| `bearer` | — | *Env/vault ref name* for `Authorization: Bearer …`; never inline plaintext |
| `timeoutMs` | 30000 | per-request timeout |
| `retries` | 3 | network / 429 / 5xx with backoff; honour `Retry-After`; 4xx fails the item |
| `batch` | `false` | `true`: one request with `items[]` per batch exchange; else one per exchange |
| `contentType` | `json` | `json` (full `Exchange`), `item` (just `item`), `text` |
| `header.<Name>` | — | extra static header (non-secret) |

Behaviour:
- Body = JSON `Exchange` (`id`, `item`/`items`, `meta`, `variables`) by default; sends
  `X-MT-Exchange-Id` as the idempotency key.
- 2xx = success; response body is discarded (terminal target). Optional `?capture=<variable>` stores
  the response body as a qualified variable on the exchange — open question.
- `checkpoint()` counts 2xx-acked exchanges, so a crash resume replays unacked items (at-least-once).
- Logging via `ctx.run.logger`; URL query secrets are masked in log lines.
- Docs landed with it: `docs/steering/waypoint.md` (WT003 row, WP003 matrix, `http-target.ts`
  section), `docs/steering/tools.md` ("`hs://` is **ingest-only**" note), `docs/steering/structure.md`,
  `docs/guiding/architecture.md`, `samples/sample1` README, `docs/SKILL.md` (URI scheme table).

### 1a. Automatic sync between two mt servers

**Status (T203): implemented for the HTTP mode.** The shipped pieces are the `@mt/core` sync engine
(manifest/scope/diff/apply), `GET /api/sync/manifest`, `GET|PUT /api/sync/files`, enriched
`GET /api/health` (`version`, `capabilities`, `syncVersion: 1`), `mt.json -> remote`, and
`mt remote sync [--push|--pull] [--dry-run] [--prune] [--force] [--watch]`.

Implemented: sha256 delta, length-prefixed framed uploads with atomic temp-then-rename writes,
server-side `.env`/vault/`.git`/`.mt` rejection plus traversal/symlink guards, per-file 20 MB /
request 64 MB / project 500 MB caps, source/import/input scope, output+run-dir pull, version guard,
conflict refusal, `.mt/remote/<projectId>.sync.json`. Deferred: `remote.sync.mode: "git"` and
`--install` (remote `scripts.install`); T204/T205 build remote-run/worker on this API.

Original design:

- **Manifest**: `GET /api/sync/manifest?projectId=` → `{ path, size, sha256, mtime }[]` for the synced set.
  Sender hashes locally, diffs against the peer manifest, sends only changed/new files, deletes removed
  ones (opt-in `--prune`).
- **Transfer**: `PUT /api/sync/files` (multipart or tar stream, chunked, atomic temp-then-rename on the
  receiver per the project atomic-write rule); resumable by re-running the diff.
- **Scope** (`mt.json → remote.sync`): `include` / `exclude` globs. Defaults: include pipelines, local
  modules they import, `mt.json`, input files declared by `.from(...)`; exclude `.mt/`, `node_modules/`,
  `.env`, vault files, `.git/`. Secrets never travel; the remote uses its own vault (`vlt:`/`keepass:`/
  `embed:` refs resolve there).
- **Directions**: `push` (local → remote) before the run; `pull` (remote → local) of target outputs and
  `.mt/runs/<id>/` after (or incrementally while running, so partial results appear locally).
  Pull scope is only what the run's targets wrote, never the whole mirror.
- **Triggers**: implicit with `mt run --remote`; explicit `mt remote sync [--push|--pull] [--watch]` for
  a dev loop (edit locally, remote mirror follows); `--dry-run` prints the diff.
- **Peers, not only client→server**: the same endpoints work server↔server (`mt serve` A pushes to
  `mt serve` B), so a remote can mirror results to a third machine.
- **Version guard**: `/api/health` returns `mt` version + capability list (chrome, docker, playwright,
  ollama); CLI refuses on mismatch or missing prerequisite before syncing.
- **Dependencies**: `node_modules` are not synced; remote must have the same `mt` build. Pipelines
  importing project-local npm deps need `mt remote sync --install` (runs the remote `scripts.install`
  hook) — open question.
- **Alternative considered**: git-based (remote pulls a ref via `git://`). Needs a shared remote repo and
  commits for every tweak; sync is simpler for iteration. Keep git as an opt-in `remote.sync.mode: "git"`.

### 1c. Worker mode: `mt` pulls from a main `mt` and waits for signals

Push-sync (1a) needs the remote to be reachable from the main machine. Invert it: start `mt` on the
remote in a **worker mode** that dials *out* to the main `mt serve` (works behind NAT/firewall, one
outbound connection, no inbound port on the worker).

```bash
# remote PC
mt worker --main http://main:7777 --token-ref MT_MAIN_TOKEN [--name gpu-box] [--tag chrome,docker]
```

Two separate concerns — **mode of work** (what the process is) and **pipe logic** (what a pipe does):

| Concern | Owner | Detail |
|---|---|---|
| Mode of work | `mt worker` process | pull project, hold a control channel, spawn processors, report status |
| Pipe logic | the pipeline module | unchanged TS; runs inside a spawned processor, same `Runner` as `mt run` |

Lifecycle of the worker:

1. **Register** — `POST /api/workers {name, tags, mtVersion, capabilities}` on main; main lists workers
   in the webui/TUI (new "Workers" view in `docs/layout.md` if built).
2. **Pull** — worker constantly mirrors the project from main using the manifest diff of 1a, in the pull
   direction (`GET /api/sync/manifest` → fetch changed files). Triggers: on connect, on a `project-changed`
   signal, and a slow poll as fallback. Mirror lives in `.mt/worker/<mainId>/`; same scope/exclude rules,
   secrets never pulled (worker has its own vault).
3. **Await signals** — long-lived control channel from main: SSE (`GET /api/workers/:id/signals`) with
   long-poll fallback; reconnect with `Last-Event-ID`. Signals: `project-changed`, `run`
   `{runId, pipeline, params}`, `pause`, `resume`, `cancel`, `drain`.
4. **Spawn a pipe processor** — on `run`, the worker spawns a child `mt` process (isolation: a crashed
   Chrome/Docker/Playwright tool cannot kill the worker; one processor per run; concurrency cap
   `--max-runs`). The child loads the pipeline from the mirror and executes it with the normal `Runner`.
5. **Report** — processor events stream to main (`POST /api/runs/:id/events` batches, or main tails
   the worker's `events.jsonl` via SSE); targets written on the worker are pulled back by main (1a pull
   scope) or, if the pipeline's target is `http://` (1b), posted straight to a main-side `hs://`/endpoint.
6. **Idle** — back to awaiting signals; `drain` finishes active runs then exits.

Main side: `mt run p.ts --on gpu-box` (or `--remote` = any worker matching tags) creates the run record
locally, sends the `run` signal, and mirrors state/events as if the run were local, so `mt ls runs`,
`mt inspect`, webui and TUI work unchanged. Worker↔main auth: bearer token (see Gaps).

**Data ingress is declared by the pipe, not by the mode.** A processor opens no listener by default.
Only if the pipeline text declares `.from('hs://…')` / `.from('http://…')` does it accept inbound data;
everything else is outbound-only. Likewise `.to('http://host?method=…')` (1b) is the only way a pipe
sends data out over HTTP. This keeps "what can reach me" derivable from the pipeline (`mt explain` already
lists sources/targets) instead of from worker configuration.

### 1d. Reuse the `mt serve` port instead of a second `hs://` listener

**Status: implemented in T201** (`acquireListener` registry in `@mt/core`; see `docs/steering/core.md`).

Today every `hs://` source calls `createServer().listen(port)` itself
(`packages/waypoint/src/http-server.ts`), so a pipeline with `hs://0.0.0.0:7777/ingest` collides with a
running `mt serve --port 7777` (`EADDRINUSE`). Proposal: one **shared HTTP listener registry** per
process (and cross-process through the worker/serve parent):

- `acquireListener(host, port)` returns the existing `http.Server` when `host:port` already has one
  (refcounted; closed only when the last user releases), otherwise creates and registers it.
- `mt serve` (`@mt/webui/standalone`, `startBackend`) registers its server in that registry, and mounts
  `hs://` ingest routes onto its h3 app as sub-paths (`/ingest`, `/events`, `/health` already exist →
  namespace ingest under the pipeline's declared path; collision with `/api/*` is rejected at `open()`).
- Port match rule: same port and compatible host (`0.0.0.0` covers `127.0.0.1`; explicit different
  interfaces on one port stay separate). Mismatch → own listener as today.
- Cross-process: a spawned pipe processor under `mt serve`/`mt worker` does not bind; it asks the parent
  (IPC or `POST /api/ingest/register {path, runId}`) to route `POST <path>` to it. Parent forwards the
  body (or hands over via a local socket), keeps the 503/`Retry-After` backpressure semantics.
- Lifecycle: route registered on `open()`, removed on `close()`/pause/failed, with the existing
  paused/resumed/done/failed mirroring on `/events`.
- Tests: two `hs://` sources on one port share it; `hs://` + running `mt serve` on the same port both
  answer; port conflict with a foreign process still fails with a clear message.

### Relationship to other pieces

- `hs://` keeps its job: long-lived ingest endpoint inside a pipeline (WT003,
  `docs/steering/waypoint.md`); the `http://` target (1b) can feed another process's `hs://` source.
- T197 (router embedded in `mt serve`) means one remote port already serves admin API + router API.
- Generalises the old `mt-browser-translate` worker: instead of one purpose-built server, any tool chain
  that needs a remote toolchain runs via `--remote`. The standalone `browser-translate-server` stays
  for the narrow "just translate text" case.

### Open questions

- Pull-only (1c worker) vs. push (1a) as the default; likely: worker/pull is the default, push is the
  `--watch` dev loop.
- Worker trust: tokens per worker, allow-listing which pipelines a worker may run, since a pulled pipeline
  is arbitrary code.
- Cross-process ingest forwarding (1d): IPC vs. local unix socket vs. reverse-proxy via parent.
- CLI shape: `mt run --remote <url>` vs. `mt remote run|status|fetch`; default remote from `mt.json`
  (`remote: { url, tokenRef }`).
- Sync conflict policy when both sides changed a file (last-writer-wins vs. refuse; likely refuse, since
  only `push` writes sources and only `pull` writes outputs).
- Dependency story: remote `node_modules` must match (monorepo `workspace:` deps?); require the same
  `mt` version on both ends (check via `/api/health`).
- Streaming results incrementally vs. one artifact at end.
- Multi-user / concurrent bundles, cleanup TTL for `.mt/remote/<bundleId>/`.

## 2. Reserved domain for semi-local Chrome translation

Goal: serve local text on a hostname that Chrome might treat as public, so native auto-translate
could run without exposing the page to the internet.

Reserved-name candidates (RFC 2606 / RFC 6761):

```text
mt-translate.test
mt-translate.example
mt-translate.invalid   # resolution only, never routable
```

Typical `/etc/hosts` line:

```text
127.0.0.1 mt-translate.test
```

Then serve the page at `http://mt-translate.test:<port>` and keep the Chrome prefs
(`translate_whitelists: { en: '<target>' }`).

### Verified limitation

Chrome 156 headless **does** native-translate public pages (e.g. `https://example.com`), but did
**not** translate any local/private variant tried:

- `http://localhost:<port>`
- `http://lvh.me:<port>` / `http://127.0.0.1.nip.io:<port>` (DNS -> 127.0.0.1)
- `http://<LAN-IP>:<port>`
- a local HTTP proxy serving a public-looking host
- `--host-resolver-rules=MAP mt-probe.example.com 127.0.0.1`

So a hosts-file alias is an experiment, not a guaranteed trigger. Chrome appears to exclude
local/private pages below the URL layer.

### If it must be native Chrome translation

- Try HTTPS + a name that resolves to a routable address (public tunnel/reverse proxy), not loopback.
- Or keep the current implementation: the page calls
  `https://translate.googleapis.com/translate_a/single` itself (`PAGE_ENDPOINT` in
  `packages/tools/src/modification/browser-translate.ts`); it works on localhost and is already
  implemented in `browser-translate` (TL247).
- Or use Chrome's on-device `Translator` API with a real user gesture (model download required).

Reserve `mt-translate.test` in docs/examples for HTTP fixtures; do not promise native translation
from it until a real Chrome experiment passes.

**Decision recorded (2026-11-04):** `mt-translate.test` is reserved for HTTP fixtures and examples
only, and no doc may promise native Chrome translation from it. See the "Reserved hostname" note in
[docs/steering/tools.md](../steering/tools.md#modificationbrowser-translatets) (`browser-translate`,
TL247).

## Cost note

Updated 2026-11-03 (evening): the translate worker is no longer an external project — it lives
in-repo as `browser-translate` (TL247, `packages/tools/src/modification/browser-translate.ts`,
category `translator`) plus its headless server (`browser-translate-server.ts`: `--port`,
`--concurrency`, `--cache-entries` LRU, token auth via `timingSafeEqual`). Same features the old
`mt-browser-translate` worker provided: one shared headless Chrome, LRU cache, bounded
concurrency, `/translate`. Remote execution (section 1) makes that pattern generic for
arbitrary tool chains, not a replacement for the tool.
