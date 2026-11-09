import { category, defineTool, getVariable, setVariable, tool, useCase, withItem } from '@mt/core'
import { LineParityError, lineParityLinter } from './line-parity-linter.js'
import type { LineParityInput, LineParityReport } from './line-parity-linter.js'

/**
 * `lineParityLinter` over every EN/RU pair of a batch (`env.items`); throws (retryable) on the
 * first hard error. Per-chapter `{ errors, warnings }` land in the `parityByChapter` variable, keyed
 * by `chapterNums[i]` (variable).
 */
export const chapterPairsLinter = defineTool<LineParityInput, LineParityInput>({
  name: 'chapter-pairs-linter',
  version: '1.0.0',
  mdDescription:
    'lineParityLinter over every EN/RU chapter pair; reports in the parityByChapter variable.',
  annotations: [
    tool('TL205', {
      name: 'chapter-pairs-linter',
      description: 'Runs line parity checks over every EN/RU chapter pair.',
      refs: ['UC057'],
    }),
    useCase('UC057'),
    category(['validator']),
  ],
  async invoke(env, ctx) {
    const pairs = env.items ?? [env.item]
    const nums = getVariable<number[]>(env, 'chapterNums') ?? []
    const reports: Record<string, { errors: number; warnings: number }> = {}
    for (const [i, pair] of pairs.entries()) {
      const n = nums[i] ?? i + 1
      try {
        const res = await lineParityLinter.invoke(withItem(env, pair), ctx)
        const r = getVariable<LineParityReport>(res, 'parity') as LineParityReport
        reports[String(n)] = { errors: r.errors, warnings: r.warnings }
      } catch (err) {
        if (err instanceof LineParityError) {
          throw new LineParityError(err.report, `chapter ${n}`)
        }
        throw err
      }
    }
    return setVariable(env, 'parityByChapter', reports)
  },
})
