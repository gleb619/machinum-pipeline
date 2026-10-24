import { type OpenRouterPool, OpenRouterPoolSupplier } from '@mt/tools'
import { getRouterConfig } from './router-config.js'

let supplier: OpenRouterPoolSupplier | undefined
let supplierKeys = ''

/**
 * The supplier is built from the effective router config instead of `process.env` at import time,
 * so keys supplied through CLI flags or `mt.json → secrets.envFile` reach the pool. Rebuilt only
 * when the key set changes, which in practice happens once, before the first request.
 */
function currentSupplier(): OpenRouterPoolSupplier {
  const keys = getRouterConfig().apiKeys
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
