import { type ToolContext, withItem } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getInstalledLlmProvider,
  installLlmProvider,
  mockLlm,
  resetProcessLlm,
  resolveProcessLlm,
  uninstallLlmProvider,
} from '../src/core/llm-install.js'
import { createTitleTranslator } from '../src/modification/chapter-translator.js'
import { runPromptWithRetry } from '../src/normalization/schema/llm.js'

const ctx = { run: { global: { settings: {}, env: {} } } } as unknown as ToolContext

const savedEnv = { ...process.env }

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'MT_LLM_TOOL')
  Reflect.deleteProperty(process.env, 'MT_LLM_MODEL')
  Reflect.deleteProperty(process.env, 'MT_LLM_USE')
  uninstallLlmProvider()
})

afterEach(() => {
  process.env = { ...savedEnv }
  uninstallLlmProvider()
  resetProcessLlm()
})

describe('mockLlm provider', () => {
  it('is an offline mock choice with an install() hook', () => {
    const provider = mockLlm({ source: ['answer'] })
    expect(provider.tool).toBe('mock')
    expect(provider.model).toBe('mock')
    expect(typeof provider.install).toBe('function')
    provider.install()
    expect(getInstalledLlmProvider()?.tool).toBe('mock')
  })
})

describe('resolveProcessLlm', () => {
  it('returns the installed provider when the picked backend is mock (default)', () => {
    installLlmProvider(mockLlm({ source: ['x'] }))
    expect(resolveProcessLlm()?.tool).toBe('mock')
  })

  it('returns undefined when nothing is installed and the backend is mock', () => {
    expect(resolveProcessLlm()).toBeUndefined()
  })

  it('MT_LLM_TOOL naming a real backend beats the installed mock', () => {
    installLlmProvider(mockLlm())
    process.env.MT_LLM_TOOL = 'ollama'
    resetProcessLlm()
    expect(resolveProcessLlm()?.tool).toBe('ollama')
  })

  it('uninstall restores the undefined default', () => {
    installLlmProvider(mockLlm())
    uninstallLlmProvider()
    expect(resolveProcessLlm()).toBeUndefined()
  })
})

describe('factory fallback (no explicit call)', () => {
  it('runPromptWithRetry uses the installed mock when no call is passed', async () => {
    installLlmProvider(mockLlm({ source: ['mock summary'] }))
    const result = await runPromptWithRetry(ctx, {
      systemPrompt: 'sys',
      userPrompt: 'Summarise.',
      validate: (content) => ({ ok: true, value: content }),
    })
    expect(result.ok).toBe(true)
    expect(result.content).toBe('mock summary')
    expect(result.model).toBe('mock')
  })

  it('an explicit call always wins over the installed mock', async () => {
    installLlmProvider(mockLlm({ source: ['installed'] }))
    const result = await runPromptWithRetry(ctx, {
      systemPrompt: 'sys',
      userPrompt: 'Summarise.',
      call: async () => ({
        content: 'explicit',
        model: 'm',
        tokens: 1,
        promptTokens: 1,
        completionTokens: 0,
      }),
      validate: (content) => ({ ok: true, value: content }),
    })
    expect(result.content).toBe('explicit')
  })

  it('createTitleTranslator without translate resolves the installed mock at invoke time', async () => {
    installLlmProvider(mockLlm({ source: ['Переведённый заголовок'] }))
    const translator = createTitleTranslator()
    const res = await translator.invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { text: '# Hello\n\nBody text.', targetLang: 'ru' },
        meta: {},
      },
      ctx,
    )
    expect(res.item.text).toContain('Переведённый заголовок')
    expect(res.item.text).toContain('Body text.')
    expect(res.item.titleTranslated).toBe(true)
  })

  it('createTitleTranslator with an explicit translate keeps it (no registry lookup)', async () => {
    installLlmProvider(mockLlm({ source: ['installed'] }))
    const translator = createTitleTranslator({
      translate: {
        name: 'fixed-translate',
        version: '1.0.0',
        mdDescription: 'test double',
        async invoke(env) {
          return withItem(env, { ...env.item, translatedText: `fixed:${env.item.text}` })
        },
      },
    })
    const res = await translator.invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { text: '# Hello\n\nBody.', targetLang: 'ru' },
        meta: {},
      },
      ctx,
    )
    expect(res.item.text).toContain('fixed:Hello')
    expect(res.item.text).toContain('Body.')
  })
})
