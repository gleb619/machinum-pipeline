import { registry } from '@mt/core'
import {
  createGitWorktreeSource,
  createGitWorktreeTarget,
} from '@mt/core/engine/git-worktree-source.js'
import { annotateWaypoint } from './registration.js'

/**
 * Git worktree Source/Target implementations live in @mt/core — they are
 * generic wrappers around any inner Source/Target and the core worktree
 * engine. This module re-exports them and owns the `git` URI scheme
 * registration, which is waypoint's responsibility.
 *
 * Syntax: git://<path>?via=<scheme>&branch=…&commit=on-close
 */
export { GitWorktreeSource, GitWorktreeTarget } from '@mt/core/engine/git-worktree-source.js'
export { createGitWorktreeSource, createGitWorktreeTarget }

// ---------------------------------------------------------------------------
// Module-level side effect: register git scheme
// ---------------------------------------------------------------------------

annotateWaypoint(createGitWorktreeSource, {
  id: 'WT006',
  name: 'git worktree source',
  description: 'Reads the inner source inside a git worktree (git://…?via=<scheme>).',
  schemes: ['git'],
  direction: 'source',
})
annotateWaypoint(createGitWorktreeTarget, {
  id: 'WT006',
  name: 'git worktree target',
  description: 'Writes through the inner target inside a git worktree (git://…?via=<scheme>).',
  schemes: ['git'],
  direction: 'target',
})

registry.registerSource('git', createGitWorktreeSource)
registry.registerTarget('git', createGitWorktreeTarget)
