/**
 * Cache entry stored in .mt/cache/<hash>.json
 */
export interface CacheEntry<T = unknown> {
  toolName: string
  version: string
  inputHash: string
  output: T
  createdAt: string
}

/**
 * Cache options for computing keys.
 */
export interface CacheOptions {
  toolName: string
  version: string
  input: unknown
  context?: Record<string, unknown>
}
