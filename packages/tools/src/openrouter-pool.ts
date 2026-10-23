/**
 * OpenRouterPool — round-robin client pool with rate-limit tracking,
 * 402 / DDoS handling, and TTL-based recreation.
 */

export interface OpenRouterClient {
  apiKey: string
  apiUrl: string
  blockedUntil?: number
  disabled?: boolean
  disabledModels?: Set<string>
}

export interface OpenRouterPoolConfig {
  clients: Array<{ apiKey: string; apiUrl?: string }>
  poolTtlMs?: number
}

export class OpenRouterPool {
  private readonly clients: OpenRouterClient[]
  private readonly poolTtlMs: number
  private createdAt: number
  private index = 0

  constructor(config: OpenRouterPoolConfig) {
    const defaultUrl = 'https://openrouter.ai/api/v1'
    this.clients = config.clients.map((c) => ({
      apiKey: c.apiKey,
      apiUrl: c.apiUrl ?? defaultUrl,
      blockedUntil: undefined,
      disabled: false,
      disabledModels: new Set<string>(),
    }))
    this.poolTtlMs = config.poolTtlMs ?? 60 * 60 * 1000 // 1 hour
    this.createdAt = Date.now()
  }

  /** Pick the next available client using round-robin */
  getAvailableClient(preferredModel?: string): OpenRouterClient | undefined {
    if (this.isExpired()) return undefined
    const now = Date.now()
    const count = this.clients.length
    if (count === 0) return undefined
    for (let i = 0; i < count; i++) {
      const idx = this.index % count
      this.index = (this.index + 1) % count
      const client = this.clients[idx]
      if (!client) continue
      if (client.disabled) continue
      if (client.blockedUntil && client.blockedUntil > now) continue
      if (preferredModel && client.disabledModels?.has(preferredModel)) continue
      return client
    }
    return undefined
  }

  /** Mark a client as rate-limited for a given duration */
  handleRateLimitError(client: OpenRouterClient, retryAfterMs = 60_000): void {
    const found = this.clients.find((c) => c.apiKey === client.apiKey)
    if (found) {
      found.blockedUntil = Date.now() + retryAfterMs
    }
  }

  /** Mark a client as permanently disabled (402 / DDoS) */
  handle402Error(client: OpenRouterClient): void {
    const found = this.clients.find((c) => c.apiKey === client.apiKey)
    if (found) {
      found.disabled = true
    }
  }

  /** Disable a specific model for a client */
  disableModel(client: OpenRouterClient, model: string): void {
    const found = this.clients.find((c) => c.apiKey === client.apiKey)
    if (found) {
      if (!found.disabledModels) {
        found.disabledModels = new Set<string>()
      }
      found.disabledModels.add(model)
    }
  }

  /** Count of clients that are currently available */
  availableSize(): number {
    const now = Date.now()
    return this.clients.filter((c) => !c.disabled && (!c.blockedUntil || c.blockedUntil <= now))
      .length
  }

  /** Total number of clients in the pool (including disabled/blocked) */
  totalSize(): number {
    return this.clients.length
  }

  /** Breakdown of client states */
  statusCounts(): { total: number; available: number; rateLimited: number; disabled: number } {
    const now = Date.now()
    let available = 0
    let rateLimited = 0
    let disabled = 0
    for (const c of this.clients) {
      if (c.disabled) {
        disabled++
      } else if (c.blockedUntil && c.blockedUntil > now) {
        rateLimited++
      } else {
        available++
      }
    }
    return { total: this.clients.length, available, rateLimited, disabled }
  }

  /** Whether the pool has exceeded its TTL */
  isExpired(): boolean {
    return Date.now() - this.createdAt > this.poolTtlMs
  }

  /** Reset the creation timestamp (used by supplier after recreation) */
  refresh(): void {
    this.createdAt = Date.now()
  }
}

/**
 * Lazy supplier that creates a new pool on first access
 * and recreates it whenever the old pool expires.
 */
export class OpenRouterPoolSupplier {
  private pool: OpenRouterPool | undefined
  private readonly config: OpenRouterPoolConfig

  constructor(config: OpenRouterPoolConfig) {
    this.config = config
  }

  getPool(): OpenRouterPool {
    if (!this.pool || this.pool.isExpired()) {
      this.pool = new OpenRouterPool(this.config)
      this.pool.refresh()
    }
    return this.pool
  }
}
