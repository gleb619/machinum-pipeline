import { definePipeline, log } from '@mt/core'
import { createWaitForFile } from '@mt/tools'
import '@mt/waypoint'

/**
 * Stop / resume demo: each range item waits for its own latch file before it is
 * written. Pause the run with Ctrl-C, create the remaining latches, then
 * `mt resume <runId>` — the JSONL target keeps the committed lines, so nothing is
 * written twice.
 */
export default definePipeline({ id: 'sample1-stop-resume' })
  .from('range://1..5')
  .use(createWaitForFile({ path: './jsonl/latches/{item}.latch', pollMs: 100, timeoutMs: 600_000 }))
  .tap((env) => log.info('stop-resume item', { item: env.item }))
  .to('jsonl://./jsonl/stop-resume.jsonl')
