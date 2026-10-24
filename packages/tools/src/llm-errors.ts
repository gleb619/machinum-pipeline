/** Structured LLM error classes. Messages never contain credentials. */

export interface LlmErrorOptions {
  status?: number
  retryable?: boolean
  cause?: unknown
}

export class LlmError extends Error {
  readonly status?: number
  readonly retryable: boolean

  constructor(message: string, options: LlmErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.status = options.status
    this.retryable = options.retryable ?? false
  }
}

export class LlmRateLimitError extends LlmError {
  readonly retryAfterMs?: number
  constructor(message: string, options: LlmErrorOptions & { retryAfterMs?: number } = {}) {
    super(message, { status: 429, retryable: true, ...options })
    this.retryAfterMs = options.retryAfterMs
  }
}

export class LlmAuthError extends LlmError {
  constructor(message: string, options: LlmErrorOptions = {}) {
    super(message, { retryable: false, ...options })
  }
}

/** 402 / exhausted credits. */
export class LlmQuotaError extends LlmError {
  constructor(message: string, options: LlmErrorOptions = {}) {
    super(message, { status: 402, retryable: false, ...options })
  }
}

export class LlmContextLengthError extends LlmError {
  constructor(message: string, options: LlmErrorOptions = {}) {
    super(message, { retryable: false, ...options })
  }
}

export class LlmServerError extends LlmError {
  constructor(message: string, options: LlmErrorOptions = {}) {
    super(message, { retryable: true, ...options })
  }
}

export class LlmNetworkError extends LlmError {
  constructor(message: string, options: LlmErrorOptions = {}) {
    super(message, { retryable: true, ...options })
  }
}

export class LlmTimeoutError extends LlmError {
  readonly timeoutMs: number
  constructor(timeoutMs: number, options: LlmErrorOptions = {}) {
    super(`LLM call timed out after ${timeoutMs}ms`, { retryable: true, ...options })
    this.timeoutMs = timeoutMs
  }
}

export class LlmAbortError extends LlmError {
  constructor(message = 'LLM call aborted', options: LlmErrorOptions = {}) {
    super(message, { retryable: false, ...options })
  }
}

/** Other non-retryable 4xx. */
export class LlmRequestError extends LlmError {
  constructor(message: string, options: LlmErrorOptions = {}) {
    super(message, { retryable: false, ...options })
  }
}

/** Output could not be parsed / validated (e.g. JSON mode). */
export class LlmParseError extends LlmError {
  readonly content: string
  constructor(message: string, content: string, options: LlmErrorOptions = {}) {
    super(message, { retryable: false, ...options })
    this.content = content
  }
}

const CONTEXT_RE =
  /context[_ ]length|maximum context|context window|too many tokens|prompt is too long|reduce the length|token limit/i

/** Map an HTTP failure to a typed error. Message format keeps the legacy `Chat completion failed: <status> <body>`. */
export function classifyHttpError(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): LlmError {
  const message = `Chat completion failed: ${status} ${body}`
  if (status === 401 || status === 403) return new LlmAuthError(message, { status })
  if (status === 402) return new LlmQuotaError(message)
  if (status === 429) {
    const ra = Number(headers['retry-after'])
    return new LlmRateLimitError(message, {
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
    })
  }
  if ([400, 413, 422].includes(status) && CONTEXT_RE.test(body)) {
    return new LlmContextLengthError(message, { status })
  }
  if (status >= 500) return new LlmServerError(message, { status })
  return new LlmRequestError(message, { status })
}

export function isRetryableLlmError(err: unknown): boolean {
  return err instanceof LlmError && err.retryable
}
