import { createError, defineEventHandler, getHeader, getQuery, getRouterParam } from 'h3'
import { serveRootOf } from '../../../../utils/sync-root.js'
import {
  isValidWorkerId,
  waitForWorkerSignal,
  workerSignalHeartbeatMs,
  workerSignalsAfter,
} from '../../../../utils/worker-registry.js'

function requestedAfterId(header: string | undefined): number {
  const value = Number(header)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id || !isValidWorkerId(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid worker id' })
  }
  const root = serveRootOf(event)
  const query = getQuery(event)
  const afterFromHeader = requestedAfterId(getHeader(event, 'last-event-id'))
  const lastQuery = Number(query.lastEventId)
  const afterId = Number.isSafeInteger(lastQuery) && lastQuery >= 0 ? lastQuery : afterFromHeader

  const waitSeconds = Number(query.wait)
  if (Number.isFinite(waitSeconds) && waitSeconds > 0) {
    const pending = await workerSignalsAfter(root, id, afterId)
    if (pending.length > 0) return { signals: pending, lastEventId: pending.at(-1)?.id ?? afterId }
    const signal = await waitForWorkerSignal(root, id, afterId, waitSeconds * 1000)
    return {
      signals: signal === undefined ? [] : [signal],
      lastEventId: signal?.id ?? afterId,
    }
  }

  event.node.res.setHeader('Content-Type', 'text/event-stream')
  event.node.res.setHeader('Cache-Control', 'no-cache')
  event.node.res.setHeader('Connection', 'keep-alive')
  event.node.res.setHeader('X-Accel-Buffering', 'no')
  event.node.res.flushHeaders?.()

  let lastId = afterId
  let closed = false
  const heartbeatMs = workerSignalHeartbeatMs()
  event.node.req.on('close', () => {
    closed = true
  })

  const send = (payload: string): void => {
    if (!closed) event.node.res.write(payload)
  }

  try {
    for (const signal of await workerSignalsAfter(root, id, afterId)) {
      lastId = signal.id
      send(`id: ${signal.id}\nevent: ${signal.type}\ndata: ${JSON.stringify(signal)}\n\n`)
    }
    while (!closed) {
      const signal = await waitForWorkerSignal(root, id, lastId, heartbeatMs)
      if (closed) break
      if (signal === undefined) {
        send(': heartbeat\n\n')
        continue
      }
      lastId = signal.id
      send(`id: ${signal.id}\nevent: ${signal.type}\ndata: ${JSON.stringify(signal)}\n\n`)
    }
  } finally {
    event.node.res.end()
  }
})
