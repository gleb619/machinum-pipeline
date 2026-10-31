import {
  type Exchange,
  type ToolContext,
  createExchange,
  getVariable,
  setVariable,
  unbatchExchange,
  withBatchMembers,
  withItem,
  withMeta,
} from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  type BatchEntry,
  createBatchApply,
  createBatchCollect,
  createEntryPacketParser,
  createEntryTranslator,
} from '../src/modification/batch-packet.js'

const ctx = { run: { global: {} } } as unknown as ToolContext

function packageOf(items: Exchange<unknown>[]): Exchange<unknown> {
  return withBatchMembers(
    createExchange(
      items.map((m) => m.item),
      { items: items.map((m) => m.item) },
    ),
    items,
  ) as Exchange<unknown>
}

describe('generic batch packet flow', () => {
  // Non-title example: uppercase-transform the SECOND paragraph of each member body.
  const paragraphs = (text: string): string[] => text.split('\n\n').filter(Boolean)

  it('collect → translate → packet → parse → apply round-trips arbitrary per-member fields', async () => {
    const members = [
      withMeta(createExchange('intro one\n\nbody para A\n\ntail'), { chapterNum: 1 }),
      withMeta(createExchange('intro two\n\nbody para B\n\ntail'), { chapterNum: 2 }),
    ]
    const pack = packageOf(members)

    // 1. collect: package-as-one-item — grab the second paragraph of every member.
    const collect = createBatchCollect({
      keyOf: (member) => String(member.meta?.chapterNum),
      read: (member) => paragraphs(String(member.item))[1],
    })
    const collected = await collect.invoke(pack, ctx)
    expect(collected.item).toEqual([
      { key: '1', value: 'body para A' },
      { key: '2', value: 'body para B' },
    ])

    // 2. translate the whole package as one item (shout-case "translation").
    const translate = createEntryTranslator({
      translate: (value) => value.toUpperCase(),
    })
    const packet = await translate.invoke(collected, ctx)
    expect(packet.item).toBe('1\tBODY PARA A\n2\tBODY PARA B')

    // 3. parse the packet back into entries.
    const parse = createEntryPacketParser()
    const parsed = await parse.invoke(packet, ctx)
    expect(parsed.item).toEqual([
      { key: '1', value: 'BODY PARA A' },
      { key: '2', value: 'BODY PARA B' },
    ])

    // 4. unbatch + per-member apply: swap the translated paragraph back into each body.
    const apply = createBatchApply({
      variable: 'entries',
      keyOf: (member) => {
        const chapter = member.meta?.chapterNum
        return typeof chapter === 'number' ? String(chapter) : ''
      },
      apply: (member, entry) => {
        const parts = paragraphs(String(member.item))
        parts[1] = entry.value
        return withMeta(withItem(member, parts.join('\n\n')), { ...member.meta, lang: 'ru' })
      },
    })
    const patched = await Promise.all(
      unbatchExchange(parsed).map((member) => apply.invoke(member, ctx)),
    )
    expect(patched.map((m) => m.item)).toEqual([
      'intro one\n\nBODY PARA A\n\ntail',
      'intro two\n\nBODY PARA B\n\ntail',
    ])
    expect(patched.map((m) => m.meta.lang)).toEqual(['ru', 'ru'])
  })

  it('collect defaults keys to meta.batchIndex / position', async () => {
    const members = [withMeta(createExchange('x'), {}), withMeta(createExchange('y'), {})]
    const pack = packageOf(members)
    const collected = await createBatchCollect({ read: (member) => String(member.item) }).invoke(
      pack,
      ctx,
    )
    expect(collected.item.map((e) => e.key)).toEqual(['0', '1'])
  })

  it('apply passes members without a matching entry through', async () => {
    const apply = createBatchApply({
      variable: 'entries',
      apply: (member, entry) => setVariable(member, 'hit', entry.value),
    })
    const member = withMeta(createExchange('keep'), { batchIndex: 5 })
    const stamped = setVariable(member, 'entries', [
      { key: '0', value: 'v' },
    ] satisfies BatchEntry[])
    const out = await apply.invoke(stamped, ctx)
    expect(out.item).toBe('keep')
    expect(getVariable(out, 'hit')).toBeUndefined()
  })

  it('parser fails fast on a malformed line', async () => {
    await expect(
      createEntryPacketParser().invoke(createExchange('no-separator-here'), ctx),
    ).rejects.toThrow(/line 1/)
  })
})
