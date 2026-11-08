import { createExchange } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { buildSftTriples, isPromptEcho, sftTriples } from './sft-triples.js'

const ctx = {} as ToolContext

function lines(jsonl: string): string[] {
  return jsonl.split('\n').filter((line) => line !== '')
}

describe('buildSftTriples', () => {
  it('normalises a system/user/reply record into a three-turn chat triple', () => {
    const jsonl = JSON.stringify({
      system: 'You translate EN to RU.',
      user: 'The door opened.',
      reply: 'Дверь открылась.',
    })
    const { jsonl: out, stats } = buildSftTriples(jsonl)

    expect(stats).toEqual({ recordsIn: 1, recordsOut: 1, dropped: {} })
    expect(lines(out)).toHaveLength(1)
    const triple: unknown = JSON.parse(lines(out)[0] ?? '')
    expect(triple).toEqual({
      messages: [
        { role: 'system', content: 'You translate EN to RU.' },
        { role: 'user', content: 'The door opened.' },
        { role: 'assistant', content: 'Дверь открылась.' },
      ],
    })
  })

  it('accepts `assistant` as an alias for `reply` and omits an empty system turn', () => {
    const { jsonl } = buildSftTriples(
      JSON.stringify({ user: 'Hi', assistant: 'Hello', system: ' ' }),
    )
    const triple = JSON.parse(lines(jsonl)[0] ?? '') as { messages: unknown[] }
    expect(triple.messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ])
  })

  it('collapses a messages record to the last user turn and the assistant turn after it', () => {
    const jsonl = JSON.stringify({
      messages: [
        { role: 'system', content: 'Rules.' },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: 'Second answer' },
      ],
    })
    const { jsonl: out, stats } = buildSftTriples(jsonl)

    expect(stats.recordsOut).toBe(1)
    const triple = JSON.parse(lines(out)[0] ?? '') as {
      messages: Array<{ role: string; content: string }>
    }
    expect(triple.messages.map((m) => m.content)).toEqual([
      'Rules.',
      'Second question',
      'Second answer',
    ])
  })

  it('emits one triple per pair of a chapter record and keeps the system prompt', () => {
    const jsonl = JSON.stringify({
      chapter: 'chapter-1',
      system: 'Translate.',
      pairs: [
        { src: 'One', tgt: 'Один' },
        { src: 'Two', tgt: 'Два' },
      ],
    })
    const { jsonl: out, stats } = buildSftTriples(jsonl)

    expect(stats).toEqual({ recordsIn: 1, recordsOut: 2, dropped: {} })
    const [first, second] = lines(out).map(
      (line) => JSON.parse(line) as { messages: Array<{ role: string; content: string }> },
    )
    expect(first?.messages[0]).toEqual({ role: 'system', content: 'Translate.' })
    expect(first?.messages[1]).toEqual({ role: 'user', content: 'One' })
    expect(second?.messages[2]).toEqual({ role: 'assistant', content: 'Два' })
  })

  it('drops empty assistant turns, prompt echoes and broken lines, counted by reason', () => {
    const jsonl = [
      JSON.stringify({ user: 'Anything', reply: '   ' }),
      JSON.stringify({ user: 'Copy me please', reply: 'copy   ME please' }),
      'not json at all',
      JSON.stringify({ user: 'Keep me', reply: 'Kept.' }),
    ].join('\n')

    const { jsonl: out, stats } = buildSftTriples(jsonl)

    expect(stats.recordsIn).toBe(4)
    expect(stats.recordsOut).toBe(1)
    expect(stats.dropped).toEqual({
      'empty-assistant': 1,
      'prompt-echo': 1,
      'invalid-json': 1,
    })
    expect(JSON.parse(lines(out)[0] ?? '')).toMatchObject({
      messages: [
        { role: 'user', content: 'Keep me' },
        { role: 'assistant', content: 'Kept.' },
      ],
    })
  })

  it('counts invalid pairs, empty pair lists and unknown shapes without dropping the file', () => {
    const jsonl = [
      JSON.stringify({ chapter: 'c1', pairs: [] }),
      JSON.stringify({ chapter: 'c1', pairs: [{ src: 'only source' }, { src: 'a', tgt: 'b' }] }),
      JSON.stringify({ hello: 'world' }),
      JSON.stringify([1, 2, 3]),
    ].join('\n')

    const { stats } = buildSftTriples(jsonl)

    expect(stats.dropped).toEqual({
      'empty-pairs': 1,
      'invalid-pair': 1,
      'invalid-shape': 2,
    })
    expect(stats.recordsOut).toBe(1)
  })

  it('emits JSONL with a trailing newline and an empty string for no records', () => {
    const { jsonl } = buildSftTriples(JSON.stringify({ user: 'a', reply: 'b' }))
    expect(jsonl.endsWith('\n')).toBe(true)
    expect(buildSftTriples('\n\n').jsonl).toBe('')
    expect(buildSftTriples('').stats.recordsIn).toBe(0)
  })
})

describe('isPromptEcho', () => {
  it('ignores case and whitespace but not content', () => {
    expect(isPromptEcho('HELLO\n  world', 'hello world')).toBe(true)
    expect(isPromptEcho('hello there', 'hello world')).toBe(false)
  })
})

describe('sftTriples tool', () => {
  it('writes recordsIn, recordsOut and dropped into meta and returns JSONL in the item', async () => {
    const jsonl = [
      JSON.stringify({ user: 'Hi', reply: 'Hello' }),
      JSON.stringify({ user: 'Echo', reply: 'Echo' }),
    ].join('\n')

    const out = await sftTriples.invoke(createExchange(jsonl), ctx)

    expect(out.meta).toMatchObject({ recordsIn: 2, recordsOut: 1, dropped: { 'prompt-echo': 1 } })
    expect(lines(out.item)).toHaveLength(1)
  })

  it('rejects a non-string item with an actionable message', async () => {
    const item = { not: 'jsonl' } as unknown as string
    await expect(sftTriples.invoke(createExchange(item), ctx)).rejects.toThrow(
      'sft-triples: item must be a JSONL string',
    )
  })
})
