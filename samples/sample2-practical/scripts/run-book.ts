/**
 * Timed, crash-safe book chain runner.
 *
 *   pnpm run book -- --label baseline
 *   pnpm run book -- --label tuned --stages en,stats
 *   pnpm run book -- --label tuned --skip chapters,assemble
 *
 * Runs the `runner:<stage>` scripts in the same order as `pnpm run runner`, records the wall
 * time of every stage in `runs/<label>/timings.json` after each stage, and (unless
 * `--no-backup`) freezes the artefacts with `backupRun` so one directory holds the output, the
 * config and the timings.
 */
import { spawn } from 'node:child_process'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLlmConfig } from '@mt/tools'
import { ROOT, assertRealBackend } from '../lib/llm.js'
import { applyNames } from './apply-names.js'
import { backupRun } from './backup-run.js'

/** The chain in dependency order: identical to the `runner` script in package.json. */
export const BOOK_STAGES = [
  'en',
  'stats',
  'split',
  'summary',
  'ner',
  'vocabulary',
  'glossary',
  'glossary-index',
  'quality',
  'preprocess',
  'titles',
  'chapters',
  'assemble',
] as const

export type BookStage = (typeof BOOK_STAGES)[number]

export type StageStatus = 'ok' | 'failed' | 'skipped'

export interface StageTiming {
  ms: number
  status: StageStatus
  exitCode: number | null
}

export interface TimingsRecord {
  label: string
  startedAt: string
  finishedAt?: string
  stages: Record<string, StageTiming>
  totalMs: number
  failedStage?: string
}

export interface RunBookOptions {
  label: string
  /** Comma list from `--stages`; canonical order is preserved. */
  stages?: string
  /** Comma list from `--skip`. */
  skip?: string
  /** Skip the `backupRun` step (`--no-backup`). */
  noBackup?: boolean
  root?: string
  /** Injected stage runner (tests); must return the process exit code. */
  runStage?: (stage: BookStage) => Promise<number>
  /** Injected monotonic clock in nanoseconds (tests). */
  clock?: () => bigint
  /** Resolve and refuse the `mock` backend before starting. Default true. */
  checkBackend?: boolean
  log?: (line: string) => void
}

export interface RunBookResult {
  dir: string
  timings: TimingsRecord
}

function isStage(name: string): name is BookStage {
  return (BOOK_STAGES as readonly string[]).includes(name)
}

function parseNames(raw: string, flag: string): BookStage[] {
  const names = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const out: BookStage[] = []
  for (const name of names) {
    if (!isStage(name)) {
      throw new Error(`unknown stage '${name}' in ${flag}; valid: ${BOOK_STAGES.join(', ')}`)
    }
    out.push(name)
  }
  return out
}

/** Resolve `--stages` / `--skip` into the ordered stage list the runner will execute. */
export function selectStages(selection: { stages?: string; skip?: string } = {}): BookStage[] {
  let stages: BookStage[] = [...BOOK_STAGES]
  if (selection.stages !== undefined) {
    const chosen = new Set(parseNames(selection.stages, '--stages'))
    stages = stages.filter((stage) => chosen.has(stage))
  }
  if (selection.skip !== undefined) {
    const skipped = new Set(parseNames(selection.skip, '--skip'))
    stages = stages.filter((stage) => !skipped.has(stage))
  }
  return stages
}

/** Temp-then-rename so a crash never leaves a half-written `timings.json`. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  await rename(tmp, path)
}

/** Write (or replace) `runs/<label>/timings.json`. Exposed for the crash-safety test. */
export async function writeTimings(dir: string, record: TimingsRecord): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(join(dir, 'timings.json'), record)
}

function spawnStage(root: string, stage: BookStage): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn('pnpm', ['run', `runner:${stage}`], { cwd: root, stdio: 'inherit' })
    child.on('error', () => resolvePromise(1))
    child.on('close', (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)))
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Turn the extractor's glossary proposal into the editorial table. A missing `names.json` is not
 * an error (the sample stays runnable without the table): it logs `names-applied=0`.
 */
async function applyNamesAfterGlossary(root: string, log: (line: string) => void): Promise<void> {
  const namesPath = resolve(root, 'chapters', 'names.json')
  if (!(await exists(namesPath))) {
    log('stage=glossary names-applied=0')
    return
  }
  const result = await applyNames({
    glossaryPath: resolve(root, 'chapters', 'glossary.json'),
    namesPath,
    log,
  })
  log(`stage=glossary names-applied=${result.applied} ignored=${result.ignored}`)
}

function toMs(nanos: bigint): number {
  return Math.round(Number(nanos) / 1_000_000)
}

function printTable(stages: BookStage[], record: TimingsRecord): void {
  const rows: string[][] = [['stage', 'seconds', 'status']]
  for (const stage of stages) {
    const timing = record.stages[stage]
    if (!timing) continue
    rows.push([stage, (timing.ms / 1000).toFixed(2), timing.status])
  }
  rows.push(['total', (record.totalMs / 1000).toFixed(2), record.failedStage ? 'failed' : 'ok'])
  const widths = (rows[0] ?? []).map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  )
  for (const row of rows) {
    console.log(
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
  }
}

/**
 * Run the selected stages, persisting timings after every stage. The first non-zero exit stops
 * the chain: the remaining stages are recorded as `skipped`, `failedStage` is set, and the final
 * timings/table are still written.
 */
export async function runBook(options: RunBookOptions): Promise<RunBookResult> {
  const root = options.root ?? ROOT
  const { label } = options
  if (!label) throw new Error('run label is empty')
  if (options.checkBackend !== false) {
    const config = readLlmConfig(process.env, resolve(root, 'mt.json'))
    assertRealBackend('run-book', config.tool)
  }

  const stages = selectStages({ stages: options.stages, skip: options.skip })
  if (stages.length === 0) throw new Error('no stages selected')

  const runStage = options.runStage ?? ((stage: BookStage) => spawnStage(root, stage))
  const clock = options.clock ?? (() => process.hrtime.bigint())
  const log = options.log ?? ((line: string) => console.log(line))

  const dir = resolve(root, 'runs', label)
  await mkdir(dir, { recursive: true })

  const record: TimingsRecord = {
    label,
    startedAt: new Date().toISOString(),
    stages: {},
    totalMs: 0,
  }
  const chainStart = clock()
  await writeTimings(dir, record)

  let failed = false
  for (const stage of stages) {
    if (failed) {
      record.stages[stage] = { ms: 0, status: 'skipped', exitCode: null }
      continue
    }
    const start = clock()
    const exitCode = await runStage(stage)
    const ms = toMs(clock() - start)
    const status: StageStatus = exitCode === 0 ? 'ok' : 'failed'
    record.stages[stage] = { ms, status, exitCode }
    if (status === 'failed') {
      failed = true
      record.failedStage = stage
    }
    record.totalMs = toMs(clock() - chainStart)
    await writeTimings(dir, record)
    log(`stage=${stage} ${status} ${ms}ms`)
    if (stage === 'glossary' && status === 'ok') {
      await applyNamesAfterGlossary(root, log)
    }
  }

  record.finishedAt = new Date().toISOString()
  record.totalMs = toMs(clock() - chainStart)
  await writeTimings(dir, record)

  if (!options.noBackup) {
    const { meta } = await backupRun({ label, root })
    // `backupRun` replaces the directory, so restore the timings and merge them into the meta.
    await writeTimings(dir, record)
    await writeJsonAtomic(join(dir, 'meta.json'), { ...meta, timings: record })
  }

  printTable(stages, record)
  return { dir, timings: record }
}

interface CliArgs {
  label: string
  stages?: string
  skip?: string
  noBackup: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let label = ''
  let stages: string | undefined
  let skip: string | undefined
  let noBackup = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--label') label = argv[++i] ?? ''
    else if (arg === '--stages') stages = argv[++i]
    else if (arg === '--skip') skip = argv[++i]
    else if (arg === '--no-backup') noBackup = true
    else if (!arg.startsWith('-') && !label) label = arg
  }
  return { label, stages, skip, noBackup }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = await runBook({
      label: args.label,
      ...(args.stages !== undefined ? { stages: args.stages } : {}),
      ...(args.skip !== undefined ? { skip: args.skip } : {}),
      noBackup: args.noBackup,
    })
    console.log(`run-book: wrote ${result.dir}`)
    if (result.timings.failedStage) process.exit(1)
  } catch (err) {
    console.error(`run-book: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
