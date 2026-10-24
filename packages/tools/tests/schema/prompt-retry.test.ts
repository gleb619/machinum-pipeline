import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_ROUTER_URL,
  attemptMeta,
  resolveLlmOptions,
  runPromptWithRetry,
} from '../../src/normalization/schema/llm.js'
import { installRouter, toolContext } from './mock-router.js'

let router: ReturnType<typeof installRouter> | undefined

afterEach(() => {
  router?.restore()
  router = undefined
  vi.restoreAllMocks()
})

const acceptThreeWords = (content: string) =>
  content.split(/\s+/).length >= 3
    ? { ok: true as const, value: content }
    : { ok: false as const, reason: 'answer must contain at least three words' }

describe('runPromptWithRetry', () => {
  it('sends one user message plus the system prompt to the router from the run context', async () => {
    router = installRouter(['a full sentence answer'])

    const result = await runPromptWithRetry(toolContext('http://router.test'), {
      systemPrompt: 'be brief',
      userPrompt: 'summarise this',
      validate: acceptThreeWords,
    })

    expect(result).toMatchObject({ ok: true, attempts: 1, value: 'a full sentence answer' })
    expect(router.calls).toHaveLength(1)
    const call = router.calls[0]
    expect(call?.url).toBe('http://router.test/api/chat/completions')
    expect(call?.model).toBe(DEFAULT_LLM_MODEL)
    expect(call?.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'summarise this' },
    ])
  })

  it('defaults the router URL when the run context has none', async () => {
    router = installRouter(['a full sentence answer'])

    await runPromptWithRetry({ run: { global: {} } } as never, {
      systemPrompt: 's',
      userPrompt: 'u',
      validate: acceptThreeWords,
    })

    expect(router.calls[0]?.url).toBe(`${DEFAULT_ROUTER_URL}/api/chat/completions`)
  })

  it('passes model, temperature and maxTokens through', async () => {
    router = installRouter(['a full sentence answer'])

    await runPromptWithRetry(toolContext(), {
      systemPrompt: 's',
      userPrompt: 'u',
      validate: acceptThreeWords,
      model: 'anthropic/claude-sonnet-4',
      temperature: 0.2,
      maxTokens: 512,
    })

    expect(router.calls[0]).toMatchObject({
      model: 'anthropic/claude-sonnet-4',
      temperature: 0.2,
      max_tokens: 512,
    })
  })

  it('re-prompts with the rejection reason until the answer validates', async () => {
    router = installRouter(['too short', 'now a proper long answer', 'unused'])

    const result = await runPromptWithRetry(toolContext(), {
      systemPrompt: 's',
      userPrompt: 'original prompt',
      validate: acceptThreeWords,
    })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.failures).toEqual(['answer must contain at least three words'])
    expect(router.calls).toHaveLength(2)
    expect(router.lastPrompt()).toContain('original prompt')
    expect(router.lastPrompt()).toContain('attempt 1 of 3')
    expect(router.lastPrompt()).toContain('answer must contain at least three words')
  })

  it('gives up after the attempt budget and reports the last failure instead of throwing', async () => {
    router = installRouter(['too short'])

    const result = await runPromptWithRetry(toolContext(), {
      systemPrompt: 's',
      userPrompt: 'u',
      validate: acceptThreeWords,
    })

    expect(result.ok).toBe(false)
    expect(result.value).toBeUndefined()
    expect(result.attempts).toBe(DEFAULT_MAX_ATTEMPTS)
    expect(result.lastFailure).toBe('answer must contain at least three words')
    expect(router.calls).toHaveLength(DEFAULT_MAX_ATTEMPTS)
  })

  it('honours a custom attempt budget', async () => {
    router = installRouter(['too short'])

    const result = await runPromptWithRetry(toolContext(), {
      systemPrompt: 's',
      userPrompt: 'u',
      validate: acceptThreeWords,
      maxAttempts: 2,
    })

    expect(result.attempts).toBe(2)
    expect(router.calls).toHaveLength(2)
  })

  it('treats a refused router connection as a failed attempt, not an error', async () => {
    router = installRouter([new Error('connect ECONNREFUSED 127.0.0.1:7777')])

    const result = await runPromptWithRetry(toolContext(), {
      systemPrompt: 's',
      userPrompt: 'u',
      validate: acceptThreeWords,
    })

    expect(result.ok).toBe(false)
    expect(result.lastFailure).toContain('ECONNREFUSED')
  })

  it('records an HTTP failure from the proxy as a failure reason', async () => {
    router = installRouter([{ status: 503, body: 'no keys left' }])

    const result = await runPromptWithRetry(toolContext(), {
      systemPrompt: 's',
      userPrompt: 'u',
      validate: acceptThreeWords,
    })

    expect(result.ok).toBe(false)
    expect(result.lastFailure).toContain('503')
    expect(result.lastFailure).toContain('no keys left')
  })

  it('rejects an empty completion and retries', async () => {
    router = installRouter(['   ', 'a full sentence answer'])

    const result = await runPromptWithRetry(toolContext(), {
      systemPrompt: 's',
      userPrompt: 'u',
      validate: acceptThreeWords,
    })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.failures).toEqual(['the response was empty'])
  })

  it('accumulates tokens across attempts and reports the model', async () => {
    router = installRouter(['too short', 'now a proper long answer'])

    const result = await runPromptWithRetry(toolContext(), {
      systemPrompt: 's',
      userPrompt: 'u',
      validate: acceptThreeWords,
    })

    expect(result.tokens).toBe(240)
    expect(result.model).toBe(DEFAULT_LLM_MODEL)
  })
})

describe('attemptMeta', () => {
  it('sums attempts and tokens and flags the fallback with its reason', async () => {
    router = installRouter(['too short'])

    const results = [
      await runPromptWithRetry(toolContext(), {
        systemPrompt: 's',
        userPrompt: 'u',
        validate: acceptThreeWords,
      }),
    ]
    const meta = attemptMeta(results)

    expect(meta).toEqual({
      attempts: DEFAULT_MAX_ATTEMPTS,
      tokens: DEFAULT_MAX_ATTEMPTS * 120,
      model: DEFAULT_LLM_MODEL,
      fallbackUsed: true,
      lastFailure: 'answer must contain at least three words',
    })
  })

  it('reports no fallback when every item validated', async () => {
    router = installRouter(['a full sentence answer'])

    const results = [
      await runPromptWithRetry(toolContext(), {
        systemPrompt: 's',
        userPrompt: 'u',
        validate: acceptThreeWords,
      }),
    ]

    expect(attemptMeta(results)).toMatchObject({ attempts: 1, fallbackUsed: false })
  })
})

describe('resolveLlmOptions', () => {
  it('lets meta override the tool options and the prompt templates', () => {
    const resolved = resolveLlmOptions(
      { model: 'tool/model', userPrompt: 'tool prompt', systemPrompt: 'tool system' },
      {
        schemaDocLlm: { model: 'meta/model', maxAttempts: 5, temperature: 0.1 },
        summaryPrompt: 'meta prompt',
        summarySystemPrompt: 'meta system',
      },
      'summary',
    )

    expect(resolved).toEqual({
      model: 'meta/model',
      temperature: 0.1,
      maxAttempts: 5,
      userPrompt: 'meta prompt',
      systemPrompt: 'meta system',
    })
  })

  it('ignores malformed meta overrides', () => {
    const resolved = resolveLlmOptions(
      { model: 'tool/model' },
      { schemaDocLlm: 'nope', summaryPrompt: 42 },
      'summary',
    )

    expect(resolved).toEqual({ model: 'tool/model' })
  })
})
