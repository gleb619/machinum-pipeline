import { buildManifest, collectOutputScope } from '@mt/core'
import { createError, defineEventHandler, getQuery, getRouterParam } from 'h3'
import { projectRootFor } from '../../../../utils/run-dir.js'
import { isValidRunId } from '../../../../utils/sync-root.js'

/**
 * Artifact manifest for one remote run. Reuses the T203 output scope so the
 * client can pull target outputs and `.mt/runs/<runId>/` with the sync client.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id || !isValidRunId(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid run id' })
  }

  const query = getQuery(event)
  const projectId = typeof query.projectId === 'string' ? query.projectId : undefined
  const root = projectRootFor(event, projectId)
  const files = await collectOutputScope(root, { runId: id })
  return buildManifest(root, { files, allowRunState: true })
})
