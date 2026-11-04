import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import {
  MAX_PROJECT_BYTES,
  MAX_REQUEST_BYTES,
  SyncFileTooLargeError,
  SyncPathError,
  collectOutputScope,
  deleteSyncFile,
  isProtectedSyncPath,
  normalizeSyncPath,
  readSyncFile,
  walkSyncFiles,
  writeSyncFile,
} from '@mt/core'
import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3'
import { readSyncFrames } from '../../../utils/sync-frames.js'
import {
  isValidRunId,
  queryString,
  readSyncLimits,
  resolveMirrorRoots,
  serveRootOf,
} from '../../../utils/sync-root.js'

function mirrorFor(
  event: Parameters<typeof serveRootOf>[0],
  projectId: string | undefined,
): string {
  if (!projectId) throw createError({ statusCode: 400, statusMessage: 'Missing projectId' })
  try {
    return resolveMirrorRoots(serveRootOf(event), projectId).mirrorRoot
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: err instanceof Error ? err.message : 'Invalid projectId',
    })
  }
}

async function mirrorFileSizes(mirrorRoot: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  for (const path of await walkSyncFiles(mirrorRoot, { allowRunState: true })) {
    try {
      const info = await stat(`${mirrorRoot}/${path}`)
      if (info.isFile()) sizes.set(path, info.size)
    } catch {
      // A file disappearing mid-scan is fine; the next frame reconciles it.
    }
  }
  return sizes
}

function totalSize(sizes: Map<string, number>): number {
  let total = 0
  for (const size of sizes.values()) total += size
  return total
}

function safePathOrThrow(path: string, allowRunState = false): string {
  const normalized = normalizeSyncPath(path)
  if (normalized === undefined) {
    throw createError({ statusCode: 400, statusMessage: `Invalid sync path: ${path}` })
  }
  if (isProtectedSyncPath(normalized, { allowRunState })) {
    throw createError({ statusCode: 400, statusMessage: `Protected sync path: ${path}` })
  }
  return normalized
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const projectId = queryString(query.projectId)
  const mirrorRoot = mirrorFor(event, projectId)
  const scope = queryString(query.scope) ?? 'sources'
  if (scope !== 'sources' && scope !== 'outputs') {
    throw createError({ statusCode: 400, statusMessage: 'scope must be sources or outputs' })
  }
  const runId = queryString(query.runId)
  if (runId !== undefined && !isValidRunId(runId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid runId' })
  }

  if (event.method === 'GET') {
    const requested = queryString(query.path)
    if (!requested) throw createError({ statusCode: 400, statusMessage: 'Missing path' })
    const path = safePathOrThrow(requested, scope === 'outputs')
    const allowed =
      scope === 'outputs'
        ? new Set(await collectOutputScope(mirrorRoot, runId === undefined ? {} : { runId }))
        : new Set(await walkSyncFiles(mirrorRoot))
    if (!allowed.has(path)) {
      throw createError({ statusCode: 404, statusMessage: 'Synced file not found' })
    }
    let body: Buffer
    try {
      body = await readSyncFile(mirrorRoot, path, { allowRunState: scope === 'outputs' })
    } catch {
      throw createError({ statusCode: 404, statusMessage: 'Synced file not found' })
    }
    setResponseHeader(event, 'Content-Type', 'application/octet-stream')
    setResponseHeader(event, 'Content-Length', body.length)
    setResponseHeader(event, 'X-Mt-Sync-Sha256', createHash('sha256').update(body).digest('hex'))
    return body
  }

  if (event.method !== 'PUT') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const declaredLength = Number(event.node.req.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Sync request exceeds 64 MB' })
  }
  const { maxFileBytes } = await readSyncLimits(serveRootOf(event))
  const sizes = await mirrorFileSizes(mirrorRoot)
  let projectBytes = totalSize(sizes)
  let requestBytes = 0
  let written = 0
  let deleted = 0

  try {
    for await (const frame of readSyncFrames(event.node.req)) {
      const path = safePathOrThrow(frame.header.path)
      if (frame.header.op === 'delete') {
        if (await deleteSyncFile(mirrorRoot, path)) {
          deleted++
          const previous = sizes.get(path) ?? 0
          projectBytes -= previous
          sizes.delete(path)
        }
        continue
      }

      const body = frame.body ?? Buffer.alloc(0)
      if (body.length > maxFileBytes) {
        throw new SyncFileTooLargeError(path, body.length, maxFileBytes)
      }
      requestBytes += body.length
      if (requestBytes > MAX_REQUEST_BYTES) {
        throw createError({ statusCode: 413, statusMessage: 'Sync request exceeds 64 MB' })
      }
      const expected = frame.header.sha256
      if (expected !== undefined) {
        const actual = createHash('sha256').update(body).digest('hex')
        if (actual !== expected) {
          throw createError({ statusCode: 400, statusMessage: `Checksum mismatch: ${path}` })
        }
      }
      const previous = sizes.get(path) ?? 0
      const nextBytes = projectBytes - previous + body.length
      if (nextBytes > MAX_PROJECT_BYTES) {
        throw createError({ statusCode: 413, statusMessage: 'Mirrored project exceeds 500 MB' })
      }
      await writeSyncFile(mirrorRoot, path, body, { maxBytes: maxFileBytes })
      sizes.set(path, body.length)
      projectBytes = nextBytes
      written++
    }
  } catch (err) {
    if (err instanceof SyncFileTooLargeError) {
      throw createError({ statusCode: 413, statusMessage: err.message })
    }
    if (err instanceof SyncPathError) {
      throw createError({ statusCode: 400, statusMessage: err.message })
    }
    const statusCode =
      typeof err === 'object' && err !== null && 'statusCode' in err
        ? Number((err as { statusCode: unknown }).statusCode)
        : 400
    if (Number.isFinite(statusCode) && statusCode >= 400) throw err
    throw createError({
      statusCode: 400,
      statusMessage: err instanceof Error ? err.message : 'Invalid sync frame',
    })
  }

  return { written, deleted, bytes: requestBytes }
})
