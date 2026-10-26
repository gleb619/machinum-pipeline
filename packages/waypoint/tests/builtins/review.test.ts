import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Envelope, TargetContext } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReviewTarget, renderGlossaryReview } from '../../src/review.js'
import type { ParsedUri } from '../../src/uri.js'

const ctx = { run: { global: { settings: {} } } } as TargetContext

const GLOSSARY = {
  terms: [
    {
      id: 'alice',
      term: 'Alice',
      type: 'character',
      ru: 'Алиса',
      aliases: [],
      locked: true,
    },
    {
      id: 'bob',
      term: 'Bob',
      type: 'character',
      ru: 'Боб',
      aliases: [],
      pending: ['Бобби', 'Боберт'],
    },
    { id: 'keep', term: 'Iron Keep', type: 'place', ru: null, aliases: [] },
  ],
  ignored: [],
  rejected: ['Бобби-старый'],
}

function makeUri(path: string): ParsedUri {
  return { scheme: 'review', raw: `review://${path}`, host: '', path, query: {} }
}

describe('renderGlossaryReview', () => {
  it('renders locked terms and one row per pending proposal', () => {
    const md = renderGlossaryReview(GLOSSARY, 'chapters/glossary.json')
    expect(md).toContain('# Glossary Review Queue')
    expect(md).toContain('Source: `chapters/glossary.json` — 3 terms, 1 with pending proposals.')
    expect(md).toContain('## Locked terms (always injected, never auto-changed)')
    expect(md).toContain('`alice` **Alice** (character) = Алиса')
    expect(md).toContain('| 1 | `bob` | Bob | character | Боб | Бобби |')
    expect(md).toContain('| 2 | `bob` | Bob | character | Боб | Боберт |')
    expect(md).not.toContain('`keep`')
  })

  it('renders an empty-queue note when nothing is pending', () => {
    const md = renderGlossaryReview({ terms: [] })
    expect(md).toContain('_No pending proposals — nothing to review._')
    expect(md).not.toContain('## Locked terms')
  })

  it('escapes pipes in terms and proposals', () => {
    const md = renderGlossaryReview({
      terms: [
        {
          id: 'a',
          term: 'A | B',
          type: 'term',
          ru: null,
          aliases: [],
          pending: ['x | y'],
        },
      ],
    })
    expect(md).toContain('A \\| B')
    expect(md).toContain('x \\| y')
  })
})

describe('review target', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-review-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the review queue markdown atomically on close', async () => {
    const file = join(dir, 'glossary.review.md')
    const target = createReviewTarget(makeUri(file))
    await target.open(ctx)
    await target.write(
      { item: 'unused', meta: { glossary: GLOSSARY, source: 'chapters/glossary.json' } },
      ctx,
    )
    await target.close(ctx)

    const written = await readFile(file, 'utf-8')
    expect(written).toBe(renderGlossaryReview(GLOSSARY, 'chapters/glossary.json'))
  })

  it('parses a glossary JSON string item', async () => {
    const file = join(dir, 'from-string.md')
    const target = createReviewTarget(makeUri(file))
    await target.open(ctx)
    await target.write({ item: JSON.stringify(GLOSSARY), meta: {} } as Envelope<string>, ctx)
    await target.close(ctx)

    const written = await readFile(file, 'utf-8')
    expect(written).toContain('| 1 | `bob` | Bob | character | Боб | Бобби |')
  })

  it('throws a clear error for envelopes without a glossary', async () => {
    const target = createReviewTarget(makeUri(join(dir, 'x.md')))
    await target.open(ctx)
    await expect(target.write({ item: 'plain text', meta: {} }, ctx)).rejects.toThrow(
      /expects a glossary envelope/,
    )
  })

  it('writes nothing when closed without a write', async () => {
    const file = join(dir, 'never.md')
    const target = createReviewTarget(makeUri(file))
    await target.open(ctx)
    await target.close(ctx)
    await expect(readFile(file, 'utf-8')).rejects.toThrow()
  })
})
