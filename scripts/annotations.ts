// Repo-dev-only annotation listing. Requires `pnpm build` first; never shipped in the mt binary.
// Dynamic imports keep one @mt/core instance when tsx runs this file as CommonJS.
import type { AnnotationKind, AnnotationRecord } from '../packages/core/dist/index.js'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

const USAGE = `Usage: pnpm annotations [options]

Lists annotations registered by built @mt/core, @mt/waypoint and @mt/tools output.
Run \`pnpm build\` first.

Print a Markdown table (default), or JSON with --json.

Options:
  --kind <kind>   Filter by kind: tool | waypoint | useCase | category
  --json          Print a JSON array instead of Markdown
  -h, --help      Show this help
`

interface AnnotationRow {
  kind: AnnotationKind
  id: string
  categories: string[]
  name: string
  description: string
  refs: string[]
  targetName: string
}

function buildRows(records: readonly AnnotationRecord[]): AnnotationRow[] {
  const rows = new Map<string, AnnotationRow>()
  for (const { annotation, targetName } of records) {
    const id = 'id' in annotation ? annotation.id : ''
    const categories = 'categories' in annotation ? [...annotation.categories] : []
    const label = id || categories.join(',')
    const key = `${annotation.kind}\u0000${label}\u0000${targetName}`
    if (rows.has(key)) continue
    rows.set(key, {
      kind: annotation.kind,
      id,
      categories,
      name: annotation.name ?? targetName,
      description: annotation.description ?? '',
      refs: [...annotation.refs],
      targetName,
    })
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      (a.id || a.categories.join(',')).localeCompare(b.id || b.categories.join(',')),
  )
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\r\n?|\n/g, '<br>')
}

function renderMarkdown(rows: readonly AnnotationRow[]): string {
  const headers = ['KIND', 'ID', 'NAME', 'REFS', 'TARGET']
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) {
    // Category annotations have no id; show their category names in the ID column.
    const id = row.id || row.categories.join(',')
    const cells = [row.kind, id, row.name, row.refs.join(', '), row.targetName]
    lines.push(`| ${cells.map(escapeCell).join(' | ')} |`)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const { ANNOTATION_KINDS, listAnnotations } = await import('../packages/core/dist/index.js')
  // Import for side effects: register every tool and waypoint annotation.
  await import('../packages/waypoint/dist/index.js')
  await import('../packages/tools/dist/index.js')

  const parseKind = (value: string | undefined): AnnotationKind => {
    if (!value) {
      console.error(`Error: --kind requires a value (${ANNOTATION_KINDS.join(', ')})`)
      process.exit(1)
    }
    if (!(ANNOTATION_KINDS as readonly string[]).includes(value)) {
      console.error(
        `Error: Unknown annotation kind '${value}' — allowed: ${ANNOTATION_KINDS.join(', ')}`,
      )
      process.exit(1)
    }
    return value as AnnotationKind
  }

  const args = process.argv.slice(2)
  let kind: AnnotationKind | undefined
  let json = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      return
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--kind') {
      kind = parseKind(args[++i])
      continue
    }
    if (arg.startsWith('--kind=')) {
      kind = parseKind(arg.slice('--kind='.length))
      continue
    }
    console.error(`Error: Unknown option for pnpm annotations: ${arg}`)
    process.exit(1)
  }

  const rows = buildRows(listAnnotations(kind))
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    console.log(renderMarkdown(rows))
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
