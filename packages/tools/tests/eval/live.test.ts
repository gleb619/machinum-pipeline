import { describe, expect, it } from 'vitest'
import { formatLiveReport, runLiveEval } from './live.js'

const live = process.env.MT_EVAL_LIVE === '1'
const describeLive = live ? describe : describe.skip

describeLive('live translation eval (opt-in)', () => {
  it('reports the same corpus through the real ollama server without gating', async () => {
    const report = await runLiveEval()
    process.stdout.write(`\n${formatLiveReport(report)}\n`)
    expect(report.rows).toHaveLength(3)
  }, 300_000)
})
