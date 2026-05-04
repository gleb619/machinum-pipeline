/**
 * Re-export built-in JSONL source and target.
 */
export { createJsonlSource, createJsonlTarget } from './jsonl.js'

// Markdown read/write
export { createMdSource, createMdTarget } from './md.js'

// Git worktree wrappers
export {
  GitWorktreeSource,
  GitWorktreeTarget,
  createGitWorktreeSource,
  createGitWorktreeTarget,
} from './git-worktree.js'

// Side-effect imports to register
import './http-server.js'
import './git-worktree.js' // registers git+ composite via registry
import './md.js'
