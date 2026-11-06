import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Runs every `runner:NN` script of this tutorial in declaration order and prints a short report.
 *
 *   pnpm run runner
 *
 * `prepare-input` runs first, so the lorem-ipsum fixtures exist. The two interactive pipes are
 * skipped: 02 waits for its HTTP client (`pnpm run simulate`), 06 waits for latch files and a
 * Ctrl-C (`mt resume`).
 */
const SAMPLE_DIR = import.meta.dirname
const SKIP = new Set(['runner:02', 'runner:06'])

function run(name: string): Promise<{ name: string; code: number | null; output: string }> {
  return new Promise((resolveRun) => {
    const child = spawn('pnpm', ['--silent', 'run', name], {
      cwd: SAMPLE_DIR,
      env: process.env,
    })
    const chunks: string[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf-8')))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf-8')))
    child.on('error', (error) => resolveRun({ name, code: null, output: error.message }))
    child.on('close', (code) => resolveRun({ name, code, output: chunks.join('') }))
  })
}

const pkg = JSON.parse(await readFile(join(SAMPLE_DIR, 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>
}
const runners = Object.keys(pkg.scripts)
  .filter((name) => /^runner:\d+$/.test(name) && !SKIP.has(name))
  .sort()

await run('prepare-input')
const results = []
for (const name of runners) {
  process.stdout.write(`\n=== ${name} ===\n`)
  const result = await run(name)
  process.stdout.write(result.output)
  results.push(result)
}

console.log('\n# Tutorial runner report\n')
for (const result of results) {
  console.log(
    `- ${result.name}: ${result.code === 0 ? 'ok' : `FAILED (${result.code ?? 'killed'})`}`,
  )
}
console.log(`\n${results.filter((r) => r.code === 0).length}/${results.length} runner(s) ok`)
if (results.some((result) => result.code !== 0)) process.exit(1)
