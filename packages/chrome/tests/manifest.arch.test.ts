import { access, readFile } from 'node:fs/promises'
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

describe('UC-42,43 - Chrome Extension (architectural)', () => {
  it('manifest.json exists', async () => {
    expect(await fileExists('../manifest.json')).toBe(true)
  })

  it('vitest.config.ts exists', async () => {
    expect(await fileExists('../vitest.config.ts')).toBe(true)
  })

  it('background script exists', async () => {
    expect(await fileExists('../src/background/background.ts')).toBe(true)
  })

  it('content script exists', async () => {
    expect(await fileExists('../src/content/content.ts')).toBe(true)
  })

  it('popup script exists', async () => {
    expect(await fileExists('../src/popup/popup.ts')).toBe(true)
  })

  it('messages types exist', async () => {
    expect(await fileExists('../src/messages.ts')).toBe(true)
  })

  it('manifest_version is 3', async () => {
    const raw = await readFile(join(__dirname, '../manifest.json'), 'utf-8')
    const manifest = JSON.parse(raw)
    expect(manifest.manifest_version).toBe(3)
  })

  it('manifest has permissions', async () => {
    const raw = await readFile(join(__dirname, '../manifest.json'), 'utf-8')
    const manifest = JSON.parse(raw)
    expect(manifest.permissions).toContain('activeTab')
  })

  it('manifest has host_permissions', async () => {
    const raw = await readFile(join(__dirname, '../manifest.json'), 'utf-8')
    const manifest = JSON.parse(raw)
    expect(manifest.host_permissions).toContain('http://localhost:7777/*')
  })

  it('manifest declares background service_worker', async () => {
    const raw = await readFile(join(__dirname, '../manifest.json'), 'utf-8')
    const manifest = JSON.parse(raw)
    expect(manifest.background.service_worker).toBeDefined()
  })

  it('messages.ts exports ScrapeRequest interface', async () => {
    const content = await readFile(join(__dirname, '../src/messages.ts'), 'utf-8')
    expect(content).toContain('export interface ScrapeRequest')
  })

  it('messages.ts exports UploadRequest interface', async () => {
    const content = await readFile(join(__dirname, '../src/messages.ts'), 'utf-8')
    expect(content).toContain('export interface UploadRequest')
  })

  it('messages.ts exports at least 3 interfaces', async () => {
    const content = await readFile(join(__dirname, '../src/messages.ts'), 'utf-8')
    const interfaceMatches = content.match(/export interface/g) || []
    expect(interfaceMatches.length).toBeGreaterThanOrEqual(3)
  })
})
