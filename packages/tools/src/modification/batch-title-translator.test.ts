import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ToolContext, createExchange } from '@mt/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SchemaDocLlmCall } from '../normalization/schema/llm.js'
import { createBatchTitleTranslator } from './batch-title-translator.js'

interface TitleInput {
  text: string
  targetLang: string
  sourceLang?: string
}

const ctx = {} as ToolContext

let chaptersDir: string
beforeAll(() => {
  chaptersDir = mkdtempSync(join(tmpdir(), 'mt-tools-titles-'))
})
afterAll(() => {
  rmSync(chaptersDir, { recursive: true, force: true })
})

function xmlReply(ids: number[], lines: string[]): string {
  return ids
    .map((id, i) => `<result><id>${id}</id><translated>${lines[i] ?? ''}</translated></result>`)
    .join('\n')
}

function stubCall(content: string): SchemaDocLlmCall {
  return async () => ({
    content,
    model: 'stub',
    tokens: 10,
    promptTokens: 8,
    completionTokens: 2,
    finishReason: 'stop',
  })
}

describe('createBatchTitleTranslator', () => {
  it('translates a title batch in one XML request and preserves member order', async () => {
    const tool = createBatchTitleTranslator({
      chaptersDir,
      call: stubCall(xmlReply([1, 2], ['Глава 1: Дорога', 'Глава 2: Тьма'])),
    })
    const input = [
      { text: '# Chapter 1: The Road', targetLang: 'ru' },
      { text: '# Chapter 2: Dark', targetLang: 'ru' },
    ]
    const out = await tool.invoke(
      createExchange<TitleInput>(input[0] as TitleInput, { items: input }),
      ctx,
    )
    expect(out.item).toEqual([{ text: '# Глава 1: Дорога' }, { text: '# Глава 2: Тьма' }])
  })

  it('wraps a single title back into one item', async () => {
    const tool = createBatchTitleTranslator({
      chaptersDir,
      call: stubCall(xmlReply([1], ['Глава 1: Дорога'])),
    })
    const out = await tool.invoke(
      createExchange({ text: '# Chapter 1: The Road', targetLang: 'ru' }),
      ctx,
    )
    expect(out.item).toEqual({ text: '# Глава 1: Дорога' })
  })

  it('rejects a reply with the wrong line count as retryable', async () => {
    const tool = createBatchTitleTranslator({
      chaptersDir,
      call: stubCall(xmlReply([1], ['Глава 1: Дорога'])),
    })
    const input = [
      { text: '# Chapter 1: The Road', targetLang: 'ru' },
      { text: '# Chapter 2: Dark', targetLang: 'ru' },
    ]
    await expect(
      tool.invoke(createExchange<TitleInput>(input[0] as TitleInput, { items: input }), ctx),
    ).rejects.toMatchObject({
      message: expect.stringContaining('returned 1 line(s) for 2'),
      retryable: true,
    })
  })
})
