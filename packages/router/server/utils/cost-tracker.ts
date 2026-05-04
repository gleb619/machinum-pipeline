import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface LogEntry {
  timestamp: string
  runId: string | null
  stepId: string | null
  model: string
  promptTokens: number
  completionTokens: number
  cost: number
}

export interface DailyUsage {
  calls: number
  totalCost: number
  models: Record<string, { calls: number; cost: number }>
}

function getLogDir(): string {
  const mtHome = process.env.MT_HOME || join(process.env.HOME || '/root', '.mt')
  return join(mtHome, 'router')
}

export function getLogPath(date: string): string {
  return join(getLogDir(), date, 'log.jsonl')
}

export async function getDailyCost(date: string): Promise<DailyUsage> {
  const logPath = getLogPath(date)
  const usage: DailyUsage = { calls: 0, totalCost: 0, models: {} }

  try {
    const content = await readFile(logPath, 'utf-8')
    const lines = content.split('\n').filter((line) => line.trim())

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LogEntry
        usage.calls++
        usage.totalCost += entry.cost

        if (!usage.models[entry.model]) {
          usage.models[entry.model] = { calls: 0, cost: 0 }
        }
        const modelStats = usage.models[entry.model]
        if (modelStats) {
          modelStats.calls++
          modelStats.cost += entry.cost
        }
      } catch {
        // Skip invalid lines
      }
    }
  } catch {
    // File doesn't exist or read error, return empty usage
  }

  return usage
}

export async function getMonthlyCost(): Promise<{ calls: number; totalCost: number }> {
  const logDir = getLogDir()
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`

  let totalCalls = 0
  let totalCost = 0

  try {
    const entries = await readdir(logDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith(prefix)) continue

      const dayUsage = await getDailyCost(entry.name)
      totalCalls += dayUsage.calls
      totalCost += dayUsage.totalCost
    }
  } catch {
    // Directory doesn't exist
  }

  return { calls: totalCalls, totalCost }
}

export async function logCall(
  runId: string | null,
  stepId: string | null,
  model: string,
  usage: { promptTokens: number; completionTokens: number },
): Promise<void> {
  const cost = usage.promptTokens * 0.000001 + usage.completionTokens * 0.000002
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    runId,
    stepId,
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cost,
  }

  const today = new Date().toISOString().split('T')[0] as string
  const logPath = getLogPath(today)
  const logDir = dirname(logPath)

  try {
    await mkdir(logDir, { recursive: true })
    await appendFile(logPath, `${JSON.stringify(entry)}\n`)
  } catch (err) {
    console.error('Failed to write log entry:', err)
  }
}
