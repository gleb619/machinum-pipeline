import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Exchange,
  type ToolContext,
  createExchange,
  getVariable,
  setVariable,
  withBatchMembers,
  withMeta,
} from '@mt/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createApplyTranslatedTitle,
  createDictionaryTitleTranslator,
  createSchemaTitles,
  createTitlePacketParser,
  dictionaryTranslateTitle,
} from '../src/modification/title-packet.js'
import { exchangeOf } from './exchange-helper.js'

const ctx = { run: { global: {} } } as unknown as ToolContext

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'title-packet-'))
  await mkdir(join(root, 'chapters/schema'), { recursive: true })
  await writeFile(join(root, 'chapters/schema/chapter1.schema.md'), '# The Road\n\ntext\n')
  await writeFile(
    join(root, 'chapters/schema/chapter2.schema.md'),
    '# The Duke’s Tribunal\n\ntext\n',
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function schemaTitlesCtx(): ToolContext {
  return {
    run: { global: { project: { root } }, logger: { debug: () => {} } },
  } as unknown as ToolContext
}

describe('createSchemaTitles', () => {
  it('reads one title per member from its schema doc', async () => {
    const members = [
      withMeta(createExchange('# Whatever\n\ntext'), { chapterNum: 1 }),
      withMeta(createExchange('# Other\n\ntext'), { chapterNum: 2 }),
    ]
    const pack = withBatchMembers(
      createExchange(
        members.map((m) => m.item),
        { items: members.map((m) => m.item) },
      ),
      members,
    )
    const out = await createSchemaTitles().invoke(pack as Exchange<unknown>, schemaTitlesCtx())
    expect(out.item).toEqual([
      { chapter: 1, title: 'The Road' },
      { chapter: 2, title: 'The Duke’s Tribunal' },
    ])
    expect(getVariable(out, 'titles')).toEqual(out.item)
  })

  it('falls back to the chapter H1 when no schema doc exists', async () => {
    const member = withMeta(createExchange('# Ambush in Darkwood\n\ntext'), { chapterNum: 3 })
    const pack = withBatchMembers(createExchange([member.item], { items: [member.item] }), [member])
    const out = await createSchemaTitles().invoke(pack as Exchange<unknown>, schemaTitlesCtx())
    expect(out.item).toEqual([{ chapter: 3, title: 'Ambush in Darkwood' }])
  })

  it('treats a plain envelope as a one-entry package', async () => {
    const env = withMeta(createExchange('# The Road'), { chapterNum: 1 })
    const out = await createSchemaTitles().invoke(env, schemaTitlesCtx())
    expect(out.item).toEqual([{ chapter: 1, title: 'The Road' }])
  })
})

describe('dictionaryTranslateTitle', () => {
  it('maps words case-insensitively and keeps unmatched words', () => {
    expect(dictionaryTranslateTitle('The Road', { the: '', road: 'Дорога' })).toBe('Дорога')
    expect(dictionaryTranslateTitle('Ambush in Darkwood', { ambush: 'Засада' })).toBe(
      'Засада in Darkwood',
    )
  })
})

describe('createDictionaryTitleTranslator', () => {
  it('emits a chapter/title packet line per entry', async () => {
    const tool = createDictionaryTitleTranslator({ dictionary: { the: '', road: 'Дорога' } })
    const env = exchangeOf(
      [
        { chapter: 1, title: 'The Road' },
        { chapter: 2, title: 'Tribunal' },
      ],
      {},
      [
        { chapter: 1, title: 'The Road' },
        { chapter: 2, title: 'Tribunal' },
      ],
    )
    const out = await tool.invoke(env, ctx)
    expect(out.item).toBe('1\tДорога\n2\tTribunal')
    expect(getVariable(out, 'titlePacket')).toBe('1\tДорога\n2\tTribunal')
  })
})

describe('createTitlePacketParser', () => {
  it('parses a packet back into entries', async () => {
    const out = await createTitlePacketParser().invoke(exchangeOf('1\tДорога\n2\tTribunal'), ctx)
    expect(out.item).toEqual([
      { chapter: 1, title: 'Дорога' },
      { chapter: 2, title: 'Tribunal' },
    ])
    expect(getVariable(out, 'translatedTitles')).toEqual(out.item)
  })

  it('fails fast on a malformed line', async () => {
    await expect(
      createTitlePacketParser().invoke(exchangeOf('1 no separator'), ctx),
    ).rejects.toThrow(/line 1/)
  })
})

describe('createApplyTranslatedTitle', () => {
  const entries = [{ chapter: 1, title: 'Глава 1. Дорога' }]

  it('replaces the H1 and stamps meta.lang, matched by meta.chapterNum', async () => {
    const tool = createApplyTranslatedTitle({ lang: 'ru' })
    const env = setTitles(
      withMeta(createExchange('# The Road\n\ntext'), { chapterNum: 1 }),
      entries,
    )
    const out = await tool.invoke(env, ctx)
    expect(out.item).toBe('# Глава 1. Дорога\n\ntext')
    expect(out.meta.lang).toBe('ru')
  })

  it('falls back to meta.batchIndex when chapterNum is missing', async () => {
    const tool = createApplyTranslatedTitle({ lang: 'ru' })
    const env = setTitles(withMeta(createExchange('# The Road'), { batchIndex: 0 }), entries)
    const out = await tool.invoke(env, ctx)
    expect(out.item).toBe('# Глава 1. Дорога')
  })

  it('leaves the envelope untouched without a matching entry', async () => {
    const tool = createApplyTranslatedTitle({ lang: 'ru' })
    const env = setTitles(withMeta(createExchange('# The Road'), { chapterNum: 9 }), entries)
    expect(await tool.invoke(env, ctx)).toBe(env)
  })
})

/** Stamp the `translatedTitles` batch variable a `batch://members` member would carry. */
function setTitles<T>(
  env: Exchange<T>,
  entries: { chapter: number; title: string }[],
): Exchange<T> {
  return setVariable(env, 'translatedTitles', entries)
}
