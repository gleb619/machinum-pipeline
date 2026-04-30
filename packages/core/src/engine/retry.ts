
import { RetryPolicy } from '../contexts.js';

export async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getBackoff(attempt: number, policy: RetryPolicy): number {
  switch (policy.strategy) {
    case 'fixed':
      return policy.backoffMs;
    case 'linear':
      return policy.backoffMs * (attempt + 1);
    case 'exp':
      return policy.backoffMs * Math.pow(2, attempt);
    default:
      return policy.backoffMs;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  onRetry: (error: unknown, attempt: number) => void
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.max; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < policy.max) {
        onRetry(error, attempt);
        const delay = getBackoff(attempt, policy);
        await wait(delay);
      }
    }
  }
  throw lastError;
}
