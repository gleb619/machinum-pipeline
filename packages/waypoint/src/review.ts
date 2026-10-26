import type { ParsedUri } from '@mt/core'
import type { Envelope, Target, TargetContext } from '@mt/core'
import { atomicWriteFile, registry } from '@mt/core'
import { resolveWaypointRoot } from './settings.js'

/**
 * Structural mirror of the `@mt/tools` glossary JSON (`chapters/glossary.json`).
 * `review://` deliberately does NOT import `@mt/tools` — waypoint depends on
 * `@mt/core` only — so the few fields it reads are declared locally and kept in
 * sync with `GlossaryTerm` by convention (see docs/waypoints.md WP010).
 */
export interface ReviewTerm {
  id: string
  term: string
  type: string
  ru: string | null
  aliases?: string[]
  locked?: boolean
  pending?: string[]
}

export interface ReviewGlossary {
  terms: ReviewTerm[]
  ignored?: string[]
  rejected?: string[]
}

function isGlossary(value: unknown): value is ReviewGlossary {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as ReviewGlossary).terms)
  )
}

/** Extracts a glossary from an envelope: `meta.glossary`, else a JSON-string `item`, else an object `item`. */
function glossaryOf<T>(env: Envelope<T>): ReviewGlossary | undefined {
  const fromMeta = (env.meta as Record<string, unknown> | undefined)?.glossary
  if (isGlossary(fromMeta)) return fromMeta
  if (typeof env.item === 'string') {
    try {
      const parsed: unknown = JSON.parse(env.item)
      if (isGlossary(parsed)) return parsed
    } catch {
      // Not JSON — fall through to the error below.
    }
  }
  if (isGlossary(env.item)) return env.item
  return undefined
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|')
}

/** Renders the pending-change review queue as markdown (the human's editing worksheet). */
export function renderGlossaryReview(glossary: ReviewGlossary, source = 'glossary'): string {
  const locked = glossary.terms.filter((t) => t.locked === true)
  const queued = glossary.terms.filter((t) => (t.pending ?? []).length > 0)
  const lines: string[] = [
    '# Glossary Review Queue',
    '',
    `Source: \`${source}\` — ${glossary.terms.length} terms, ${queued.length} with pending proposals.`,
    '',
  ]
  if (locked.length > 0) {
    lines.push('## Locked terms (always injected, never auto-changed)', '')
    for (const t of locked) {
      lines.push(`- \`${t.id}\` **${escapeCell(t.term)}** (${t.type}) = ${t.ru ?? '—'}`)
    }
    lines.push('')
  }
  if (queued.length === 0) {
    lines.push('## Review queue', '', '_No pending proposals — nothing to review._', '')
  } else {
    lines.push(
      '## Review queue',
      '',
      '| # | ID | Term | Type | Current RU | Proposed RU |',
      '|---|---|---|---|---|---|',
    )
    let n = 0
    for (const t of queued) {
      for (const proposal of t.pending ?? []) {
        n += 1
        lines.push(
          `| ${n} | \`${t.id}\` | ${escapeCell(t.term)} | ${t.type} | ${t.ru ?? '—'} | ${escapeCell(proposal)} |`,
        )
      }
    }
    lines.push('')
  }
  lines.push(
    '## How to resolve',
    '',
    '- **Approve**: set `ru` to the proposed value and remove it from the term\u2019s `pending` array in the glossary JSON.',
    '- **Reject**: move the value to the top-level `rejected` array; auto-merge never applies or re-queues rejected values.',
    '- Locked terms need no action — their `ru`/`type` are final and proposals for them are never generated.',
    '',
  )
  return `${lines.join('\n')}\n`
}

/**
 * Glossary review-queue Target — renders the pending proposals (`term.pending`) of the
 * glossary carried by the envelope as a markdown worksheet for human review.
 *
 * URI scheme: review://./chapters/glossary.review.md
 *
 * The glossary is taken from `meta.glossary`, or parsed from a JSON-string / object `item`
 * (so `.from('md://./chapters/glossary.json')` … `.to('review://…')` also works). The last
 * glossary envelope wins; the file is written atomically in `close()` (temp + rename).
 * There is deliberately NO `checkpoint()`: nothing is durable mid-run, so a crash resume
 * replays the source safely.
 */
export function createReviewTarget<T>(uri: ParsedUri): Target<T> {
  let filePath = ''
  let pending: { glossary: ReviewGlossary; source: string } | null = null

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      const projectRoot = ctx.run.global.project?.root ?? process.cwd()
      filePath = resolveWaypointRoot(uri, 'review', ctx.run.global.settings, projectRoot)
      pending = null
    },
    async write(env: Envelope<T>, _ctx: TargetContext): Promise<void> {
      if (!filePath) {
        throw new Error('Target not opened. Call open() before write().')
      }
      const glossary = glossaryOf(env)
      if (!glossary) {
        throw new Error(
          'review:// target expects a glossary envelope (meta.glossary, or item as glossary JSON)',
        )
      }
      pending = {
        glossary,
        source: String((env.meta as Record<string, unknown>).source ?? uri.raw),
      }
    },
    async close(_ctx: TargetContext): Promise<void> {
      const doc = pending
      pending = null
      if (!doc) return
      await atomicWriteFile(filePath, renderGlossaryReview(doc.glossary, doc.source))
    },
  }
}

// Register built-in review target (target-only: no source registration)
registry.registerTarget('review', createReviewTarget)
