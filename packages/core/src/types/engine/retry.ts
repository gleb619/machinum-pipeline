/**
 * Duck-typed error contract read by `withRetry`. Core must not import tool error classes, so any
 * shape works: `retryable: false` marks the failure fatal for this item (quota / auth / oversize
 * prompt / parse), `retryAfterMs` tells the engine how long the server asked it to wait.
 */
export interface RetryableError {
  readonly retryable?: boolean
  readonly retryAfterMs?: number
}
