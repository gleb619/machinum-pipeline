import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type SyncManifestEntry,
  buildManifest,
  createSyncHashCache,
  diffManifests,
  writeSyncFile,
} from '@mt/core'
import { readSyncState, writeSyncState } from './remote-client.js'

export interface WorkerApiRecord {
  id: string
  name: string
  tags: string[]
  status: 'online' | 'lost'
  registeredAt: string
  lastSeen: string
  runs: string[]
}

export interface WorkerRegistrationBody {
  name?: string
  tags?: string[]
  mtVersion?: string
  capabilities?: Record<string, boolean>
}

export interface WorkerApiOptions {
  url: string
  token?: string
}

export interface WorkerProjectPullResult {
  mirrorRoot: string
  transferred: number
  bytes: number
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Invalid worker main URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Worker main URL must use http or https: ${url}`)
  }
  return trimmed
}

function endpoint(base: string, path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, `${base}/`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

function headers(token: string | undefined, extra: Record<string, string> = {}) {
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }
}

async function responseError(response: Response): Promise<Error> {
  let body = ''
  try {
    body = (await response.text()).trim()
  } catch {
    body = ''
  }
  return new Error(
    `Worker main request failed (${response.status})${body === '' ? '' : `: ${body.slice(0, 500)}`}`,
  )
}

async function requestJson<T>(
  base: string,
  path: string,
  token: string | undefined,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(endpoint(base, path), {
    ...init,
    headers: headers(token, (init.headers as Record<string, string> | undefined) ?? {}),
  })
  if (!response.ok) throw await responseError(response)
  return (await response.json()) as T
}

export async function registerWorkerWithMain(
  options: WorkerApiOptions,
  body: WorkerRegistrationBody,
): Promise<WorkerApiRecord> {
  return requestJson<WorkerApiRecord>(
    normalizeBaseUrl(options.url),
    '/api/workers',
    options.token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

export async function heartbeatWorkerWithMain(
  options: WorkerApiOptions,
  workerId: string,
): Promise<WorkerApiRecord> {
  return requestJson<WorkerApiRecord>(
    normalizeBaseUrl(options.url),
    `/api/workers/${encodeURIComponent(workerId)}/heartbeat`,
    options.token,
    { method: 'POST' },
  )
}

/** Post one NDJSON batch into the main run event log. */
export async function getMainRunState(
  options: WorkerApiOptions,
  runId: string,
): Promise<string | undefined> {
  try {
    const state = await requestJson<{ state?: unknown }>(
      normalizeBaseUrl(options.url),
      `/api/runs/${encodeURIComponent(runId)}`,
      options.token,
    )
    return typeof state.state === 'string' ? state.state : undefined
  } catch {
    return undefined
  }
}

export async function postRunEvents(
  options: WorkerApiOptions,
  runId: string,
  ndjson: string,
): Promise<void> {
  const response = await fetch(
    endpoint(normalizeBaseUrl(options.url), `/api/runs/${encodeURIComponent(runId)}/events`),
    {
      method: 'POST',
      headers: headers(options.token, { 'Content-Type': 'application/x-ndjson' }),
      body: ndjson,
    },
  )
  if (!response.ok) throw await responseError(response)
}

/** Stable main identity for the worker mirror path: `.mt/worker/<slug>-<hash8>/`. */
export function workerMirrorPath(root: string, mainUrl: string): string {
  const base = normalizeBaseUrl(mainUrl)
  const slug =
    base
      .replace(/^https?:\/\//, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'main'
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 8)
  return join(root, '.mt', 'worker', `${slug}-${hash}`)
}

async function fetchProjectManifest(options: WorkerApiOptions): Promise<SyncManifestEntry[]> {
  return requestJson<SyncManifestEntry[]>(
    normalizeBaseUrl(options.url),
    '/api/sync/manifest?scope=project',
    options.token,
  )
}

async function downloadProjectFile(
  options: WorkerApiOptions,
  entry: SyncManifestEntry,
): Promise<Buffer> {
  const response = await fetch(
    endpoint(normalizeBaseUrl(options.url), '/api/sync/files', {
      scope: 'project',
      path: entry.path,
    }),
    { headers: headers(options.token) },
  )
  if (!response.ok) throw await responseError(response)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length !== entry.size) {
    throw new Error(`Size mismatch for ${entry.path}: expected ${entry.size}, got ${body.length}`)
  }
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== entry.sha256) throw new Error(`Checksum mismatch for ${entry.path}`)
  return body
}

/**
 * Pull the main project source scope into the worker mirror. Uses the same manifest
 * diff and atomic write rules as T203; secrets are never part of the project scope.
 */
export async function pullWorkerProject(
  root: string,
  mirrorRoot: string,
  options: WorkerApiOptions,
  mainId: string,
): Promise<WorkerProjectPullResult> {
  await mkdir(mirrorRoot, { recursive: true })
  const remote = await fetchProjectManifest(options)
  const hashCache = createSyncHashCache()
  const local = await buildManifest(mirrorRoot, { hashCache })
  const diff = diffManifests(remote, local)
  const state = await readSyncState(root, mainId)
  let bytes = 0
  for (const entry of [...diff.added, ...diff.changed]) {
    const body = await downloadProjectFile(options, entry)
    await writeSyncFile(mirrorRoot, entry.path, body)
    bytes += body.length
  }
  const files = { ...state.files }
  for (const entry of remote) {
    files[entry.path] = { size: entry.size, sha256: entry.sha256, mtime: entry.mtime }
  }
  await writeSyncState(root, {
    version: 1,
    projectId: mainId,
    url: normalizeBaseUrl(options.url),
    updatedAt: new Date().toISOString(),
    files,
    outputs: state.outputs,
  })
  return {
    mirrorRoot,
    transferred: diff.added.length + diff.changed.length,
    bytes,
  }
}
