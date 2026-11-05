import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { chapterDocLinter, createChapterDocLinter } from '../src/verification/chapter-doc-linter.js'
import type { LineParityReport } from '../src/verification/line-parity-linter.js'
import { LineParityError } from '../src/verification/line-parity-linter.js'

const ctx = {} as ToolContext

const EN_DOC = [
  '---',
  'number: 1',
  '---',
  '',
  '# Chapter 1: Start',
  '',
  'He walked in.',
  '',
  '[System: level up!]',
  '',
].join('\n')

const RU_DOC = [
  '---',
  'number: 1',
  '---',
  '',
  '# Глава 1: Начало',
  '',
  'Он вошёл.',
  '',
  '[Система: уровень повышен!]',
  '',
].join('\n')

describe('chapterDocLinter', () => {
  it('passes a matching EN/RU chapter pair and writes the parity variable', async () => {
    const out = await chapterDocLinter.invoke(
      { id: 'ex-test', variables: [], item: { en: EN_DOC, ru: RU_DOC }, meta: {} },
      ctx,
    )
    const report = getVariable<LineParityReport>(out, 'parity')
    expect(report?.ok).toBe(true)
    expect(report?.enLines).toBe(report?.ruLines)
  })

  it('ignores frontmatter differences between the docs', async () => {
    const en = EN_DOC.replace('number: 1', 'number: 1\nseries: a.md')
    const ru = RU_DOC.replace('number: 1', 'number: 1\nseries: b.md')
    const out = await createChapterDocLinter({ throwOnError: false }).invoke(
      { id: 'ex-test', variables: [], item: { en, ru }, meta: {} },
      ctx,
    )
    expect(getVariable<LineParityReport>(out, 'parity')?.ok).toBe(true)
  })

  it('flags a line-count mismatch inside the chapter body', async () => {
    const ru = RU_DOC.replace('\n\nОн вошёл.', '')
    await expect(
      chapterDocLinter.invoke(
        { id: 'ex-test', variables: [], item: { en: EN_DOC, ru }, meta: {} },
        ctx,
      ),
    ).rejects.toBeInstanceOf(LineParityError)
  })

  it('reports without throwing when throwOnError is false', async () => {
    const ru = RU_DOC.replace('\n\nОн вошёл.', '')
    const out = await createChapterDocLinter({ throwOnError: false }).invoke(
      { id: 'ex-test', variables: [], item: { en: EN_DOC, ru }, meta: {} },
      ctx,
    )
    const report = getVariable<LineParityReport>(out, 'parity')
    expect(report?.ok).toBe(false)
    expect(report?.issues.map((i) => i.code)).toContain('line-count')
  })
})
