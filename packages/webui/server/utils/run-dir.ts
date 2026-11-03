import { join } from 'node:path'
import { createError } from 'h3'

/**
 * Resolve the `.mt/runs/<id>` directory for a run id taken from the URL.
 * Rejects anything that is not a plain directory name (empty, path separators,
 * `..`, NUL) with a 400 — run ids are engine-minted UUIDs, never paths.
 */
export function runDirOf(id: string): string {
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw createError({ statusCode: 400, statusMessage: `Invalid run id: ${id}` })
  }
  return join(process.cwd(), '.mt', 'runs', id)
}
