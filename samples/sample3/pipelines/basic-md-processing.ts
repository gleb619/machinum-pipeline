import { writeFileSync as fsWriteFileSync } from 'node:fs'
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'
import { join } from 'node:path'
import { definePipeline, defineTool } from '@mt/core'
import type {
  Envelope,
  ParsedUri,
  RunEvent,
  Source,
  SourceContext,
  Target,
  TargetContext,
} from '@mt/core'
import { registry } from '@mt/core'
import '@mt/waypoint'

// Convert a JSONL record into a markdown bullet line.
const toLine = defineTool<{ id: number; text: string }, string>({
  name: 'to-line',
  version: '1.0.0',
  mdDescription: 'Convert a record into a markdown bullet line.',
  invoke: async (env, _ctx) => {
    const { id, text } = env.item
    return { item: `- ${id}: ${text}`, meta: { ...env.meta, lineReady: true } }
  },
})

// Emit a small event to the console and to meta so downstream steps can react.
const emitEvent = defineTool<string, string>({
  name: 'emit-event',
  version: '1.0.0',
  mdDescription: 'Emit a small console/meta event for each line.',
  invoke: async (env, _ctx) => {
    const event = { type: 'line-seen', line: env.item }
    console.log(JSON.stringify(event))
    return { item: env.item, meta: { ...env.meta, event } }
  },
})

// Sync branch: append a marker to the line.
const markSync = defineTool<string, string>({
  name: 'mark-sync',
  version: '1.0.0',
  mdDescription: 'Append a sync-processed marker to a line.',
  invoke: async (env, _ctx) => ({
    item: `${env.item} [sync processed]`,
    meta: { ...env.meta, sync: true },
  }),
})

// Async branch: append a marker to the line.
const markAsync = defineTool<string, string>({
  name: 'mark-async',
  version: '1.0.0',
  mdDescription: 'Append an async-processed marker to a line.',
  invoke: async (env, _ctx) => ({
    item: `${env.item} [async processed]`,
    meta: { ...env.meta, async: true },
  }),
})

// Event-aware target: listens to run lifecycle events and writes them to a sidecar file.
// Keeps the subscription open after close so the final 'done' (or 'failed') event is captured.
function createEventsFileTarget(uri: ParsedUri): Target<unknown> {
  const path = uri.path || uri.host || './events.jsonl'
  let unsubscribe: (() => void) | undefined
  let buffer = ''
  let fullPath = ''
  const flush = (): void => {
    if (fullPath) fsWriteFileSync(fullPath, buffer, 'utf-8')
  }
  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      fullPath = join(ctx.run.global.project.root, path)
      unsubscribe = ctx.events?.subscribe((event: RunEvent) => {
        const line = JSON.stringify({ ...event, capturedAt: Date.now() })
        ctx.run.logger.info(`[events-target] ${line}`)
        buffer += `${line}\n`
        if (event.type === 'done' || event.type === 'failed') {
          flush()
          unsubscribe?.()
        }
      })
      await Promise.resolve()
    },
    async write(env: Envelope<unknown>, _ctx: TargetContext): Promise<void> {
      // Pass-through: keep the envelope flowing while appending captured events.
      buffer += `${JSON.stringify({ item: env.item, capturedAt: Date.now() })}\n`
    },
    async close(_ctx: TargetContext): Promise<void> {
      // Lifecycle events (including done) are emitted after the target closes, so we
      // flush only when the run finishes. If no event subscription was available, flush
      // the envelope buffer we already collected.
      if (!unsubscribe) flush()
    },
  }
}
registry.registerTarget('events-file', createEventsFileTarget)

// Event-aware source: reads the captured lifecycle file and yields each line as an envelope.
function createEventsSource(uri: ParsedUri): Source<unknown> {
  const path = uri.path || uri.host || './events.jsonl'
  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(ctx: SourceContext): AsyncIterable<Envelope<unknown>> {
      const fullPath = join(ctx.run.global.project.root, path)
      const text = await fsReadFile(fullPath, 'utf-8').catch(() => '')
      for (const line of text.split('\n').filter(Boolean)) {
        yield { item: line, meta: { source: 'events-file' } }
      }
    },
    async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<unknown>> {
      const skip = typeof cursor === 'number' ? cursor : 0
      const fullPath = join(ctx.run.global.project.root, path)
      const text = await fsReadFile(fullPath, 'utf-8').catch(() => '')
      let index = 0
      for (const line of text.split('\n').filter(Boolean)) {
        if (index++ < skip) continue
        yield { item: line, meta: { source: 'events-file' } }
      }
    },
  }
}
registry.registerSource('events-file', createEventsSource)

// Inline subflow: enrich each line and emit an event, then merge back into the parent stream.
const enrichSubflow = definePipeline({ id: 'basic-md-enrich' }).use(toLine).use(emitEvent)

// Child pipelines for .fork() — no source step, so the parent envelope is fed directly in.
const syncBranch = definePipeline({ id: 'basic-md-sync' }).use(markSync)
const asyncBranch = definePipeline({ id: 'basic-md-async' }).use(markAsync)

// Default pipeline: read JSONL, enrich via subflow, fork sync + async branches,
// then write one MD file.
export default definePipeline({ id: 'basic-md-processing' })
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => {
    const { id, text } = record as { id: number; text: string }
    return [{ id, text }]
  })
  .subflow(enrichSubflow)
  .fork(syncBranch)
  .fork(asyncBranch)
  .to('md://./output.md')

// Events target demo: capture every lifecycle event to ./events.jsonl.
export const eventsDemoPipeline = definePipeline({ id: 'basic-md-events-demo' })
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => {
    const { id, text } = record as { id: number; text: string }
    return [{ id, text }]
  })
  .subflow(enrichSubflow)
  .to('events-file://./events.jsonl')

// Events source demo: read back the captured events file and print each line.
export const replayEventsPipeline = definePipeline({ id: 'basic-md-replay-events' })
  .from('events-file://./events.jsonl')
  .tap(async (env) => {
    console.log(`[replay] ${env.item}`)
  })
  .to('void://')

// range:// demo: generate integers, turn them into lines, emit events, then discard everything with void://.
export const rangeDemoPipeline = definePipeline({ id: 'basic-md-range' })
  .from('range://1..3')
  .flatMap(async (n: unknown) => [{ id: n as number, text: `range value ${n}` }])
  .subflow(enrichSubflow)
  .to('void://')

// void:// demo: read the same JSONL source but throw the results away instead of writing a file.
export const voidDemoPipeline = definePipeline({ id: 'basic-md-void' })
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => {
    const { id, text } = record as { id: number; text: string }
    return [{ id, text }]
  })
  .subflow(enrichSubflow)
  .to('void://')

// Non-blocking side pipeline: counts lines independently of the main flow.
// Run this with `mt run ./pipelines/basic-md-processing.ts --pipeline countSidePipeline`.
// It reads the same JSONL source, counts envelopes in batches, and writes the total to a
// sidecar file without blocking or changing the main stream.
export const countSidePipeline = definePipeline({ id: 'basic-md-counter' })
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => {
    const { id, text } = record as { id: number; text: string }
    return [{ id, text }]
  })
  .batch(1000)
  .tap(async (env) => {
    const items = (env.items ?? env.item ?? []) as unknown[]
    console.log(`[counter] side branch counted ${items.length} lines`)
  })
  .to('events-file://./counts.jsonl')
