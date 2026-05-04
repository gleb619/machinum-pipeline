import { existsSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'

interface Envelope<T = unknown> {
  item: T
  items?: T[]
  meta: {
    chapterId?: string
    paragraphId?: string
    lineId?: string
    [k: string]: unknown
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing run id' })
  }

  let body: unknown
  try {
    body = await readBody(event)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid JSON body' })
  }

  const projectRoot = process.cwd()
  const runDir = join(projectRoot, '.mt', 'runs', id)

  if (!existsSync(runDir)) {
    throw createError({ statusCode: 404, statusMessage: 'Run not found' })
  }

  const envelope: Envelope = {
    item: body,
    meta: {
      source: 'http',
      timestamp: new Date().toISOString(),
    },
  }

  const eventsPath = join(runDir, 'events.jsonl')
  const line = `${JSON.stringify(envelope)}\n`

  await appendFile(eventsPath, line, 'utf-8')

  const { getDb } = await import('../../../../utils/sqlite.js')
  const db = getDb()
  if (db) {
    try {
      db.prepare('INSERT INTO run_events (run_id, type, data, timestamp) VALUES (?, ?, ?, ?)').run(
        id,
        'item',
        JSON.stringify(envelope),
        envelope.meta.timestamp,
      )
    } catch {
      // SQLite insert failed, but file write succeeded
    }
  }

  return { received: true, runId: id }
})
