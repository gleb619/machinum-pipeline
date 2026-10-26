import { getVariable } from '@mt/core'
import type { Exchange } from '@mt/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTE_COUNT,
  createNotesSummaryTool,
  notesSummaryTool,
  renderSummaryNotes,
} from '../../src/normalization/schema/summary.js'
import { exchangeOf } from '../exchange-helper.js'
import { CHAPTER, CHAPTER_TWO, installRouter, toolContext } from './mock-router.js'
import type { MockRouter } from './mock-router.js'

let router: MockRouter | undefined

afterEach(() => {
  router?.restore()
  router = undefined
})

const NOTES_REPLY = [
  '- Sir Aldric rides out of Thornhaven at dawn with his grey mare.',
  '- The road into the Darkwood narrows as the trees close in.',
  '- Aldric counts his coins and thinks of the Duke’s tribunal.',
].join('\n')

function envelopeOf(item: string, fields: Record<string, unknown> = {}): Exchange<string> {
  return exchangeOf(item, fields)
}

describe('createNotesSummaryTool (LLM summary notes)', () => {
  it('stores the bullet notes and the rendered block', async () => {
    router = installRouter([NOTES_REPLY])

    const result = await notesSummaryTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(result.item).toBe(CHAPTER)
    expect(getVariable(result, 'summaryNotes')).toEqual([
      'Sir Aldric rides out of Thornhaven at dawn with his grey mare.',
      'The road into the Darkwood narrows as the trees close in.',
      'Aldric counts his coins and thinks of the Duke’s tribunal.',
    ])
    expect(getVariable(result, 'summary')).toBe(NOTES_REPLY)
    expect(getVariable(result, 'summaryNotesLlm')).toMatchObject({
      attempts: 1,
      fallbackUsed: false,
    })
  })

  it('prompts with the bundled md prompts, count rendered into the user turn', async () => {
    router = installRouter([NOTES_REPLY])

    await createNotesSummaryTool({ count: 3 }).invoke(envelopeOf(CHAPTER), toolContext())

    const system = router.calls[0]?.messages[0]?.content ?? ''
    const user = router.lastPrompt()
    expect(system).toContain('Web Novel Summary Notes Generator')
    expect(system).toContain('Each item must start with a dash')
    expect(user).toContain('exactly 3** plain text summary notes')
    expect(user).toContain('<context>')
    expect(user).toContain('Sir Aldric rode out of Thornhaven at dawn')
    expect(user).not.toContain('{{count}}')
    expect(user).not.toContain('{{text}}')
  })

  it('defaults to DEFAULT_NOTE_COUNT in the prompt', async () => {
    router = installRouter([NOTES_REPLY])

    await notesSummaryTool.invoke(envelopeOf(CHAPTER), toolContext())

    expect(router.lastPrompt()).toContain(`exactly ${DEFAULT_NOTE_COUNT}`)
  })

  it('accepts a fenced answer', async () => {
    router = installRouter([`\`\`\`\n${NOTES_REPLY}\n\`\`\``])

    const result = await createNotesSummaryTool({ count: 3 }).invoke(
      envelopeOf(CHAPTER),
      toolContext(),
    )

    expect((getVariable(result, 'summaryNotes') as string[]).length).toBe(3)
    expect(getVariable(result, 'summaryNotesLlm')).toMatchObject({ attempts: 1 })
  })

  it('retries when a line is not a "- " bullet', async () => {
    router = installRouter(['Aldric rides out. He thinks of the tribunal.', NOTES_REPLY])

    const result = await createNotesSummaryTool({ count: 3 }).invoke(
      envelopeOf(CHAPTER),
      toolContext(),
    )

    expect(getVariable(result, 'summaryNotesLlm')).toMatchObject({
      attempts: 2,
      fallbackUsed: false,
    })
    expect(router.lastPrompt()).toContain("every line must be a '- ' bullet")
  })

  it('drops notes beyond the requested count', async () => {
    router = installRouter([`${NOTES_REPLY}\n- Fourth note that was not asked for.`])

    const result = await createNotesSummaryTool({ count: 3 }).invoke(
      envelopeOf(CHAPTER),
      toolContext(),
    )

    expect(getVariable(result, 'summaryNotes')).toHaveLength(3)
  })

  it('falls back to the chapter lead sentences when the router fails', async () => {
    router = installRouter([{ status: 503, body: 'router unavailable' }])

    const result = await createNotesSummaryTool({ count: 2 }).invoke(
      envelopeOf(CHAPTER),
      toolContext(),
    )

    expect(getVariable(result, 'summaryNotes')).toEqual([
      'Sir Aldric rode out of Thornhaven at dawn, alone except for his grey mare.',
      'The road into the Darkwood narrowed until the trees closed in like witnesses.',
    ])
    expect(getVariable(result, 'summary')).toBe(
      renderSummaryNotes(getVariable(result, 'summaryNotes') as string[]),
    )
    expect(getVariable(result, 'summaryNotesLlm')).toMatchObject({
      attempts: 3,
      fallbackUsed: true,
    })
  })

  it('keeps one note set per item when batching', async () => {
    router = installRouter([NOTES_REPLY, '- Second chapter opens with an ambush in the Darkwood.'])

    const result = await createNotesSummaryTool({ count: 3 }).invoke(
      { id: 'ex-test', variables: [], item: CHAPTER, items: [CHAPTER, CHAPTER_TWO], meta: {} },
      toolContext(),
    )

    expect(getVariable(result, 'summaryNotes')).toHaveLength(3)
    expect(getVariable(result, 'summaryNotesByItem')).toHaveLength(2)
    expect((getVariable(result, 'summaryNotesByItem') as string[][])[1]).toEqual([
      'Second chapter opens with an ambush in the Darkwood.',
    ])
    expect(getVariable(result, 'summaryNotesLlm')).toMatchObject({
      attempts: 2,
      fallbackUsed: false,
    })
  })

  it('takes the user prompt from meta and still renders count / text', async () => {
    router = installRouter([NOTES_REPLY])

    await createNotesSummaryTool({ count: 3 }).invoke(
      envelopeOf(CHAPTER, { summaryNotesPrompt: 'Notes for {{title}} ({{count}}):\n{{text}}' }),
      toolContext(),
    )

    expect(router.lastPrompt()).toContain('Notes for Chapter 1: The Road from Thornhaven (3):')
  })

  it('leaves an existing summary untouched when nothing can be extracted', async () => {
    router = installRouter([{ status: 503, body: 'router unavailable' }])
    const empty = '# Chapter 9\n\n```\ncode only\n```'

    const result = await notesSummaryTool.invoke(
      envelopeOf(empty, { summary: 'earlier summary' }),
      toolContext(),
    )

    expect(getVariable(result, 'summaryNotes')).toEqual([])
    expect(getVariable(result, 'summary')).toBe('earlier summary')
    expect(getVariable(result, 'summaryNotesLlm')).toMatchObject({ fallbackUsed: true })
  })
})
