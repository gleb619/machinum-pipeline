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

/**
 * Does a Chrome match pattern cover the given URL? http(s) only: a host without a
 * port in the pattern matches every port of that host.
 */
function patternCovers(pattern: string, url: string): boolean {
  const patternParts = /^(\w+):\/\/([^/]+)(\/.*)$/.exec(pattern)
  const urlParts = /^(\w+):\/\/([^/:]+)(?::\d+)?(\/.*)$/.exec(url)
  if (!patternParts || !urlParts) return false
  const [, patternScheme, patternHost, patternPath] = patternParts
  const [, urlScheme, urlHost, urlPath] = urlParts
  if (patternScheme !== urlScheme) return false
  if (patternHost !== urlHost) return false
  return urlPath.startsWith(patternPath.replace(/\*$/, ''))
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
    expect(manifest.host_permissions).toContain('http://localhost/*')
  })

  it('manifest host_permissions cover the backend on any local port', async () => {
    const raw = await readFile(join(__dirname, '../manifest.json'), 'utf-8')
    const manifest = JSON.parse(raw)
    const patterns: string[] = manifest.host_permissions

    // A Chrome match pattern without a port covers every port of that host, so the
    // popup can point at a custom `mt serve --port` without a manifest change.
    expect(patterns.some((p) => patternCovers(p, 'http://localhost:3000/api/runs/x/items'))).toBe(
      true,
    )
    expect(patterns.some((p) => patternCovers(p, 'http://127.0.0.1:3000/api/runs/x/items'))).toBe(
      true,
    )
  })

  it('defaults to the mt serve backend port, not the router port', async () => {
    const background = await readFile(join(__dirname, '../src/background/background.ts'), 'utf-8')
    const chromePort = /DEFAULT_BACKEND_URL = 'http:\/\/localhost:(\d+)'/.exec(background)?.[1]
    expect(chromePort).toBeDefined()

    // `mt serve` owns the runs API; its default port is the one the extension must use.
    const serve = await readFile(join(__dirname, '../../cli/src/commands/serve.ts'), 'utf-8')
    const servePort = /port: (\d+), host: 'localhost'/.exec(serve)?.[1]
    expect(servePort).toBeDefined()

    expect(Number(chromePort)).toBe(Number(servePort))
  })

  it('popup placeholder shows the backend port', async () => {
    const popup = await readFile(join(__dirname, '../src/popup/popup.html'), 'utf-8')
    const background = await readFile(join(__dirname, '../src/background/background.ts'), 'utf-8')
    const chromePort = /DEFAULT_BACKEND_URL = 'http:\/\/localhost:(\d+)'/.exec(background)?.[1]

    expect(popup).toContain(`placeholder="http://localhost:${chromePort}"`)
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
