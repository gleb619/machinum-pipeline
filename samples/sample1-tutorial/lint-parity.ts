/**
 * Standalone EN/RU line-parity check (no `mt` run needed).
 *
 *   tsx lint-parity.ts <enDir> <ruDir>
 *
 * Pairs `chapter<N>.md` files by name, prints one table row per chapter and exits 1 when any
 * chapter has a hard error or a RU file is missing.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type LineParityReport, lintLineParity } from '@mt/tools'

const [enArg, ruArg] = process.argv.slice(2)
if (!enArg || !ruArg) {
  console.error('usage: tsx lint-parity.ts <enDir> <ruDir>')
  process.exit(2)
}
const enDir = resolve(enArg)
const ruDir = resolve(ruArg)

const numOf = (f: string) => Number(/(\d+)/.exec(f)?.[1] ?? 0)
const files = (await readdir(enDir))
  .filter((f) => f.endsWith('.md'))
  .sort((a, b) => numOf(a) - numOf(b))

const rows: string[][] = [['file', 'EN lines', 'RU lines', 'cyr', 'errors', 'warn', 'first issue']]
let failed = false
for (const file of files) {
  const en = await readFile(join(enDir, file), 'utf-8')
  let report: LineParityReport | undefined
  try {
    report = lintLineParity(en, await readFile(join(ruDir, file), 'utf-8'))
  } catch {
    // RU file missing
  }
  if (!report) {
    failed = true
    rows.push([file, String(en.split('\n').length), '-', '-', '-', '-', 'RU file missing'])
    continue
  }
  if (!report.ok) failed = true
  const first = report.issues.find((i) => i.severity === 'error') ?? report.issues[0]
  rows.push([
    file,
    String(report.enLines),
    String(report.ruLines),
    report.cyrillicRatio.toFixed(2),
    String(report.errors),
    String(report.warnings),
    first ? `${first.code}${first.line ? `@${first.line}` : ''}` : '',
  ])
}

const widths = (rows[0] as string[]).map((_, c) =>
  Math.max(...rows.map((r) => (r[c] ?? '').length)),
)
for (const r of rows)
  console.log(
    r
      .map((cell, c) => cell.padEnd(widths[c] ?? 0))
      .join('  ')
      .trimEnd(),
  )
console.log(failed ? 'FAIL: parity errors' : `OK: ${files.length} chapter(s)`)
process.exit(failed ? 1 : 0)
