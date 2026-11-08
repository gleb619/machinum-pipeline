/** Insertion-order LRU map: a read refreshes the recency, the oldest entry is evicted first. */
export interface LruCacheOptions {
  /** Max entries kept; 0 disables the cache. */
  maxEntries: number
  /** Max total byte size; undefined = unbounded, 0 disables the cache. */
  maxBytes?: number
}

export interface LruCache {
  readonly size: number
  readonly bytes: number
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export function createLruCache(options: LruCacheOptions): LruCache {
  const { maxEntries, maxBytes } = options
  const entries = new Map<string, { value: string; bytes: number }>()
  const disabled = maxEntries <= 0 || maxBytes === 0
  let bytes = 0

  return {
    get size(): number {
      return entries.size
    },
    get bytes(): number {
      return bytes
    },
    get(key: string): string | undefined {
      const hit = entries.get(key)
      if (hit === undefined) return undefined
      entries.delete(key)
      entries.set(key, hit)
      return hit.value
    },
    set(key: string, value: string): void {
      if (disabled) return
      const size = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8')
      if (maxBytes !== undefined && size > maxBytes) return

      const previous = entries.get(key)
      if (previous) bytes -= previous.bytes
      entries.delete(key)
      entries.set(key, { value, bytes: size })
      bytes += size

      while (entries.size > maxEntries || (maxBytes !== undefined && bytes > maxBytes)) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        const evicted = entries.get(oldest)
        if (evicted) bytes -= evicted.bytes
        entries.delete(oldest)
      }
    },
  }
}
