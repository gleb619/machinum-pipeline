import { describe, expect, it } from 'vitest'

import {
  markdownFormatter,
  typoFixer,
} from '../../../packages/tools/src/chapter-fixer.js'
import {
  paragraphTranslator,
  titleTranslator,
} from '../../../packages/tools/src/chapter-translator.js'
// Import tools directly from source (sample2 has no workspace resolution for @mt/tools)
import { chapterValidator } from '../../../packages/tools/src/chapter-validator.js'
import { forbiddenCharDetector } from '../../../packages/tools/src/chapter-validator.js'
import { tokenSplitter } from '../../../packages/tools/src/token-splitter.js'

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
    const ctx = { run: { global: {} } } as any
    const result = await chapterValidator.invoke({ item: sampleChapter, meta: {} }, ctx)
    expect(result.meta.valid).toBe(true)
    expect(result.meta.errors).toEqual([])
  })

  it('detects missing H1 heading', async () => {
    const ctx = { run: { global: {} } } as any
    const noH1 = '## Just a level 2\n\nContent here.'
    const result = await chapterValidator.invoke({ item: noH1, meta: {} }, ctx)
    expect(result.meta.valid).toBe(false)
    expect(result.meta.errors.some((e: string) => e.includes('H1'))).toBe(true)
  })

  it('detects code blocks without language tags', async () => {
    const ctx = { run: { global: {} } } as any
    const noLangChapter = `# Test\n\n\`\`\`\ncode without language tag\n\`\`\`\n`
    const result = await chapterValidator.invoke({ item: noLangChapter, meta: {} }, ctx)
    const codeErrors = result.meta.errors.filter(
      (e: string) => e.toLowerCase().includes('code') || e.toLowerCase().includes('language'),
    )
    expect(codeErrors.length).toBeGreaterThan(0)
  })
})

describe('tokenSplitter', () => {
  it('does not split short chapters', async () => {
    const ctx = { run: { global: {} } } as any
    const result = await tokenSplitter.invoke({ item: sampleChapter, meta: {} }, ctx)
    const items = result.item
    expect(items.length).toBe(1)
  })

  it('splits very long chapters', async () => {
    const ctx = { run: { global: {} } } as any
    const result = await tokenSplitter.invoke({ item: longChapter, meta: {} }, ctx)
    const items = result.item
    expect(items.length).toBeGreaterThan(1)
  })
})

describe('forbiddenCharDetector', () => {
  it('passes clean text', async () => {
    const ctx = { run: { global: {} } } as any
    const result = await forbiddenCharDetector.invoke({ item: 'Normal text.', meta: {} }, ctx)
    expect(result.meta.forbidden).toBeDefined()
    expect(result.meta.forbidden.length).toBe(0)
  })

  it('detects zero-width characters', async () => {
    const ctx = { run: { global: {} } } as any
    const textWithZW = 'Normal text\u200Bwith zero-width space.'
    const result = await forbiddenCharDetector.invoke({ item: textWithZW, meta: {} }, ctx)
    expect(result.meta.forbidden.length).toBeGreaterThan(0)
  })
})

describe('typoFixer', () => {
  it('fixes common typos', async () => {
    const ctx = { run: { global: {} } } as any
    const result = await typoFixer.invoke(
      { item: { text: 'Please recieve this package.' }, meta: {} },
      ctx,
    )
    expect(result.item.text.toLowerCase()).not.toContain('recieve')
  })
})

describe('markdownFormatter', () => {
  it('formats markdown', async () => {
    const ctx = { run: { global: {} } } as any
    const result = await markdownFormatter.invoke(
      { item: { text: 'Some text\n```js\ncode\n```\nMore text' }, meta: {} },
      ctx,
    )
    expect(result.item.text).toBeDefined()
  })
})
