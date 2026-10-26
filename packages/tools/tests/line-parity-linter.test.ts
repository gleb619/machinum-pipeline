import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import {
  LineParityError,
  createLineParityLinter,
  lintLineParity,
  parityFeedback,
} from '../src/verification/line-parity-linter.js'

const EN = ['# Chapter 1: Start', '', 'He walked in.', '', '[System: level up!]', ''].join('\n')
const RU = ['# Глава 1: Начало', '', 'Он вошёл.', '', '[Система: уровень повышен!]', ''].join('\n')

const codes = (en: string, ru: string) => lintLineParity(en, ru).issues.map((i) => i.code)

describe('lintLineParity', () => {
  it('accepts a matching translation', () => {
    const r = lintLineParity(EN, RU)
    expect(r.ok).toBe(true)
    expect(r.errors).toBe(0)
    expect(r.enLines).toBe(r.ruLines)
  })

  it('flags a line count mismatch', () => {
    expect(codes(EN, RU.replace('\n\nОн вошёл.', ''))).toContain('line-count')
  })

  it('flags shifted empty lines', () => {
    const ru = ['# Глава 1: Начало', 'Он вошёл.', '', '', '[Система: уровень повышен!]', ''].join(
      '\n',
    )
    expect(codes(EN, ru)).toContain('empty-line-position')
  })

  it('flags a lost bracket line', () => {
    const ru = RU.replace('[Система: уровень повышен!]', 'Система: уровень повышен!')
    expect(codes(EN, ru)).toContain('bracket-line-position')
  })

  it('flags leftover term tags and think blocks', () => {
    const ru = RU.replace('Он вошёл.', '<think>x</think><term id="a">Он</term> вошёл.')
    const c = codes(EN, ru)
    expect(c).toContain('term-tag-left')
    expect(c).toContain('think-block')
  })

  it('flags an untranslated text via the Cyrillic ratio', () => {
    const r = lintLineParity(EN, EN)
    expect(r.ok).toBe(false)
    expect(r.issues.map((i) => i.code)).toContain('low-cyrillic')
  })

  it('can downgrade the Cyrillic check to a warning', () => {
    const r = lintLineParity(EN, EN, { cyrillicSeverity: 'warn' })
    expect(r.ok).toBe(true)
    expect(r.warnings).toBeGreaterThan(0)
  })

  it('warns about a long line without Cyrillic', () => {
    const long = 'He walked slowly into the great hall of the old keep.'
    const r = lintLineParity(`${long}\nок`, `${long}\nок`, { cyrillicSeverity: 'warn' })
    expect(r.issues.some((i) => i.code === 'untranslated-line' && i.severity === 'warn')).toBe(true)
  })
})

describe('parityFeedback (measured feedback for retry prompts, T138)', () => {
  it('reports line counts, Cyrillic ratio and the hard errors', () => {
    const report = lintLineParity(EN, EN) // untranslated: low-cyrillic error
    const fb = parityFeedback(report)
    expect(fb).toContain(`EN ${report.enLines} lines, RU ${report.ruLines} lines`)
    expect(fb).toContain(`Cyrillic ratio ${report.cyrillicRatio}`)
    expect(fb).toContain('below 0.3')
  })

  it('includes the line-count delta when counts differ', () => {
    const report = lintLineParity(EN, RU.replace('\n\nОн вошёл.', ''))
    expect(parityFeedback(report)).toContain(`line-count delta ${report.ruLines - report.enLines}`)
  })

  it('LineParityError carries the measured feedback', async () => {
    const run = createLineParityLinter().invoke(
      { id: 'ex-test', variables: [], item: { en: EN, ru: EN }, meta: {} },
      {} as ToolContext,
    )
    await expect(run).rejects.toMatchObject({
      retryable: true,
      feedback: expect.stringContaining('Cyrillic ratio'),
    })
  })
})

describe('lineParityLinter tool', () => {
  const ctx = {} as ToolContext

  it('writes the parity variable for a good pair', async () => {
    const out = await createLineParityLinter().invoke(
      { id: 'ex-test', variables: [], item: { en: EN, ru: RU }, meta: {} },
      ctx,
    )
    expect(getVariable<{ ok: boolean }>(out, 'parity')?.ok).toBe(true)
  })

  it('throws a retryable LineParityError on hard errors', async () => {
    const run = createLineParityLinter().invoke(
      { id: 'ex-test', variables: [], item: { en: EN, ru: 'Он' }, meta: {} },
      ctx,
    )
    await expect(run).rejects.toBeInstanceOf(LineParityError)
    await expect(run).rejects.toMatchObject({ retryable: true })
  })

  it('reports without throwing when throwOnError is false', async () => {
    const out = await createLineParityLinter({ throwOnError: false }).invoke(
      { id: 'ex-test', variables: [], item: { en: EN, ru: 'Он' }, meta: {} },
      ctx,
    )
    expect(getVariable<{ ok: boolean }>(out, 'parity')?.ok).toBe(false)
  })
})
