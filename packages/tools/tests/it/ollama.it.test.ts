import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  ollamaHealth,
  ollamaTool,
} from '../../src/core/ollama-tool.js'

/**
 * GPU integration test: the real remote ollama server, no mocks.
 * Run with `pnpm test:gpu` — excluded from `pnpm test` (see `vitest.config.ts`).
 * An unreachable server is a **failure with a clear message**, never a silent skip:
 * `pnpm test:gpu` is part of merge acceptance (docs/change-workflow.md), so the gate result
 * must be visible in the report.
 */

/** Minimal ctx: no layer above env, so `MT_OLLAMA_URL` / `MT_OLLAMA_MODEL` still apply. */
const ctx = {} as unknown as ToolContext

/** Same endpoint the gate resolves: provider env var wins over the preset default. */
const baseUrl = process.env.MT_OLLAMA_URL ?? OLLAMA_BASE_URL

const gateHint =
  'The ollama server on borispc3.ai:7869 must be up to run `pnpm test:gpu`. ' +
  'Report this failure — do not skip the GPU gate and do not merge without it.'

function unreachable(root: string, error?: string): Error {
  const detail = error ?? 'health check failed'
  return new Error(
    `GPU server unreachable at ${root} (default ${OLLAMA_BASE_URL}): ${detail}. ${gateHint}`,
  )
}

describe('ollama GPU integration', () => {
  it('answers the native health check', async () => {
    const health = await ollamaHealth(baseUrl)
    if (!health.ok) throw unreachable(health.baseUrl, health.error)
    expect(health.version).toMatch(/^\d+\./)
  }, 10_000)

  it('completes one short chat on the GPU model', async () => {
    const health = await ollamaHealth(baseUrl)
    if (!health.ok) throw unreachable(health.baseUrl, health.error)

    const started = Date.now()
    let content: string
    let model: string
    let completionTokens: number
    try {
      const out = await ollamaTool.invoke(
        {
          item: { prompt: 'Reply with exactly: GPU OK', temperature: 0, maxTokens: 16 },
          meta: {},
        },
        ctx,
      )
      content = out.item.content
      model = out.item.model
      completionTokens = out.item.completionTokens
      expect(out.meta.ollama).toBe(true)
    } catch (err) {
      throw new Error(
        `Chat completion failed against ${health.baseUrl} (model ${OLLAMA_MODEL}, ` +
          `${Date.now() - started}ms): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }

    expect(content.trim()).not.toBe('')
    expect(model).not.toBe('')
    expect(completionTokens).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(30_000)
  }, 30_000)
})
