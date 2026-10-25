import { defineEventHandler } from 'h3'
import { clientIdFrom } from '../utils/client-id.js'
import { getDailyCost } from '../utils/cost-tracker.js'
import { getRouterConfig } from '../utils/router-config.js'

const LIMITED_PATHS = new Set(['/api/chat/completions', '/api/translate'])

export default defineEventHandler(async (event) => {
  const path = event.path.split('?')[0] ?? ''
  if (!LIMITED_PATHS.has(path) || event.method !== 'POST') return

  const { dailyBudget, clientBudget } = getRouterConfig()
  const today = new Date().toISOString().split('T')[0] as string
  const usage = await getDailyCost(today)

  const remaining = Math.max(0, dailyBudget - usage.totalCost)

  event.node.res.setHeader('X-RateLimit-Remaining', remaining.toFixed(4))

  if (remaining <= 0) {
    event.node.res.statusCode = 429
    event.node.res.setHeader('Content-Type', 'application/json')
    event.node.res.end(
      JSON.stringify({
        error: 'Daily budget exceeded',
        retryAfter: getSecondsUntilMidnight(),
      }),
    )
    return
  }

  if (clientBudget) {
    const client = clientIdFrom(event)
    const spent = usage.clients[client]?.cost ?? 0
    const clientRemaining = Math.max(0, clientBudget - spent)
    event.node.res.setHeader('X-RateLimit-Client-Remaining', clientRemaining.toFixed(4))
    if (clientRemaining <= 0) {
      const retryAfter = getSecondsUntilMidnight()
      event.node.res.statusCode = 429
      event.node.res.setHeader('Content-Type', 'application/json')
      event.node.res.setHeader('Retry-After', String(retryAfter))
      event.node.res.end(
        JSON.stringify({ error: 'Client daily budget exceeded', client, retryAfter }),
      )
    }
  }
})

function getSecondsUntilMidnight(): number {
  const now = new Date()
  const midnight = new Date(now)
  midnight.setUTCHours(24, 0, 0, 0)
  return Math.floor((midnight.getTime() - now.getTime()) / 1000)
}
