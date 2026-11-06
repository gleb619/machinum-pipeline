# Change Workflow (state machine)

By default every code change follows this lifecycle. **Explicit user override:** if the user says to
work in the current worktree / `main` checkout, do not create a worktree or feature branch — make the
change and commit directly on `main`.

```
NEW WORKTREE ──► BRANCH ──► CODE ──► TEST/LINT ──► COMMIT ──► SAMPLES IT ──► FF-MERGE ──► CLEANUP
                                        │ fail           │ fail           │ fail
                                        ▼                ▼                ▼
                                     fix, redo        no merge,        stay on branch,
                                                       stay on branch   fix, re-run
```

1. **Worktree + branch** — create a git worktree + feature branch (e.g. `../<repo>-<id>` on
   `feat/<id>`). Skip this step when the user explicitly asked for the current worktree / `main`.

   Use `at worktree-new` to create the worktree, then **bootstrap it** (a fresh worktree has no
   `node_modules`, no `dist/`, no workspace bins, no GPU env):

   ```bash
   # 1. create (copies the gitignored GPU notes; add --copy .env if you have one)
   cd $(at worktree-new <id> --copy .ollama-remote.md --json | jq -r .worktree)
   # 2. bootstrap: install -> build -> install again (bins like samples/*/node_modules/.bin/mt
   #    are linked to packages/cli/dist, which only exists after build)
   pnpm install --offline --frozen-lockfile && pnpm build && pnpm install --offline --frozen-lockfile
   # 3. GPU env (values from .ollama-remote.md; verify: curl -s ${MT_OLLAMA_URL%/v1}/api/tags)
   export MT_OLLAMA_URL=... MT_OLLAMA_MODEL=...   # then: pnpm test:gpu
   ```

   Whole bootstrap takes ~10s (pnpm store + turbo cache are shared). Verified green from a cold
   worktree: `pnpm --filter`/`pnpm -C samples/sampleN run test` for `sample1-tutorial` + `sample2-practical`.

   **Do NOT `--symlink node_modules`.** `pnpm install` follows the symlink and wants to wipe/reinstall
   the *main* checkout's `node_modules` (it prompts; non-interactive runs may not). Likewise do not
   symlink `packages/*/dist` — a worktree build would overwrite main's build output. Install is
   offline + hardlinked and builds are turbo-cached, so a real per-worktree install is cheap and safe.

   Manual fallback when `at` is unavailable:
   ```bash
   git worktree add -b feat/<id> ../<repo>-<id>
   cp .ollama-remote.md ../<repo>-<id>/
   ```
   then run the same bootstrap.

2. **Code** — do the change, scoped to the task.
3. **Pre-commit gate** — run `pnpm test` + `pnpm lint` (scoped to the change) **before** committing.
   Red → fix, do not commit. The merge gate is `pnpm test:coverage` (coverage report for
   `@mt/core` + `@mt/tools` with thresholds; paste the report in the merge note).
4. **Commit** — only when the pre-commit gate is green.
5. **Pre-merge gate** — rebase/FF-merge **only after** integration tests for `samples/` pass
   (`samples/*/tests/`) **and** the GPU gate `pnpm test:gpu` has been **run**. Red → stay on
   branch, fix, re-run. Also run the **wrkflw guard** `pnpm ci:local` (see below) and paste its summary line.
6. **Rebase + FF-merge + cleanup** — rebase the feature branch onto `main` (`git rebase main`),
   then merge → FF only (`git merge --ff-only`) → delete branch + worktree.
   **Regular merge commits are forbidden.** Never use `git merge --no-ff` or merge without rebase.

Rebase pitfall: other agents land commits on `main` meanwhile, so `git rebase main` may conflict.
Resolve by keeping main's text and re-adding yours, `git rebase --continue`, then re-run the gates.
Run `git merge --ff-only feat/<id>` from the main checkout (it may have a dirty tree from other
agents — FF-merge only touches files the branch changes; stop and ask if they overlap).

A merge is allowed only when both gates are green. Any failure returns to the branch, never to main.

**GPU gate (`pnpm test:gpu`)** — `packages/tools/tests/it/*.it.test.ts` hits the real ollama server
at `MT_OLLAMA_URL` (the project's GPU server; default `http://localhost:11434/v1`; health check + one short chat completion, plus the keyless path tools `router` provider -> in-process router (temp vault, `ollama` entry) -> same server, <30s). Use the `borispc3ai` skill when the GPU is the remote `borispc3.ai` server; host-specific commands are kept in the gitignored `.ollama-remote.md`. It is excluded from `pnpm test`
and must be run explicitly before FF-merge. If the server is unreachable the tests **fail with a clear
message** — that failure is reported, never silently skipped: a skipped or unrun GPU gate is not a green
merge, and the merge report must state the `pnpm test:gpu` result (or why it could not run).

**wrkflw guard (`pnpm ci:local`, `scripts/wrkflw-guard.sh`)** — proves a change will not break `main` CI.
- `pnpm ci:check` (`--quick`): `wrkflw validate` only, no Docker, <1s. Fast loop while editing workflows; not the gate.
- `pnpm ci:local`: pre-merge gate. Validate + `wrkflw run --runtime docker` for `skill-drift` + `actionlint` (local or
  `rhysd/actionlint`; catches unknown keys / bad `${{ }}` that `wrkflw validate` misses) + stand-ins for
  `shellcheck` (local or `koalaman/shellcheck`) and `hadolint`, whose commands/flags/image are parsed from `ci.yml` (no drift). Prints one summary line (`RESULT=GREEN|RED`) for the merge note.
  Needs `wrkflw` and Docker; missing either **fails** (never silent skip). `WRKFLW_GUARD_SKIP=1` is a loud, explicit
  opt-out (exit 0 but prints `RESULT=SKIPPED`, never GREEN) that must be stated in the merge note. `WRKFLW_JOBS="a b"` / `--jobs` / `--all` override the job set.
- wrkflw limits (v0.8.0, empirical): jobs run on bare `ubuntu:latest` (no node/corepack/shellcheck/docker CLI).
  `lint`, `typecheck`, `test`, `binary` fail at the composite `.github/actions/setup` (`corepack enable`: command not found),
  `docker` fails (needs `binary`, docker-in-docker). Those stay covered by `pnpm lint`/`typecheck`/`test`/`smoke:bin`.
  No `--dry-run` exists; `validate` is the dry check. `--event` needs `--diff`/`--changed-files`, so the guard omits it.

**Commit hygiene** — tests leave temp artifacts (e.g. `samples/sample1-tutorial/chapters/*.md.tmp.*`,
`samples/*/out/`). Never `git add -A` / `git add .`: stage explicit paths and check `git status`
first. Pre-existing lint errors on `main` are not caused by your worktree; do not fix unrelated files.

**First-try checklist**
1. `at worktree-new <id> --copy .ollama-remote.md` -> `cd` into it
2. `pnpm install --offline --frozen-lockfile && pnpm build && pnpm install --offline --frozen-lockfile`
3. Export `MT_OLLAMA_URL`/`MT_OLLAMA_MODEL` from `.ollama-remote.md`
4. Code -> `pnpm lint` + scoped tests -> `git status` -> `git add <paths>` -> commit
5. Samples IT + `pnpm test:gpu` + `pnpm ci:local` green -> `git rebase main` -> `git merge --ff-only` from main -> remove worktree + branch

---

Related: automated loop version of this flow is described in [kanban-loop.md](kanban-loop.md) and
[kanban-compose.md](kanban-compose.md) (managed via `at compose --loop --worktree --merge`).
