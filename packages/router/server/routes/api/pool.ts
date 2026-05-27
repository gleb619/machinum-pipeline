import { defineEventHandler } from 'h3'
import { isMockMode } from '../../plugins/mock-mode.js'
import { poolSupplier } from '../../utils/openrouter-pool-supplier.js'

export default defineEventHandler(() => {
  const pool = poolSupplier.getPool()
  const counts = pool.statusCounts()

  return {
    mockMode: isMockMode(),
    totalKeys: counts.total,
    activeKeys: counts.available,
    rateLimitedKeys: counts.rateLimited,
    blockedKeys: counts.disabled,
  }
})
