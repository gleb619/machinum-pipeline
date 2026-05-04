import type { H3Event } from 'h3'
import type { NitroApp } from 'nitropack'
import { getDailyCost } from '../utils/cost-tracker.js'

export default function rateLimitPlugin(nitroApp: NitroApp): void {
  nitroApp.use('/api/chat/completions', async (event: H3Event) => {
    if (event.method !== 'POST') return

    const dailyBudget = Number.parseFloat(process.env.MT_DAILY_BUDGET || '5.00')
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
    }
  })
}

function getSecondsUntilMidnight(): number {
  const now = new Date()
  const midnight = new Date(now)
  midnight.setUTCHours(24, 0, 0, 0)
  return Math.floor((midnight.getTime() - now.getTime()) / 1000)
}
