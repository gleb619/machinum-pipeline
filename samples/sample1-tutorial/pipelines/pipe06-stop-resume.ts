import { definePipeline, log } from '@mt/core'
import { createWaitForFile } from '@mt/tools'
import '@mt/waypoint'

/**
 * PIPE 06 — stop, fix the outside world, resume.
 *
 * Every range item waits for its own latch file before it is written:
 *
 *   range://1..5 → waitForFile(jsonl/latches/<item>.latch) → jsonl://./jsonl/stop-resume.jsonl
 *
 * Run it, press Ctrl-C while item 2 waits, create the remaining latch files and resume:
 *
 *   touch jsonl/latches/{2,3,4,5}.latch
 *   mt resume <runId>
 *
 * The JSONL target keeps the committed lines, so nothing is written twice. The checkpoint tree
 * under `.mt/runs/<runId>/` is the only resume mechanism — there is no separate database.
 */
export default definePipeline({ id: 'pipe06-stop-resume' })
  .from('range://1..5')
  .use(createWaitForFile({ path: './jsonl/latches/{item}.latch', pollMs: 100, timeoutMs: 600_000 }))
  .tap((env) => log.info('stop-resume item', { item: env.item }))
  .to('jsonl://./jsonl/stop-resume.jsonl')
