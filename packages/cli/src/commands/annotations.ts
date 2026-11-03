import { resolve } from 'node:path'
import { ANNOTATION_KINDS, importPipelineModule, listAnnotations } from '@mt/core'
import type { AnnotationKind, AnnotationRecord } from '@mt/core'

// Ensure built-in URI schemes (and their annotations) are registered before listing.
import '@mt/waypoint'

const USAGE = `Usage: mt annotations [pipeline.ts ...] [options]

Lists runtime annotations registered by the loaded modules. Pipeline files are imported
first so their tool/waypoint/useCase annotations are present.

Options:
  --kind <kind>   Filter by kind: tool | waypoint | useCase
  --json          Print a JSON array instead of a table
  -h, --help      Show this help
`

interface AnnotationRow {
  kind: AnnotationKind
  id: string
  name: string
  description: string
  refs: string[]
  targetName: string
}

/**
 * `mt annotations [pipeline.ts ...] [--kind tool|waypoint|useCase] [--json]`
 *
 * Lists runtime annotations from the process-wide registry. Pipeline modules given on the
 * command line are imported first so annotations registered at module load are included.
 */
export async function annotationsCommand(args: string[]): Promise<void> {
  let kind: AnnotationKind | undefined
  let json = false
  const pipelineFiles: string[] = []

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

    if (arg.startsWith('-')) {
      console.error(`Error: Unknown option for mt annotations: ${arg}`)
      process.exit(1)
    }

    pipelineFiles.push(arg)
  }

  for (const file of pipelineFiles) {
    const resolvedPath = resolve(process.cwd(), file)
    try {
      await importPipelineModule(resolvedPath)
    } catch (error) {
      console.error(
        `Error loading pipeline '${file}': ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  }

  const rows = buildRows(listAnnotations(kind))

  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  if (rows.length === 0) {
    console.log('No annotations registered.')
    return
  }

  printTable(rows)
}

function parseKind(value: string | undefined): AnnotationKind {
  if (!value) {
    console.error(`Error: --kind requires a value (${ANNOTATION_KINDS.join(', ')})`)
    process.exit(1)
  }
  if (!isAnnotationKind(value)) {
    console.error(
      `Error: Unknown annotation kind '${value}' — allowed: ${ANNOTATION_KINDS.join(', ')}`,
    )
    process.exit(1)
  }
  return value
}

function isAnnotationKind(value: string): value is AnnotationKind {
  return (ANNOTATION_KINDS as readonly string[]).includes(value)
}

function buildRows(records: readonly AnnotationRecord[]): AnnotationRow[] {
  const byKey = new Map<string, AnnotationRow>()

  for (const record of records) {
    const { annotation, targetName } = record
    const key = `${annotation.kind}\u0000${annotation.id}\u0000${targetName}`
    if (byKey.has(key)) continue
    byKey.set(key, {
      kind: annotation.kind,
      id: annotation.id,
      name: annotation.name ?? targetName,
      description: annotation.description ?? '',
      refs: [...annotation.refs],
      targetName,
    })
  }

  return [...byKey.values()].sort((a, b) => {
    const byKind = a.kind.localeCompare(b.kind)
    return byKind !== 0 ? byKind : a.id.localeCompare(b.id)
  })
}

function printTable(rows: readonly AnnotationRow[]): void {
  const headers = ['KIND', 'ID', 'NAME', 'REFS', 'DESCRIPTION']
  const cells = rows.map((row) => [
    row.kind,
    row.id,
    row.name,
    row.refs.join(', '),
    row.description,
  ])
  const widths = headers.map((header, index) =>
    cells.reduce((width, row) => Math.max(width, (row[index] ?? '').length), header.length),
  )

  const line = (row: readonly string[]): string =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ')

  console.log(line(headers))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of cells) console.log(line(row))
}
