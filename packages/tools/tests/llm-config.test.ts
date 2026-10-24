import { describe, expect, it } from 'vitest'
import { redactLlmConfig, resolveLlmConfig } from '../src/llm-config.js'

describe('resolveLlmConfig precedence', () => {
  it('defaults to router provider with legacy model and url', () => {
    const c = resolveLlmConfig()
    expect(c.provider).toBe('router')
    expect(c.model).toBe('openai/gpt-4o-mini')
    expect(c.baseUrl).toBe('http://localhost:7777')
    expect(c.cache).toBe(false)
    expect(c.retry).toEqual({ max: 3, backoffMs: 1000, strategy: 'exp' })
  })

  it('input > tool > meta > settings > env', () => {
    const args = {
      input: { model: 'in' },
      tool: { model: 'tool' },
      meta: { llm: { model: 'meta' } },
      settings: { 'llm.model': 'settings' },
      env: { MT_LLM_MODEL: 'env' },
    }
    expect(resolveLlmConfig(args).model).toBe('in')
    expect(resolveLlmConfig({ ...args, input: undefined }).model).toBe('tool')
    expect(resolveLlmConfig({ ...args, input: undefined, tool: undefined }).model).toBe('meta')
    expect(
      resolveLlmConfig({ ...args, input: undefined, tool: undefined, meta: undefined }).model,
    ).toBe('settings')
    expect(resolveLlmConfig({ env: args.env }).model).toBe('env')
    expect(resolveLlmConfig({ env: args.env }).sources.model).toBe('env')
  })

  it('provider picks defaults for model and base url', () => {
    const a = resolveLlmConfig({ tool: { provider: 'anthropic' }, env: { ANTHROPIC_API_KEY: 'k' } })
    expect(a.baseUrl).toBe('https://api.anthropic.com')
    expect(a.model).toMatch(/claude/)
    expect(a.apiKey).toBe('k')
    expect(resolveLlmConfig({ tool: { provider: 'ollama' } }).baseUrl).toBe(
      'http://localhost:11434/v1',
    )
    expect(resolveLlmConfig({ tool: { provider: 'openai' } }).baseUrl).toBe(
      'https://api.openai.com/v1',
    )
  })

  it('router base url: ctx routerUrl > MT_ROUTER_URL > default; MT_LLM_BASE_URL beats both', () => {
    const env = { MT_ROUTER_URL: 'http://env:1' }
    expect(resolveLlmConfig({ env }).baseUrl).toBe('http://env:1')
    expect(resolveLlmConfig({ env, routerUrl: 'http://ctx:2' }).baseUrl).toBe('http://ctx:2')
    expect(
      resolveLlmConfig({
        env: { ...env, MT_LLM_BASE_URL: 'http://x:3' },
        routerUrl: 'http://ctx:2',
      }).baseUrl,
    ).toBe('http://x:3')
  })

  it('provider is never inferred from keys', () => {
    expect(
      resolveLlmConfig({ env: { OPENAI_API_KEY: 'k', OPENROUTER_API_KEYS: 'a,b' } }).provider,
    ).toBe('router')
  })

  it('openrouter key pool from OPENROUTER_API_KEYS', () => {
    const c = resolveLlmConfig({
      env: { MT_LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEYS: 'a, b ,c' },
    })
    expect(c.provider).toBe('openrouter')
    expect(c.apiKeys).toEqual(['a', 'b', 'c'])
    expect(c.apiKey).toBe('a')
    expect(c.baseUrl).toBe('https://openrouter.ai/api/v1')
  })

  it('apiKey from meta is ignored (meta is checkpointed)', () => {
    const c = resolveLlmConfig({
      tool: { provider: 'openai' },
      meta: { llm: { apiKey: 'leak', model: 'm' } },
    })
    expect(c.apiKey).toBeUndefined()
    expect(c.model).toBe('m')
  })

  it('retry: ctx defaults merged under layers', () => {
    const base = { max: 5, backoffMs: 10, strategy: 'fixed' as const }
    expect(resolveLlmConfig({ retryDefault: base }).retry).toEqual(base)
    expect(resolveLlmConfig({ retryDefault: base, tool: { retry: { max: 1 } } }).retry).toEqual({
      ...base,
      max: 1,
    })
  })

  it('timeout and cache from env', () => {
    const c = resolveLlmConfig({ env: { MT_LLM_TIMEOUT_MS: '500', MT_LLM_CACHE: 'true' } })
    expect(c.timeoutMs).toBe(500)
    expect(c.cache).toBe(true)
  })

  it('unknown provider fails clearly; custom needs base url', () => {
    expect(() => resolveLlmConfig({ env: { MT_LLM_PROVIDER: 'nope' } })).toThrow(
      /Unknown LLM provider/,
    )
    expect(() => resolveLlmConfig({ tool: { provider: 'custom' } })).toThrow(/requires a baseUrl/)
    expect(resolveLlmConfig({ tool: { provider: 'custom', baseUrl: 'http://h/v1' } }).baseUrl).toBe(
      'http://h/v1',
    )
  })

  it('redact removes secrets', () => {
    const c = resolveLlmConfig({
      tool: { provider: 'openai', apiKey: 'sk-secret', headers: { 'X-Org': 'secret' } },
    })
    const text = JSON.stringify(redactLlmConfig(c))
    expect(text).not.toContain('sk-secret')
    expect(text).not.toContain('"secret"')
    expect(redactLlmConfig(c).hasApiKey).toBe(true)
  })
})
