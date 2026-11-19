import type { ParsedUri } from '@mt/core'
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
 * Primary syntax: git://<path>?via=<scheme>&branch=…&commit=on-close
 * Deprecated alias: git+<scheme>://<path>?… (still resolves).
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

/**
 * Deprecated composite resolver for git+ URIs (e.g. git+jsonl://data.jsonl?branch=feat).
 * Still resolves for backward compatibility; new pipelines should use
 * git://data.jsonl?via=jsonl&branch=feat instead.
 *
 * Parses the inner scheme and injects it as _inner_scheme query param
 * so that createGitWorktreeSource / createGitWorktreeTarget can use it.
 */
registry.registerComposite('git+', (_schemes: string[], rest: string): ParsedUri => {
  // rest looks like: jsonl://data.jsonl?branch=feat&commit=on-close
  const parsed = registry.parse(rest)
  parsed.query._inner_scheme = parsed.scheme
  parsed.scheme = 'git'
  parsed.raw = `git+${rest}`
  return parsed
})
