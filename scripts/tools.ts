// Repo-dev-only tool catalogue report. Requires `pnpm build` first; never shipped in the mt binary.
// Dynamic imports keep one @mt/core instance when tsx runs this file as CommonJS.
import { readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Annotation, CategoryAnnotation, IdAnnotation } from '../packages/core/dist/index.js'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

const USAGE = `Usage: pnpm tools [--json]

Prints a tool catalogue for packages/{tools,bookkit}/dist modules and samples/*/pipelines, samples/*/lib.
Run \`pnpm build\` first.

Print a Markdown table (default), or JSON with --json.

Options:
  --json          Print a JSON array instead of Markdown
  -h, --help      Show this help
`

const TOOL_PACKAGES = [
  { dist: join('packages', 'tools', 'dist'), src: join('packages', 'tools', 'src') },
  { dist: join('packages', 'bookkit', 'dist'), src: join('packages', 'bookkit', 'src') },
] as const
const SKIP_SUFFIXES = ['.test.js', '.d.ts', '.map']

/** Minimal runtime view of a tool: named object with an invoke function. */
interface ToolView {
  readonly name: string
  readonly description: string
}

/** Where a tool was found: source path and exported symbol name. */
interface ToolFound {
  source: string
  exportName: string
}

interface ToolRow {
  id: string | null
  tool: string
  exportName: string
  categories: string[]
  ucs: string[]
  alsoCovers: string[]
  description: string
  source: string
}

function isTool(value: unknown): value is ToolView {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { invoke?: unknown }).invoke === 'function'
  )
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

/** Repo-relative `*.js` modules under `packages/tools/dist` (recursive; test/d.ts/map excluded). */
function walkJsModules(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...walkJsModules(path))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
    found.push(path)
  }
  return found.sort()
}

/** Repo-relative `<pkg.src>/<same relative path>.ts` for a dist module. */
function packageSourceOf(modulePath: string, pkg: (typeof TOOL_PACKAGES)[number]): string {
  const rel = relative(pkg.dist, modulePath).replaceAll('\\', '/')
  return `${pkg.src.replaceAll('\\', '/')}/${rel.replace(/\.js$/, '.ts')}`
}

async function collectPackageTools(seen: Map<ToolView, ToolFound>): Promise<void> {
  for (const pkg of TOOL_PACKAGES) {
    const rootBarrel = join(pkg.dist, 'index.js')
    const rootBarrelSource = packageSourceOf(rootBarrel, pkg)
    for (const modulePath of walkJsModules(pkg.dist)) {
      const mod = await import(pathToFileURL(resolve(modulePath)).href)
      for (const [exportName, value] of Object.entries(mod)) {
        if (!isTool(value)) continue
        const found = seen.get(value)
        if (found) {
          // The root barrel only re-exports tools; prefer the defining module's source path.
          if (found.source === rootBarrelSource && modulePath !== rootBarrel) {
            seen.set(value, { source: packageSourceOf(modulePath, pkg), exportName })
          }
          continue
        }
        seen.set(value, { source: packageSourceOf(modulePath, pkg), exportName })
      }
    }
  }
}

async function collectSampleTools(seen: Map<ToolView, ToolFound>): Promise<string[]> {
  const errors: string[] = []
  const samples = readdirSync('samples', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const sample of samples) {
    for (const dirName of ['pipelines', 'lib'] as const) {
      const dir = join('samples', sample.name, dirName)
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
          continue
        }
        const modulePath = join(dir, entry.name)
        const label = modulePath.replaceAll('\\', '/')
        try {
          const mod = await withMutedStdout(() => import(pathToFileURL(resolve(modulePath)).href))
          for (const [exportName, value] of Object.entries(mod)) {
            if (!isTool(value)) continue
            if (seen.has(value)) continue
            seen.set(value, { source: label, exportName })
          }
        } catch (error: unknown) {
          errors.push(`${label}: ${errorMessage(error)}`)
        }
      }
    }
  }
  return errors
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** Numeric part of a tool id (`TL008` → 8), or Infinity when there is no number. */
function toolIdNumber(id: string): number {
  const match = /(\d+)/.exec(id)
  return match ? Number.parseInt(match[1] ?? '0', 10) : Number.POSITIVE_INFINITY
}

function buildRows(
  seen: ReadonlyMap<ToolView, ToolFound>,
  annotationsOf: (target: object) => readonly Annotation[],
): ToolRow[] {
  const annotated: ToolRow[] = []
  const unannotated: ToolRow[] = []
  for (const [tool, found] of seen) {
    const annotations = annotationsOf(tool)
    const toolAnno = annotations.find((a): a is IdAnnotation => a.kind === 'tool')
    const categories = [
      ...new Set(
        annotations
          .filter((a): a is CategoryAnnotation => a.kind === 'category')
          .flatMap((a) => [...a.categories]),
      ),
    ]
    const row: ToolRow = {
      id: toolAnno?.id ?? null,
      tool: tool.name || toolAnno?.name || '',
      exportName: found.exportName,
      categories,
      ucs: toolAnno ? [...toolAnno.refs] : [],
      alsoCovers: toolAnno ? stringList(toolAnno.meta.alsoCovers) : [],
      description: toolAnno?.description || tool.description,
      source: found.source,
    }
    if (toolAnno) annotated.push(row)
    else unannotated.push(row)
  }
  annotated.sort((a, b) => {
    const byId = toolIdNumber(a.id ?? '') - toolIdNumber(b.id ?? '')
    return byId !== 0 ? byId : (a.id ?? '').localeCompare(b.id ?? '')
  })
  unannotated.sort(
    (a, b) => a.source.localeCompare(b.source) || a.exportName.localeCompare(b.exportName),
  )
  return [...annotated, ...unannotated]
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\r\n?|\n/g, '<br>')
}

function cell(value: string): string {
  return value === '' ? '—' : escapeCell(value)
}

function listCell(values: readonly string[]): string {
  return values.length === 0 ? '—' : cell(values.join(', '))
}

function renderMarkdown(rows: readonly ToolRow[]): string {
  const annotated = rows.filter((row) => row.id !== null).length
  const headers = [
    'TL ID',
    'Tool',
    'Export',
    'Categories',
    'UCs',
    'Also covers',
    'Description',
    'Source',
  ]
  const lines = [
    '# Tool catalogue',
    '',
    `${rows.length} tools: ${annotated} annotated with a TL id, ${rows.length - annotated} without.`,
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) {
    const cells = [
      cell(row.id ?? ''),
      cell(row.tool),
      cell(row.exportName),
      listCell(row.categories),
      listCell(row.ucs),
      listCell(row.alsoCovers),
      cell(row.description),
      cell(row.source),
    ]
    lines.push(`| ${cells.join(' | ')} |`)
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
    console.error(`Error: Unknown option for pnpm tools: ${arg}`)
    process.exit(1)
  }

  const { annotationsOf } = await import('../packages/core/dist/index.js')
  const seen = new Map<ToolView, ToolFound>()
  await collectPackageTools(seen)
  const errors = await collectSampleTools(seen)
  const rows = buildRows(seen, annotationsOf)
  console.log(json ? JSON.stringify(rows, null, 2) : renderMarkdown(rows))
  for (const error of errors) {
    console.error(`Warning: sample module failed to import — ${error}`)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
