/**
 * @mt/waypoint — Source/Target implementations for machinum-pipeline.
 *
 * Registers built-in URI schemes (jsonl, md, http, hs, git+…) via side-effect imports.
 * Re-exports factory functions for direct use if needed.
 */
export { createJsonlSource, createJsonlTarget } from './jsonl.js'
export { createMdSource, createMdTarget } from './md.js'
export { createSchemaDocSource, createSchemaDocTarget } from './schema-doc.js'
export {
  GitWorktreeSource,
  GitWorktreeTarget,
  createGitWorktreeSource,
  createGitWorktreeTarget,
} from './git-worktree.js'

// Side-effect imports — register schemes with the URI registry
import './jsonl.js'
import './md.js'
import './schema-doc.js'
import './http-server.js'
import './git-worktree.js'
