import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createError, defineEventHandler, getRouterParam } from 'h3'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing run id' })
  }
  const eventsPath = join(process.cwd(), '.mt', 'runs', id, 'events.jsonl')

  if (!existsSync(eventsPath)) {
    throw createError({ statusCode: 404, statusMessage: 'Run events not found' })
  }

  event.node.res.setHeader('Content-Type', 'text/event-stream')
  event.node.res.setHeader('Cache-Control', 'no-cache')
  event.node.res.setHeader('Connection', 'keep-alive')
  event.node.res.setHeader('X-Accel-Buffering', 'no')

  const stream = createReadStream(eventsPath, { encoding: 'utf-8' })

  const streamEvents = () => {
    return new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk) => {
        const data = typeof chunk === 'string' ? chunk : chunk.toString()
        const lines = data.split('\n').filter((l) => l.trim())
        for (const line of lines) {
          try {
            const evt = JSON.parse(line)
            event.node.res.write(`event: ${evt.type || 'message'}\n`)
            event.node.res.write(`data: ${JSON.stringify(evt)}\n\n`)
          } catch {
            // skip invalid lines
          }
        }
      })
      stream.on('end', () => {
        event.node.res.write('event: done\ndata: {}\n\n')
        event.node.res.end()
        resolve()
      })
      stream.on('error', reject)
    })
  }

  await streamEvents()
})
