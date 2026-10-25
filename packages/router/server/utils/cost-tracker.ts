import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ANONYMOUS_CLIENT } from './client-id.js'
import { redact, redactError } from './redact.js'
import { getRouterConfig } from './router-config.js'

export interface LogEntry {
  timestamp: string
  runId: string | null
  stepId: string | null
  model: string
  promptTokens: number
  completionTokens: number
  cost: number
  /** Upstream that served the call; absent in logs written before upstream routing. */
  upstream?: string
  /** Sanitised `X-MT-Client` id; absent in older logs (counted as `anonymous`). */
  client?: string
}

export interface DailyUsage {
  calls: number
  totalCost: number
  models: Record<string, { calls: number; cost: number }>
  /** Per-client totals (client id -> calls/cost); never contains keys. */
  clients: Record<string, { calls: number; cost: number }>
}

function getLogDir(): string {
  return getRouterConfig().logDir
}

export function getLogPath(date: string): string {
  return join(getLogDir(), date, 'log.jsonl')
}

export async function getDailyCost(date: string): Promise<DailyUsage> {
  const logPath = getLogPath(date)
  const usage: DailyUsage = { calls: 0, totalCost: 0, models: {}, clients: {} }

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
        const clientId = entry.client || ANONYMOUS_CLIENT
        const clientStats = usage.clients[clientId] ?? { calls: 0, cost: 0 }
        clientStats.calls++
        clientStats.cost += entry.cost
        usage.clients[clientId] = clientStats
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

/** Spend of one client today; legacy entries without `client` count as `anonymous`. */
export async function getDailyClientCost(
  date: string,
  client: string,
): Promise<{ calls: number; cost: number }> {
  const usage = await getDailyCost(date)
  return usage.clients[client] ?? { calls: 0, cost: 0 }
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
  opts: { upstream?: string; free?: boolean; client?: string } = {},
): Promise<void> {
  // Upstreams without pricing (ollama, local openai-compat) are free; `free` forces cost 0.
  const cost = opts.free ? 0 : usage.promptTokens * 0.000001 + usage.completionTokens * 0.000002
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    runId,
    stepId,
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cost,
    ...(opts.upstream ? { upstream: opts.upstream } : {}),
    ...(opts.client ? { client: opts.client } : {}),
  }

  const today = new Date().toISOString().split('T')[0] as string
  const logPath = getLogPath(today)
  const logDir = dirname(logPath)

  try {
    await mkdir(logDir, { recursive: true })
    await appendFile(logPath, `${redact(JSON.stringify(entry))}\n`)
  } catch (err) {
    console.error('Failed to write log entry:', redactError(err))
  }
}
