import { describe, expect, it } from 'vitest'

import type { ToolContext } from '@mt/core'
import { mockLlmCall } from '@mt/tools'
import { pickLlmTool, readLlmConfig } from '../pipelines/llm-picker.js'

const vctx = {
  run: {
    global: {
      env: { MT_OLLAMA_MODEL: '', MT_OLLAMA_URL: '' },
      vault: {
        version: 1,
        entries: {
          gpu: { provider: 'ollama', baseUrl: 'http://vault-host:1/v1', defaultModel: 'llama3' },
        },
      },
    },
  },
} as unknown as ToolContext

describe('llm.use vault refs', () => {
  it('MT_LLM_USE is read from env', () => {
    expect(readLlmConfig({ MT_LLM_TOOL: 'ollama', MT_LLM_USE: 'vault://gpu/qwen3:8b' })).toEqual({
      tool: 'ollama',
      model: 'qwen3:8b',
      use: 'vault://gpu/qwen3:8b',
    })
  })

  it('passes the ref to the chosen tool; vault model is not defeated by the picker pin', async () => {
    const llm = pickLlmTool({ env: { MT_LLM_TOOL: 'ollama', MT_LLM_USE: '@vault/gpu' } })
    const mock = mockLlmCall(['ok'])
    await llm.gate.with({ call: mock }).invoke({ item: { prompt: 'hi' }, meta: {} }, vctx)
    expect(mock.calls[0]?.model).toBe('llama3')
  })
})
