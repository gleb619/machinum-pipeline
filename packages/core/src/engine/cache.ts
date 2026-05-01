import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Store } from '../store.js'

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

/**
 * Tool cache — memoises tool outputs by content hash.
 * Stored in .mt/cache/<hash>.json
 */
export class Cache {
  private readonly store: Store

  constructor(mtRoot: string) {
    this.store = new Store(mtRoot)
  }

  /**
   * Compute cache key from tool name, version, input, and context.
   */
  computeKey(options: CacheOptions): string {
    const { toolName, version, input, context } = options
    const payload = JSON.stringify({ toolName, version, input, context })
    return createHash('sha256').update(payload).digest('hex')
  }

  /**
   * Get a cached value if present.
   */
  async get<T>(key: string): Promise<T | undefined> {
    const _filePath = this.store.resolve('cache', `${key}.json`)
    const exists = await this.store.exists('cache', `${key}.json`)
    if (!exists) return undefined

    try {
      const entry = await this.store.readJson<CacheEntry<T>>('cache', `${key}.json`)
      return entry.output
    } catch {
      return undefined
    }
  }

  /**
   * Set a cached value.
   */
  async set<T>(key: string, options: CacheOptions, value: T): Promise<void> {
    const entry: CacheEntry<T> = {
      toolName: options.toolName,
      version: options.version,
      inputHash: this.computeKey(options),
      output: value,
      createdAt: new Date().toISOString(),
    }

    await this.store.ensureDir('cache')
    await this.store.writeJson(entry, 'cache', `${key}.json`)
  }

  /**
   * Check if a key exists in cache.
   */
  async has(key: string): Promise<boolean> {
    return this.store.exists('cache', `${key}.json`)
  }

  /**
   * Clear a cache entry.
   */
  async delete(key: string): Promise<void> {
    const exists = await this.store.exists('cache', `${key}.json`)
    if (exists) {
      await this.store.remove('cache', `${key}.json`)
    }
  }

  /**
   * Clear all cache entries.
   */
  async clear(): Promise<void> {
    const cacheDir = this.store.resolve('cache')
    // Remove entire cache directory, then re-create
    await rm(cacheDir, { recursive: true, force: true })
    await this.store.ensureDir('cache')
  }
}
