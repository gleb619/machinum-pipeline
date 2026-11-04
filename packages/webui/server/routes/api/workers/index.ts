import { createError, defineEventHandler, readBody } from 'h3'
import { serveRootOf } from '../../../utils/sync-root.js'
import {
  type WorkerRegistration,
  isValidWorkerId,
  listWorkers,
  registerWorker,
} from '../../../utils/worker-registry.js'

interface RegisterBody {
  id?: string
  name?: string
  tags?: string[]
  mtVersion?: string
  capabilities?: Record<string, boolean>
}

export default defineEventHandler(async (event) => {
  const root = serveRootOf(event)
  if (event.method === 'GET') return listWorkers(root)
  if (event.method !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const body = await readBody<RegisterBody>(event)
  if (body?.id !== undefined && !isValidWorkerId(body.id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid worker id' })
  }
  if (body?.tags !== undefined && !Array.isArray(body.tags)) {
    throw createError({ statusCode: 400, statusMessage: 'tags must be an array' })
  }
  const registration: WorkerRegistration = {
    ...(body?.name === undefined ? {} : { name: body.name }),
    ...(body?.tags === undefined ? {} : { tags: body.tags }),
    ...(body?.mtVersion === undefined ? {} : { mtVersion: body.mtVersion }),
    ...(body?.capabilities === undefined ? {} : { capabilities: body.capabilities }),
  }
  return registerWorker(root, registration)
})
