# Change Workflow (state machine)

Every code change follows this lifecycle — no exceptions:

```
NEW WORKTREE ──► BRANCH ──► CODE ──► TEST/LINT ──► COMMIT ──► SAMPLES IT ──► FF-MERGE ──► CLEANUP
                                        │ fail           │ fail           │ fail
                                        ▼                ▼                ▼
                                     fix, redo        no merge,        stay on branch,
                                                       stay on branch   fix, re-run
```

1. **Worktree + branch** — never code on `main`. Create a git worktree + feature branch
   (e.g. `../<repo>-<id>` on `feat/<id>`).

   Use `at worktree-new` to bootstrap a worktree and link/copy git-ignored folders
   (so you don't reinstall/build from scratch):

   ```bash
   # Default: creates ../<repo>-<id> on feat/<id> and symlinks node_modules from the main checkout
   at worktree-new <id>

   # Explicit symlink / copy examples
   at worktree-new <id> --symlink node_modules
   at worktree-new <id> --copy .mt
   at worktree-new <id> --symlink node_modules --copy .mt --base main

   # Machine-readable output
   cd $(at worktree-new <id>)
   at worktree-new <id> --json
   ```

   Manual fallback when `at` is unavailable:
   ```bash
   git worktree add -b feat/<id> ../<repo>-<id>
   cd ../<repo>-<id>
   ln -s /path/to/main-repo/node_modules node_modules
   ```

2. **Code** — do the change, scoped to the task.
3. **Pre-commit gate** — run `pnpm test` + `pnpm lint` (scoped to the change) **before** committing.
   Red → fix, do not commit. The merge gate is `pnpm test:coverage` (coverage report for
   `@mt/core` + `@mt/tools` with thresholds; paste the report in the merge note).
4. **Commit** — only when the pre-commit gate is green.
5. **Pre-merge gate** — rebase/FF-merge **only after** integration tests for `samples/` pass
   (`samples/sample*/tests/`) **and** the GPU gate `pnpm test:gpu` has been **run**. Red → stay on
   branch, fix, re-run.
6. **Rebase + FF-merge + cleanup** — rebase the feature branch onto `main` (`git rebase main`),
   then merge → FF only (`git merge --ff-only`) → delete branch + worktree.
   **Regular merge commits are forbidden.** Never use `git merge --no-ff` or merge without rebase.

A merge is allowed only when both gates are green. Any failure returns to the branch, never to main.

**GPU gate (`pnpm test:gpu`)** — `packages/tools/tests/it/*.it.test.ts` hits the real ollama server
at `MT_OLLAMA_URL` (the project's GPU server; default `http://localhost:11434/v1`; health check + one short chat completion, plus the keyless path tools `router` provider -> in-process router (temp vault, `ollama` entry) -> same server, <30s). Use the `borispc3ai` skill when the GPU is the remote `borispc3.ai` server; host-specific commands are kept in the gitignored `.ollama-remote.md`. It is excluded from `pnpm test`
and must be run explicitly before FF-merge. If the server is unreachable the tests **fail with a clear
message** — that failure is reported, never silently skipped: a skipped or unrun GPU gate is not a green
merge, and the merge report must state the `pnpm test:gpu` result (or why it could not run).

---

Related: automated loop version of this flow is described in [kanban-loop.md](kanban-loop.md) and
[kanban-compose.md](kanban-compose.md) (managed via `at compose --loop --worktree --merge`).
