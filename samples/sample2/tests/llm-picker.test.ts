import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '@mt/core'
import { pickLlmTool, readLlmConfig } from '../pipelines/llm-picker.js'

const ctx = { run: { global: {} } } as unknown as ToolContext

function configFile(settings: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sample2-mt-'))
  const path = join(dir, 'mt.json')
  writeFileSync(path, JSON.stringify({ settings }), 'utf-8')
  return path
}

describe('readLlmConfig', () => {
  it('falls back to the offline mock backend', () => {
    expect(readLlmConfig({})).toEqual({ tool: 'mock', model: 'mock' })
  })

  it('reads the backend and the model from the env', () => {
    expect(readLlmConfig({ MT_LLM_TOOL: 'ollama', MT_LLM_MODEL: 'llama3.1' })).toEqual({
      tool: 'ollama',
      model: 'llama3.1',
    })
  })

  it('falls back to the backend default model', () => {
    expect(readLlmConfig({ MT_LLM_TOOL: 'ollama' })).toEqual({
      tool: 'ollama',
      model: 'gemma4:latest',
    })
    expect(readLlmConfig({ MT_LLM_TOOL: 'openrouter-free' })).toEqual({
      tool: 'openrouter-free',
      model: 'openrouter/free',
    })
  })

  it('reads the backend and the model from mt.json settings', () => {
    const path = configFile({ 'llm.tool': 'router', 'llm.model': 'my/model' })
    expect(readLlmConfig({}, path)).toEqual({ tool: 'router', model: 'my/model' })
  })

  it('lets the env win over mt.json', () => {
    const path = configFile({ 'llm.tool': 'router', 'llm.model': 'my/model' })
    expect(readLlmConfig({ MT_LLM_TOOL: 'ollama', MT_LLM_MODEL: 'other/model' }, path)).toEqual({
      tool: 'ollama',
      model: 'other/model',
    })
  })

  it('rejects an unknown backend', () => {
    expect(() => readLlmConfig({ MT_LLM_TOOL: 'nope' })).toThrow(/MT_LLM_TOOL/)
  })
})

describe('pickLlmTool', () => {
  it('picks the ollama gate for MT_LLM_TOOL=ollama', () => {
    const choice = pickLlmTool({ env: { MT_LLM_TOOL: 'ollama' } })
    expect(choice.tool).toBe('ollama')
    expect(choice.gate.name).toBe('ollama')
    expect(choice.model).toBe('gemma4:latest')
  })

  it('picks the openrouter-free gate for MT_LLM_TOOL=openrouter-free', () => {
    const choice = pickLlmTool({ env: { MT_LLM_TOOL: 'openrouter-free' } })
    expect(choice.gate.name).toBe('openrouter-free')
  })

  it('picks the openrouter-pool gate for MT_LLM_TOOL=openrouter-pool', () => {
    const choice = pickLlmTool({ env: { MT_LLM_TOOL: 'openrouter-pool' } })
    expect(choice.gate.name).toBe('openrouter-pool')
  })

  it('answers through the mock backend without touching the network', async () => {
    const choice = pickLlmTool({ env: {}, mockSource: ['mock-answer'] })
    const res = await choice.gate.invoke(
      { item: { messages: [{ role: 'user', content: 'hi' }] }, meta: {} },
      ctx,
    )
    expect(res.item.content).toBe('mock-answer')
    expect(res.item.model).toBe('mock')
  })

  it('translates through the picked backend', async () => {
    const choice = pickLlmTool({ env: {}, mockSource: ['mock-translation'] })
    const res = await choice.translate.invoke(
      { item: { text: 'hello', targetLang: 'ru' }, meta: {} },
      ctx,
    )
    expect(res.item.translatedText).toBe('mock-translation')
  })

  it('routes the schema-doc tools through the picked backend', async () => {
    const choice = pickLlmTool({ env: {}, mockSource: ['mock-summary'] })
    const res = await choice.schemaCall(
      { messages: [{ role: 'user', content: 'summarise this' }] },
      ctx,
    )
    expect(res.content).toBe('mock-summary')
    expect(res.model).toBe('mock')
  })
})
