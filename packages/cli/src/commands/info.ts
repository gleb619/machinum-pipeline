import type { Dirent } from 'node:fs'
import { access, lstat, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_MT_CONFIG, annotate, readMtConfig, useCase } from '@mt/core'
import type { CheckpointNode, MtConfig } from '@mt/core'
import { maskSecrets } from '../utils/mask.js'

/**
 * `mt info` — show the effective project config (secrets masked) and the `.mt` state/runs.
 *
 * Usage: mt info [--json] [--runs <n>]
 */

const DEFAULT_RUN_LIMIT = 10
const MAX_SLOWEST_STEPS = 5
const KNOWN_ENTRIES = ['runs', 'cache', 'vault.json', 'master.key', 'backend', 'router'] as const

export interface InfoOptions {
  json: boolean
  runs: number
}

export interface SizeEntry {
  name: string
  type: 'dir' | 'file'
  bytes: number
  mb: number
  files: number
}

export interface CheckpointCounts {
  total: number
  done: number
  failed: number
  inProgress: number
  pending: number
}

export interface StepCounts {
  /** Unique steps that emitted a `step-done` event (top-level steps have no checkpoint node). */
  done: number
  /** Total `step-done` events, including repeats after a resume. */
  events: number
  /** Nested-scope nodes from the checkpoint tree (fork/subflow/batch). */
  checkpoint: CheckpointCounts
}

export interface SlowStep {
  stepId: string
  durationMs: number
}

export interface RunInfo {
  runId: string
  pipelineId: string
  state: string
  startedAt: string
  updatedAt: string
  durationMs: number
  sizeBytes: number
  sizeMb: number
  steps: StepCounts
  deadLetters: number
  slowestSteps: SlowStep[]
}

export interface RunSummary {
  total: number
  byState: Record<string, number>
  latest: { runId: string; pipelineId: string; state: string; startedAt: string } | null
}

export interface InfoDocument {
  schemaVersion: 1
  project: {
    name: string
    root: string
    configPath: string
    configExists: boolean
    imports: string[]
  }
  config: Record<string, unknown>
  state: {
    root: string
    exists: boolean
    totalBytes: number
    totalMb: number
    entries: SizeEntry[]
    runs: RunSummary
    runList: RunInfo[]
  }
  secrets: {
    envFile: string
    envFilePresent: boolean
    vaultFile: string
    vaultPresent: boolean
    masterKey: 'project' | 'user' | 'default'
  }
  runtime: { node: string; platform: string; arch: string }
}

interface SecretsPaths {
  projectMasterKey: string
  userMasterKey: string
  projectMasterKeyPresent: boolean
  userMasterKeyPresent: boolean
}

interface CollectedInfo {
  info: InfoDocument
  warnings: string[]
  secretsPaths: SecretsPaths
}

interface MeasuredPath {
  exists: boolean
  type: 'dir' | 'file'
  bytes: number
  files: number
}

/** Parse and validate `mt info` arguments. */
export function parseInfoArgs(args: string[]): { options: InfoOptions; help: boolean } {
  // Help wins over every other flag, so `--help --bogus` never fails or echoes a value.
  if (args.includes('-h') || args.includes('--help')) {
    return { options: { json: args.includes('--json'), runs: DEFAULT_RUN_LIMIT }, help: true }
  }

  let json = false
  let runs = DEFAULT_RUN_LIMIT
  let help = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--runs') {
      const value = args[++i]
      runs = parseRunLimit(value)
      continue
    }
    if (arg.startsWith('--runs=')) {
      runs = parseRunLimit(arg.slice('--runs='.length))
      continue
    }
    if (arg.startsWith('-')) {
      // Never echo a value: `--token=secret` may be a mistyped credential.
      const name = arg.includes('=') ? `${arg.slice(0, arg.indexOf('='))}=<redacted>` : arg
      throw new Error(`Unknown option: ${name}`)
    }
    throw new Error('Unexpected positional argument')
  }

  return { options: { json, runs }, help }
}

function parseRunLimit(value: string | undefined): number {
  if (value === undefined || value === '') {
    throw new Error('--runs requires a non-negative integer')
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`--runs requires a non-negative integer, got ${JSON.stringify(value)}`)
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`--runs requires a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

export async function infoCommand(args: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseInfoArgs>
  try {
    parsed = parseInfoArgs(args)
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`)
    printUsage()
    process.exit(1)
    return
  }

  if (parsed.help) {
    printHelp()
    return
  }

  try {
    const collected = await collectInfo(process.cwd(), parsed.options.runs)
    for (const warning of collected.warnings) console.error(`Warning: ${warning}`)
    if (parsed.options.json) {
      console.log(JSON.stringify(collected.info, null, 2))
    } else {
      console.log(renderInfo(collected))
    }
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`)
    process.exit(1)
  }
}

function printUsage(): void {
  console.error('Usage: mt info [--json] [--runs <n>]')
}

function printHelp(): void {
  console.log(`Usage: mt info [--json] [--runs <n>]

Show the effective mt.json (defaults merged, secrets masked) and the .mt state/runs.

Options:
  --json         Emit one machine-readable JSON document (schemaVersion 1)
  --runs <n>     Limit the run table to n runs (default 10; 0 = all)
  -h, --help     Show this help

Only existence of .env/vault/master-key files is checked; their contents are never read.`)
}

async function collectInfo(projectRoot: string, runsLimit: number): Promise<CollectedInfo> {
  const warnings: string[] = []
  const configPath = join(projectRoot, 'mt.json')
  const configExists = await pathIsFile(configPath)

  let rawConfig: Partial<MtConfig>
  try {
    rawConfig = await readMtConfig(projectRoot)
  } catch (error) {
    throw new Error(
      `Cannot read project config ${configPath}: ${safeConfigError(error)}. Fix the JSON syntax and retry.`,
    )
  }

  const imports = await readDeclaredImports(configPath, warnings)
  const effective = deepMerge(DEFAULT_MT_CONFIG as unknown, rawConfig as unknown)
  const effectiveConfig = isPlainObject(effective) ? (effective as Record<string, unknown>) : {}
  const maskedConfig = maskSecrets(effectiveConfig)
  const projectName = projectNameOf(maskedConfig, projectRoot)

  const stateRoot = join(projectRoot, '.mt')
  const stateExists = await pathExists(stateRoot)
  const total = stateExists
    ? await measurePath(stateRoot)
    : { exists: false, type: 'file' as const, bytes: 0, files: 0 }
  const entries = stateExists ? await topLevelEntries(stateRoot) : []
  const runStates = await scanRuns(join(stateRoot, 'runs'), warnings)
  const byState: Record<string, number> = {}
  for (const run of runStates) byState[run.state] = (byState[run.state] ?? 0) + 1
  const latestRun = runStates[0] ?? null
  const runLimit = runsLimit === 0 ? runStates.length : runsLimit
  const runList = await Promise.all(runStates.slice(0, runLimit).map(enrichRun))

  const secretsConfig = isPlainObject(effectiveConfig.secrets) ? effectiveConfig.secrets : {}
  const envFile =
    typeof secretsConfig.envFile === 'string'
      ? secretsConfig.envFile
      : DEFAULT_MT_CONFIG.secrets.envFile
  const envFilePath = resolve(projectRoot, envFile)
  const vaultPath = join(stateRoot, 'vault.json')
  const projectMasterKey = join(stateRoot, 'master.key')
  const userMasterKey = join(mtHome(), 'master.key')

  const [envFilePresent, vaultPresent, projectMasterKeyPresent, userMasterKeyPresent] =
    await Promise.all([
      pathIsFile(envFilePath),
      pathIsFile(vaultPath),
      pathIsFile(projectMasterKey),
      pathIsFile(userMasterKey),
    ])

  const info: InfoDocument = {
    schemaVersion: 1,
    project: {
      name: projectName,
      root: projectRoot,
      configPath,
      configExists,
      imports,
    },
    config: maskedConfig,
    state: {
      root: stateRoot,
      exists: stateExists,
      totalBytes: total.bytes,
      totalMb: toMb(total.bytes),
      entries,
      runs: {
        total: runStates.length,
        byState,
        latest: latestRun
          ? {
              runId: latestRun.runId,
              pipelineId: latestRun.pipelineId,
              state: latestRun.state,
              startedAt: latestRun.startedAt,
            }
          : null,
      },
      runList,
    },
    secrets: {
      envFile,
      envFilePresent,
      vaultFile: vaultPath,
      vaultPresent,
      masterKey: projectMasterKeyPresent ? 'project' : userMasterKeyPresent ? 'user' : 'default',
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  }

  return {
    info,
    warnings,
    secretsPaths: {
      projectMasterKey,
      userMasterKey,
      projectMasterKeyPresent,
      userMasterKeyPresent,
    },
  }
}

async function readDeclaredImports(configPath: string, warnings: string[]): Promise<string[]> {
  try {
    const raw = await readFile(configPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainObject(parsed)) return []
    const imports = parsed.imports
    if (!Array.isArray(imports)) return []
    return imports.filter((entry): entry is string => typeof entry === 'string')
  } catch (error) {
    if (isNotFound(error)) return []
    warnings.push(`Could not read declared imports from ${configPath}: ${safeConfigError(error)}`)
    return []
  }
}

interface RunStateSummary {
  runId: string
  pipelineId: string
  state: string
  startedAt: string
  updatedAt: string
  runDir: string
  checkpoint?: CheckpointNode
}

interface RunEventsInfo {
  /** Timestamp of the first event (the original `started` survives resume). */
  firstTs?: number
  stepDoneEvents: number
  uniqueSteps: number
  slowestSteps: SlowStep[]
}

async function scanRuns(runsRoot: string, warnings: string[]): Promise<RunStateSummary[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(runsRoot, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return []
    warnings.push(`Could not read ${runsRoot}: ${errorMessage(error)}`)
    return []
  }

  const runs: RunStateSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runDir = join(runsRoot, entry.name)
    try {
      const raw = await readFile(join(runDir, 'state.json'), 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (!isPlainObject(parsed)) throw new Error('state.json is not a JSON object')
      runs.push(runStateOf(entry.name, runDir, parsed))
    } catch (error) {
      if (!isNotFound(error)) {
        warnings.push(`Skipping run ${entry.name}: invalid or unreadable state.json`)
      }
    }
  }

  runs.sort((a, b) => sortTime(b) - sortTime(a) || a.runId.localeCompare(b.runId))
  return runs
}

function runStateOf(
  runId: string,
  runDir: string,
  state: Record<string, unknown>,
): RunStateSummary {
  const effectiveRunId = typeof state.runId === 'string' ? state.runId : runId
  const pipelineId = typeof state.pipelineId === 'string' ? state.pipelineId : 'unknown'
  const runState = typeof state.state === 'string' ? state.state : 'pending'
  const startedAt =
    typeof state.startedAt === 'string' ? state.startedAt : new Date(0).toISOString()
  const updatedAt = typeof state.updatedAt === 'string' ? state.updatedAt : startedAt
  const checkpoint = isPlainObject(state.checkpoint)
    ? (state.checkpoint as unknown as CheckpointNode)
    : undefined
  return {
    runId: effectiveRunId,
    pipelineId,
    state: runState,
    startedAt,
    updatedAt,
    runDir,
    checkpoint,
  }
}

/** Newest usable timestamp, falling back to `updatedAt` when `startedAt` is missing/invalid. */
function sortTime(run: RunStateSummary): number {
  const started = timestampOf(run.startedAt)
  if (Number.isFinite(started)) return started
  const updated = timestampOf(run.updatedAt)
  return Number.isFinite(updated) ? updated : 0
}

async function enrichRun(run: RunStateSummary): Promise<RunInfo> {
  const size = await measurePath(run.runDir)
  const events = await readRunEvents(join(run.runDir, 'events.jsonl'), run.startedAt)
  const checkpoint = countCheckpoint(run.checkpoint)
  const now = Date.now()
  const startCandidates = [timestampOf(run.startedAt), events.firstTs].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  const start = startCandidates.length > 0 ? Math.min(...startCandidates) : sortTime(run)
  const updated = timestampOf(run.updatedAt)
  const end = run.state === 'running' ? now : Number.isFinite(updated) ? updated : start

  return {
    runId: run.runId,
    pipelineId: run.pipelineId,
    state: run.state,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0,
    sizeBytes: size.bytes,
    sizeMb: toMb(size.bytes),
    steps: {
      done: Math.max(events.uniqueSteps, checkpoint.done),
      events: events.stepDoneEvents,
      checkpoint,
    },
    deadLetters: await countDeadLetters(join(run.runDir, 'dead-letter.jsonl')),
    slowestSteps: events.slowestSteps,
  }
}

function countCheckpoint(node: CheckpointNode | undefined): CheckpointCounts {
  const counts: CheckpointCounts = { total: 0, done: 0, failed: 0, inProgress: 0, pending: 0 }
  // The synthetic `root` node stays `pending` even for finished runs; count real scopes only.
  for (const child of node?.children ?? []) visitCheckpoint(child, counts)
  return counts
}

function visitCheckpoint(node: CheckpointNode, counts: CheckpointCounts): void {
  counts.total++
  switch (node.state) {
    case 'done':
      counts.done++
      break
    case 'failed':
      counts.failed++
      break
    case 'in-progress':
      counts.inProgress++
      break
    case 'pending':
      counts.pending++
      break
  }
  for (const child of node.children ?? []) visitCheckpoint(child, counts)
}

async function countDeadLetters(path: string): Promise<number> {
  try {
    const content = await readFile(path, 'utf-8')
    // Appends are not atomic: ignore a trailing line the writer did not finish.
    const complete = content.endsWith('\n')
      ? content
      : content.slice(0, content.lastIndexOf('\n') + 1)
    return complete.split(/\r?\n/).filter((line) => line.trim().length > 0).length
  } catch {
    return 0
  }
}

async function readRunEvents(eventsPath: string, startedAt: string): Promise<RunEventsInfo> {
  let content: string
  try {
    content = await readFile(eventsPath, 'utf-8')
  } catch {
    return { stepDoneEvents: 0, uniqueSteps: 0, slowestSteps: [] }
  }

  const durations: SlowStep[] = []
  const steps = new Set<string>()
  let stepDoneEvents = 0
  let firstTs: number | undefined
  let previous = timestampOf(startedAt)
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isPlainObject(event)) continue
    const ts = typeof event.ts === 'string' ? timestampOf(event.ts) : Number.NaN
    if (!Number.isFinite(ts)) continue
    if (firstTs === undefined) firstTs = ts
    if (event.type === 'step-done' && typeof event.stepId === 'string') {
      stepDoneEvents++
      steps.add(event.stepId)
      if (Number.isFinite(previous)) {
        // No `step-start` event exists: this is the gap since the previous event,
        // accurate for linear runs and approximate when fork branches interleave.
        durations.push({ stepId: event.stepId, durationMs: Math.max(0, ts - previous) })
      }
    }
    previous = ts
  }

  return {
    firstTs,
    stepDoneEvents,
    uniqueSteps: steps.size,
    slowestSteps: durations.sort((a, b) => b.durationMs - a.durationMs).slice(0, MAX_SLOWEST_STEPS),
  }
}

async function measurePath(target: string): Promise<MeasuredPath> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(target)
  } catch {
    return { exists: false, type: 'file', bytes: 0, files: 0 }
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return { exists: true, type: 'file', bytes: stats.size, files: 1 }
  }

  let bytes = 0
  let files = 0
  try {
    for (const entry of await readdir(target, { withFileTypes: true })) {
      const child = join(target, entry.name)
      if (entry.isDirectory()) {
        const nested = await measurePath(child)
        bytes += nested.bytes
        files += nested.files
      } else {
        try {
          const childStats = await lstat(child)
          bytes += childStats.size
          files++
        } catch {
          // Vanished between readdir and lstat; skip it.
        }
      }
    }
  } catch {
    // Unreadable directory: report what was measured so far.
  }
  return { exists: true, type: 'dir', bytes, files }
}

async function topLevelEntries(stateRoot: string): Promise<SizeEntry[]> {
  let dirents: Dirent[]
  try {
    dirents = await readdir(stateRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const names = new Set(dirents.map((entry) => entry.name))
  const entries: SizeEntry[] = []
  for (const name of KNOWN_ENTRIES) {
    if (!names.has(name)) continue
    const measured = await measurePath(join(stateRoot, name))
    if (!measured.exists) continue
    entries.push(sizeEntry(name, measured))
  }

  const known = new Set<string>(KNOWN_ENTRIES)
  let otherBytes = 0
  let otherFiles = 0
  let otherIsDir = false
  let hasOther = false
  for (const entry of dirents) {
    if (known.has(entry.name)) continue
    hasOther = true
    const measured = await measurePath(join(stateRoot, entry.name))
    otherBytes += measured.bytes
    otherFiles += measured.files
    if (measured.type === 'dir') otherIsDir = true
  }
  if (hasOther) {
    entries.push({
      name: 'other',
      type: otherIsDir ? 'dir' : 'file',
      bytes: otherBytes,
      mb: toMb(otherBytes),
      files: otherFiles,
    })
  }

  return entries
}

function sizeEntry(name: string, measured: MeasuredPath): SizeEntry {
  return {
    name,
    type: measured.type,
    bytes: measured.bytes,
    mb: toMb(measured.bytes),
    files: measured.files,
  }
}

function projectNameOf(config: Record<string, unknown>, projectRoot: string): string {
  const project = config.project
  if (isPlainObject(project) && typeof project.name === 'string' && project.name !== '') {
    return project.name
  }
  return DEFAULT_MT_CONFIG.project.name || projectRoot
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(base)) out[key] = cloneValue(value)
    for (const [key, value] of Object.entries(over)) {
      const current = out[key]
      out[key] =
        isPlainObject(current) && isPlainObject(value)
          ? deepMerge(current, value)
          : cloneValue(value)
    }
    return out
  }
  return cloneValue(over)
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = cloneValue(entry)
    return out
  }
  return value
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    // Unreadable is not the same as missing, but `info` must stay read-only and non-fatal.
    return false
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  if (path.trim() === '') return false
  try {
    const stats = await stat(path)
    return stats.isFile()
  } catch {
    return false
  }
}

function mtHome(): string {
  return process.env.MT_HOME || join(process.env.HOME || homedir(), '.mt')
}

function timestampOf(value: string): number {
  return Date.parse(value)
}

function toMb(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(3))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Keep the useful location but drop the parser's input excerpt: a malformed
 * `mt.local.json` can contain credentials and Node echoes the offending line.
 */
function safeConfigError(error: unknown): string {
  const message = errorMessage(error)
  const position = message.match(/at position \d+/)?.[0]
  if (/invalid mt\.json/i.test(message)) return `invalid JSON${position ? ` (${position})` : ''}`
  if (/cannot read|ENOENT|EACCES|EPERM/i.test(message)) return 'cannot read file'
  return 'invalid config'
}

function renderInfo({ info, secretsPaths }: CollectedInfo): string {
  const lines: string[] = []
  lines.push(`mt info — ${info.project.name}`)
  lines.push(`Root: ${info.project.root}`)
  lines.push(
    `Config: ${info.project.configPath} (${info.project.configExists ? 'exists' : 'missing'})`,
  )
  lines.push(
    `Imports: ${info.project.imports.length > 0 ? info.project.imports.join(', ') : '(none)'}`,
  )
  lines.push('')
  lines.push('## Effective mt.json (secrets masked)')
  lines.push(JSON.stringify(info.config, null, 2))
  lines.push('')

  lines.push('## State (.mt)')
  lines.push(`Root: ${info.state.root}`)
  lines.push(`Exists: ${info.state.exists ? 'yes' : 'no'}`)
  lines.push(
    `Total: ${formatMb(info.state.totalBytes)} (${info.state.totalBytes} bytes, ${info.state.entries.reduce(
      (sum, entry) => sum + entry.files,
      0,
    )} files)`,
  )
  if (info.state.entries.length > 0) {
    lines.push('Breakdown:')
    for (const entry of info.state.entries) {
      lines.push(
        `  ${entryLabel(entry).padEnd(18)} ${formatMb(entry.bytes).padStart(10)}  ${entry.files} files`,
      )
    }
  }
  lines.push('')

  const runs = info.state.runs
  if (runs.total === 0) {
    lines.push('No runs recorded.')
  } else {
    const states = Object.keys(runs.byState)
      .sort()
      .map((state) => `${state} ${runs.byState[state]}`)
      .join(', ')
    lines.push(`Runs: ${runs.total} total (${states})`)
    if (runs.latest) {
      lines.push(
        `Latest: ${runs.latest.runId} (${runs.latest.pipelineId}) ${runs.latest.state}, started ${formatTimestamp(runs.latest.startedAt)}`,
      )
    }
    lines.push('')
    lines.push(renderRunTable(info.state.runList))
    if (info.state.runList.length < runs.total) {
      lines.push('')
      lines.push(`Showing ${info.state.runList.length} of ${runs.total} runs (--runs 0 = all).`)
    }
    lines.push('')
    lines.push('Slowest steps (latest run; event deltas, approximate for parallel runs)')
    const latest = info.state.runList[0]
    if (latest && latest.slowestSteps.length > 0) {
      for (const step of latest.slowestSteps) {
        lines.push(`  ${formatDuration(step.durationMs).padStart(10)}  ${step.stepId}`)
      }
    } else {
      lines.push('  (none)')
    }
  }
  lines.push('')

  lines.push('## Secrets (existence only)')
  lines.push(
    `envFile: ${info.secrets.envFile} (${info.secrets.envFilePresent ? 'present' : 'missing'})`,
  )
  lines.push(
    `vault: ${info.secrets.vaultFile} (${info.secrets.vaultPresent ? 'present' : 'missing'})`,
  )
  lines.push(
    `master key: ${info.secrets.masterKey} (project present: ${
      secretsPaths.projectMasterKeyPresent ? 'yes' : 'no'
    }, user present: ${secretsPaths.userMasterKeyPresent ? 'yes' : 'no'})`,
  )
  lines.push('')
  lines.push('## Runtime')
  lines.push(`node ${info.runtime.node} (${info.runtime.platform} ${info.runtime.arch})`)
  return lines.join('\n')
}

function renderRunTable(runs: RunInfo[]): string {
  const headers = [
    'Run',
    'Pipeline',
    'State',
    'Started',
    'Duration',
    'Size',
    'Steps done',
    'Dead letters',
  ]
  const rows = runs.map((run) => [
    shortRunId(run.runId),
    run.pipelineId,
    run.state,
    formatTimestamp(run.startedAt),
    formatDuration(run.durationMs),
    formatMb(run.sizeBytes),
    String(run.steps.done),
    String(run.deadLetters),
  ])
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  )
  const renderRow = (row: string[]): string =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join('  ')
      .trimEnd()
  return [
    renderRow(headers),
    renderRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(renderRow),
  ].join('\n')
}

function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId
}

function entryLabel(entry: SizeEntry): string {
  return entry.type === 'dir' ? `${entry.name}/` : entry.name
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatTimestamp(value: string): string {
  const ms = timestampOf(value)
  if (!Number.isFinite(ms)) return value
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function formatDuration(ms: number): string {
  const rounded = Math.round(ms)
  if (rounded < 1000) return `${rounded}ms`
  if (rounded < 60_000) return `${(rounded / 1000).toFixed(2)}s`
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

annotate(
  infoCommand,
  useCase('UC081', {
    name: 'Show project info',
    description: 'Show effective mt.json (secrets masked) and .mt state/runs.',
  }),
)
