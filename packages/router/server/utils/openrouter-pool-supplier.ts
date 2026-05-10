import { OpenRouterPoolSupplier } from '@mt/tools'

const envKeys = (process.env.OPENROUTER_API_KEYS ?? process.env.OPENROUTER_API_KEY ?? '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean)
  .map(k => ({ apiKey: k }))

export const poolSupplier = new OpenRouterPoolSupplier({ clients: envKeys })
