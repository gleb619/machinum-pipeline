import { readFile } from 'node:fs/promises'
import { createError, defineEventHandler, getQuery } from 'h3'
import { type LogEntry, getLogPath } from '../../utils/cost-tracker.js'
import { redact } from '../../utils/redact.js'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const date =
    typeof query.date === 'string' ? query.date : (new Date().toISOString().split('T')[0] as string)
  const limit = Math.min(Number.parseInt(String(query.limit ?? '50'), 10) || 50, 200)

  let logPath: string
  try {
    logPath = getLogPath(date)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid date' })
  }

  const entries: LogEntry[] = []

  try {
    const content = await readFile(logPath, 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(redact(line)) as LogEntry)
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // log file absent — return empty
  }

  entries.reverse()

  return { entries: entries.slice(0, limit) }
})
