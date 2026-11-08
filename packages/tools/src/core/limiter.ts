/** Bounded concurrency gate: `concurrency` holders, `queueLimit` waiters, FIFO wake-up. */
export interface LimiterOptions {
  concurrency: number
  queueLimit: number
  /** Called after every counter change. */
  onChange?: (active: number, queued: number) => void
}

export interface Limiter {
  readonly active: number
  readonly queued: number
  acquire(): Promise<boolean>
  release(): void
}

export function createLimiter(options: LimiterOptions): Limiter {
  const { concurrency, queueLimit, onChange } = options
  const waiting: Array<() => void> = []
  let active = 0

  return {
    get active(): number {
      return active
    },
    get queued(): number {
      return waiting.length
    },
    async acquire(): Promise<boolean> {
      if (active < concurrency) {
        active++
        onChange?.(active, waiting.length)
        return true
      }
      if (waiting.length >= queueLimit) return false
      await new Promise<void>((resolve) => {
        waiting.push(resolve)
        onChange?.(active, waiting.length)
      })
      return true
    },
    release(): void {
      active = Math.max(0, active - 1)
      const next = waiting.shift()
      if (next) active++
      onChange?.(active, waiting.length)
      next?.()
    },
  }
}
