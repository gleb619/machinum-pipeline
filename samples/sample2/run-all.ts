/**
 * Aggregate runner for sample2.
 *
 * Launches every sibling runner script of this sample — one after another — and
 * writes one plain-markdown report of the whole sweep to `out/runner-report.md`.
 * The same text goes to stdout, so `pnpm run runner | less` works too.
 *
 * How it works:
 *
 *  1. `package.json` is read and every script that runs a pipeline
 *     (`mt run …`) is picked up. `runner` itself is skipped, so this script
 *     never recurses into itself. Discovery is dynamic: a new `runner:<name>`
 *     script is picked up without touching this file.
 *  2. `prepare-input` runs first when the sample defines it, so the fixtures the
 *     pipelines read (`jsonl/*.jsonl`) always exist.
 *  3. The sibling runners run one by one. sample2 cannot run them in parallel:
 *     `basic-md-processing.ts` and `custom-md-processing.ts` both write
 *     `output.md`, and `chunk-normalization.ts` writes `chapters/ladder-chapters/`
 *     from two of its pipelines. A sample whose runners write to disjoint paths
 *     can raise `CONCURRENCY` and let them run side by side.
 *  4. Each run is recorded: exit code, duration, the run id and the files the
 *     run touched. The run id also names the log file the CLI's duplex logger
 *     wrote (`<sample>/.mt/runs/<runId>/run.log`), which is what
 *     `mt inspect <runId>` reads.
 */
import { spawn } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const SAMPLE_DIR = import.meta.dirname
const PACKAGE_JSON = join(SAMPLE_DIR, 'package.json')
const REPORT_PATH = join(SAMPLE_DIR, 'out', 'runner-report.md')

/** How many sibling runners may run at the same time. 1 = one by one. */
const CONCURRENCY = 1

/** Directories that never carry sample output and are skipped while diffing. */
const IGNORED_DIRS = new Set(['node_modules', '.mt', '.turbo'])

interface ScriptEntry {
  /** Script name in package.json, e.g. `runner:basic`. */
  name: string
  /** The shell command of the script. */
  command: string
  /** Pipeline file the script runs, e.g. `basic-md-processing.ts`. */
  pipelineFile: string | null
  /** Named pipeline of that file, when the script passes `--pipeline`. */
  pipelineName: string | null
}

interface RunResult {
  script: ScriptEntry
  /** Exit code of the child process, `null` when it was killed by a signal. */
  exitCode: number | null
  durationMs: number
  /** Run id parsed from the child's output, `null` when the run never started. */
  runId: string | null
  /** Files the run created or changed, relative to the sample directory. */
  outputs: string[]
  /** Everything the child wrote to stdout and stderr. */
  output: string
}

/** Read `package.json` and return every script that runs a pipeline. */
async function readPipelineScripts(): Promise<ScriptEntry[]> {
  const raw = await readFile(PACKAGE_JSON, 'utf-8')
  const { scripts } = JSON.parse(raw) as { scripts?: Record<string, string> }
  const entries: ScriptEntry[] = []
  for (const [name, command] of Object.entries(scripts ?? {})) {
    if (name === 'runner') continue
    if (!/\bmt run\s/.test(command)) continue
    const pipelineFile = /mt run\s+(\S+)/.exec(command)?.[1] ?? null
    const pipelineName = /--pipeline\s+(\S+)/.exec(command)?.[1] ?? null
    entries.push({ name, command, pipelineFile, pipelineName })
  }
  return entries
}

/** Snapshot every file of the sample directory with its size and mtime. */
async function snapshotFiles(): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(full)
      snapshot.set(full, `${info.size}:${info.mtimeMs}`)
    }
  }
  await walk(SAMPLE_DIR)
  return snapshot
}

/** Files that appeared or changed between two snapshots. */
function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = []
  for (const [file, stamp] of after) {
    if (before.get(file) !== stamp) {
      changed.push(relative(SAMPLE_DIR, file).split(sep).join('/'))
    }
  }
  return changed.sort()
}

/** Run one package script and collect everything about the run. */
async function runScript(script: ScriptEntry, before: Map<string, string>): Promise<RunResult> {
  const started = Date.now()
  const child = spawn('pnpm', ['--silent', 'run', script.name], {
    cwd: SAMPLE_DIR,
    env: process.env,
  })
  const chunks: string[] = []
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf-8')))
  child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf-8')))
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', (error) => {
      chunks.push(`\n${error.message}\n`)
      resolve(null)
    })
    child.on('close', (code) => resolve(code))
  })
  const output = chunks.join('')
  const after = await snapshotFiles()
  return {
    script,
    exitCode,
    durationMs: Date.now() - started,
    runId: /Run ID:\s*(\S+)/.exec(output)?.[1] ?? null,
    outputs: changedFiles(before, after),
    output,
  }
}

/** Run the sample's `prepare-input` script when it has one. */
async function prepareInput(): Promise<boolean> {
  const raw = await readFile(PACKAGE_JSON, 'utf-8')
  const { scripts } = JSON.parse(raw) as { scripts?: Record<string, string> }
  const command = scripts?.['prepare-input']
  if (!command) return false
  const child = spawn(command, { cwd: SAMPLE_DIR, shell: true, env: process.env })
  const code = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null))
    child.on('close', (exit) => resolve(exit))
  })
  return code === 0
}

/** Run the sibling runners, at most `CONCURRENCY` at a time. */
async function runAll(scripts: ScriptEntry[]): Promise<RunResult[]> {
  const results: RunResult[] = []
  for (let index = 0; index < scripts.length; index += CONCURRENCY) {
    const batch = scripts.slice(index, index + CONCURRENCY)
    const before = await snapshotFiles()
    const batchResults = await Promise.all(batch.map((script) => runScript(script, before)))
    results.push(...batchResults)
  }
  return results
}

/** Format a duration as a short human-readable string. */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Wrap text in a fence longer than any fence inside it. */
function fenced(text: string): string {
  return `~~~~text\n${text.trimEnd()}\n~~~~`
}

/** Render the files a run touched as a nested bullet list (one per line). */
function outputList(outputs: string[]): string[] {
  if (outputs.length === 0) return ['- Outputs: none']
  return ['- Outputs:', ...outputs.map((file) => `  - \`${file}\``)]
}

/** One-word status of a run. */
function status(result: RunResult): string {
  if (result.exitCode === 0) return 'ok'
  if (result.exitCode === null) return 'killed'
  return `failed (exit ${result.exitCode})`
}

/** Render the whole sweep as one markdown document. */
function renderReport(results: RunResult[], prepared: boolean): string {
  const failed = results.filter((result) => result.exitCode !== 0)
  const lines: string[] = [
    '# sample2 runner report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Every sibling runner script of this sample, executed one after another.',
    'Command: `pnpm run runner`',
    '',
  ]
  if (prepared) {
    lines.push('Fixtures: `prepare-input` ran before the sweep.', '')
  }
  lines.push(
    '## Summary',
    '',
    '| Runner | Pipeline | Status | Duration |',
    '| --- | --- | --- | --- |',
  )
  for (const result of results) {
    const pipeline = result.script.pipelineFile
      ? `\`${result.script.pipelineFile}\`${
          result.script.pipelineName ? ` (\`${result.script.pipelineName}\`)` : ''
        }`
      : '—'
    lines.push(
      `| \`${result.script.name}\` | ${pipeline} | ${status(result)} | ${formatDuration(
        result.durationMs,
      )} |`,
    )
  }
  lines.push(
    '',
    `Totals: ${results.length} runners, ${results.length - failed.length} ok, ${failed.length} failed.`,
    '',
  )
  for (const result of results) {
    lines.push(
      `## ${result.script.name}`,
      '',
      `- Status: ${status(result)}`,
      `- Duration: ${formatDuration(result.durationMs)}`,
      `- Run id: ${result.runId ? `\`${result.runId}\`` : '—'}`,
      `- Log: ${result.runId ? `\`.mt/runs/${result.runId}/run.log\`` : '—'}`,
      ...outputList(result.outputs),
      '',
      fenced(result.output),
      '',
    )
  }
  return `${lines.join('\n').trimEnd()}\n`
}

async function main(): Promise<void> {
  const scripts = await readPipelineScripts()
  if (scripts.length === 0) {
    console.error('No pipeline scripts found in package.json — nothing to run.')
    process.exit(1)
  }
  const prepared = await prepareInput()
  const results = await runAll(scripts)
  const report = renderReport(results, prepared)
  await mkdir(join(SAMPLE_DIR, 'out'), { recursive: true })
  await writeFile(REPORT_PATH, report, 'utf-8')
  process.stdout.write(report)
  if (results.some((result) => result.exitCode !== 0)) {
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(`runner failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
