import { defineTool, setVariable, setVariables } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { get_encoding } from 'tiktoken'

/** Variables written by the token counters. */
export const VAR_TOKEN_COUNT = 'tokenCount'
export const VAR_TOKEN_COUNTS = 'tokenCounts'

const ENCODING = 'cl100k_base'

type Encoder = ReturnType<typeof get_encoding>

/**
 * Counts tokens in a string envelope item using tiktoken (cl100k_base).
 * Adds `tokenCount` to the envelope meta.
 *
 * Simple variant: creates and frees the encoder on every call — clean each
 * time, no shared state, safe for retries and parallel runs.
 */
export const tokenCounter = defineTool<string, string>({
  name: 'token-counter',
  version: '1.0.0',
  mdDescription:
    'Counts tokens in a string envelope item using tiktoken (cl100k_base). Adds `tokenCount` to the envelope meta. Creates/frees the encoder per call.',
  async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string>> {
    const encoder = get_encoding(ENCODING)
    try {
      const tokenCount = encoder.encode(env.item).length
      return setVariable(env, VAR_TOKEN_COUNT, tokenCount)
    } finally {
      encoder.free()
    }
  },
})

/**
 * Batch-optimized token counter. Designed for batched envelopes (place after
 * `.batch(n)`): opens one encoder per batch invoke and frees it in `finally` —
 * exactly one create/free cycle per batch.
 *
 * Adds `tokenCounts` (per-item) and `tokenCount` (batch total) to the meta.
 */
export const tokenCounterBatch = defineTool<string, string>({
  name: 'token-counter-batch',
  version: '1.0.0',
  mdDescription:
    'Counts tokens for a batched envelope (`items` after `.batch(n)`) using tiktoken (cl100k_base). One encoder create/free per batch. Adds `tokenCounts` (per item) and `tokenCount` (batch total) to the envelope meta.',
  async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string>> {
    const items: string[] = env.items ?? [env.item]
    const encoder = get_encoding(ENCODING)
    try {
      const tokenCounts = items.map((text) => encoder.encode(text).length)
      return setVariables(env, {
        [VAR_TOKEN_COUNTS]: tokenCounts,
        [VAR_TOKEN_COUNT]: tokenCounts.reduce((sum, n) => sum + n, 0),
      })
    } finally {
      encoder.free()
    }
  },
})

let cachedEncoder: Encoder | undefined
let cachedEncoderExitHookInstalled = false

function getCachedEncoder(): Encoder {
  if (!cachedEncoder) {
    cachedEncoder = get_encoding(ENCODING)
  }
  if (!cachedEncoderExitHookInstalled) {
    cachedEncoderExitHookInstalled = true
    process.on('exit', () => {
      cachedEncoder?.free()
      cachedEncoder = undefined
    })
  }
  return cachedEncoder
}

/**
 * Batch-optimized token counter with a process-lifetime cached encoder.
 * Reuses one encoder across all invocations and frees it on process exit —
 * exactly one create/free cycle per process. Use for large runs where
 * per-batch encoder construction dominates.
 *
 * Adds `tokenCounts` (per-item) and `tokenCount` (batch total) to the meta.
 */
export const tokenCounterBatchCached = defineTool<string, string>({
  name: 'token-counter-batch-cached',
  version: '1.0.0',
  mdDescription:
    'Counts tokens for a batched envelope (`items` after `.batch(n)`) using tiktoken (cl100k_base). Reuses one encoder process-wide, freed on process exit. Adds `tokenCounts` (per item) and `tokenCount` (batch total) to the envelope meta.',
  async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string>> {
    const items: string[] = env.items ?? [env.item]
    const encoder = getCachedEncoder()
    const tokenCounts = items.map((text) => encoder.encode(text).length)
    return setVariables(env, {
      [VAR_TOKEN_COUNTS]: tokenCounts,
      [VAR_TOKEN_COUNT]: tokenCounts.reduce((sum, n) => sum + n, 0),
    })
  },
})

/**
 * Token count for plain text using the process-wide cached encoder (cl100k_base).
 * Shared by LLM context-window management.
 */
export function countTextTokens(text: string): number {
  return getCachedEncoder().encode(text).length
}
