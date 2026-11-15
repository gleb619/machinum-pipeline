/**
 * Freeze one run under `runs/<label>/` so two runs can be compared after the fact.
 *
 *   pnpm run backup -- --label baseline
 *
 * The run artefacts (`chapters/ru`, `chapters/book`, the JSON/schema side tables) are
 * git-ignored and overwritten by every run, so a copy plus the configuration that produced it
 * is the only way to answer "what changed between these two books?".
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMtConfigSync } from '@mt/core'
import { readLlmConfig } from '@mt/tools'
import { ROOT, modelEnvVar } from '../lib/llm.js'

/** Directories copied wholesale into the backup. */
export const BACKUP_DIRS = ['chapters/ru', 'chapters/book', 'chapters/en'] as const

/** Side tables copied when present; `chapters/schema/*.json` is handled separately. */
export const BACKUP_FILES = [
  'chapters/titles.json',
  'chapters/glossary.json',
  'chapters/names.json',
] as const

/** Every stage `pickFor()` is called with, so `perStage` covers all of them. */
export const STAGES = ['summary', 'ner', 'translate', 'preprocess', 'titles', 'glossary'] as const

/** Env vars that change what a run produces; recorded verbatim when set. */
const KNOB_ENV = [
  'MT_ONLY_CHAPTERS',
  'MT_TRANSLATE_BLOCK_LINES',
  'MT_TRANSLATE_SLOTS',
  'MT_FORCE_BRANCH',
  'MT_LLM_CACHE',
  'MT_LLM_TIMEOUT_MS',
] as const

const LABEL_PATTERN = /^[A-Za-z0-9._-]+$/

export interface BackupCounts {
  en: number
  ru: number
  book?: { words: number; lines: number }
}

export interface BackupMeta {
  label: string
  createdAt: string
  gitHead: string | null
  gitDirty: boolean
  resolved: {
    tool: string
    model: string
    perStage: Record<string, string>
  }
  knobs: Record<string, string>
  counts: BackupCounts
  missing: string[]
}

export interface BackupOptions {
  label: string
  root?: string
}

export interface BackupResult {
  dir: string
  meta: BackupMeta
}

/** A label must be one safe path segment: no separators, no `..`, non-empty. */
export function assertLabel(label: string): void {
  if (!label) throw new Error('backup label is empty')
  if (label.includes('/') || label.includes('\\') || label.includes('..')) {
    throw new Error(`backup label '${label}' must not contain '/', '\\' or '..'`)
  }
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`backup label '${label}' must match ${LABEL_PATTERN.source}`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function countMarkdown(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.md')).length
  } catch {
    return 0
  }
}

function gitInfo(root: string): { gitHead: string | null; gitDirty: boolean } {
  const stdio: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore']
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8', stdio })
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf-8',
      stdio,
    })
    return { gitHead: head.trim() || null, gitDirty: status.trim() !== '' }
  } catch {
    return { gitHead: null, gitDirty: false }
  }
}

function readKnobs(env: NodeJS.ProcessEnv): Record<string, string> {
  const knobs: Record<string, string> = {}
  for (const key of KNOB_ENV) {
    const value = env[key]
    if (value) knobs[key] = value
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('MT_LLM_MODEL') && value) knobs[key] = value
  }
  return knobs
}

function resolveConfig(root: string): BackupMeta['resolved'] {
  const config = readLlmConfig(process.env, resolve(root, 'mt.json'))
  const settings = readMtConfigSync(root).settings ?? {}
  const perStage: Record<string, string> = {}
  for (const stage of STAGES) {
    const fromEnv = process.env[modelEnvVar(stage)]?.trim()
    const fromFile = settings[`llm.model.${stage}`]
    const fromFileText =
      typeof fromFile === 'string' && fromFile.trim() !== '' ? fromFile.trim() : ''
    perStage[stage] = fromEnv || fromFileText || config.model
  }
  return { tool: config.tool, model: config.model, perStage }
}

async function countBook(root: string): Promise<BackupCounts['book']> {
  try {
    const content = await readFile(join(root, 'chapters/book/book.md'), 'utf-8')
    const words = content.split(/\s+/).filter((word) => word !== '').length
    return { words, lines: content.split(/\r?\n/).length }
  } catch {
    return undefined
  }
}

/**
 * Copy the current run's artefacts to `runs/<label>/` and record the configuration that made
 * them. Missing inputs are not an error (a backup may run before the first chapter exists);
 * they are listed in `meta.json` under `missing`. An existing backup dir is replaced cleanly.
 */
export async function backupRun(options: BackupOptions): Promise<BackupResult> {
  const root = options.root ?? ROOT
  const { label } = options
  assertLabel(label)

  const dir = resolve(root, 'runs', label)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const missing: string[] = []

  for (const rel of BACKUP_DIRS) {
    const source = resolve(root, rel)
    if (await pathExists(source)) {
      await cp(source, resolve(dir, rel), { recursive: true })
      console.log(`backup: ${rel}/ -> runs/${label}/${rel}/`)
    } else {
      missing.push(rel)
      console.log(`backup: skip ${rel}/ (missing)`)
    }
  }

  for (const rel of BACKUP_FILES) {
    const source = resolve(root, rel)
    if (await pathExists(source)) {
      await cp(source, resolve(dir, rel))
      console.log(`backup: ${rel} -> runs/${label}/${rel}`)
    } else {
      missing.push(rel)
      console.log(`backup: skip ${rel} (missing)`)
    }
  }

  const schemaDir = resolve(root, 'chapters/schema')
  const schemaNames = (await readdir(schemaDir).catch(() => [] as string[])).filter((name) =>
    name.endsWith('.json'),
  )
  if (schemaNames.length > 0) {
    await mkdir(resolve(dir, 'chapters/schema'), { recursive: true })
    for (const name of schemaNames) {
      await cp(resolve(schemaDir, name), resolve(dir, 'chapters/schema', name))
    }
    console.log(`backup: chapters/schema/*.json -> runs/${label}/chapters/schema/`)
  } else {
    missing.push('chapters/schema')
    console.log('backup: skip chapters/schema/*.json (missing)')
  }

  const [en, ru, book] = await Promise.all([
    countMarkdown(resolve(root, 'chapters/en')),
    countMarkdown(resolve(root, 'chapters/ru')),
    countBook(root),
  ])
  const counts: BackupCounts = book ? { en, ru, book } : { en, ru }
  if (!book && !missing.includes('chapters/book')) missing.push('chapters/book/book.md')

  const meta: BackupMeta = {
    label,
    createdAt: new Date().toISOString(),
    ...gitInfo(root),
    resolved: resolveConfig(root),
    knobs: readKnobs(process.env),
    counts,
    missing: [...new Set(missing)],
  }
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
  console.log(`backup: meta.json -> runs/${label}/meta.json`)

  return { dir, meta }
}

/** `--label <label>` or a bare first positional argument. */
function parseLabel(argv: string[]): string {
  const flag = argv.indexOf('--label')
  if (flag !== -1) return argv[flag + 1] ?? ''
  return argv.find((arg) => !arg.startsWith('-')) ?? ''
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await backupRun({ label: parseLabel(process.argv.slice(2)) })
    console.log(`backup: wrote ${result.dir}`)
  } catch (err) {
    console.error(`backup: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
