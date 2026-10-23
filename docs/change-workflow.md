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
2. **Code** — do the change, scoped to the task.
3. **Pre-commit gate** — run `pnpm test` + `pnpm lint` (scoped to the change) **before** committing.
   Red → fix, do not commit.
4. **Commit** — only when the pre-commit gate is green.
5. **Pre-merge gate** — rebase/FF-merge **only after** integration tests for `samples/` pass
   (`samples/sample*/tests/`). Red → stay on branch, fix, re-run.
6. **Merge + cleanup** — merge → FF only (`git merge --ff-only`) → delete branch + worktree.

A merge is allowed only when both gates are green. Any failure returns to the branch, never to main.

---

Related: automated loop version of this flow is described in [kanban-loop.md](kanban-loop.md) and
[kanban-compose.md](kanban-compose.md) (managed via `at compose --loop --worktree --merge`).
