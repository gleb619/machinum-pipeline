import type { ParsedUri } from '@mt/core'
import { registry } from '@mt/core'

/**
 * Git worktree Source/Target implementations live in @mt/core — they are
 * generic wrappers around any inner Source/Target and the core worktree
 * engine. This module re-exports them and owns the `git+` URI scheme
 * registration, which is waypoint's responsibility.
 */
export {
  GitWorktreeSource,
  GitWorktreeTarget,
  createGitWorktreeSource,
  createGitWorktreeTarget,
} from '@mt/core/engine/git-worktree-source.js'

// ---------------------------------------------------------------------------
// Module-level side effect: register git+ composite resolver
// ---------------------------------------------------------------------------

/**
 * Composite resolver for git+ URIs.
 * E.g., git+jsonl://data.jsonl?branch=feat&commit=on-close
 *
 * Parses the inner scheme and injects it as _inner_scheme query param
 * so that createGitWorktreeSource / createGitWorktreeTarget can use it.
 */
registry.registerComposite('git+', (_schemes: string[], rest: string): ParsedUri => {
  // rest looks like: jsonl://data.jsonl?branch=feat&commit=on-close
  const parsed = registry.parse(rest)
  parsed.query._inner_scheme = parsed.scheme
  return parsed
})
