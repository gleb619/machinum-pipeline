import { join } from 'node:path'
import { type H3Event, createError } from 'h3'
import { resolveMirrorRoots, serveRootOf } from './sync-root.js'

/**
 * Resolve the `.mt/runs/<id>` directory for a run id taken from the URL.
 * Rejects anything that is not a plain directory name (empty, path separators,
 * `..`, NUL) with a 400 — run ids are engine-minted UUIDs, never paths.
 */
export function runDirOf(id: string, root = process.cwd()): string {
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw createError({ statusCode: 400, statusMessage: `Invalid run id: ${id}` })
  }
  return join(root, '.mt', 'runs', id)
}

/**
 * Resolve the project root a run belongs to. No `projectId` keeps the legacy
 * serve-root behaviour; with one, the sandboxed sync mirror is the project root.
 */
export function projectRootFor(event: H3Event, projectId?: string): string {
  const serveRoot = serveRootOf(event)
  if (projectId === undefined || projectId === '') return serveRoot
  try {
    return resolveMirrorRoots(serveRoot, projectId).mirrorRoot
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: err instanceof Error ? err.message : 'Invalid projectId',
    })
  }
}
