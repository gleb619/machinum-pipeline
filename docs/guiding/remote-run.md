# Remote run — `mt run --remote` / `mt resume --remote`

Run a pipeline on another machine that is already serving `mt serve`. The CLI keeps the local
project as the source of truth, mirrors the project to the remote, streams the remote run's event
log back into the local console, and pulls target outputs plus `.mt/runs/<runId>/` back.

## Quick start

```bash
# remote host: bind loopback and set a token when the tunnel exits elsewhere
export MT_SERVE_TOKEN='<long-random-secret>'
mt serve --host 127.0.0.1 --port 7777

# local host
ssh -N -L 7777:127.0.0.1:7777 user@remote
mt run ./pipelines/translate.ts --remote http://127.0.0.1:7777

# if remote.url is set in mt.json, the value is optional
mt run ./pipelines/translate.ts --remote
mt resume <runId> --remote http://127.0.0.1:7777
```

`mt.json` supplies defaults; `--remote <url>` and `--token-ref <ENV_OR_REF>` apply to one run only.

```jsonc
{
  "remote": {
    "url": "http://127.0.0.1:7777",
    "tokenRef": "env:MT_SERVE_TOKEN",
    "projectId": "my-book"
  }
}
```

## Lifecycle

1. `GET /api/health` — check the remote `mt` major.minor, sync protocol, and capabilities.
2. Fail fast on declared tool prerequisites (`browserTranslate` → Chrome; container tools → Docker;
   tool names containing `playwright` → Playwright). Unknown tools skip the check.
3. `mt remote sync --push` semantics — upload the shippable source scope. Secrets never travel;
   absolute or outside-root `jsonl://` / `md://` inputs fail before start.
4. `POST /api/runs/start` with `projectId` and the pipeline's relative path. The server resolves the
   project inside `<serveRoot>/.mt/remote/<projectId>/` and rejects traversal.
5. Stream `GET /api/runs/:id/events?stream=true&projectId=...` into the local `DuplexLogger`.
   Reconnects send `Last-Event-ID` (byte offset) so no event is duplicated.
6. Pull artifacts every 5 seconds while the run is active, then once more on the terminal state.
   The pull scope is target outputs plus `.mt/runs/<runId>/`, so `mt ls runs` and `mt inspect` work
   locally.
7. Exit `0` for `done`/`paused`, `1` for `failed` — same outcome mapping as a local `mt run`.

The remote side allows one active run per `projectId`; a second start returns `409`. Idle mirror
cleanup is not automatic — remove `.mt/remote/<projectId>/` when the project is retired.

## Ctrl+C

- First Ctrl+C posts `POST /api/runs/:id/pause`, waits for the acknowledgement, performs a final
  pull, prints `Resume: mt resume <id> --remote <url>`, and exits `0`.
- Second Ctrl+C detaches immediately without waiting for the pause request.

`mt resume <id> --remote <url>` re-attaches to a live paused run (it calls
`POST /api/runs/:id/resume` when the run is paused). A run whose backend process restarted is no
longer in the in-process runner registry; start it again or resume it locally from the pulled
`.mt/runs/<id>/` mirror.

## Trust and security

> **Uploading a pipeline executes code on the remote host.** A pipeline is a TypeScript module; the
> remote imports it and runs it as the `mt serve` user. Only send pipelines to machines you own and
> trust, and protect the API with a bearer token.

- Use `--token-ref` / `remote.tokenRef` with an env or vault reference. Never paste a token into a
  command line where shell history or `ps` can see it.
- `mt serve` does not terminate TLS. Bind loopback and use an SSH tunnel
  (`ssh -L 7777:127.0.0.1:7777 host`) or a TLS reverse proxy. A non-loopback bind requires a token.
- Secrets stay local: `.env*`, vault/KeePass/embed stores, keys and `.mt/` are excluded from sync.
  Configure the remote's own vault/env. A missing remote secret fails the run with the error surfaced
  through SSE.
- Artifact pulling writes only target outputs and `.mt/runs/<runId>/` under the local project root.

## Limits

- Per file 20 MB by default (`remote.sync.maxFileBytes`), 64 MB per request, 500 MB per mirror.
- Large-input streaming and `remote.sync.mode: "git"` are not implemented.
- The local mirror is a run mirror, not a distributed scheduler: the CLI process can detach, but the
  remote `mt serve` process must stay alive for pause/resume re-attachment.
