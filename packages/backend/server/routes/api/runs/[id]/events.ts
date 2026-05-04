import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createError, defineEventHandler, getQuery, getRouterParam } from 'h3'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing run id' })
  }

  const query = getQuery(event)
  const streamMode = query.stream === 'true'

  const eventsPath = join(process.cwd(), '.mt', 'runs', id, 'events.jsonl')

  if (!existsSync(eventsPath)) {
    throw createError({ statusCode: 404, statusMessage: 'Run events not found' })
  }

  event.node.res.setHeader('Content-Type', 'text/event-stream')
  event.node.res.setHeader('Cache-Control', 'no-cache')
  event.node.res.setHeader('Connection', 'keep-alive')
  event.node.res.setHeader('X-Accel-Buffering', 'no')

  const sendEvent = (evt: unknown) => {
    const data = JSON.stringify(evt)
    event.node.res.write(`event: ${(evt as { type?: string }).type || 'message'}\n`)
    event.node.res.write(`data: ${data}\n\n`)
  }

  let lastPosition = 0

  const streamExisting = async (): Promise<number> => {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(eventsPath, { encoding: 'utf-8' })
      let position = 0

      stream.on('data', (chunk) => {
        const data = typeof chunk === 'string' ? chunk : chunk.toString()
        const lines = data.split('\n').filter((l) => l.trim())
        for (const line of lines) {
          try {
            const evt = JSON.parse(line)
            sendEvent(evt)
          } catch {
            // skip invalid lines
          }
        }
        position += data.length
      })

      stream.on('end', () => {
        lastPosition = position
        resolve(position)
      })

      stream.on('error', reject)
    })
  }

  await streamExisting()

  if (streamMode) {
    const pollInterval = 500

    const poll = async () => {
      if (event.node.req.closed) return

      try {
        const newStream = createReadStream(eventsPath, {
          encoding: 'utf-8',
          start: lastPosition,
        })

        let _foundNew = false

        await new Promise<void>((resolve, reject) => {
          newStream.on('data', (chunk) => {
            const data = typeof chunk === 'string' ? chunk : chunk.toString()
            const lines = data.split('\n').filter((l) => l.trim())
            for (const line of lines) {
              try {
                const evt = JSON.parse(line)
                sendEvent(evt)
                _foundNew = true
              } catch {
                // skip invalid lines
              }
            }
            lastPosition += data.length
          })

          newStream.on('end', resolve)
          newStream.on('error', reject)
        })

        if (!event.node.req.closed) {
          setTimeout(poll, pollInterval)
        }
      } catch {
        if (!event.node.req.closed) {
          setTimeout(poll, pollInterval)
        }
      }
    }

    poll()
  } else {
    event.node.res.write('event: done\ndata: {}\n\n')
    event.node.res.end()
  }
})
