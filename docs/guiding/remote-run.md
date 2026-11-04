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

## Worker mode (T205)

Push mode needs the remote to be reachable. Worker mode reverses the connection: the remote dials out
to a main `mt serve` and holds no inbound listener unless the pipeline itself declares one.

```bash
# main host
export MT_SERVE_TOKEN='<long-random-secret>'
mt serve --host 127.0.0.1 --port 7777

# worker host (NAT/firewall friendly: outbound only)
export MT_MAIN_TOKEN='<same-secret>'
mt worker --main http://main:7777 --token-ref env:MT_MAIN_TOKEN --name gpu-box --tag gpu,docker

# main host routes a run to it
mt run ./pipelines/translate.ts --on gpu-box --remote http://main:7777
# or pick the first online worker carrying every tag
mt run ./pipelines/translate.ts --tags gpu,docker --remote http://main:7777
```

Lifecycle:

1. `POST /api/workers` registers name, tags, `mt` version and capabilities.
2. The worker pulls the main source scope with the T203 manifest/file API (`scope=project`) into
   `.mt/worker/<mainId>/`; secrets never travel.
3. `GET /api/workers/:id/signals` is the control channel (SSE with 25 s heartbeat comments,
   `Last-Event-ID` replay, reconnect/backoff; `?wait=25` long-poll fallback). Signals:
   `project-changed`, `run`, `resume`, `pause`, `cancel`, `drain`.
4. On `run`, a child `mt` process starts in the mirror (`--run-id` from main, `--report-to` main).
   `--max-runs` (default 1) bounds concurrency; `--allow-pipeline` (default `pipelines/**`) limits
   which pipeline paths may execute.
5. The child posts NDJSON batches to `POST /api/runs/:id/events`; main appends to its own
   `events.jsonl` and mirrors the state, so `mt ls runs`, `mt inspect`, the webui and TUI work
   unchanged.
6. `drain` lets active runs finish, then the worker exits 0. A child crash is reported `failed` and
   the worker keeps running. A worker with no heartbeat for 60 s is `lost`; its runs become `paused`
   (resumable), never silently failed.

`--on` / `--tags` require `remote.url` (or `--remote <url>`). The main project files are read from the
`mt serve` root; start the worker on the machine that must execute the tools. Ctrl+C on the worker
currently exits it without cancelling children; send `cancel` or stop the child explicitly.
