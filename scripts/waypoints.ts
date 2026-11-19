// Repo-dev-only waypoint coverage report. Requires `pnpm build` first; never shipped in the mt
// binary. Dynamic imports keep one @mt/core instance when tsx runs this file as CommonJS.
// Annotations are attributed to the module that registered them via registry snapshots: @mt/*
// dists are cached after the package phase, so each sample module's import appends only its own
// annotate()/register calls.
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AnnotationRecord } from '../packages/core/dist/index.js'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

const CORE_MODULE = '../packages/core/dist/index.js'
const WAYPOINT_MODULE = '../packages/waypoint/dist/index.js'
const BUILTIN_LABEL = '@mt/waypoint'

const USAGE = `Usage: pnpm waypoints [--json]

Prints a waypoint coverage report for @mt/waypoint and samples/*/waypoints/*.ts.
Run \`pnpm build\` first.

Print a Markdown table (default), or JSON with --json.

Options:
  --json          Print a JSON array instead of Markdown
  -h, --help      Show this help
`

interface WaypointRow {
  id: string
  names: string[]
  schemes: string[]
  directions: string[]
  registered: string
  targetNames: string[]
  modules: string[]
  refs: string[]
}

interface UnannotatedRow {
  scheme: string
  direction: string
  targetNames: string[]
  module: string
}

/** One report line, shared by the Markdown and JSON renderers. */
interface ReportRow {
  id: string | null
  name: string
  schemes: string[]
  direction: string
  registered: string
  refs: string[]
  factories: string[]
  module: string
}

function addUnique(values: string[], value: string): void {
  if (value !== '' && !values.includes(value)) values.push(value)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
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

/** Repo-relative `samples/<name>/waypoints/*.ts` modules. */
function discoverSampleWaypointModules(): string[] {
  const found: string[] = []
  for (const sample of readdirSync('samples', { withFileTypes: true })) {
    if (!sample.isDirectory()) continue
    const dir = join('samples', sample.name, 'waypoints')
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (entry.endsWith('.ts')) found.push(join(dir, entry))
    }
  }
  return found.sort()
}

async function collectRows(): Promise<{
  rows: Map<string, WaypointRow>
  unannotated: UnannotatedRow[]
  errors: string[]
}> {
  const { listAnnotations, registry } = await import(CORE_MODULE)
  const rows = new Map<string, WaypointRow>()
  const schemeModules = new Map<string, string>()
  const errors: string[] = []
  let cursor = 0

  const take = (): readonly AnnotationRecord[] => {
    const all = listAnnotations('waypoint')
    const slice = all.slice(cursor)
    cursor = all.length
    return slice
  }

  const harvest = (moduleLabel: string): void => {
    for (const { annotation, targetName } of take()) {
      if (annotation.kind !== 'waypoint') continue
      const row = rows.get(annotation.id) ?? {
        id: annotation.id,
        names: [],
        schemes: [],
        directions: [],
        registered: '',
        targetNames: [],
        modules: [],
        refs: [],
      }
      if (annotation.name) addUnique(row.names, annotation.name)
      for (const scheme of stringList(annotation.meta.schemes)) addUnique(row.schemes, scheme)
      if (typeof annotation.meta.direction === 'string') {
        addUnique(row.directions, annotation.meta.direction)
      }
      addUnique(row.targetNames, targetName)
      addUnique(row.modules, moduleLabel)
      for (const ref of annotation.refs) addUnique(row.refs, ref)
      rows.set(annotation.id, row)
    }
  }

  const registrySnapshot = (): Set<string> => {
    return new Set([...registry.getSourceSchemes(), ...registry.getTargetSchemes()])
  }

  await withMutedStdout(() => import(WAYPOINT_MODULE))
  harvest(BUILTIN_LABEL)

  for (const modulePath of discoverSampleWaypointModules()) {
    const before = registrySnapshot()
    const label = modulePath.replaceAll('\\', '/')
    try {
      await withMutedStdout(() => import(pathToFileURL(resolve(modulePath)).href))
    } catch (error: unknown) {
      errors.push(`${label}: ${errorMessage(error)}`)
    }
    harvest(label)
    for (const scheme of registrySnapshot()) {
      if (!before.has(scheme) && !schemeModules.has(scheme)) schemeModules.set(scheme, label)
    }
  }

  const registeredDirections = (schemes: readonly string[]): string => {
    const directions: string[] = []
    if (schemes.some((scheme) => registry.hasSource(scheme))) directions.push('source')
    if (schemes.some((scheme) => registry.hasTarget(scheme))) directions.push('target')
    return directions.join(', ')
  }

  for (const row of rows.values()) row.registered = registeredDirections(row.schemes)

  const coveredSchemes = new Set([...rows.values()].flatMap((row) => row.schemes))
  const allSchemes = new Set([...registry.getSourceSchemes(), ...registry.getTargetSchemes()])
  const unannotated: UnannotatedRow[] = [...allSchemes]
    .filter((scheme) => !coveredSchemes.has(scheme))
    .sort()
    .map((scheme) => {
      const directions: string[] = []
      const targetNames: string[] = []
      if (registry.hasSource(scheme)) {
        directions.push('source')
        const name = registry.getSourceFactory(scheme)?.name
        if (name) addUnique(targetNames, name)
      }
      if (registry.hasTarget(scheme)) {
        directions.push('target')
        const name = registry.getTargetFactory(scheme)?.name
        if (name) addUnique(targetNames, name)
      }
      return {
        scheme,
        direction: directions.join(', '),
        targetNames,
        module: schemeModules.get(scheme) ?? '',
      }
    })

  return { rows, unannotated, errors }
}

function cell(value: string): string {
  return value === '' ? '—' : value
}

function list(values: readonly string[]): string {
  return values.join(', ')
}

/** Annotated rows sorted by WT id first, then unannotated rows by scheme. */
function buildReportRows(
  rows: Map<string, WaypointRow>,
  unannotated: readonly UnannotatedRow[],
): ReportRow[] {
  const report: ReportRow[] = []
  for (const id of [...rows.keys()].sort()) {
    const row = rows.get(id)
    if (!row) continue
    report.push({
      id: row.id,
      name: cell(list(row.names)),
      schemes: row.schemes,
      direction: list(row.directions),
      registered: row.registered,
      refs: row.refs,
      factories: row.targetNames,
      module: list(row.modules),
    })
  }
  for (const row of unannotated) {
    report.push({
      id: null,
      name: `${row.scheme} (unannotated)`,
      schemes: [row.scheme],
      direction: row.direction,
      registered: row.direction,
      refs: [],
      factories: row.targetNames,
      module: row.module,
    })
  }
  return report
}

function renderMarkdown(report: readonly ReportRow[]): string {
  const annotated = report.filter((row) => row.id !== null).length
  const unannotated = report.length - annotated
  const lines = [
    '# Waypoint report',
    '',
    `${report.length} waypoints: ${annotated} annotated (WT###) and ${unannotated} registered without a waypoint annotation.`,
    '',
    '| ID | Name | Schemes | Direction | Registered | UC refs | Factory / module |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const row of report) {
    lines.push(
      `| ${cell(row.id ?? '—')} | ${cell(row.name)} | ${cell(list(row.schemes))} | ${cell(row.direction)} | ${cell(row.registered)} | ${cell(list(row.refs))} | ${cell(list(row.factories))} (${cell(row.module)}) |`,
    )
  }
  return lines.join('\n')
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
    console.error(`Error: Unknown option for pnpm waypoints: ${arg}`)
    process.exit(1)
  }

  const { rows, unannotated, errors } = await collectRows()
  const report = buildReportRows(rows, unannotated)
  console.log(json ? JSON.stringify(report, null, 2) : renderMarkdown(report))
  for (const error of errors) {
    console.error(`Warning: sample waypoint module failed to import — ${error}`)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
