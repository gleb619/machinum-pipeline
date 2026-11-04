import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Exchange, ParsedUri, Target, TargetContext } from '@mt/core'
import { annotate, atomicWriteFile, registry, waypoint } from '@mt/core'
import { exchangeField } from './fields.js'
import { resolveWaypointRoot } from './settings.js'

/**
 * Variable the `book-compiler` tool publishes (title, TOC, warnings).
 * Mirrors `VAR_BOOK` in `@mt/tools` — the waypoint package cannot import tools.
 */
const VAR_BOOK = 'book'

interface BookTargetTocEntry {
  number: number | undefined
  title: string
  anchor: string
}

interface BookTargetWarning {
  code: string
  chapterNumber?: number
  message: string
}

interface BookTargetDoc {
  title: string
  toc: BookTargetTocEntry[]
  warnings: BookTargetWarning[]
}

export function createBookTarget<T>(uri: ParsedUri): Target<T> {
  let rootDir = ''

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      rootDir = resolveWaypointRoot(
        uri,
        'book',
        ctx.run.global.settings,
        ctx.run.global.project.root,
      )
      mkdirSync(rootDir, { recursive: true })
    },
    async write(env: Exchange<T>, _ctx: TargetContext): Promise<void> {
      if (!rootDir) {
        throw new Error(`book:// target '${uri.raw}' not opened. Call open() before write().`)
      }

      // Validate everything before the first write: a rejected envelope must not
      // leave a half-written book behind.
      const markdown = env.item
      if (typeof markdown !== 'string') {
        throw new Error(
          `book:// target '${uri.raw}' expects the book markdown as item, got ${typeof markdown}.`,
        )
      }
      const doc = exchangeField<BookTargetDoc>(env, VAR_BOOK)
      if (!doc) {
        throw new Error(
          `book:// target '${uri.raw}' found no book document — run the book-compiler tool first.`,
        )
      }

      const json = `${JSON.stringify(
        { title: doc.title, toc: doc.toc, warnings: doc.warnings },
        null,
        2,
      )}\n`

      await atomicWriteFile(join(rootDir, 'book.md'), markdown)
      await atomicWriteFile(join(rootDir, 'book.json'), json)
    },
    async close(_ctx: TargetContext): Promise<void> {
      // Nothing to close — every write is atomic.
    },
  }
}

annotate(
  createBookTarget,
  waypoint('WT016', {
    name: 'book target',
    description: 'Writes book.md + book.json (TOC, warnings) atomically under a directory.',
    meta: { schemes: ['book'], direction: 'target' },
  }),
)
registry.registerTarget('book', createBookTarget)
