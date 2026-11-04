import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '@mt/core'
import type { RunEvent, RunStateData } from '@mt/core'

/** Default heartbeat TTL: a worker unheard from this long is `lost`, never silently failed. */
export const WORKER_HEARTBEAT_TTL_MS = 60_000
/** Last-Event-ID replay ring size per worker. */
export const WORKER_SIGNAL_RING = 200

export type WorkerStatus = 'online' | 'lost'
export type WorkerSignalType = 'project-changed' | 'run' | 'resume' | 'pause' | 'cancel' | 'drain'

export interface WorkerRecord {
  id: string
  name: string
  tags: string[]
  mtVersion?: string
  capabilities?: Record<string, boolean>
  registeredAt: string
  lastSeen: string
  status: WorkerStatus
  /** Run ids routed to this worker, so a lost worker can pause them (never fail). */
  runs: string[]
  /** Last dispatched signal id; persisted so a main restart never reuses ids. */
  signalSeq?: number
}

export interface WorkerSignal {
  id: number
  type: WorkerSignalType
  ts: string
  data?: Record<string, unknown>
}

export interface WorkerRegistration {
  name?: string
  tags?: string[]
  mtVersion?: string
  capabilities?: Record<string, boolean>
}

interface WorkerRuntime {
  root: string
  record: WorkerRecord
  sequence: number
  ring: WorkerSignal[]
  waiters: Set<(signal: WorkerSignal) => void>
}

const runtimes = new Map<string, WorkerRuntime>()

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isValidWorkerId(id: string): boolean {
  return WORKER_ID.test(id)
}

function workersDir(root: string): string {
  return join(root, '.mt', 'workers')
}

function workerPath(root: string, id: string): string {
  return join(workersDir(root), `${id}.json`)
}

export function workerHeartbeatTtlMs(): number {
  const raw = Number(process.env.MT_WORKER_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : WORKER_HEARTBEAT_TTL_MS
}

export function workerSignalHeartbeatMs(): number {
  const raw = Number(process.env.MT_WORKER_SIGNAL_HEARTBEAT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000
}

function normalizeRecord(value: unknown): WorkerRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !isValidWorkerId(record.id)) return undefined
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  const runs = Array.isArray(record.runs)
    ? record.runs.filter((run): run is string => typeof run === 'string')
    : []
  return {
    id: record.id,
    name: typeof record.name === 'string' && record.name !== '' ? record.name : record.id,
    tags,
    ...(typeof record.mtVersion === 'string' ? { mtVersion: record.mtVersion } : {}),
    ...(typeof record.capabilities === 'object' && record.capabilities !== null
      ? { capabilities: record.capabilities as Record<string, boolean> }
      : {}),
    registeredAt:
      typeof record.registeredAt === 'string' ? record.registeredAt : new Date().toISOString(),
    lastSeen: typeof record.lastSeen === 'string' ? record.lastSeen : new Date().toISOString(),
    status: record.status === 'lost' ? 'lost' : 'online',
    runs,
    ...(typeof record.signalSeq === 'number' && Number.isSafeInteger(record.signalSeq)
      ? { signalSeq: record.signalSeq }
      : {}),
  }
}

async function persist(runtime: WorkerRuntime): Promise<void> {
  await mkdir(workersDir(runtime.root), { recursive: true })
  await atomicWriteFile(
    workerPath(runtime.root, runtime.record.id),
    `${JSON.stringify(runtime.record, null, 2)}\n`,
  )
}

async function loadRuntime(root: string, id: string): Promise<WorkerRuntime | undefined> {
  if (!isValidWorkerId(id)) return undefined
  const existing = runtimes.get(id)
  if (existing !== undefined && existing.root === root) return existing
  let raw: string
  try {
    raw = await readFile(workerPath(root, id), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const record = normalizeRecord(parsed)
  if (record === undefined) return undefined
  const runtime: WorkerRuntime = {
    root,
    record,
    sequence: record.signalSeq ?? 0,
    ring: [],
    waiters: new Set(),
  }
  runtimes.set(id, runtime)
  return runtime
}

function copyRecord(record: WorkerRecord): WorkerRecord {
  return { ...record, tags: [...record.tags], runs: [...record.runs] }
}

export async function registerWorker(
  root: string,
  registration: WorkerRegistration = {},
): Promise<WorkerRecord> {
  const id = randomUUID()
  const now = new Date().toISOString()
  const record: WorkerRecord = {
    id,
    name: registration.name?.trim() || `worker-${id.slice(0, 8)}`,
    tags: [...new Set((registration.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    ...(registration.mtVersion === undefined ? {} : { mtVersion: registration.mtVersion }),
    ...(registration.capabilities === undefined ? {} : { capabilities: registration.capabilities }),
    registeredAt: now,
    lastSeen: now,
    status: 'online',
    runs: [],
    signalSeq: 0,
  }
  const runtime: WorkerRuntime = {
    root,
    record,
    sequence: record.signalSeq ?? 0,
    ring: [],
    waiters: new Set(),
  }
  runtimes.set(id, runtime)
  await persist(runtime)
  return copyRecord(record)
}

/**
 * Mark a worker `lost` and pause its active runs. Pausing keeps the run resumable:
 * a worker that disappeared is an infrastructure failure, not a pipeline failure.
 */
export async function markWorkerLost(root: string, id: string): Promise<WorkerRecord | undefined> {
  const runtime = await loadRuntime(root, id)
  if (runtime === undefined) return undefined
  if (!runtime.record.runs.length && runtime.record.status === 'lost') {
    return copyRecord(runtime.record)
  }
  runtime.record.status = 'lost'
  await persist(runtime)
  for (const runId of runtime.record.runs) {
    await pauseRunForLostWorker(root, runId)
  }
  return copyRecord(runtime.record)
}

/** Sweep every known worker; one whose heartbeat is older than `ttlMs` becomes `lost`. */
export async function sweepWorkers(
  root: string,
  ttlMs = workerHeartbeatTtlMs(),
): Promise<WorkerRecord[]> {
  await hydrateFromDisk(root)
  const now = Date.now()
  const result: WorkerRecord[] = []
  for (const runtime of runtimes.values()) {
    if (runtime.root !== root) continue
    const lastSeen = Date.parse(runtime.record.lastSeen)
    if (runtime.record.status === 'online' && Number.isFinite(lastSeen) && now - lastSeen > ttlMs) {
      await markWorkerLost(root, runtime.record.id)
    }
    result.push(copyRecord(runtime.record))
  }
  return result.sort((left, right) => left.registeredAt.localeCompare(right.registeredAt))
}

async function hydrateFromDisk(root: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(workersDir(root))
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    await loadRuntime(root, id)
  }
}

export async function listWorkers(
  root: string,
  ttlMs = workerHeartbeatTtlMs(),
): Promise<WorkerRecord[]> {
  return sweepWorkers(root, ttlMs)
}

export async function getWorker(
  root: string,
  id: string,
  ttlMs = workerHeartbeatTtlMs(),
): Promise<WorkerRecord | undefined> {
  await sweepWorkers(root, ttlMs)
  const runtime = await loadRuntime(root, id)
  return runtime === undefined ? undefined : copyRecord(runtime.record)
}

export async function heartbeatWorker(
  root: string,
  id: string,
  ttlMs = workerHeartbeatTtlMs(),
): Promise<WorkerRecord | undefined> {
  const runtime = await loadRuntime(root, id)
  if (runtime === undefined) return undefined
  if (runtime.record.status === 'lost') {
    // A late heartbeat is evidence of life again; runs stay paused (resume explicitly).
    runtime.record.status = 'online'
  }
  runtime.record.lastSeen = new Date().toISOString()
  await persist(runtime)
  await sweepWorkers(root, ttlMs)
  return copyRecord(runtime.record)
}

export async function findWorkerByTags(
  root: string,
  tags: readonly string[],
  ttlMs = workerHeartbeatTtlMs(),
): Promise<WorkerRecord | undefined> {
  const required = tags.map((tag) => tag.trim()).filter(Boolean)
  const workers = await listWorkers(root, ttlMs)
  return workers.find(
    (worker) => worker.status === 'online' && required.every((tag) => worker.tags.includes(tag)),
  )
}

export async function attachWorkerRun(
  root: string,
  workerId: string,
  runId: string,
): Promise<void> {
  const runtime = await loadRuntime(root, workerId)
  if (runtime === undefined) throw new Error(`Unknown worker: ${workerId}`)
  if (!runtime.record.runs.includes(runId)) runtime.record.runs.push(runId)
  await persist(runtime)
}

/** Remove a run from every worker record once it reaches a terminal state. */
export async function detachWorkerRun(root: string, runId: string): Promise<void> {
  await hydrateFromDisk(root)
  for (const runtime of runtimes.values()) {
    if (runtime.root !== root) continue
    const next = runtime.record.runs.filter((id) => id !== runId)
    if (next.length === runtime.record.runs.length) continue
    runtime.record.runs = next
    await persist(runtime)
  }
}

export async function dispatchWorkerSignal(
  root: string,
  workerId: string,
  type: WorkerSignalType,
  data?: Record<string, unknown>,
): Promise<WorkerSignal> {
  const runtime = await loadRuntime(root, workerId)
  if (runtime === undefined) throw new Error(`Unknown worker: ${workerId}`)
  const signal: WorkerSignal = {
    id: ++runtime.sequence,
    type,
    ts: new Date().toISOString(),
    ...(data === undefined ? {} : { data }),
  }
  runtime.record.signalSeq = signal.id
  await persist(runtime)
  runtime.ring.push(signal)
  if (runtime.ring.length > WORKER_SIGNAL_RING) {
    runtime.ring.splice(0, runtime.ring.length - WORKER_SIGNAL_RING)
  }
  for (const waiter of runtime.waiters) waiter(signal)
  runtime.waiters.clear()
  return signal
}

export async function workerSignalsAfter(
  root: string,
  workerId: string,
  afterId: number,
): Promise<WorkerSignal[]> {
  const runtime = await loadRuntime(root, workerId)
  if (runtime === undefined) return []
  return runtime.ring.filter((signal) => signal.id > afterId)
}

/** Wait for the next signal after `afterId`; resolves `undefined` on timeout. */
export async function waitForWorkerSignal(
  root: string,
  workerId: string,
  afterId: number,
  timeoutMs: number,
): Promise<WorkerSignal | undefined> {
  const pending = await workerSignalsAfter(root, workerId, afterId)
  if (pending.length > 0) return pending[0]
  const runtime = await loadRuntime(root, workerId)
  if (runtime === undefined) return undefined

  return new Promise<WorkerSignal | undefined>((resolvePromise) => {
    let settled = false
    const finish = (signal: WorkerSignal | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      runtime.waiters.delete(waiter)
      resolvePromise(signal)
    }
    const waiter = (signal: WorkerSignal): void => {
      if (signal.id > afterId) finish(signal)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    runtime.waiters.add(waiter)
    // Re-check after installing the waiter: a signal may have landed between the
    // first ring read and the subscription.
    const late = runtime.ring.find((signal) => signal.id > afterId)
    if (late !== undefined) finish(late)
  })
}

/**
 * Pause a run whose worker disappeared. The engine owns state normally; this is the
 * main-side lifecycle mirror, so `mt ls runs` / `mt inspect` show a resumable run.
 */
export async function pauseRunForLostWorker(root: string, runId: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) return
  const runDir = join(root, '.mt', 'runs', runId)
  const statePath = join(runDir, 'state.json')
  let stateData: RunStateData
  try {
    stateData = JSON.parse(await readFile(statePath, 'utf8')) as RunStateData
  } catch {
    return
  }
  if (stateData.state === 'done' || stateData.state === 'failed' || stateData.state === 'paused') {
    return
  }
  stateData.state = 'paused'
  stateData.updatedAt = new Date().toISOString()
  await atomicWriteFile(statePath, `${JSON.stringify(stateData, null, 2)}\n`)
  const event: RunEvent = {
    type: 'paused',
    ts: new Date().toISOString(),
    runId,
  }
  await mkdir(runDir, { recursive: true })
  await appendFile(join(runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
}

/** Test/route helper: clear the in-memory registry without touching `.mt/workers`. */
export function resetWorkerRegistry(): void {
  runtimes.clear()
}
