import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createError, defineEventHandler, getHeader, getQuery, getRouterParam } from 'h3'
import { readNewLines } from '../../../../utils/read-lines.js'
import { projectRootFor, runDirOf } from '../../../../utils/run-dir.js'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing run id' })
  }

  const query = getQuery(event)
  const streamMode = query.stream === 'true'
  const projectId = typeof query.projectId === 'string' ? query.projectId : undefined

  const eventsPath = join(runDirOf(id, projectRootFor(event, projectId)), 'events.jsonl')

  if (!existsSync(eventsPath)) {
    throw createError({ statusCode: 404, statusMessage: 'Run events not found' })
  }

  event.node.res.setHeader('Content-Type', 'text/event-stream')
  event.node.res.setHeader('Cache-Control', 'no-cache')
  event.node.res.setHeader('Connection', 'keep-alive')
  event.node.res.setHeader('X-Accel-Buffering', 'no')

  const sendEvent = (evt: unknown, offset: number) => {
    const data = JSON.stringify(evt)
    event.node.res.write(`id: ${offset}\n`)
    event.node.res.write(`event: ${(evt as { type?: string }).type || 'message'}\n`)
    event.node.res.write(`data: ${data}\n\n`)
  }

  const sendLines = (lines: string[], startOffset: number) => {
    let offset = startOffset
    for (const line of lines) {
      try {
        offset += Buffer.byteLength(line, 'utf8') + 1
        sendEvent(JSON.parse(line), offset)
      } catch {
        // skip invalid lines
      }
    }
    return offset
  }

  const lastEventId = Number(getHeader(event, 'last-event-id'))
  const requestedOffset = Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0

  // Replay everything written so far; the offset is byte-accurate, so a later
  // poll resumes exactly after the last complete line (multi-byte safe).
  const initial = await readNewLines(eventsPath, requestedOffset)
  let lastPosition = initial.nextOffset
  sendLines(initial.lines, requestedOffset)

  if (streamMode) {
    const pollInterval = 500
    let timer: NodeJS.Timeout | undefined

    const poll = async () => {
      if (event.node.req.closed) return
      try {
        const { lines, nextOffset } = await readNewLines(eventsPath, lastPosition)
        sendLines(lines, lastPosition)
        lastPosition = nextOffset
      } catch {
        // file may be mid-rename; retry on the next tick
      }
      timer = setTimeout(poll, pollInterval)
    }

    timer = setTimeout(poll, pollInterval)
    event.node.req.on('close', () => {
      if (timer) clearTimeout(timer)
    })
  } else {
    event.node.res.write('event: done\ndata: {}\n\n')
    event.node.res.end()
  }
})
