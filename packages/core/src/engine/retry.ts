import type { RetryPolicy, RetryStrategy } from '../contexts.js'

/** Any retry layer may be partial — unset fields inherit from the layer below. */
export type PartialRetryPolicy = {
  max?: number
  backoffMs?: number
  strategy?: RetryStrategy
}

const STRATEGIES: readonly RetryStrategy[] = ['fixed', 'linear', 'exp']

export async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Merge the layered retry configuration into one complete policy.
 *
 * Precedence is per field (step override → pipeline → global defaults), so a partial
 * override such as `.use(tool, { retry: { backoffMs: 50 } })` keeps the outer `max`
 * and `strategy` instead of dropping them. Unset (`undefined`) means "inherit";
 * `null` or a wrong type is a configuration error and is reported as such.
 */
export function resolveRetryPolicy(
  step: PartialRetryPolicy | undefined,
  pipeline: PartialRetryPolicy | undefined,
  defaults: PartialRetryPolicy | undefined,
): RetryPolicy {
  const layers: Array<{ label: string; value: PartialRetryPolicy | undefined }> = [
    { label: 'globalContext.defaults.retry', value: defaults },
    { label: 'pipeline.retry', value: pipeline },
    { label: '.use() retry override', value: step },
  ]

  const merged: PartialRetryPolicy = {}
  const origin: Record<keyof RetryPolicy, string> = {
    max: 'no retry layer',
    backoffMs: 'no retry layer',
    strategy: 'no retry layer',
  }
  for (const { label, value } of layers) {
    if (value === undefined) continue
    if (typeof value !== 'object') {
      throw new Error(`Invalid retry policy in ${label}: expected an object, got ${typeof value}`)
    }
    if (value.max !== undefined) {
      merged.max = value.max
      origin.max = label
    }
    if (value.backoffMs !== undefined) {
      merged.backoffMs = value.backoffMs
      origin.backoffMs = label
    }
    if (value.strategy !== undefined) {
      merged.strategy = value.strategy
      origin.strategy = label
    }
  }

  const max = merged.max
  if (max === undefined) throw new Error(`Invalid retry policy: 'max' is not set (${origin.max})`)
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
    throw new Error(
      `Invalid retry policy: 'max' must be an integer >= 0, got ${String(max)} (from ${origin.max})`,
    )
  }

  const backoffMs = merged.backoffMs
  if (backoffMs === undefined) {
    throw new Error(`Invalid retry policy: 'backoffMs' is not set (${origin.backoffMs})`)
  }
  if (typeof backoffMs !== 'number' || !Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error(
      `Invalid retry policy: 'backoffMs' must be a finite number >= 0, got ${String(
        backoffMs,
      )} (from ${origin.backoffMs})`,
    )
  }

  const strategy = merged.strategy
  if (strategy === undefined) {
    throw new Error(`Invalid retry policy: 'strategy' is not set (${origin.strategy})`)
  }
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(
      `Invalid retry policy: 'strategy' must be one of ${STRATEGIES.join(
        ' | ',
      )}, got ${String(strategy)} (from ${origin.strategy})`,
    )
  }

  return { max, backoffMs, strategy }
}

export function getBackoff(attempt: number, policy: RetryPolicy): number {
  switch (policy.strategy) {
    case 'fixed':
      return policy.backoffMs
    case 'linear':
      return policy.backoffMs * (attempt + 1)
    case 'exp':
      return policy.backoffMs * 2 ** attempt
    default:
      return policy.backoffMs
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  onRetry: (error: unknown, attempt: number) => void,
): Promise<T> {
  // A malformed `max` must never skip `fn`: anything other than a positive integer
  // means "no retries", so the first call always happens.
  const max = Number.isInteger(policy.max) && policy.max > 0 ? policy.max : 0
  let lastError: unknown
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < max) {
        onRetry(error, attempt)
        const delay = getBackoff(attempt, policy)
        await wait(Number.isFinite(delay) && delay > 0 ? delay : 0)
      }
    }
  }
  throw lastError
}
