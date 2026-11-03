/**
 * @mt/waypoint — Source/Target implementations for machinum-pipeline.
 *
 * Registers built-in URI schemes (jsonl, md, http, hs, git+…) via side-effect imports.
 * Re-exports factory functions for direct use if needed.
 */
export { createJsonlSource, createJsonlTarget } from './jsonl.js'
export { createMdSource, createMdTarget } from './md.js'
export { createHttpSource } from './http-server.js'
export { createSchemaDocSource, createSchemaDocTarget } from './schema-doc.js'
export { createChapterOutputSource, createChapterOutputTarget } from './chapter-output.js'
export { createEphemeralSource, createEphemeralTarget } from './ephemeral.js'
export {
  ENTITY_BUFFER_SCHEMES,
  LADDER_BUFFER_SCHEMES,
  PACKAGE_BUFFER_SCHEMES,
  entityBufferKey,
  createEntityBufferSource,
  createEntityBufferTarget,
  createTempBufferTarget,
  type EntityBufferScheme,
  type LadderBufferScheme,
  type PackageBufferScheme,
} from './entity-buffers.js'
export { createBatchScopeSource, createBatchReturnTarget } from './batch-scope.js'
export { createEventsSource, createEventsTarget } from './events.js'
export { createRangeSource } from './range.js'
export { createVoidTarget } from './void.js'
export { createReviewTarget, renderGlossaryReview } from './review.js'
export {
  createConsoleTarget,
  renderConsoleExchange,
  type ConsoleFormat,
  type ConsoleStream,
  type ConsoleTargetOptions,
} from './console.js'
export {
  GitWorktreeSource,
  GitWorktreeTarget,
  createGitWorktreeSource,
  createGitWorktreeTarget,
} from './git-worktree.js'

// Side-effect imports — register schemes with the URI registry
import './jsonl.js'
import './batch-scope.js'
import './md.js'
import './schema-doc.js'
import './http-server.js'
import './git-worktree.js'
import './chapter-output.js'
import './ephemeral.js'
import './entity-buffers.js'
import './events.js'
import './range.js'
import './void.js'
import './review.js'
import './console.js'
