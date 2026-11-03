# Remote browser translation

← [Installation](installation.md) · [Tool catalogue](../steering/tools.md#modificationbrowser-translatets)

Run one long-lived Chrome worker on a remote PC and call it from `browserTranslate` over HTTP. Use this
when the main machine has no Chrome, or when many runs should share one browser and one translation cache.

## What runs where

```
main machine                         worker PC
browserTranslate  --HTTP POST-->  mt-browser-translate  -->  Chrome  -->  Google Translate endpoint
     ^                                  |
     +---------- translatedText --------+
```

- The worker owns one Chrome instance and one in-memory LRU cache (headless by default).
- `browserTranslate` sends `{ text, sourceLang?, targetLang, cache? }` and receives `translatedText`.
- `browserTranslate` reports `transport: 'remote'` and the resolved worker endpoint in its `browserTranslate`
  variable. A local call reports `transport: 'local'`.
- `TranslateInput` / `TranslateOutput` do not change, so the worker is a drop-in translator slot.

## 1. Prepare the worker

Requirements:

| Component | Notes |
|---|---|
| Node.js | >= 20 (the worker is a Node entry point, not the single-file Bun binary) |
| Google Chrome / Chromium | installed on the worker; verify with `google-chrome --version` or `chromium --version` |
| `playwright-core` | peer dependency; it uses the installed Chrome and does **not** download a browser |
| `mt` | npm package that provides the `mt-browser-translate` bin |

Install Google Chrome or Chromium with your OS package manager, then:

```bash
node --version
npm install -g playwright-core mt
google-chrome --version
```

`mt` is pre-release in this repository. If your registry does not have it yet, build the repo on the
worker (`pnpm install && pnpm build`) and use the built Node entry point
(`packages/mt/dist/browser-translate-server.js`) instead of the single-file `mt` binary. The single-file
binary cannot load `playwright-core` unless that package is resolvable at runtime.

If Chrome is not on `PATH`, pass `--chrome-path /path/to/chrome` or set `MT_CHROME_PATH`.

## 2. Start the worker

Bind to loopback and require a token. Create the token file first; keep it readable only by the worker user.

```bash
install -d -m 700 ~/.config/mt
install -m 600 /dev/null ~/.config/mt/browser-translate.token
openssl rand -hex 32 > ~/.config/mt/browser-translate.token

mt-browser-translate \
  --host 127.0.0.1 \
  --port 8787 \
  --token-file ~/.config/mt/browser-translate.token
```

The worker logs only startup by default; per-request failures are not logged unless the embedding code
wires `log`. It shuts down gracefully on `SIGINT` / `SIGTERM`.

| Flag | Default | Purpose |
|---|---|---|
| `--host` | `127.0.0.1` | bind address; non-loopback requires a token |
| `--port` | `8787` | HTTP port; `0` picks an ephemeral port |
| `--token-file` | — | token file; preferred over a literal CLI token |
| `--token` | — | literal token; avoid in shell history, use `--token-file` or `MT_BROWSER_TRANSLATE_TOKEN` |
| `--chrome-path` | auto-detected | Chrome executable |
| `--headless` / `--headed` | headless | Chrome display mode |
| `--concurrency` | `4` | maximum in-flight translations |
| `--queue-limit` | `32` | waiting requests before `429` |
| `--cache-entries` | `1000` | LRU entries; `0` disables the cache |
| `--cache-max-bytes` | `64 MiB` | LRU byte cap; `0` disables the cache |
| `--help`, `--version` | — | usage / version |

The token can also come from `MT_BROWSER_TRANSLATE_TOKEN`. Do not put a real token in a command line;
shell history and process lists expose it.

## 3. Tunnel from the main machine

Keep the worker on loopback and forward the port over SSH:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@worker-pc
```

On the main machine, point `browserTranslate` at the local end of the tunnel and provide the same token:

```bash
export MT_BROWSER_TRANSLATE_URL=http://127.0.0.1:8787
export MT_BROWSER_TRANSLATE_TOKEN="$(cat ~/.config/mt/browser-translate.token)"
```

No pipeline code change is needed: `browserTranslate` reads `MT_BROWSER_TRANSLATE_URL` lazily and selects
the remote engine. Options can override it per tool:

```ts
import { createBrowserTranslate } from 'mt/tools'

const translator = createBrowserTranslate({
  remoteUrl: 'http://127.0.0.1:8787',
  // Prefer MT_BROWSER_TRANSLATE_TOKEN over putting the token in source.
})
```

Health check (no auth, no secrets):

```bash
curl -fsS http://127.0.0.1:8787/health
```

Example response:

```json
{"status":"ok","engine":"google-endpoint","cache":{"entries":0,"bytes":0,"hits":0,"misses":0},"active":0,"queued":0}
```

## 4. Run it as a systemd service

Create `/etc/systemd/system/mt-browser-translate.service`:

```ini
[Unit]
Description=mt browser-translate worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mt
Environment=MT_CHROME_PATH=/usr/bin/google-chrome
ExecStart=/usr/local/bin/mt-browser-translate --host 127.0.0.1 --port 8787 --token-file /etc/mt/browser-translate.token
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

The token file must be readable by `User=mt` and not world-readable:

```bash
sudo install -d -m 700 /etc/mt
sudo install -m 600 -o mt -g mt /dev/null /etc/mt/browser-translate.token
sudo sh -c 'openssl rand -hex 32 > /etc/mt/browser-translate.token'
sudo systemctl daemon-reload
sudo systemctl enable --now mt-browser-translate
sudo systemctl status mt-browser-translate
```

## 5. Cache and concurrency tuning

| Setting | Default | Effect |
|---|---|---|
| `--cache-entries` | `1000` | LRU size keyed by source language, target language, and exact text; repeated paragraphs and titles become cheap |
| `--cache-max-bytes` | `64 MiB` | byte cap for cached entries; LRU evicts when either the entry or byte cap is exceeded; `0` disables the cache |
| `--concurrency` | `4` | maximum simultaneous browser translations; raising it increases CPU, Chrome pages, and upstream request pressure |
| `--queue-limit` | `32` | waiting requests; over the limit returns `429` with `Retry-After: 1` |

Start with the defaults, watch `/health` (`active`, `queued`, `cache.hits`, `cache.misses`, `cache.bytes`),
then raise concurrency only while the worker has CPU headroom. Reuse one worker for a whole run or several
runs instead of launching Chrome per paragraph.

Per-request `cache: false` bypasses the cache lookup but still stores a successful result. The cache lives
in memory for the worker lifetime; restarting the worker clears it.

**Upload caps.** A request body is limited to 10 MiB. A `Content-Length` over the limit is rejected early
with `413` and `Connection: close`; streamed bodies are cut at the same limit. At most
`concurrency + queue-limit` uploads/translation requests are in flight; excess requests get `429` with
`Retry-After: 1`.

## 6. Cost comparison

| Setup | LLM cost | Chrome | Best for |
|---|---|---|---|
| Local `browserTranslate` | none | on the main machine, one launch per engine instance | dev, or a single machine with Chrome |
| Remote `browserTranslate` worker | none | on the worker, one shared browser | laptops/containers without Chrome, many runs sharing cache and concurrency |
| `translateText` / `llmTranslate` | paid LLM tokens (`router` `/api/translate` or provider) | none | when LLM translation quality is acceptable |
| `hs://` | none | none | ingest only; cannot return translations |

One worker + cache + bounded concurrency is the cheap path for browser translation. The router
`/api/translate` endpoint is an LLM-paid service, not Chrome; do not point the browser worker at it.

## 7. Why not reuse `hs://`?

`hs://` is an **ingest source**. `POST /<path>` returns `{ "received": true }`; it has no response channel
for a translation. Using it as transport would require a second response path and a running pipeline on the
worker. The worker therefore exposes its own small API:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | status, cache counters, active/queued counts |
| `POST /translate` | `Authorization: Bearer <token>` when a token is set | translate one text and return `{ translatedText, engine, model, ms, cached }` |

`POST /translate` errors are `{ error: string }`: `400` invalid body, `401` bad token, `413` body over
10 MiB (early on `Content-Length`, with `Connection: close`), `429` queue/upload full, `502` engine failure
or empty translation (`Translation returned empty text`), `503` shutting down, `504` timeout. Empty results
are never cached.

## 8. Security

- Keep `--host 127.0.0.1` and use the SSH tunnel; never expose port `8787` directly to the internet.
- A non-loopback bind requires a token: the server refuses to start without one.
- Prefer `MT_BROWSER_TRANSLATE_TOKEN` or `--token-file`; never pass a real token with `--token`.
- Use a 0600 token file owned by the worker user. Rotate the token by restarting both ends with the new value.
- If a tunnel is not possible, put the worker behind HTTPS (reverse proxy or VPN) and still require a token.
- `GET /health` is unauthenticated but exposes only counters, not text or secrets.
- Requests are capped at 10 MiB; oversized `Content-Length` is rejected early with `413` and
  `Connection: close`. Split larger text before sending.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `browser-translate: Chrome executable not found` | Chrome missing or not on `PATH` | install Chrome, set `--chrome-path` or `MT_CHROME_PATH` |
| `playwright-core is required` | peer dependency missing | `npm install -g playwright-core` on the worker |
| `ECONNREFUSED 127.0.0.1:8787` | worker down or tunnel not running | start the worker; restart `ssh -N -L ...` |
| `401` from `/translate` | token mismatch | use the same token in both environments |
| `429` / `Retry-After: 1` | queue/upload cap full | raise `--queue-limit` / `--concurrency` or reduce parallel runs |
| `502` / `504` | Chrome, network, or Google endpoint failure | check outbound connectivity; retry; wire `log` for diagnostics |
| `503` | worker is shutting down | retry after the worker restarts |
| `413` | request body over 10 MiB, or early `Content-Length` reject | split the text; send smaller chunks |
| non-loopback bind error | no token configured | add a token or bind `127.0.0.1` and tunnel |
| `hs://` returns `{"received":true}` | wrong transport | use the worker URL / `MT_BROWSER_TRANSLATE_URL` |
| `502 Translation returned empty text` | engine returned empty text | not cached; `remoteRetries` retries `502`; check upstream/Chrome if it persists |
