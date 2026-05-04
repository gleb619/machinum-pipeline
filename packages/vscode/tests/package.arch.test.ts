import { access } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function fileExists(relativePath: string): Promise<boolean> {
  try {
    await access(join(__dirname, relativePath))
    return true
  } catch {
    return false
  }
}

describe('UC-44..46 - VSCode Extension (architectural)', () => {
  it('package.json exists', async () => {
    expect(await fileExists('../package.json')).toBe(true)
  })

  it('vitest.config.ts exists', async () => {
    expect(await fileExists('../vitest.config.ts')).toBe(true)
  })

  it('extension.ts exists', async () => {
    expect(await fileExists('../src/extension.ts')).toBe(true)
  })

  it('hover-provider.ts exists', async () => {
    expect(await fileExists('../src/hover-provider.ts')).toBe(true)
  })

  it('codelens-provider.ts exists', async () => {
    expect(await fileExists('../src/codelens-provider.ts')).toBe(true)
  })

  it('package.json has engines.vscode', async () => {
    const raw = await readFile(join(__dirname, '../package.json'), 'utf-8')
    const pkg = JSON.parse(raw)
    expect(pkg.engines?.vscode).toBeDefined()
  })

  it('package.json has activationEvents', async () => {
    const raw = await readFile(join(__dirname, '../package.json'), 'utf-8')
    const pkg = JSON.parse(raw)
    expect(pkg.activationEvents).toContain('onLanguage:typescript')
  })

  it('package.json activation includes workspaceContains', async () => {
    const raw = await readFile(join(__dirname, '../package.json'), 'utf-8')
    const pkg = JSON.parse(raw)
    expect(pkg.activationEvents).toContain('workspaceContains:mt.json')
  })

  it('package.json contributes jsonValidation', async () => {
    const raw = await readFile(join(__dirname, '../package.json'), 'utf-8')
    const pkg = JSON.parse(raw)
    expect(pkg.contributes?.jsonValidation).toBeDefined()
  })

  it('package.json main points to dist', async () => {
    const raw = await readFile(join(__dirname, '../package.json'), 'utf-8')
    const pkg = JSON.parse(raw)
    expect(pkg.main).toContain('./dist/')
  })

  it('extension.ts exports activate function', async () => {
    const content = await readFile(join(__dirname, '../src/extension.ts'), 'utf-8')
    expect(content).toContain('export function activate')
  })

  it('extension.ts exports deactivate function', async () => {
    const content = await readFile(join(__dirname, '../src/extension.ts'), 'utf-8')
    expect(content).toContain('export function deactivate')
  })

  it('extension.ts registers HoverProvider', async () => {
    const content = await readFile(join(__dirname, '../src/extension.ts'), 'utf-8')
    expect(content).toContain('registerHoverProvider')
  })

  it('extension.ts registers CodeLensProvider', async () => {
    const content = await readFile(join(__dirname, '../src/extension.ts'), 'utf-8')
    expect(content).toContain('registerCodeLensProvider')
  })

  it('extension.ts registers mt.runPipeline command', async () => {
    const content = await readFile(join(__dirname, '../src/extension.ts'), 'utf-8')
    expect(content).toContain('mt.runPipeline')
  })
})
