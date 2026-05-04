import { defineEventHandler } from 'h3'

export default defineEventHandler(() => {
  const mockMode = process.env.MT_ROUTER_MOCK === 'true'

  return {
    status: 'ok',
    mockMode,
    uptime: Date.now(),
  }
})
