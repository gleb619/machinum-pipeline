// Repo-dev-only use-case coverage report. Requires `pnpm build` first; never shipped in the mt binary.
// Dynamic imports keep one @mt/core instance when tsx runs this file as CommonJS. Annotations are
// attributed to the module that registered them via registry snapshots: @mt/* dists are cached after
// the package phase, so each sample module's import appends only its own annotate() calls.
import { readFileSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AnnotationRecord } from '../packages/core/dist/index.js'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

const UC_DOC = 'docs/guiding/uc.md'
const SKIP_DIRS = new Set(['depricated', 'deprecated', 'node_modules'])
const SKIP_FILE_SUFFIXES = ['.test.ts', '.d.ts', '.spec.ts']

const USAGE = `Usage: pnpm usecases [--json]

Prints a use-case coverage report for @mt packages and samples/*/pipelines/*.ts.
Run \`pnpm build\` first.

Print a Markdown table (default), or JSON with --json.

Options:
  --json          Print JSON instead of Markdown
  -h, --help      Show this help
`

const PACKAGE_MODULES: readonly [string, string][] = [
  ['core', '../packages/core/dist/index.js'],
  ['waypoint', '../packages/waypoint/dist/index.js'],
  ['tools', '../packages/tools/dist/index.js'],
  ['cli', '../packages/cli/dist/index.js'],
]

interface UcRow {
  name: string
  packages: string[]
  samples: string[]
}

interface ReportRow {
  id: string
  name: string
  packages: string[]
  samples: string[]
}

interface MissingRow {
  id: string
  name: string
}

interface Report {
  rows: ReportRow[]
  missing: MissingRow[]
}

/** UC ids from the uc.md index/detail tables: lines starting `| UCxxx | name |`. */
function declaredUcIds(): Map<string, string> {
  const text = readFileSync(UC_DOC, 'utf-8')
  const found = new Map<string, string>()
  for (const match of text.matchAll(/^\|\s*(UC\d{3})\s*\|\s*([^|]+?)\s*\|/gm)) {
    const id = match[1]
    if (id && !found.has(id)) found.set(id, match[2] ?? '')
  }
  return found
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Sample modules log during import; keep the markdown report on stdout clean. */
async function withMutedStdout<T>(run: () => Promise<T>): Promise<T> {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const originals = methods.map((method) => console[method])
  const redirect = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(' ')}\n`)
  }
  const restore = (): void => {
    for (const [index, method] of methods.entries()) {
      console[method] = originals[index] as typeof console.log
    }
  }
  for (const method of methods) console[method] = redirect
  try {
    return await run()
  } finally {
    restore()
  }
}

/** Repo-relative `samples/<name>/pipelines/*.ts` modules, sorted. */
function discoverSamplePipelineModules(): string[] {
  const found: string[] = []
  for (const sample of readdirSync('samples', { withFileTypes: true })) {
    if (!sample.isDirectory() || SKIP_DIRS.has(sample.name)) continue
    const dir = join('samples', sample.name, 'pipelines')
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      if (SKIP_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
      found.push(join(dir, entry.name))
    }
  }
  return found.sort()
}

async function collectRows(): Promise<{ rows: Map<string, UcRow>; errors: string[] }> {
  const { listAnnotations } = await import('../packages/core/dist/index.js')
  const rows = new Map<string, UcRow>()
  const errors: string[] = []
  let cursor = 0

  const take = (): readonly AnnotationRecord[] => {
    const all = listAnnotations()
    const slice = all.slice(cursor)
    cursor = all.length
    return slice
  }

  const harvest = (source: string, bucket: 'packages' | 'samples'): void => {
    for (const { annotation } of take()) {
      if (annotation.kind !== 'useCase') continue
      const row = rows.get(annotation.id) ?? { name: '', packages: [], samples: [] }
      if (row.name === '' && annotation.name) row.name = annotation.name
      const list = bucket === 'packages' ? row.packages : row.samples
      if (!list.includes(source)) list.push(source)
      rows.set(annotation.id, row)
    }
  }

  for (const [pkg, specifier] of PACKAGE_MODULES) {
    await import(specifier)
    harvest(pkg, 'packages')
  }
  for (const modulePath of discoverSamplePipelineModules()) {
    const label = modulePath.replaceAll('\\', '/')
    try {
      await withMutedStdout(() => import(pathToFileURL(resolve(modulePath)).href))
    } catch (error: unknown) {
      errors.push(`${label}: ${errorMessage(error)}`)
    }
    harvest(label, 'samples')
  }
  return { rows, errors }
}

/** Annotated rows sorted by UC id, plus declared-but-unannotated ids sorted by id. */
function buildReport(rows: Map<string, UcRow>, declared: Map<string, string>): Report {
  const reportRows: ReportRow[] = []
  for (const id of [...rows.keys()].sort()) {
    const row = rows.get(id)
    if (!row) continue
    reportRows.push({
      id,
      name: row.name || declared.get(id) || '',
      packages: [...row.packages],
      samples: [...row.samples],
    })
  }
  const missing: MissingRow[] = [...declared.keys()]
    .filter((id) => !rows.has(id))
    .sort()
    .map((id) => ({ id, name: declared.get(id) ?? '' }))
  return { rows: reportRows, missing }
}

function renderMarkdown(report: Report, declaredCount: number): void {
  const cell = (value: string): string => (value === '' ? '—' : value)
  const list = (values: readonly string[]): string => (values.length === 0 ? '' : values.join(', '))
  console.log('# Use-case coverage')
  console.log('')
  console.log(
    `${report.rows.length} of ${declaredCount} use cases declared in \`${UC_DOC}\` carry at least one useCase() annotation across packages and samples.`,
  )
  console.log('')
  console.log('| UC ID | Name | Annotated in (packages) | Annotated in (samples) |')
  console.log('| --- | --- | --- | --- |')
  for (const row of report.rows) {
    console.log(
      `| ${row.id} | ${cell(row.name)} | ${cell(list(row.packages))} | ${cell(list(row.samples))} |`,
    )
  }
  if (report.missing.length === 0) return
  console.log('')
  console.log('## Declared in docs but not annotated anywhere')
  console.log('')
  console.log(report.missing.map((row) => `${row.id} (${row.name})`).join(', '))
}

async function main(): Promise<void> {
  let json = false
  for (const arg of process.argv.slice(2)) {
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      return
    }
    if (arg === '--json') {
      json = true
      continue
    }
    console.error(`Error: Unknown option for pnpm usecases: ${arg}`)
    process.exit(1)
  }

  const declared = declaredUcIds()
  const { rows, errors } = await collectRows()
  const report = buildReport(rows, declared)
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    renderMarkdown(report, declared.size)
  }
  for (const error of errors) console.error(`Warning: sample module failed to import — ${error}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
