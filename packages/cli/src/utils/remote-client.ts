import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_REMOTE_SYNC,
  MAX_REQUEST_BYTES,
  MT_VERSION,
  type RemoteSyncMode,
  SYNC_PROTOCOL_VERSION,
  type SyncDiff,
  SyncFileTooLargeError,
  type SyncManifestEntry,
  atomicWriteFile,
  buildManifest,
  collectSyncScope,
  createSyncHashCache,
  deleteSyncFile,
  diffManifests,
  isSecretRef,
  readMtConfig,
  resolveEmbedValue,
  resolveKeepassValue,
  resolveProjectId,
  resolveVltValue,
  versionsCompatible,
  writeSyncFile,
} from '@mt/core'

export interface RemoteHealth {
  status: string
  version?: string
  capabilities?: {
    chrome: boolean
    docker: boolean
    playwright: boolean
    ollama: boolean
  }
  syncVersion?: number
}

export class RemoteVersionMismatchError extends Error {
  constructor(
    readonly localVersion: string,
    readonly remoteVersion: string,
  ) {
    super(
      `Remote mt version ${remoteVersion} is incompatible with local ${localVersion} (major.minor must match)`,
    )
    this.name = 'RemoteVersionMismatchError'
  }
}

export class SyncConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`Sync conflict on ${paths.length} file(s): ${paths.join(', ')}; use --force to overwrite`)
    this.name = 'SyncConflictError'
  }
}

export interface SyncStateEntry {
  size: number
  sha256: string
  mtime: number
}

export interface SyncStateFile {
  version: 1
  projectId: string
  url: string
  updatedAt: string
  files: Record<string, SyncStateEntry>
  outputs?: Record<string, SyncStateEntry>
}

export interface RemoteClientOptions {
  root: string
  url: string
  token?: string
  projectId: string
  include?: string[]
  exclude?: string[]
  maxFileBytes?: number
  dryRun?: boolean
  prune?: boolean
  force?: boolean
  allowVersionMismatch?: boolean
  runId?: string
}

export interface RemoteSyncResult {
  direction: 'push' | 'pull'
  projectId: string
  url: string
  added: string[]
  changed: string[]
  removed: string[]
  transferred: number
  deleted: number
  bytes: number
  dryRun: boolean
}

export interface ResolvedRemoteConfig {
  url: string
  token?: string
  projectId: string
  include?: string[]
  exclude?: string[]
  maxFileBytes: number
  mode: RemoteSyncMode
}

export interface RemoteConfigOverrides {
  url?: string
  tokenRef?: string
  projectId?: string
}

interface UploadFrame {
  path: string
  op: 'write' | 'delete'
  data?: Buffer
  sha256?: string
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Invalid remote URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Remote URL must use http or https: ${url}`)
  }
  return trimmed
}

function endpoint(base: string, path: string, params: Record<string, string | undefined>): string {
  const url = new URL(path, `${base}/`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function responseError(response: Response): Promise<Error> {
  let body = ''
  try {
    body = (await response.text()).trim()
  } catch {
    body = ''
  }
  const suffix = body === '' ? '' : `: ${body.slice(0, 500)}`
  return new Error(`Remote request failed (${response.status})${suffix}`)
}

async function jsonRequest<T>(
  url: string,
  token: string | undefined,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...authHeaders(token), ...(init.headers ?? {}) },
  })
  if (!response.ok) throw await responseError(response)
  return (await response.json()) as T
}

/** Fetch the remote health document; no token means the remote may answer with the minimal shape. */
export async function fetchRemoteHealth(url: string, token?: string): Promise<RemoteHealth> {
  return jsonRequest<RemoteHealth>(endpoint(normalizeBaseUrl(url), '/api/health', {}), token)
}

export async function assertRemoteCompatible(
  url: string,
  token?: string,
  allowMismatch = false,
): Promise<RemoteHealth> {
  const health = await fetchRemoteHealth(url, token)
  if (health.syncVersion !== undefined && health.syncVersion !== SYNC_PROTOCOL_VERSION) {
    throw new Error(
      `Remote sync protocol ${health.syncVersion} is not supported (expected ${SYNC_PROTOCOL_VERSION})`,
    )
  }
  if (health.version !== undefined && !versionsCompatible(MT_VERSION, health.version)) {
    if (!allowMismatch) throw new RemoteVersionMismatchError(MT_VERSION, health.version)
  }
  return health
}

export async function fetchRemoteManifest(
  options: Pick<RemoteClientOptions, 'url' | 'token' | 'projectId' | 'runId'> & {
    scope: 'sources' | 'outputs'
  },
): Promise<SyncManifestEntry[]> {
  const base = normalizeBaseUrl(options.url)
  return jsonRequest<SyncManifestEntry[]>(
    endpoint(base, '/api/sync/manifest', {
      projectId: options.projectId,
      scope: options.scope,
      runId: options.runId,
    }),
    options.token,
  )
}

function encodeFrames(frames: readonly UploadFrame[]): Buffer {
  const chunks: Buffer[] = []
  for (const frame of frames) {
    const body = frame.data ?? Buffer.alloc(0)
    const header = Buffer.from(
      JSON.stringify({
        path: frame.path,
        op: frame.op,
        size: body.length,
        sha256: frame.sha256,
      }),
      'utf8',
    )
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(header.length, 0)
    chunks.push(length, header, body)
  }
  return Buffer.concat(chunks)
}

/** Exported for tests and future clients; one buffer is one PUT request. */
export function encodeSyncFrames(
  frames: ReadonlyArray<{ path: string; op?: 'write' | 'delete'; data?: Buffer; sha256?: string }>,
): Buffer {
  return encodeFrames(
    frames.map((frame) => ({
      path: frame.path,
      op: frame.op ?? 'write',
      data: frame.data,
      sha256: frame.sha256,
    })),
  )
}

function batches(frames: readonly UploadFrame[]): UploadFrame[][] {
  const result: UploadFrame[][] = []
  let current: UploadFrame[] = []
  let currentBytes = 0
  // Leave headroom for frame headers; the server also caps the declared Content-Length.
  const batchLimit = MAX_REQUEST_BYTES - 64 * 1024
  for (const frame of frames) {
    const size = frame.data?.length ?? 0
    if (size > batchLimit) throw new Error(`File exceeds request cap: ${frame.path}`)
    if (current.length > 0 && currentBytes + size > batchLimit) {
      result.push(current)
      current = []
      currentBytes = 0
    }
    current.push(frame)
    currentBytes += size
  }
  if (current.length > 0) result.push(current)
  return result
}

async function uploadFrames(
  base: string,
  token: string | undefined,
  projectId: string,
  frames: readonly UploadFrame[],
): Promise<number> {
  let bytes = 0
  for (const batch of batches(frames)) {
    const body = encodeFrames(batch)
    const response = await fetch(endpoint(base, '/api/sync/files', { projectId }), {
      method: 'PUT',
      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(body),
    })
    if (!response.ok) throw await responseError(response)
    bytes += batch.reduce((sum, frame) => sum + (frame.data?.length ?? 0), 0)
  }
  return bytes
}

async function downloadFile(
  base: string,
  token: string | undefined,
  projectId: string,
  entry: SyncManifestEntry,
  scope: 'sources' | 'outputs',
  runId: string | undefined,
): Promise<Buffer> {
  const response = await fetch(
    endpoint(base, '/api/sync/files', {
      projectId,
      path: entry.path,
      scope,
      runId,
    }),
    { headers: authHeaders(token) },
  )
  if (!response.ok) throw await responseError(response)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length !== entry.size) {
    throw new Error(`Size mismatch for ${entry.path}: expected ${entry.size}, got ${body.length}`)
  }
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== entry.sha256) {
    throw new Error(`Checksum mismatch for ${entry.path}`)
  }
  return body
}

export function syncStatePath(root: string, projectId: string): string {
  return join(root, '.mt', 'remote', `${projectId}.sync.json`)
}

function isStateEntry(value: unknown): value is SyncStateEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.size === 'number' &&
    typeof record.sha256 === 'string' &&
    typeof record.mtime === 'number'
  )
}

function isEntryMap(value: unknown): value is Record<string, SyncStateEntry> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(isStateEntry)
}

/** Read the last successful hash map; a missing file is an empty state. */
export async function readSyncState(root: string, projectId: string): Promise<SyncStateFile> {
  const path = syncStatePath(root, projectId)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, projectId, url: '', updatedAt: '', files: {} }
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid sync state at ${path}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid sync state at ${path}`)
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) throw new Error(`Unsupported sync state version at ${path}`)
  if (!isEntryMap(record.files)) throw new Error(`Invalid sync state files at ${path}`)
  return {
    version: 1,
    projectId,
    url: typeof record.url === 'string' ? record.url : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    files: record.files,
    outputs: isEntryMap(record.outputs) ? record.outputs : undefined,
  }
}

export async function writeSyncState(root: string, state: SyncStateFile): Promise<void> {
  const path = syncStatePath(root, state.projectId)
  await mkdir(join(root, '.mt', 'remote'), { recursive: true })
  await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`)
}

function toStateEntry(entry: SyncManifestEntry): SyncStateEntry {
  return { size: entry.size, sha256: entry.sha256, mtime: entry.mtime }
}

function remoteMap(entries: readonly SyncManifestEntry[]): Map<string, SyncManifestEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]))
}

function pushConflicts(
  diff: SyncDiff,
  remote: readonly SyncManifestEntry[],
  state: SyncStateFile,
): string[] {
  const peers = remoteMap(remote)
  const conflicts = new Set<string>()
  for (const entry of diff.changed) {
    const peer = peers.get(entry.path)
    const last = state.files[entry.path]?.sha256
    if (peer && last !== undefined && peer.sha256 !== last && entry.sha256 !== peer.sha256) {
      conflicts.add(entry.path)
    }
  }
  for (const path of diff.removed) {
    const peer = peers.get(path)
    const last = state.files[path]?.sha256
    if (peer && last !== undefined && peer.sha256 !== last) conflicts.add(path)
  }
  return [...conflicts].sort()
}

function pullConflicts(
  remote: readonly SyncManifestEntry[],
  local: readonly SyncManifestEntry[],
  state: SyncStateFile,
): string[] {
  const localByPath = new Map(local.map((entry) => [entry.path, entry]))
  const lastByPath = state.outputs ?? state.files
  const conflicts = new Set<string>()
  for (const entry of remote) {
    const current = localByPath.get(entry.path)
    const last = lastByPath[entry.path]?.sha256
    if (
      current &&
      last !== undefined &&
      current.sha256 !== last &&
      entry.sha256 !== current.sha256
    ) {
      conflicts.add(entry.path)
    }
  }
  return [...conflicts].sort()
}

export async function resolveRemoteConfig(
  root: string,
  overrides: RemoteConfigOverrides = {},
): Promise<ResolvedRemoteConfig> {
  const config = await readMtConfig(root)
  const url = overrides.url ?? config.remote?.url
  if (!url) throw new Error('Missing remote URL: set mt.json remote.url or pass --url')
  const tokenRef = overrides.tokenRef ?? config.remote?.tokenRef
  const token = await resolveRemoteToken(tokenRef)
  const mode = config.remote?.sync?.mode ?? DEFAULT_REMOTE_SYNC.mode
  if (mode === 'git') {
    throw new Error('remote.sync.mode "git" is not implemented yet; use "http"')
  }
  return {
    url: normalizeBaseUrl(url),
    token,
    projectId: resolveProjectId(root, overrides.projectId ?? config.remote?.projectId),
    include: config.remote?.sync?.include,
    exclude: config.remote?.sync?.exclude,
    maxFileBytes: config.remote?.sync?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    mode,
  }
}

/**
 * Resolve `--token-ref`: bare names are environment variables, `env:` is explicit,
 * and `vlt:` / `keepass:` / `embed:` go through the core vault. Plaintext is not accepted.
 */
export async function resolveRemoteToken(ref: string | undefined): Promise<string | undefined> {
  const value = ref?.trim() || process.env.MT_SERVE_TOKEN?.trim()
  if (!value) return undefined
  if (value.startsWith('env:')) {
    const name = value.slice('env:'.length)
    const secret = process.env[name]?.trim()
    if (!secret) throw new Error(`Remote token environment variable "${name}" is not set`)
    return secret
  }
  if (isSecretRef(value)) {
    let resolved = await resolveVltValue(value, process.env)
    resolved = await resolveKeepassValue(resolved, process.env)
    return resolveEmbedValue(resolved, process.env)
  }
  const secret = process.env[value]?.trim()
  if (!secret) {
    throw new Error(`Remote token environment variable "${value}" is not set or empty`)
  }
  return secret
}

async function localManifestForPaths(
  root: string,
  paths: readonly string[],
  allowRunState: boolean,
): Promise<SyncManifestEntry[]> {
  return buildManifest(root, { files: paths, allowRunState })
}

function emptyResult(
  direction: 'push' | 'pull',
  options: RemoteClientOptions,
  diff: SyncDiff,
): RemoteSyncResult {
  return {
    direction,
    projectId: options.projectId,
    url: options.url,
    added: diff.added.map((entry) => entry.path),
    changed: diff.changed.map((entry) => entry.path),
    removed: [...diff.removed],
    transferred: 0,
    deleted: 0,
    bytes: 0,
    dryRun: options.dryRun === true,
  }
}

/** Push the local source scope to the remote mirror. */
export async function syncProjectPush(options: RemoteClientOptions): Promise<RemoteSyncResult> {
  const base = normalizeBaseUrl(options.url)
  await assertRemoteCompatible(base, options.token, options.allowVersionMismatch === true)
  const remote = await fetchRemoteManifest({ ...options, scope: 'sources' })
  const files = await collectSyncScope(options.root, {
    include: options.include,
    exclude: options.exclude,
  })
  const hashCache = createSyncHashCache()
  const local = await buildManifest(options.root, { files, hashCache })
  const diff = diffManifests(local, remote)
  const state = await readSyncState(options.root, options.projectId)
  const conflicts = pushConflicts(diff, remote, state)
  if (conflicts.length > 0 && options.force !== true) throw new SyncConflictError(conflicts)
  const result = emptyResult('push', options, diff)
  if (options.dryRun === true) return result

  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const uploads: UploadFrame[] = []
  for (const entry of [...diff.added, ...diff.changed]) {
    if (entry.size > maxFileBytes) {
      throw new SyncFileTooLargeError(entry.path, entry.size, maxFileBytes)
    }
    const data = await readFile(join(options.root, ...entry.path.split('/')))
    uploads.push({ path: entry.path, op: 'write', data, sha256: entry.sha256 })
  }
  if (options.prune === true) {
    for (const path of diff.removed) uploads.push({ path, op: 'delete' })
  }
  const bytes = await uploadFrames(base, options.token, options.projectId, uploads)

  const nextFiles = { ...state.files }
  for (const entry of local) nextFiles[entry.path] = toStateEntry(entry)
  if (options.prune === true) {
    for (const path of diff.removed) delete nextFiles[path]
  }
  await writeSyncState(options.root, {
    version: 1,
    projectId: options.projectId,
    url: base,
    updatedAt: new Date().toISOString(),
    files: nextFiles,
    outputs: state.outputs,
  })
  return {
    ...result,
    transferred: diff.added.length + diff.changed.length,
    deleted: options.prune === true ? diff.removed.length : 0,
    bytes,
  }
}

/** Pull the remote output scope (run dirs + target outputs) into the local project. */
export async function syncProjectPull(options: RemoteClientOptions): Promise<RemoteSyncResult> {
  const base = normalizeBaseUrl(options.url)
  await assertRemoteCompatible(base, options.token, options.allowVersionMismatch === true)
  const remote = await fetchRemoteManifest({ ...options, scope: 'outputs' })
  const local = await localManifestForPaths(
    options.root,
    remote.map((entry) => entry.path),
    true,
  )
  const diff = diffManifests(remote, local)
  const state = await readSyncState(options.root, options.projectId)
  const conflicts = pullConflicts(remote, local, state)
  const remotePaths = new Set(remote.map((entry) => entry.path))
  const runPrefix = options.runId === undefined ? undefined : `.mt/runs/${options.runId}/`
  const stateOutputs = state.outputs ?? {}
  const staleOutputs = Object.keys(stateOutputs).filter(
    (path) => !remotePaths.has(path) && (runPrefix === undefined || path.startsWith(runPrefix)),
  )
  for (const path of staleOutputs) {
    const current = local.find((entry) => entry.path === path)
    const last = stateOutputs[path]?.sha256
    if (current && last !== undefined && current.sha256 !== last) conflicts.push(path)
  }
  const uniqueConflicts = [...new Set(conflicts)].sort()
  if (uniqueConflicts.length > 0 && options.force !== true) {
    throw new SyncConflictError(uniqueConflicts)
  }
  const result = { ...emptyResult('pull', options, diff), removed: staleOutputs.sort() }
  if (options.dryRun === true) return result

  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  let bytes = 0
  for (const entry of [...diff.added, ...diff.changed]) {
    if (entry.size > maxFileBytes) {
      throw new SyncFileTooLargeError(entry.path, entry.size, maxFileBytes)
    }
    const body = await downloadFile(
      base,
      options.token,
      options.projectId,
      entry,
      'outputs',
      options.runId,
    )
    await writeSyncFile(options.root, entry.path, body, {
      maxBytes: maxFileBytes,
      allowRunState: true,
    })
    bytes += body.length
  }

  let deleted = 0
  const nextOutputs = { ...stateOutputs }
  if (options.prune === true) {
    for (const path of staleOutputs) {
      if (await deleteSyncFile(options.root, path, { allowRunState: true })) deleted++
      delete nextOutputs[path]
    }
  }
  for (const entry of remote) nextOutputs[entry.path] = toStateEntry(entry)
  await writeSyncState(options.root, {
    version: 1,
    projectId: options.projectId,
    url: base,
    updatedAt: new Date().toISOString(),
    files: state.files,
    outputs: nextOutputs,
  })
  return {
    ...result,
    transferred: diff.added.length + diff.changed.length,
    deleted,
    bytes,
  }
}

export const __remoteClientInternals = {
  encodeFrames,
  batches,
  pushConflicts,
  pullConflicts,
}
