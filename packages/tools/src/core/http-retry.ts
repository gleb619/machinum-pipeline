import { parseRetryAfterMs, wait } from '@mt/core'

/** HTTP statuses that are worth another attempt. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

/** `Retry-After` wins over the exponential backoff (`baseDelayMs * 2 ** attempt`). */
export function retryDelayMs(
  response: Response | undefined,
  attempt: number,
  baseDelayMs: number,
): number {
  const retryAfter = parseRetryAfterMs(response?.headers.get('retry-after'), { allowZero: true })
  if (retryAfter !== undefined) return retryAfter
  return baseDelayMs * 2 ** attempt
}

export interface RetryRequest {
  /** Total attempts, the first one included. */
  attempts: number
  /** Backoff base in milliseconds. */
  baseDelayMs: number
  /** Per-attempt abort signal. */
  signal?: () => AbortSignal
  /** Message of a request that never reached the server. */
  networkError: (attempts: number, error: unknown) => string
  /** Message of a retryable status that survived the last attempt. */
  statusError: (attempts: number, status: number) => string
}

/** Sends one request and retries network failures and 429/502/503/504 with a backoff. */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  request: RetryRequest,
): Promise<Response> {
  const attempts = Math.max(1, request.attempts)

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response
    try {
      response = await fetchImpl(url, {
        ...init,
        ...(request.signal ? { signal: request.signal() } : {}),
      })
    } catch (error) {
      if (attempt < attempts - 1) {
        await wait(retryDelayMs(undefined, attempt, request.baseDelayMs))
        continue
      }
      throw new Error(request.networkError(attempt + 1, error))
    }

    if (isRetryableStatus(response.status)) {
      if (attempt < attempts - 1) {
        const delay = retryDelayMs(response, attempt, request.baseDelayMs)
        try {
          await response.body?.cancel()
        } catch {
          // The retry decision does not depend on draining this response.
        }
        await wait(delay)
        continue
      }
      throw new Error(request.statusError(attempt + 1, response.status))
    }

    return response
  }

  // The loop always returns or throws on its last attempt.
  throw new Error(request.networkError(attempts, undefined))
}
