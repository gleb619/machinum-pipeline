import { readFile } from 'node:fs/promises'
import { defineEventHandler, getQuery } from 'h3'
import { getLogPath, type LogEntry } from '../../utils/cost-tracker.js'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const date =
    typeof query.date === 'string'
      ? query.date
      : (new Date().toISOString().split('T')[0] as string)
  const limit = Math.min(Number.parseInt(String(query.limit ?? '50'), 10) || 50, 200)

  const entries: LogEntry[] = []

  try {
    const content = await readFile(getLogPath(date), 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line) as LogEntry)
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
