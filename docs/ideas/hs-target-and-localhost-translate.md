# Ideas: `hs://` transport target + reserved local translation domain

Status: idea only — not implemented. Captured 2026-11-03.

## 1. `hs://` / `http://` target waypoint

Today `hs://` and `http://` are **source-only**: `createHttpSource` in
`packages/waypoint/src/http-server.ts` accepts `POST /<path>` and replies `{ "received": true }`.
There is no target that sends an `Exchange` to another `mt` process.

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

- Same-scheme source + target registration order; both `hs` and `http` aliases.
- Target semantics are terminal; should a response body be surfaced as a variable, or is
  `replyTo` the only return path?
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
  `https://translate.googleapis.com/translate_a/single` itself; it works on localhost and is already
  implemented in `browserTranslate`.
- Or use Chrome's on-device `Translator` API with a real user gesture (model download required).

Reserve `mt-translate.test` in docs/examples for HTTP fixtures; do not promise native translation
from it until a real Chrome experiment passes.

## Cost note

The current remote worker (`mt-browser-translate`) already gives one shared Chrome, LRU cache,
bounded concurrency, and `/translate`. The `hs://` target work is about making that pattern generic
for arbitrary tool chains, not about replacing the worker immediately.
