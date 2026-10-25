import { defineEventHandler } from 'h3'
import { isMockMode } from '../../plugins/mock-mode.js'
import { poolSupplier } from '../../utils/openrouter-pool-supplier.js'
import { getUpstreamRegistry } from '../../utils/upstream.js'

export default defineEventHandler(() => {
  const pool = poolSupplier.getPool()
  const counts = pool.statusCounts()

  return {
    mockMode: isMockMode(),
    totalKeys: counts.total,
    activeKeys: counts.available,
    rateLimitedKeys: counts.rateLimited,
    blockedKeys: counts.disabled,
    // Names and counts only; key values are never exposed.
    upstreams: getUpstreamRegistry()
      .list()
      .map((u) => ({
        name: u.name,
        kind: u.kind,
        keyless: u.keyless,
        ...u.getPool().statusCounts(),
      })),
  }
})
