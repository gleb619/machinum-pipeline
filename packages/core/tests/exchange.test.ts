import { describe, expect, it } from 'vitest'
import {
  copyVariable,
  createExchange,
  findVariable,
  getOldVariable,
  getVariable,
  hashableVariables,
  isEmptyValue,
  mergeVariables,
  pushVariable,
  replaceVariable,
  setVariable,
  toExchange,
  variable,
  withItem,
  withMeta,
  withVariable,
  withoutEmpty,
  withoutEphemeral,
  withoutOldAndEmpty,
  withoutVariable,
} from '../src/exchange.js'

describe('exchange', () => {
  it('createExchange mints an id and defaults', () => {
    const ex = createExchange('a')
    expect(ex.id).toMatch(/^ex-/)
    expect(ex.meta).toEqual({})
    expect(ex.variables).toEqual([])
  })

  it('qualifiers: new is default, old/copy/alt are distinct slots', () => {
    let ex = createExchange('a')
    ex = withVariable(
      ex,
      variable('x', 1),
      variable('x', 2, { qualifier: 'alt' }),
      variable('x', 3, { qualifier: 'copy' }),
    )
    expect(getVariable(ex, 'x')).toBe(1)
    expect(getVariable(ex, 'x', 'alt')).toBe(2)
    expect(getVariable(ex, 'x', 'copy')).toBe(3)
    expect(getOldVariable(ex, 'x')).toBeUndefined()
  })

  it('withVariable replaces same name+qualifier', () => {
    const ex = setVariable(setVariable(createExchange('a'), 'x', 1), 'x', 2)
    expect(ex.variables).toHaveLength(1)
    expect(getVariable(ex, 'x')).toBe(2)
  })

  it('push keeps the previous value as old, replacing an earlier old', () => {
    let ex = createExchange('a')
    ex = pushVariable(ex, 'x', 'v1')
    expect(getOldVariable(ex, 'x')).toBeUndefined()
    ex = pushVariable(ex, 'x', 'v2')
    ex = pushVariable(ex, 'x', 'v3')
    expect(getVariable(ex, 'x')).toBe('v3')
    expect(getOldVariable(ex, 'x')).toBe('v2')
    expect(ex.variables).toHaveLength(2)
  })

  it('replaceVariable keeps no history', () => {
    const ex = replaceVariable(pushVariable(createExchange('a'), 'x', 1), 'x', 2)
    expect(getVariable(ex, 'x')).toBe(2)
    expect(getOldVariable(ex, 'x')).toBeUndefined()
  })

  it('copyVariable adds a copy-qualified variable', () => {
    const ex = copyVariable(setVariable(createExchange('a'), 'x', 2), 'x', (v) => Number(v) * 2)
    expect(getVariable(ex, 'x', 'copy')).toBe(4)
    expect(getVariable(ex, 'x')).toBe(2)
  })

  it('withoutVariable removes by name, optionally by qualifier', () => {
    const base = pushVariable(pushVariable(createExchange('a'), 'x', 1), 'x', 2)
    expect(withoutVariable(base, 'x').variables).toEqual([])
    expect(withoutVariable(base, 'x', 'old').variables).toHaveLength(1)
  })

  it('ephemeral variables are dropped and excluded from hash view', () => {
    const ex = withVariable(
      createExchange('a'),
      variable('keep', 1),
      variable('tmp', 2, { ephemeral: true }),
    )
    expect(withoutEphemeral(ex).variables.map((v) => v.name)).toEqual(['keep'])
    expect(hashableVariables(ex)).toEqual([{ name: 'keep', qualifier: 'new', value: 1 }])
  })

  it('empty rules: null, blank string, empty array', () => {
    expect(isEmptyValue(null)).toBe(true)
    expect(isEmptyValue(undefined)).toBe(true)
    expect(isEmptyValue('  ')).toBe(true)
    expect(isEmptyValue([])).toBe(true)
    expect(isEmptyValue(0)).toBe(false)
    expect(isEmptyValue(false)).toBe(false)
    expect(isEmptyValue({})).toBe(false)
    const ex = withVariable(
      pushVariable(createExchange('a'), 'x', 'v'),
      variable('e', ''),
      variable('x', 'v2', { qualifier: 'old' }),
    )
    expect(
      withoutEmpty(ex)
        .variables.map((v) => v.name)
        .sort(),
    ).toEqual(['x', 'x'])
    expect(withoutOldAndEmpty(ex).variables.map((v) => `${v.name}:${v.qualifier}`)).toEqual([
      'x:new',
    ])
  })

  it('operations are immutable', () => {
    const ex = createExchange('a', { meta: { chapterId: 'c1' } })
    const frozen = JSON.stringify(ex)
    setVariable(ex, 'x', 1)
    withMeta(ex, { lineId: 'l' })
    withItem(ex, 2)
    pushVariable(ex, 'y', 1)
    expect(JSON.stringify(ex)).toBe(frozen)
  })

  it('withItem propagates id/meta/variables and clears items', () => {
    const ex = setVariable(
      createExchange('a', { id: 'e1', meta: { chapterId: 'c' }, items: ['a'] }),
      'x',
      1,
    )
    const out = withItem(ex, 42)
    expect(out.id).toBe('e1')
    expect(out.item).toBe(42)
    expect(out.items).toBeUndefined()
    expect(out.meta).toEqual({ chapterId: 'c' })
    expect(getVariable(out, 'x')).toBe(1)
  })

  it('JSON round-trips', () => {
    const ex = pushVariable(pushVariable(createExchange({ a: 1 }), 'x', 1), 'x', 2)
    expect(JSON.parse(JSON.stringify(ex))).toEqual(ex)
    expect(findVariable(JSON.parse(JSON.stringify(ex)), 'x', 'old')?.value).toBe(1)
  })

  it('toExchange normalizes loose input and reuses full exchanges', () => {
    const loose = toExchange({ item: 'a' })
    expect(loose.id).toMatch(/^ex-/)
    expect(loose.meta).toEqual({})
    expect(loose.variables).toEqual([])
    const full = createExchange('b')
    expect(toExchange(full)).toBe(full)
    expect(toExchange({ id: 'k', item: 'c', meta: { chapterId: 'x' } }).id).toBe('k')
  })

  it('mergeVariables: later wins on clash', () => {
    const a = setVariable(createExchange(1), 'x', 'a')
    const b = setVariable(setVariable(createExchange(2), 'x', 'b'), 'y', 'y')
    const merged = mergeVariables([a, b])
    expect(merged.map((v) => [v.name, v.value])).toEqual([
      ['x', 'b'],
      ['y', 'y'],
    ])
  })
})

describe('hand-built literals', () => {
  it('helpers tolerate literals missing id/variables', () => {
    const literal = { item: 'a', meta: {} } as unknown as Parameters<typeof setVariable>[0]
    const out = setVariable(literal, 'x', 1)
    expect(getVariable(out, 'x')).toBe(1)
    expect(getVariable(literal, 'x')).toBeUndefined()
  })
})
