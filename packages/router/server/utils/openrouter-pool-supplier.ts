import { type OpenRouterPool, OpenRouterPoolSupplier } from './openrouter-pool.js'
import { effectiveApiKeys } from './vault-upstreams.js'

let supplier: OpenRouterPoolSupplier | undefined
let supplierKeys = ''

/**
 * The supplier is built from the effective router config instead of `process.env` at import time,
 * so keys supplied through CLI flags or `mt.json → secrets.envFile` reach the pool. Rebuilt only
 * when the key set changes (config, or a vault edit picked up by the throttled reload).
 */
function currentSupplier(): OpenRouterPoolSupplier {
  const keys = effectiveApiKeys()
  const signature = keys.join(',')
  if (!supplier || signature !== supplierKeys) {
    supplier = new OpenRouterPoolSupplier({ clients: keys.map((apiKey) => ({ apiKey })) })
    supplierKeys = signature
  }
  return supplier
}

export const poolSupplier = {
  getPool(): OpenRouterPool {
    return currentSupplier().getPool()
  },
}
