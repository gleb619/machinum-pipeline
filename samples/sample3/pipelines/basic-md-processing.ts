import { definePipeline, defineTool } from '@mt/core'
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

// Inline subflow: enrich each line and emit an event, then merge back into the parent stream.
const enrichSubflow = definePipeline().use(toLine).use(emitEvent)

// Child pipelines for .fork() — no source step, so the parent envelope is fed directly in.
const syncBranch = definePipeline().use(markSync)
const asyncBranch = definePipeline().use(markAsync)

// Default pipeline: read JSONL, enrich via subflow, fork into sync + async branches, write one MD file.
export default definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => {
    const { id, text } = record as { id: number; text: string }
    return [{ id, text }]
  })
  .subflow(enrichSubflow)
  .fork(syncBranch)
  .fork(asyncBranch)
  .to('md://./output.md')

// range:// demo: generate integers, turn them into lines, emit events, then discard everything with void://.
export const rangeDemoPipeline = definePipeline()
  .from('range://1..3')
  .flatMap(async (n: unknown) => [{ id: n as number, text: `range value ${n}` }])
  .subflow(enrichSubflow)
  .to('void://')

// void:// demo: read the same JSONL source but throw the results away instead of writing a file.
export const voidDemoPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (record: unknown) => {
    const { id, text } = record as { id: number; text: string }
    return [{ id, text }]
  })
  .subflow(enrichSubflow)
  .to('void://')
