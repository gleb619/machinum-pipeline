/**
 * Re-export built-in JSONL source and target.
 */
export { createJsonlSource, createJsonlTarget } from './jsonl-source.js'

// Git worktree wrappers
export { GitWorktreeSource, GitWorktreeTarget, createGitWorktreeSource, createGitWorktreeTarget } from './git-worktree-source.js'

// Side-effect imports to register
import './http-source.js'
import './git-worktree-source.js'  // registers git+ composite via registry
