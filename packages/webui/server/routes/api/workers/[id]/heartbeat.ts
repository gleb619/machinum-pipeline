import { createError, defineEventHandler, getRouterParam } from 'h3'
import { serveRootOf } from '../../../../utils/sync-root.js'
import { heartbeatWorker, isValidWorkerId } from '../../../../utils/worker-registry.js'

export default defineEventHandler(async (event) => {
  if (event.method !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  const id = getRouterParam(event, 'id')
  if (!id || !isValidWorkerId(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid worker id' })
  }
  const record = await heartbeatWorker(serveRootOf(event), id)
  if (record === undefined) {
    throw createError({ statusCode: 404, statusMessage: 'Worker not found' })
  }
  return record
})
