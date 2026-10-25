import { defineTool } from '@mt/core'
import { lineParityLinter } from './line-parity-linter.js'
import type { LineParityInput, LineParityReport } from './line-parity-linter.js'

/**
 * `lineParityLinter` over every EN/RU pair of a batch (`env.items`); throws (retryable) on the
 * first hard error. Per-chapter `{ errors, warnings }` land in `meta.parityByChapter`, keyed
 * by `meta.chapterNums[i]`.
 */
export const chapterPairsLinter = defineTool<LineParityInput, LineParityInput>({
  name: 'chapter-pairs-linter',
  version: '1.0.0',
  mdDescription: 'lineParityLinter over every EN/RU chapter pair; reports in meta.parityByChapter.',
  async invoke(env, ctx) {
    const pairs = env.items ?? [env.item]
    const nums = (env.meta.chapterNums as number[] | undefined) ?? []
    const reports: Record<string, { errors: number; warnings: number }> = {}
    for (const [i, pair] of pairs.entries()) {
      const res = await lineParityLinter.invoke({ item: pair, meta: {} }, ctx)
      const r = res.meta.parity as LineParityReport
      reports[String(nums[i] ?? i + 1)] = { errors: r.errors, warnings: r.warnings }
    }
    return { ...env, meta: { ...env.meta, parityByChapter: reports } }
  },
})
