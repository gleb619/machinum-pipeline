import { describe, expect, it } from 'vitest'

import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import {
  paragraphTranslator,
  titleTranslator,
} from '../../../packages/tools/src/modification/chapter-translator.js'
// Import tools directly from source (sample2 has no workspace resolution for @mt/tools)
import { tokenSplitter } from '../../../packages/tools/src/normalization/token-splitter.js'
import {
  chapterValidator,
  forbiddenCharDetector,
  markdownFormatter,
  typoFinder,
} from '../../../packages/tools/src/verification/chapter-validator.js'

const sampleChapter = `---
title: The Road from Thornhaven
author: Test Author
---

# The Road from Thornhaven

Sir Aldric tightened the strap of his saddle and looked out across the valley.
The morning mist clung to the treetops like a ghost's embrace.

## The Journey Begins

He had been riding for three days now. The road was long and winding.

\`\`\`text
No language tag on this block
\`\`\`

\`\`\`markdown
This block has a language tag.
\`\`\`

There is a typo here: recieve the package.
`

const longChapter = Array(500)
  .fill(
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.\n\n',
  )
  .join('')

describe('chapterValidator', () => {
  it('validates a well-formed chapter', async () => {
    const ctx = { run: { global: {} } } as unknown as ToolContext
    const result = await chapterValidator.invoke({ item: sampleChapter, meta: {} }, ctx)
    expect(getVariable(result, 'valid')).toBe(true)
    expect(getVariable(result, 'errors')).toEqual([])
  })

  it('detects missing H1 heading', async () => {
    const ctx = { run: { global: {} } } as unknown as ToolContext
    const noH1 = '## Just a level 2\n\nContent here.'
    const result = await chapterValidator.invoke({ item: noH1, meta: {} }, ctx)
    expect(getVariable(result, 'valid')).toBe(false)
    expect(
      (getVariable<string[]>(result, 'errors') ?? []).some((e: string) => e.includes('H1')),
    ).toBe(true)
  })

  it('detects code blocks without language tags', async () => {
    const ctx = { run: { global: {} } } as unknown as ToolContext
    const noLangChapter = '# Test\n\n```\ncode without language tag\n```\n'
    const result = await chapterValidator.invoke({ item: noLangChapter, meta: {} }, ctx)
    const codeErrors = (getVariable<string[]>(result, 'errors') ?? []).filter(
      (e: string) => e.toLowerCase().includes('code') || e.toLowerCase().includes('language'),
    )
    expect(codeErrors.length).toBeGreaterThan(0)
  })
})

describe('tokenSplitter', () => {
  it('does not split short chapters', async () => {
    const ctx = { run: { global: {} } } as unknown as ToolContext
    const result = await tokenSplitter.invoke({ item: sampleChapter, meta: {} }, ctx)
    const items = result.item
    expect(items.length).toBe(1)
  })

  it('splits very long chapters', async () => {
    const ctx = { run: { global: {} } } as unknown as ToolContext
    const result = await tokenSplitter.invoke({ item: longChapter, meta: {} }, ctx)
    const items = result.item
    expect(items.length).toBeGreaterThan(1)
  })
})

describe('forbiddenCharDetector', () => {
  it('passes clean text', async () => {
    const ctx = { run: { global: {} } } as unknown as ToolContext
    const result = await forbiddenCharDetector.invoke({ item: 'Normal text.', meta: {} }, ctx)
    expect(getVariable(result, 'forbidden')).toBeDefined()
    expect(getVariable<unknown[]>(result, 'forbidden')?.length).toBe(0)
  })

  it('detects zero-width characters', async () => {
    const ctx = { run: { global: {} } } as unknown as ToolContext
    const textWithZW = 'Normal text\u200Bwith zero-width space.'
    const result = await forbiddenCharDetector.invoke({ item: textWithZW, meta: {} }, ctx)
    expect(getVariable<unknown[]>(result, 'forbidden')?.length).toBeGreaterThan(0)
  })
})

describe('typoFinder', () => {
  it('returns an issues list and sets typoWarned variable', async () => {
    const ctx = { run: { global: {} } } as unknown as ToolContext
    const result = await typoFinder.invoke(
      { item: { text: 'Please recieve this package.' }, meta: {} },
      ctx,
    )
    expect(Array.isArray(result.item.issues)).toBe(true)
    expect(result.item.text).toBe('Please recieve this package.')
    expect(getVariable(result, 'typoWarned')).toBe(true)
    expect(Array.isArray(getVariable(result, 'warnings'))).toBe(true)
  })
})

describe('markdownFormatter', () => {
  it('formats markdown', async () => {
    const ctx = { run: { global: {} } } as unknown as ToolContext
    const result = await markdownFormatter.invoke(
      { item: { text: 'Some text\n```js\ncode\n```\nMore text' }, meta: {} },
      ctx,
    )
    expect(result.item.text).toBeDefined()
  })
})
