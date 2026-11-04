import { createError, defineEventHandler, readBody } from 'h3'
import {
  registerIngestForwarder,
  unregisterIngestForwarder,
} from '../../../utils/ingest-forwarder.js'

interface RegisterBody {
  path?: unknown
  runId?: unknown
  targetUrl?: unknown
}

export default defineEventHandler(async (event) => {
  if (event.method === 'DELETE') {
    const body = await readBody<RegisterBody>(event)
    if (typeof body?.path !== 'string') {
      throw createError({ statusCode: 400, statusMessage: 'path is required' })
    }
    return { removed: unregisterIngestForwarder(body.path) }
  }

  if (event.method !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const body = await readBody<RegisterBody>(event)
  if (typeof body?.path !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'path is required' })
  }
  if (typeof body.runId !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'runId is required' })
  }
  if (typeof body.targetUrl !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'targetUrl is required' })
  }

  try {
    return registerIngestForwarder({
      path: body.path,
      runId: body.runId,
      targetUrl: body.targetUrl,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw createError({
      statusCode: message.includes('no mt serve listener') ? 503 : 400,
      statusMessage: message,
    })
  }
})
