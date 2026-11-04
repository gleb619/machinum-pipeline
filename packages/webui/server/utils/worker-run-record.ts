import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { atomicWriteFile, createRootCheckpoint } from '@mt/core'
import type { RunEvent, RunStateData } from '@mt/core'
import { detachWorkerRun } from './worker-registry.js'

export interface WorkerRunRecordInput {
  runId: string
  pipeline: string
  pipelineName?: string
}

function runDir(root: string, runId: string): string {
  return join(root, '.mt', 'runs', runId)
}

export function runStatePath(root: string, runId: string): string {
  return join(runDir(root, runId), 'state.json')
}

/**
 * Create the main-side run record before the worker gets the `run` signal. The
 * worker reports events via `POST /api/runs/:id/events`; until then the run reads
 * `running` so `mt ls runs` and the UI can follow it.
 */
export async function createWorkerRunRecord(
  root: string,
  input: WorkerRunRecordInput,
): Promise<void> {
  const now = new Date().toISOString()
  const stateData: RunStateData = {
    runId: input.runId,
    pipelineId: input.pipelineName ?? basename(input.pipeline).replace(/\.[^.]+$/, ''),
    pipelineFile: input.pipeline,
    ...(input.pipelineName === undefined ? {} : { pipelineName: input.pipelineName }),
    state: 'running',
    startedAt: now,
    updatedAt: now,
    checkpoint: createRootCheckpoint('root'),
    contextRef: `runs/${input.runId}/context.json`,
  }
  const dir = runDir(root, input.runId)
  await mkdir(join(dir, 'artifacts'), { recursive: true })
  await atomicWriteFile(join(dir, 'state.json'), `${JSON.stringify(stateData, null, 2)}\n`)
  await writeFile(join(dir, 'events.jsonl'), '', { flag: 'a' })
  await atomicWriteFile(join(dir, 'context.json'), '{}\n')
}

function eventType(value: unknown): RunEvent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || typeof record.ts !== 'string') return undefined
  if (typeof record.runId !== 'string' || record.runId === '') return undefined
  return record as unknown as RunEvent
}

/**
 * Append one NDJSON batch from a worker into the main `events.jsonl`, then mirror the
 * lifecycle transition into `state.json`. The batch is validated before anything is
 * written, so a malformed request cannot leave half a batch behind.
 */
export async function ingestRunEvents(
  root: string,
  runId: string,
  body: string,
): Promise<{ written: number; state?: string }> {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return { written: 0 }
  const events: RunEvent[] = []
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error('Invalid NDJSON event line')
    }
    const event = eventType(parsed)
    if (event === undefined) throw new Error('Invalid run event shape')
    events.push(event)
  }

  const dir = runDir(root, runId)
  await mkdir(dir, { recursive: true })
  await appendFile(
    join(dir, 'events.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  )

  const nextState = nextRunState(events)
  if (nextState !== undefined) {
    const statePath = join(dir, 'state.json')
    try {
      const stateData = JSON.parse(await readFile(statePath, 'utf8')) as RunStateData
      const merged = mergeState(stateData, nextState)
      await atomicWriteFile(statePath, `${JSON.stringify(merged, null, 2)}\n`)
    } catch {
      // No main-side record (e.g. a run started outside the worker route): events are
      // still canonical and stay readable.
      return { written: events.length }
    }
  }
  if (nextState === 'done' || nextState === 'failed' || nextState === 'paused') {
    await detachWorkerRun(root, runId)
  }
  return { written: events.length, ...(nextState === undefined ? {} : { state: nextState }) }
}

function nextRunState(events: readonly RunEvent[]): RunStateData['state'] | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'done') return 'done'
    if (event.type === 'failed') return 'failed'
    if (event.type === 'paused') return 'paused'
    if (event.type === 'started' || event.type === 'resumed') return 'running'
  }
  return undefined
}

function mergeState(stateData: RunStateData, next: RunStateData['state']): RunStateData {
  const current = stateData.state
  // A lost-worker pause must not be overwritten by a late `running` heartbeat event.
  if (current === 'paused' && (next === 'running' || next === 'pending')) return stateData
  // Terminal states are final; a duplicate replay must not reopen them.
  if (current === 'done' || current === 'failed') return stateData
  stateData.state = next
  stateData.updatedAt = new Date().toISOString()
  stateData.checkpoint.state =
    next === 'done'
      ? 'done'
      : next === 'failed'
        ? 'failed'
        : next === 'running'
          ? 'in-progress'
          : 'pending'
  return stateData
}
