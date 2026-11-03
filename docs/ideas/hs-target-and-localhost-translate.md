# Ideas: `hs://` transport target + reserved local translation domain

Status: idea only — not implemented. Captured 2026-11-03. Context refreshed 2026-11-03 (evening)
against the tree after the `@mt/backend`→`@mt/webui` / `@mt/frontend`→`@mt/components` renames and
the T197 router-embedding work: nothing below changed materially — `hs://`/`http://` are still
source-only, and the translate worker is now an in-repo tool (see Cost note).

## 1. `hs://` / `http://` target waypoint

Today `hs://` and `http://` are **source-only**: `createHttpSource` in
`packages/waypoint/src/http-server.ts` (`registry.registerSource('hs', …)`, waypoint WT003) accepts
`POST /<path>` and replies `{ "received": true }`; it also serves `GET /health` and a long-lived
`GET /events` SSE fan-out. There is no target that sends an `Exchange` to another `mt` process.

Current-state notes for the design:

- The URI registry keeps sources and targets separate (`registerSource` / `registerTarget`), so a
  target can claim the same `hs`/`http` names without colliding with the existing source.
- The existing SSE fan-out (`GET /events`) is a candidate return channel: the caller could watch
  events filtered by `X-MT-Exchange-Id` instead of running a second `hs://` source for `replyTo`.
  Open question below should weigh both.
- T197 (router embedded in `mt serve`) is unrelated to this idea but means a remote `mt` process
  already runs several HTTP services on one port — a future `hs://` target design should assume
  multiple endpoints behind one `mt serve`.

Proposed pair:

```text
source side (us)                         remote side
.jsonl / md / tools  --POST-->  hs://0.0.0.0:8787/ingest
                                   -> tool (browserTranslate, ...)
                                   -> POST http://us:8788/result
.from('hs://127.0.0.1:8788/result') <--+
```

### Target sketch

- Register a target for `hs` and `http` (same scheme names as the source) that POSTs JSON
  `Exchange` payloads to `http(s)://host:port/path`.
- Options: `?timeoutMs`, `?retries`, `?bearer=<env-name>`, `?batch=true|false`,
  `?replyTo=<hs-url>`, `?contentType=json`.
- Preserve `id`, `meta`, `variables`, `item`/`items`; one POST per exchange (or one per batch).
- Retry on network / 429 / 5xx with backoff; fail the run on 4xx unless `onError` handles it.
- Auth: bearer header from an env/vault ref, never inline plaintext.
- Correlation: send `X-MT-Exchange-Id` and optional `replyTo`; remote pipeline posts the result
  back to the caller's `hs://` source. `id` is the stable correlation key.
- Backpressure: `hs://` source already has `maxBuffer` / 503; target should honor `Retry-After`.

### Why it matters

- Reuses the `mt` binary on both ends; no custom server protocol.
- Lets a remote PC run a normal pipeline:
  `mt run remote.ts` with `.from('hs://0.0.0.0:8787/ingest').use(browserTranslate).to('http://us:8788/result')`.
- Generalizes the current `mt-browser-translate` worker: any tool chain becomes remotely callable.
- Needs a request/response story: `hs://` alone is one-way, so `replyTo` + correlation is mandatory
  for tools that must return data.

### Open questions

- Same-scheme source + target registration order; both `hs` and `http` aliases (registry allows it —
  sources and targets are separate maps).
- Target semantics are terminal; should a response body be surfaced as a variable, or is
  `replyTo` the only return path? And: `replyTo` POST vs. consuming the source's existing
  `GET /events` SSE stream as the correlation channel.
- Batch shape: one POST with `items[]` vs N POSTs.
- TLS / reverse proxy, token storage, replay/idempotency keys.

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

## Cost note

Updated 2026-11-03 (evening): the translate worker is no longer an external project — it lives
in-repo as `browser-translate` (TL247, `packages/tools/src/modification/browser-translate.ts`,
category `translator`) plus its headless server (`browser-translate-server.ts`: `--port`,
`--concurrency`, `--cache-entries` LRU, token auth via `timingSafeEqual`). Same features the old
`mt-browser-translate` worker provided: one shared headless Chrome, LRU cache, bounded
concurrency, `/translate`. The `hs://` target work is about making that pattern generic for
arbitrary tool chains, not about replacing the tool.
