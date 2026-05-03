# Git Worktree Isolation — Architecture Design

**Feature**: T023 / UC-24  
**Status**: Design  
**Date**: 2026-05-02

## Overview

Git worktree isolation enables pipelines to operate on a temporary Git worktree
instead of the main working tree. This provides safe, isolated environments for
Source reading and Target writing, with automatic commit/merge/cleanup on completion.

Two integration paths:
1. **Composite URI scheme**: `git+jsonl://path?branch=work-branch` — prefix `git+`
   triggers worktree creation, then delegates to the inner scheme (jsonl, http, etc.)
2. **Query parameter**: `?git=worktree` on any URI — triggers wrapping without
   scheme prefix, for ad-hoc isolation

## Architecture

```
                         git+jsonl://data/?branch=feature
                                  │
                                  ▼
                     ┌─────────────────────┐
                     │  UriRegistry.parse  │
                     │  composite resolver │
                     │  "git+" → rest      │
                     └──────┬──────────────┘
                            │
                  ┌─────────▼─────────┐
                  │  GitWorktreeSource │
                  │  or GitWorktreeTarget│
                  │                    │
                  │  1. createWorktree │
                  │  2. delegate inner │
                  │  3. merge/cleanup  │
                  └─────────┬─────────┘
                            │
                   ┌────────▼────────┐
                   │  Inner Source   │
                   │  / Target       │
                   │  (jsonl, http)  │
                   └─────────────────┘
```

## Component Design

### 1. Engine Module: `packages/core/src/engine/git-worktree.ts`

Reuses `execGit` from `git.ts`. Provides four low-level functions:

```
createWorktree(repoRoot: string, branchName: string): Promise<string>
  → git worktree add --detach <repoRoot>/<branchName>
  → Returns worktree path

removeWorktree(worktreePath: string): Promise<void>
  → git worktree remove --force <worktreePath>

mergeWorktreeToMain(repoRoot: string, worktreePath: string, commitMessage?: string): Promise<void>
  → Determines branch name from worktree
  → git checkout main
  → git rebase <branch> onto main
  → git merge --ff-only <branch>
  → git branch -d <branch>

getRepoRoot(cwd: string): Promise<string>
  → git rev-parse --show-toplevel
```

### 2. Source Wrapper: `packages/core/src/builtins/git-worktree-source.ts`

```
GitWorktreeSource<T> implements Source<T>

Constructor:
  innerSource: Source<T>
  worktreePath: string
  repoRoot: string

start(ctx): delegates to innerSource.start(ctx) inside worktree directory
resume(ctx, cursor): delegates to innerSource.resume(ctx, cursor) in worktree

uri: derived from inner source
lifestyle: derived from inner source
```

### 3. Target Wrapper: `packages/core/src/builtins/git-worktree-target.ts`

```
GitWorktreeTarget<T> implements Target<T>

Constructor:
  innerTarget: Target<T>
  worktreePath: string
  repoRoot: string
  commitOnClose: boolean

open(ctx): creates worktree via createWorktree, calls innerTarget.open(ctx)
write(env, ctx): delegates to innerTarget.write(env, ctx)
close(ctx):
  1. innerTarget.close(ctx)
  2. if commitOnClose:
     a. autoCommit(worktreePath)
     b. mergeWorktreeToMain(repoRoot, worktreePath)
  3. removeWorktree(worktreePath) — always, even on failure
```

### 4. URI Integration: changes to `packages/core/src/uri.ts`

**Composite resolver** for `git+` prefix:
- Registered at import time via `registry.registerComposite('git+', gitPlusResolver)`
- Parses inner URI from everything after `git+`
- Extracts `?branch=` and `?commit=` from query params
- Returns ParsedUri with scheme set to the inner scheme + git-worktree flags

**General `?git=worktree` mechanism**:
- In `resolveSource()` and `resolveTarget()`: after resolving the base Source/Target,
  check if `parsed.query.git === 'worktree'`
- If yes: wrap the result in GitWorktreeSource or GitWorktreeTarget
- Requires repoRoot — derived from cwd or passed via `?root=` query param

## Data Flow

### Source (read) path:
```
git+jsonl://data/?branch=feature
  → parse: "git+" resolver → inner="jsonl://data/"
  → resolveSource: create GitWorktreeSource(jsonlSource, worktreePath)
  → start(): execGit worktree add → jsonlSource.start() in worktree
  → items flow normally
  → on pipeline end: worktree cleaned up (no commit for sources)
```

### Target (write) path:
```
git+jsonl://out/?branch=feature&commit=on-close
  → parse: "git+" resolver → inner="jsonl://out/"
  → resolveTarget: create GitWorktreeTarget(jsonlTarget, worktreePath, commitOnClose=true)
  → open(): execGit worktree add → jsonlTarget.open() in worktree
  → write(): jsonlTarget.write() — writes go to worktree directory
  → close():
       jsonlTarget.close()
       if commitOnClose: autoCommit + rebase merge to main
       removeWorktree
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| git not installed | Throw descriptive error mentioning git requirement |
| worktree creation fails | Propagate error; no state left behind |
| inner Source/Target fails | Propagate error; worktree cleaned up in close/finally |
| merge conflict | Report conflict; preserve worktree for manual resolution |
| close() called after failure | Always attempt cleanup; log cleanup errors |
| worktree already exists | `git worktree remove --force` first, then retry |

## Implementation Steps (per plan T023)

1. **Engine module** (`git-worktree.ts`) — Stage 2
2. **Source/Target wrappers** — Stage 3
3. **URI integration** (`uri.ts` updates + composite resolver) — Stage 4
4. **Tests** — Stage 5
5. **Documentation** — Stage 6
