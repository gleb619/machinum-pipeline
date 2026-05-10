import { defineEventHandler } from 'h3'
import { poolSupplier } from '../../../utils/openrouter-pool-supplier.js'

export default defineEventHandler(() => {
  const pool = poolSupplier.getPool()
  return {
    availableClients: pool.availableSize(),
    totalClients: pool.totalSize(),
  }
})
