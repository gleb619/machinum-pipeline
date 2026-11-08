/**
 * Error policy — what to do when a step fails.
 */
export type ErrorPolicy = 'fail-run' | 'skip-item' | 'dead-letter'

/**
 * Retry strategy types.
 */
export type RetryStrategy = 'fixed' | 'linear' | 'exp'
