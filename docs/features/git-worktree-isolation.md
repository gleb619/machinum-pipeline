# Git Worktree Isolation

**Feature**: T023 / UC-24  
**Version**: 0.1.0

## What is Git Worktree Isolation

Git worktree isolation enables machinum-pipeline to operate on temporary Git
worktrees instead of the main working tree. When a Source reads from or a Target
writes to a worktree, the main repository stays untouched. On successful
completion, the worktree changes are auto-committed and merged back to main.

This provides safe, isolated environments for:
- **Data extraction pipelines** that read from versioned datasets
- **Transformation pipelines** that write results to a repo for review
- **Multi-branch processing** without affecting the main working tree

## How to Use

### Composite URI Scheme (primary API)

Prefix any URI with `git+` to create an isolated worktree:

```
git+jsonl://data/input.jsonl?branch=extract-feature
git+jsonl://data/output.jsonl?branch=transform&commit=on-close
git+http://localhost:8080/api/data?branch=api-extract
```

### Query Parameters

| Parameter | Value | Effect |
|-----------|-------|--------|
| `branch` | string | Worktree branch name (default: `worktree-<timestamp>`) |
| `commit` | `on-close` | Auto-commit + rebase-merge to main on Target close |
| `root` | path | Repository root (default: current working directory) |

### Example Pipeline

```typescript
import { Pipeline } from '@mt/core/pipeline'
import { registry } from '@mt/core/uri'
import '@mt/core/builtins' // registers jsonl and git-worktree builtins

const pipeline = new Pipeline()
  .source('git+jsonl://data/input.jsonl?branch=my-feature')
  .tool(myTool)
  .target('git+jsonl://data/output.jsonl?branch=my-feature&commit=on-close')

await pipeline.run()
// Result: output.jsonl is committed to worktree, merged to main, worktree cleaned up
```

## How It Works

### Source Path (read)
```
git+jsonl://data/input.jsonl?branch=my-feature
  → registry.resolveSource strips git+ prefix
  → Resolves inner jsonl Source
  → Wraps in GitWorktreeSource (creates worktree at <repo>/worktrees/my-feature)
  → Source.start() delegates to inner Source inside worktree
  → Items flow through pipeline normally
```

### Target Path (write)
```
git+jsonl://data/output.jsonl?branch=my-feature&commit=on-close
  → registry.resolveTarget strips git+ prefix
  → Resolves inner jsonl Target
  → Wraps in GitWorktreeTarget
  → Target.open(): git worktree add --detach <repo>/worktrees/my-feature
  → Target.write(): inner Target writes to worktree directory
  → Target.close():
      1. inner Target closed
      2. git auto-commit in worktree
      3. git rebase + ff-merge to main
      4. git worktree remove --force (always, even on failure)
```

### Engine Functions (packages/core/src/engine/git-worktree.ts)

| Function | Purpose |
|----------|---------|
| `createWorktree(repoRoot, branchName)` | `git worktree add --detach` |
| `removeWorktree(worktreePath)` | `git worktree remove --force` |
| `mergeWorktreeToMain(repoRoot, worktreePath, msg?)` | Rebase branch → ff-merge → delete branch |
| `getRepoRoot(cwd)` | `git rev-parse --show-toplevel` |

All functions reuse `execGit` from `packages/core/src/engine/git.ts`.

## Error Scenarios and Recovery

| Scenario | Behavior |
|----------|----------|
| Git not installed | `execGit` throws, pipeline fails with clear message |
| Worktree creation fails | Error propagated, no state left behind |
| Inner Source/Target fails | Error propagated to pipeline, Target.close() still runs |
| Merge conflict on close | Error thrown, worktree preserved for manual resolution |
| Cleanup on failure | `removeWorktree` always called in `Target.close()`, even if inner operations fail |
| Detached HEAD merge | `mergeWorktreeToMain` throws descriptive error |

## References

- **UC-24**: Git worktree isolation for Source/Target
- **UC-25**: Auto-commit results on Target close
- **Design doc**: `docs/design/git-worktree-isolation.md`
- **Tests**: `packages/core/tests/engine/git-worktree.test.ts`
- **Source**: `packages/core/src/engine/git-worktree.ts`, `packages/core/src/builtins/git-worktree-source.ts`
