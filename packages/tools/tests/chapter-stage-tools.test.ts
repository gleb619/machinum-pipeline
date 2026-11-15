import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExchange, getVariable, variable } from '@mt/core'
import type { Exchange, MdOutputEntry, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { LlmError } from '../src/core/llm-errors.js'
import { createAnalyzeOutputs } from '../src/modification/analyze-outputs.js'
import { createTranslateOutputs } from '../src/modification/translate-outputs.js'
import {
  chapterRecordMapper,
  lineTextToMarkdown,
  toChapterRecord,
  unwrapMarkdownText,
} from '../src/normalization/chapter-record.js'
import { readGlossaryFile } from '../src/normalization/glossary-extractor.js'
import { createLlmSummaryWithFallback } from '../src/normalization/llm-summary.js'
import { createLlmTypoFix } from '../src/normalization/llm-typo-fix.js'
import {
  chaptersToTitleInputs,
  createChapterBodyTranslator,
  createGlossaryTitleTranslator,
  loadGlossaryOrEmpty,
  onlyChapters,
  titleOf,
  translateConcurrency,
  translateTaggedChapter,
} from '../src/normalization/translation-stage.js'
import type { TranslateChapterStats } from '../src/normalization/translation-stage.js'
import { chapterPairsLinter } from '../src/verification/chapter-pairs-linter.js'
import { LineParityError } from '../src/verification/line-parity-linter.js'

const noop = () => {}
const ctx = {
  run: { global: {}, logger: { info: noop, warn: noop, error: noop, debug: noop } },
} as unknown as ToolContext
const reply = (content: string) => async () => ({
  content,
  model: 'm',
  tokens: 0,
  promptTokens: 0,
  completionTokens: 0,
})

function chaptersDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mt-stage-'))
  mkdirSync(join(dir, 'schema'))
  writeFileSync(join(dir, 'schema', 'chapter1.summary.md'), '# T\n\n## Summary\n\nShort.\n')
  writeFileSync(join(dir, 'glossary.json'), JSON.stringify({ terms: [] }))
  return dir
}

describe('chapter record tools', () => {
  it('toChapterRecord reads the number from the title, else the key', () => {
    expect(toChapterRecord({ key: 'k', value: 'Chapter 7: Hi\nbody' })).toEqual({
      title: 'Chapter 7: Hi',
      body: 'body',
      chapterNum: 7,
    })
    expect(toChapterRecord({ key: 'x/chapter-3', value: 'Prologue\nb' }).chapterNum).toBe(3)
    expect(() => toChapterRecord({ key: 'x', value: 'Prologue' })).toThrow(/chapter number/)
  })

  it('maps -> markdown -> unwrap', async () => {
    const mapped = await chapterRecordMapper.invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { key: 'k', value: 'Chapter 2: A\nl1\n\nl2' },
        meta: {},
      },
      ctx,
    )
    expect(mapped.meta.chapterNum).toBe(2)
    const md = await lineTextToMarkdown.invoke(mapped, ctx)
    expect(md.item.text).toBe('# Chapter 2: A\n\nl1\n\nl2\n')
    const un = await unwrapMarkdownText.invoke(
      { id: 'ex-test', variables: [], item: { text: '\\[sys\\]' } as never, meta: {} },
      ctx,
    )
    expect(un.item).toBe('[sys]')
  })
})

describe('llm typo fix / summary', () => {
  it('keeps the original when the line count changes; pass-through when disabled', async () => {
    const bad = createLlmTypoFix({ call: reply('a\nb') })
    expect(
      (await bad.invoke({ id: 'ex-test', variables: [], item: 'x', meta: {} }, ctx)).item,
    ).toBe('x')
    const good = createLlmTypoFix({ call: reply(' fixed ') })
    const out = await good.invoke({ id: 'ex-test', variables: [], item: 'x', meta: {} }, ctx)
    expect(out.item).toBe('fixed')
    expect(getVariable(out, 'llmFixed')).toBe(true)
    const off = createLlmTypoFix({ call: reply('never'), enabled: false })
    expect(
      (await off.invoke({ id: 'ex-test', variables: [], item: 'x', meta: {} }, ctx)).item,
    ).toBe('x')
  })

  it('summary tool passes through when disabled', async () => {
    const off = createLlmSummaryWithFallback({ call: reply('never'), enabled: false })
    const env = createExchange('x', { variables: [variable('summary', 'h')] })
    expect(await off.invoke(env, ctx)).toBe(env)
  })
})

describe('analyze / translate outputs', () => {
  const intents = (ex: Exchange<unknown>) => getVariable<MdOutputEntry[]>(ex, 'mdOutputs') ?? []

  it('analyze outputs: summary + tagged per chapter and the glossary', async () => {
    const tool = createAnalyzeOutputs({ log: false })
    const res = await tool.invoke(
      {
        ...createExchange('', {
          variables: [
            variable('summaryByItem', ['S1']),
            variable('taggedItems', ['# Chapter 1: A\n\nTAG']),
            variable('glossaryJson', '{}'),
          ],
        }),
        items: ['# Chapter 1: A\n\nHe ran.'],
      },
      ctx,
    )
    const out = intents(res)
    expect(out.map((o) => `${o.subdir}/${o.filename}`)).toEqual([
      'schema/chapter1.summary.md',
      'en-tagged/chapter1.md',
      '/glossary.json',
    ])
    expect(out[0]?.content).toContain('## Summary\n\nS1')
    expect(out[1]?.content).toContain('TAG')
  })

  it('translate outputs: ru chapters + merged titles.json', async () => {
    const dir = chaptersDir()
    writeFileSync(join(dir, 'titles.json'), JSON.stringify({ '9': { en: 'Old', ru: 'Старый' } }))
    const tool = createTranslateOutputs({ chaptersDir: dir, log: false })
    const res = await tool.invoke(
      {
        ...createExchange(
          { en: '# Chapter 1: A', ru: '# Глава 1: А' },
          { variables: [variable('chapterNums', [1]), variable('titlesRu', ['Глава 1: А'])] },
        ),
        items: [{ en: '# Chapter 1: A', ru: '# Глава 1: А' }],
      },
      ctx,
    )
    const out = intents(res)
    expect(out[0]).toMatchObject({ subdir: 'ru', filename: 'chapter1.md' })
    const titles = JSON.parse(out[1]?.content ?? '{}')
    expect(titles['9'].ru).toBe('Старый')
    expect(titles['1']).toEqual({ en: 'Chapter 1: A', ru: 'Глава 1: А' })
  })
})

describe('readGlossaryFile', () => {
  it('undefined for missing / malformed files', async () => {
    const dir = chaptersDir()
    expect(await readGlossaryFile(join(dir, 'glossary.json'))).toEqual({ terms: [] })
    expect(await readGlossaryFile(join(dir, 'nope.json'))).toBeUndefined()
  })
})

describe('translation stage', () => {
  it('env helpers', () => {
    expect(onlyChapters({ MT_ONLY_CHAPTERS: '1, 3,x' })).toEqual(new Set([1, 3]))
    expect(onlyChapters({})).toBeUndefined()
    expect(translateConcurrency({ MT_TRANSLATE_CONCURRENCY: '3.7' })).toBe(3)
    expect(translateConcurrency({})).toBe(1)
  })

  it('titleOf takes the last heading', () => {
    expect(titleOf('---\nx: 1\n---\n# Глава 1')).toBe('Глава 1')
    expect(titleOf(' plain ')).toBe('plain')
  })

  it('chaptersToTitleInputs stashes the chapters', async () => {
    const res = await chaptersToTitleInputs.invoke(
      {
        id: 'ex-test',
        variables: [],
        item: '' as never,
        items: ['# Chapter 1: A\nx', 'no heading'] as never,
        meta: {},
      },
      ctx,
    )
    expect(res.items?.map((i) => i.text)).toEqual(['# Chapter 1: A', '# Untitled'])
    expect(getVariable<string[]>(res, 'chapters')).toHaveLength(2)
  })

  it('translateTaggedChapter: line by line, keeps blanks/fences, memoises, rejects bad lines', async () => {
    const calls: string[] = []
    const base = {
      glossary: { terms: [] },
      summary: '',
      titleRu: 'Глава 1',
      concurrency: 2,
      memo: new Map<string, string>(),
    }
    const src = '# Chapter 1\n\nHello there.\n```\ncode\n```\nBye now.'
    const ru = await translateTaggedChapter(src, {
      ...base,
      ask: async (_s, u) => {
        calls.push(u)
        return 'Привет'
      },
    })
    expect(ru).toBe('# Глава 1\n\nПривет\n```\ncode\n```\nПривет')
    expect(calls).toHaveLength(2)
    await translateTaggedChapter(src, { ...base, ask: async () => 'нет' })
    expect(calls).toHaveLength(2) // second run served from the memo
    await expect(
      translateTaggedChapter('Hi there.', { ...base, memo: new Map(), ask: async () => '' }),
    ).rejects.toThrow()
  })

  it('translateTaggedChapter: passes the chapter so term timelines resolve at it', async () => {
    const systems: string[] = []
    const glossary = {
      terms: [
        {
          id: 'arin',
          term: 'Arin',
          type: 'character' as const,
          count: 2,
          firstChapter: 1,
          ru: 'Арин',
          aliases: [],
          ruTimeline: [{ chapter: 2, value: 'Арина' }],
        },
      ],
    }
    const src = '# Chapter 2\n\n<term id="arin">Arin</term> left.'
    await translateTaggedChapter(src, {
      glossary,
      summary: '',
      chapter: 1,
      titleRu: 'Глава 2',
      concurrency: 1,
      ask: async (s) => {
        systems.push(s)
        return 'Ушёл'
      },
    })
    expect(systems.some((s) => s.includes('Arin = Арин'))).toBe(true)
    expect(systems.some((s) => s.includes('Arin = Арина'))).toBe(false)
    await translateTaggedChapter(src, {
      glossary,
      summary: '',
      chapter: 2,
      titleRu: 'Глава 2',
      concurrency: 1,
      ask: async (s) => {
        systems.push(s)
        return 'Ушёл'
      },
    })
    expect(systems.some((s) => s.includes('Arin = Арина'))).toBe(true)
  })

  it('body translator + title translator + pairs linter work together', async () => {
    const dir = chaptersDir()
    const call = reply('Привет')
    const title = createGlossaryTitleTranslator({
      call: reply('Глава 1: Начало'),
      chaptersDir: dir,
    })
    const t = await title.invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { text: '# Chapter 1: Start', targetLang: 'ru' },
        meta: {},
      },
      ctx,
    )
    expect(t.item.translatedText).toBe('Глава 1: Начало')

    const body = createChapterBodyTranslator({ call, chaptersDir: dir, log: false })
    const res = await body.invoke(
      {
        ...createExchange(
          { text: '# Глава 1: Начало' },
          { variables: [variable('chapters', ['# Chapter 1: Start\n\nHello there.'])] },
        ),
        items: [{ text: '# Глава 1: Начало' }],
      },
      ctx,
    )
    expect(getVariable(res, 'chapterNums')).toEqual([1])
    expect(res.items?.[0]?.ru).toBe('# Глава 1: Начало\n\nПривет')
    const linted = await chapterPairsLinter.invoke(res as never, ctx)
    expect(getVariable(linted, 'parityByChapter')).toEqual({ '1': { errors: 0, warnings: 0 } })
  })

  it('names the failing chapter in the parity error', async () => {
    const pairs = [
      { en: '# Chapter 1\nОн вошёл.', ru: '# Глава 1\nОн вошёл.' },
      {
        en: '# Chapter 2\nHe walked into the hall.',
        ru: '# Chapter 2\nHe walked into the hall.',
      },
    ]
    const env = {
      id: 'ex-test',
      variables: [variable('chapterNums', [1, 2])],
      item: pairs[0],
      items: pairs,
      meta: {},
    }
    const err = (await chapterPairsLinter
      .invoke(env as never, ctx)
      .catch((e) => e)) as LineParityError
    expect(err).toBeInstanceOf(LineParityError)
    expect(err.where).toBe('chapter 2')
    expect(err.message).toContain('chapter 2')
    expect(err.report.issues).toContainEqual(expect.objectContaining({ code: 'low-cyrillic' }))
  })

  it('rejects a reply truncated at maxTokens so the engine retries', async () => {
    const dir = chaptersDir()
    const call = async () => ({
      content: '# Глава 1\n\nОборванная стр',
      model: 'm',
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      finishReason: 'length',
    })
    const body = createChapterBodyTranslator({ call, chaptersDir: dir, log: false })
    const env = {
      ...createExchange(
        { text: '# Глава 1' },
        { variables: [variable('chapters', ['# Chapter 1\n\nA long enough line.'])] },
      ),
      items: [{ text: '# Глава 1' }],
    }
    await expect(body.invoke(env, ctx)).rejects.toBeInstanceOf(LlmError)
    await expect(body.invoke(env, ctx)).rejects.toMatchObject({ retryable: true })
  })

  it('loads an empty glossary only when the file is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-glossary-'))
    expect(await loadGlossaryOrEmpty(dir)).toEqual({ terms: [] })
  })

  it('throws on a malformed glossary instead of silently translating without terms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-glossary-'))
    writeFileSync(join(dir, 'glossary.json'), '{ not json')
    await expect(loadGlossaryOrEmpty(dir)).rejects.toThrow(/glossary\.json/)
  })
})

const xmlReply = (lines: readonly string[]): string =>
  lines
    .map((ru, i) => `<result><id>${i + 1}</id><translated>${ru}</translated></result>`)
    .join('\n')

const originCount = (user: string): number => [...user.matchAll(/<origin>/g)].length

describe('block translation', () => {
  const glossary = { terms: [] }
  const SIX_LINES = [
    'First line of the chapter.',
    'Second line of the chapter.',
    'Third line of the chapter.',
    'Fourth line of the chapter.',
    'Fifth line of the chapter.',
    'Sixth line of the chapter.',
  ]

  it('6 lines with blockLines 3 make 2 requests and keep the 1:1 mapping', async () => {
    const calls: string[] = []
    let stats: TranslateChapterStats | undefined
    const ru = await translateTaggedChapter(['# Chapter 1', '', ...SIX_LINES].join('\n'), {
      glossary,
      summary: '',
      titleRu: 'Глава 1',
      concurrency: 1,
      blockLines: 3,
      ask: async () => {
        throw new Error('per-line request sent for a healthy block')
      },
      askRaw: async (_s, user) => {
        calls.push(user)
        const n = originCount(user)
        return xmlReply(Array.from({ length: n }, (_, i) => `Блок ${calls.length}-${i + 1}`))
      },
      onStats: (s) => {
        stats = s
      },
    })
    expect(calls).toHaveLength(2)
    expect(stats).toEqual({ lines: 6, calls: 2, fallbackLines: 0 })
    expect(ru.split('\n').slice(0, 2)).toEqual(['# Глава 1', ''])
    expect(ru.split('\n').slice(2)).toEqual([
      'Блок 1-1',
      'Блок 1-2',
      'Блок 1-3',
      'Блок 2-1',
      'Блок 2-2',
      'Блок 2-3',
    ])
  })

  it('falls back per line for exactly the dropped id: 2 blocks + 1 retry + 1 line', async () => {
    const blockCalls: string[] = []
    const lineCalls: string[] = []
    let stats: TranslateChapterStats | undefined
    const ru = await translateTaggedChapter(['# Chapter 1', '', ...SIX_LINES].join('\n'), {
      glossary,
      summary: '',
      titleRu: 'Глава 1',
      concurrency: 1,
      blockLines: 3,
      ask: async (_s, user) => {
        lineCalls.push(user)
        return 'Отдельный перевод'
      },
      askRaw: async (_s, user) => {
        blockCalls.push(user)
        // the first block keeps dropping id 2 on both attempts
        if (user.includes('First line of the chapter.')) {
          return [1, 3]
            .map((id) => `<result><id>${id}</id><translated>Блок ${id}</translated></result>`)
            .join('\n')
        }
        return xmlReply(['Блок 1', 'Блок 2', 'Блок 3'])
      },
      onStats: (s) => {
        stats = s
      },
    })
    expect(blockCalls).toHaveLength(3) // block 1, its retry, block 2
    expect(lineCalls).toHaveLength(1)
    expect(lineCalls[0]).toContain('Second line of the chapter.')
    expect(lineCalls[0]).not.toContain('<context>')
    expect(stats).toEqual({ lines: 6, calls: 4, fallbackLines: 1 })
    expect(ru.split('\n').slice(2, 5)).toEqual(['Блок 1', 'Отдельный перевод', 'Блок 3'])
    expect(ru.split('\n').slice(5)).toEqual(['Блок 1', 'Блок 2', 'Блок 3'])
  })

  it('parses a block reply with a trailing <terms> report block', async () => {
    const ru = await translateTaggedChapter('# Chapter 1\n\nHello there.\nGoodbye now.', {
      glossary,
      summary: '',
      titleRu: 'Глава 1',
      concurrency: 1,
      blockLines: 2,
      ask: async () => {
        throw new Error('unexpected per-line request')
      },
      askRaw: async () =>
        `${xmlReply(['Привет', 'Пока'])}\n<terms>[{"term":"Arin","ru":"Арин","type":"character"}]</terms>`,
    })
    expect(ru).toBe('# Глава 1\n\nПривет\nПока')
  })

  it('keeps numerals and [bracketed] markers from a block reply', async () => {
    const ru = await translateTaggedChapter('# Chapter 12\n\nChapter 12 begins [here].\n[Note 3]', {
      glossary,
      summary: '',
      titleRu: 'Глава 12',
      concurrency: 1,
      blockLines: 2,
      ask: async () => {
        throw new Error('unexpected per-line request')
      },
      askRaw: async () => xmlReply(['Глава 12 начинается [здесь].', '[Примечание 3]']),
    })
    expect(ru).toBe('# Глава 12\n\nГлава 12 начинается [здесь].\n[Примечание 3]')
    expect(ru).toContain('12')
  })

  it('maps a reply with a duplicated id by id, so the later lines keep their place', async () => {
    const lineCalls: string[] = []
    const ru = await translateTaggedChapter(
      ['# Chapter 1', '', ...SIX_LINES.slice(0, 3)].join('\n'),
      {
        glossary,
        summary: '',
        titleRu: 'Глава 1',
        concurrency: 1,
        blockLines: 3,
        ask: async (_s, user) => {
          lineCalls.push(user)
          return 'Отдельный перевод'
        },
        askRaw: async () =>
          [
            '<result><id>1</id><translated>Первый</translated></result>',
            '<result><id>2</id><translated>Второй</translated></result>',
            '<result><id>2</id><translated>Второй повтор</translated></result>',
            '<result><id>3</id><translated>Третий</translated></result>',
          ].join('\n'),
      },
    )
    expect(lineCalls).toHaveLength(1)
    expect(lineCalls[0]).toContain('Second line of the chapter.')
    expect(ru).toBe('# Глава 1\n\nПервый\nОтдельный перевод\nТретий')
  })

  it('rejects a candidate with an embedded newline and recovers it per line', async () => {
    const lineCalls: string[] = []
    const ru = await translateTaggedChapter(
      '# Chapter 1\n\nFirst line of the chapter.\nSecond line of the chapter.\nThird line of the chapter.',
      {
        glossary,
        summary: '',
        titleRu: 'Глава 1',
        concurrency: 1,
        blockLines: 3,
        ask: async (_s, user) => {
          lineCalls.push(user)
          return 'Первый отдельно'
        },
        askRaw: async () =>
          [
            '<result><id>1</id><translated>Первый\nи лишняя строка</translated></result>',
            '<result><id>2</id><translated>Второй</translated></result>',
            '<result><id>3</id><translated>Третий</translated></result>',
          ].join('\n'),
      },
    )
    expect(lineCalls).toHaveLength(1)
    expect(lineCalls[0]).toContain('First line of the chapter.')
    // the merged entry must not add a chapter line nor swallow its neighbours
    expect(ru.split('\n')).toHaveLength(5)
    expect(ru).toBe('# Глава 1\n\nПервый отдельно\nВторой\nТретий')
  })

  it('keeps the line order when the reply entries arrive out of order', async () => {
    const ru = await translateTaggedChapter(
      ['# Chapter 1', '', ...SIX_LINES.slice(0, 3)].join('\n'),
      {
        glossary,
        summary: '',
        titleRu: 'Глава 1',
        concurrency: 1,
        blockLines: 3,
        ask: async () => {
          throw new Error('unexpected per-line request')
        },
        askRaw: async () =>
          [
            '<result><id>3</id><translated>Третий</translated></result>',
            '<result><id>1</id><translated>Первый</translated></result>',
            '<result><id>2</id><translated>Второй</translated></result>',
          ].join('\n'),
      },
    )
    expect(ru).toBe('# Глава 1\n\nПервый\nВторой\nТретий')
  })

  it('treats an empty reply as a retryable error instead of a blank line', async () => {
    let calls = 0
    const body = createChapterBodyTranslator({
      call: (async () => {
        calls += 1
        return {
          content: '',
          model: 'm',
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          finishReason: 'stop',
        }
      }) as never,
      chaptersDir: chaptersDir(),
      log: false,
      blockLines: 2,
    })
    await expect(
      body.invoke(
        {
          ...createExchange(
            { text: '# Глава 1' },
            { variables: [variable('chapters', ['# Chapter 1\n\nHello there.'])] },
          ),
          items: [{ text: '# Глава 1' }],
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining('empty translation reply'),
    })
    expect(calls).toBeGreaterThan(0)
  })

  it('passes maxTokens through to the request', async () => {
    const seen: Array<number | undefined> = []
    const call = async (input: { maxTokens?: number }) => {
      seen.push(input.maxTokens)
      return {
        content: xmlReply(['Привет']),
        model: 'm',
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
      }
    }
    const body = createChapterBodyTranslator({
      call: call as never,
      chaptersDir: chaptersDir(),
      log: false,
      blockLines: 2,
      maxTokens: 4096,
    })
    await body.invoke(
      {
        ...createExchange(
          { text: '# Глава 1' },
          { variables: [variable('chapters', ['# Chapter 1\n\nHello there.'])] },
        ),
        items: [{ text: '# Глава 1' }],
      },
      ctx,
    )
    expect(seen).toEqual([4096])
  })

  it('keeps the glossary and entity blocks in a retried block and its per-line fallback', async () => {
    const pinnedGlossary = {
      terms: [
        {
          id: 'arin',
          term: 'Arin',
          type: 'character' as const,
          count: 2,
          firstChapter: 1,
          ru: 'Арин',
          aliases: [],
        },
      ],
    }
    const entities = [
      'Named entities in this chapter (keep spelling and gender consistent):',
      '- Arin (character)',
    ].join('\n')
    const systems: string[] = []
    const users: string[] = []
    let blockAttempts = 0
    const ru = await translateTaggedChapter(
      '# Chapter 1\n\n<term id="arin">Arin</term> left.\nGoodbye now.',
      {
        glossary: pinnedGlossary,
        summary: '',
        entities,
        titleRu: 'Глава 1',
        concurrency: 1,
        blockLines: 2,
        ask: async (system, user) => {
          systems.push(system)
          users.push(user)
          return 'Арин ушёл'
        },
        askRaw: async (system, user) => {
          systems.push(system)
          users.push(user)
          blockAttempts += 1
          return ''
        },
      },
    )
    expect(blockAttempts).toBe(2) // the block failed twice, then the lines fell back
    expect(systems).toHaveLength(4)
    for (const system of systems) {
      expect(system).toContain('Named entities in this chapter')
      expect(system).toContain('- Arin (character)')
    }
    const withTerm = users.filter((user) => user.includes('Arin'))
    expect(withTerm).toHaveLength(3) // both block attempts + the Arin line
    users.forEach((user, i) => {
      if (user.includes('Arin')) expect(systems[i]).toContain('Arin = Арин')
    })
    // the retried block reuses the exact same prompt inputs as the first attempt
    expect(systems[1]).toBe(systems[0])
    expect(users[1]).toBe(users[0])
    expect(ru).toBe('# Глава 1\n\nАрин ушёл\nАрин ушёл')
  })

  it('refuses an untagged chapter when the glossary has pinned terms', async () => {
    const pinnedGlossary = {
      terms: [
        {
          id: 'arin',
          term: 'Arin',
          type: 'character' as const,
          count: 1,
          firstChapter: 1,
          ru: 'Арин',
          aliases: [],
        },
      ],
    }
    await expect(
      translateTaggedChapter('# Chapter 1\n\nArin left.', {
        glossary: pinnedGlossary,
        summary: '',
        titleRu: 'Глава 1',
        concurrency: 1,
        ask: async () => 'Арин ушёл',
      }),
    ).rejects.toThrow(/not tagged/)
    // an untagged chapter without any pinned occurrence is still translated
    await expect(
      translateTaggedChapter('# Chapter 1\n\nNobody here.', {
        glossary: pinnedGlossary,
        summary: '',
        titleRu: 'Глава 1',
        concurrency: 1,
        ask: async () => 'Никого',
      }),
    ).resolves.toBe('# Глава 1\n\nНикого')
  })
})
