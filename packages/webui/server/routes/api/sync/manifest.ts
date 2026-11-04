import { buildManifest, collectOutputScope, collectSyncScope, walkSyncFiles } from '@mt/core'
import { createError, defineEventHandler, getQuery } from 'h3'
import {
  isValidRunId,
  queryString,
  resolveMirrorRoots,
  serveRootOf,
} from '../../../utils/sync-root.js'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const projectId = queryString(query.projectId)
  const scope = queryString(query.scope) ?? 'sources'
  if (scope !== 'sources' && scope !== 'outputs' && scope !== 'project') {
    throw createError({
      statusCode: 400,
      statusMessage: 'scope must be sources, outputs or project',
    })
  }
  if (scope === 'project') {
    const root = serveRootOf(event)
    return buildManifest(root, { files: await collectSyncScope(root) })
  }
  if (!projectId) throw createError({ statusCode: 400, statusMessage: 'Missing projectId' })
  const runId = queryString(query.runId)
  if (runId !== undefined && !isValidRunId(runId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid runId' })
  }

  let mirrorRoot: string
  try {
    mirrorRoot = resolveMirrorRoots(serveRootOf(event), projectId).mirrorRoot
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: err instanceof Error ? err.message : 'Invalid projectId',
    })
  }

  if (scope === 'outputs') {
    const files = await collectOutputScope(mirrorRoot, runId === undefined ? {} : { runId })
    return buildManifest(mirrorRoot, { files, allowRunState: true })
  }
  const files = await walkSyncFiles(mirrorRoot)
  return buildManifest(mirrorRoot, { files })
})
