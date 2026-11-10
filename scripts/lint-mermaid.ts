// Repo-dev-only: renders every ```mermaid block in the docs via mermaid-cli
// (headless Chrome) to prove the diagrams actually parse. Exits non-zero on
// any render error. Run via `pnpm lint:md`.

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const mmdc = join(repoRoot, 'node_modules', '.bin', 'mmdc')

// Markdown the hand-written-docs gate covers (kept in sync with .markdownlint-cli2.jsonc).
const roots = ['docs', 'README.md', 'AGENTS.md', 'CLAUDE.md', 'samples']

interface MermaidBlock {
  file: string
  line: number
  source: string
}

function collectMarkdownFiles(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) collectMarkdownFiles(path, acc)
    else if (entry.endsWith('.md') && !stat.isSymbolicLink()) acc.push(path)
  }
}

function collectBlocks(file: string): MermaidBlock[] {
  const text = readFileSync(file, 'utf8')
  const blocks: MermaidBlock[] = []
  const fence = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null = fence.exec(text)
  while (match !== null) {
    const line = text.slice(0, match.index).split('\n').length
    blocks.push({ file, line, source: match[1] ?? '' })
    match = fence.exec(text)
  }
  return blocks
}

function findChrome(): string {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((path): path is string => Boolean(path))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      const path = execFileSync('which', [name], { encoding: 'utf8' }).trim()
      if (path) return path
    } catch {
      // try next name
    }
  }
  throw new Error('No Chrome/Chromium found. Set PUPPETEER_EXECUTABLE_PATH to a Chrome binary.')
}

function main(): void {
  const files: string[] = []
  for (const root of roots) {
    const path = join(repoRoot, root)
    if (!existsSync(path)) continue
    if (statSync(path).isDirectory()) collectMarkdownFiles(path, files)
    else files.push(path)
  }

  const blocks = files.flatMap(collectBlocks)
  if (blocks.length === 0) {
    console.log('lint-mermaid: no mermaid blocks found')
    return
  }

  const tmp = mkdtempSync(join(tmpdir(), 'mt-mermaid-'))
  try {
    const puppeteerConfig = join(tmp, 'puppeteer.json')
    writeFileSync(
      puppeteerConfig,
      JSON.stringify({ executablePath: findChrome(), args: ['--no-sandbox'] }),
    )

    const failures: string[] = []
    blocks.forEach((block, index) => {
      const input = join(tmp, `block-${index}.mmd`)
      const output = join(tmp, `block-${index}.svg`)
      writeFileSync(input, block.source)
      try {
        execFileSync(mmdc, ['-i', input, '-o', output, '--puppeteerConfigFile', puppeteerConfig])
      } catch (error) {
        const detail =
          error instanceof Error ? error.message.split('\n').slice(0, 6).join('\n') : String(error)
        failures.push(`${relative(repoRoot, block.file)}:${block.line}\n${detail}`)
      }
    })

    if (failures.length > 0) {
      console.error(
        `lint-mermaid: ${failures.length}/${blocks.length} block(s) failed to render:\n`,
      )
      console.error(failures.join('\n\n'))
      process.exit(1)
    }
    console.log(`lint-mermaid: rendered ${blocks.length} block(s) OK`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main()
