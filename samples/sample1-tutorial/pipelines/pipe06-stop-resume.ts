import { type BusEvent, annotate, definePipeline, defineProcess, log, useCase } from '@mt/core'
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
 *
 * The default export stays the work pipeline, so `mt resume <runId>` keeps working. The
 * `stopResumeLifecycleSuite` process adds a second, independent pipeline that subscribes to the
 * process-wide lifecycle channel with the `events://` source and logs every moment:
 *
 *   mt run ./pipelines/pipe06-stop-resume.ts --pipeline stopResumeLifecycleSuite
 *
 * Caveat: a resume starts only the work pipeline, not the suite. The `resumed` and `done`
 * moments of the resumed run are still written to its `.mt/runs/<runId>/events.jsonl`, but the
 * lifecycle logger is not alive to print them — a process subscription cannot outlive the
 * process that paused.
 */
const waitForLatch = createWaitForFile({
  path: './jsonl/latches/{item}.latch',
  pollMs: 100,
  timeoutMs: 600_000,
})
annotate(waitForLatch, useCase('UC015', { name: 'Auto-checkpoint at step boundary' }))

export const stopResumePipeline = annotate(
  definePipeline({ id: 'pipe06-stop-resume' })
    .from('range://1..5')
    .use(waitForLatch)
    .tap((env) => log.info('stop-resume item', { item: env.item }))
    .to('jsonl://./jsonl/stop-resume.jsonl'),
  useCase('UC007', { name: 'Pause a running Run' }),
)

/**
 * Lifecycle logger: subscribes to the bus channel that carries `started`, `step-done`,
 * `paused`, `resumed`, `done` and `failed` for every run of this process.
 *
 * The `events://` source is long-lived; it ends when the last *other* run of the process ends.
 * The tap prints one `[lifecycle] <type>` line per event with the event fields as meta.
 */
const lifecycleLogger = definePipeline({ id: 'pipe06-lifecycle-logger' })
  .from('events://pipe06?only=started,step-done,paused,resumed,done,failed')
  .tap((env) => {
    const event = env.item as BusEvent
    log.info(`[lifecycle] ${event.type}`, {
      event: event.type,
      runId: event.runId,
      stepId: event.stepId,
      error: event.error,
    })
  })
  .to('void://')

export const stopResumeLifecycleSuite = defineProcess([stopResumePipeline, lifecycleLogger], {
  id: 'pipe06-lifecycle',
}).parallel(true)

export default stopResumePipeline
