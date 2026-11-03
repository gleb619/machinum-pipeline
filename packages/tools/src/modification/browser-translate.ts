import { statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { category, defineTool, mapConcurrent, setVariable, tool, withItem } from '@mt/core'
import type { Exchange, Tool, ToolContext } from '@mt/core'
import type { TranslateInput, TranslateOutput } from '../core/translate-text.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserTranslateInput {
  text: string
  sourceLang?: string
  targetLang?: string
}

export interface BrowserTranslateOutput extends TranslateOutput {
  translatedText: string
  engine: 'google-endpoint'
  model: 'google-translate-web'
  ms: number
}

export interface BrowserTranslateOptions {
  targetLang?: string
  chromePath?: string
  headless?: boolean
  timeoutMs?: number
  concurrency?: number
  /** Test/custom injection; bypasses Chrome entirely. */
  engine?: BrowserTranslateEngine
}

export interface BrowserTranslateEngine {
  translate(
    input: Required<Pick<BrowserTranslateInput, 'text'>> & {
      sourceLang?: string
      targetLang: string
    },
  ): Promise<string>
  close?(): Promise<void>
}

interface BrowserTranslateVariable {
  engine: 'google-endpoint'
  model: 'google-translate-web'
  ms: number
  targetLang: string
  sourceLang: string
}

export interface TranslationChunk {
  leading: string
  text: string
  trailing: string
}

interface TranslateResult {
  output: BrowserTranslateOutput
  info: BrowserTranslateVariable
}

interface PlaywrightPage {
  goto(
    url: string,
    options?: { waitUntil?: 'domcontentloaded'; timeout?: number },
  ): Promise<unknown>
  waitForFunction(pageFunction: () => boolean, options?: { timeout?: number }): Promise<unknown>
  evaluate<T>(pageFunction: () => T): Promise<T>
  close(): Promise<void>
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>
  on(event: 'disconnected', listener: () => void): void
  close(): Promise<void>
}

interface PlaywrightModule {
  chromium: {
    launch(options: {
      headless: boolean
      executablePath: string
      args: string[]
    }): Promise<PlaywrightBrowser>
  }
}

interface PageServer {
  server: Server
  url: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_CONCURRENCY = 3
const MAX_CHUNK_CHARS = 4000

const PAGE_SCRIPT = `
(() => {
  const ENDPOINT = '${PAGE_ENDPOINT}'

  async function translateChunk(chunk, sourceLang, targetLang) {
    const body = new URLSearchParams()
    body.set('client', 'gtx')
    body.set('sl', sourceLang)
    body.set('tl', targetLang)
    body.set('dt', 't')
    body.set('q', chunk)
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!response.ok) throw new Error('translate endpoint returned HTTP ' + response.status)
    const data = await response.json()
    const segments = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : []
    let translated = ''
    for (const segment of segments) {
      if (Array.isArray(segment) && typeof segment[0] === 'string') translated += segment[0]
    }
    return translated
  }

  const source = document.getElementById('mt-source')
  const text = source && typeof source.textContent === 'string' ? source.textContent : ''
  const root = document.documentElement
  const sourceLang = root.getAttribute('data-source-lang') || 'auto'
  const targetLang = root.getAttribute('data-target-lang') || 'en'

  ;(async () => {
    try {
      const chunksNode = document.getElementById('mt-chunks')
      const chunks = chunksNode ? JSON.parse(chunksNode.textContent || '[]') : []
      let translated = ''
      for (const chunk of chunks) {
        if (!chunk || typeof chunk.text !== 'string' || !chunk.text) continue
        const core = await translateChunk(chunk.text, sourceLang, targetLang)
        translated +=
          (typeof chunk.leading === 'string' ? chunk.leading : '') +
          core +
          (typeof chunk.trailing === 'string' ? chunk.trailing : '')
      }
      window.__MT_TRANSLATE_RESULT__ = translated
      window.__MT_TRANSLATE_DONE__ = true
    } catch (error) {
      window.__MT_TRANSLATE_ERROR__ = error && error.message ? String(error.message) : String(error)
    }
  })()
})()
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeJsonForScript(value: unknown): string {
  return (JSON.stringify(value) ?? '[]')
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function coreLength(raw: string): number {
  return raw.trim().length
}

function splitRawAtBoundaries(text: string): string[] {
  const tokens = text.match(/\s+|\S+/g)
  if (!tokens) return []

  const atoms: string[] = []
  let raw = ''
  for (const token of tokens) {
    raw += token
    if (!/^\s+$/.test(token) || !raw.trim()) continue
    const paragraphBreak = /\n[ \t]*\n/.test(token)
    const sentenceBreak = /[.!?。！？…]["'”’)\]]?$/.test(raw.trim())
    if (paragraphBreak || sentenceBreak) {
      atoms.push(raw)
      raw = ''
    }
  }

  if (raw) {
    if (raw.trim()) atoms.push(raw)
    else if (atoms.length > 0) atoms[atoms.length - 1] += raw
  }
  return atoms
}

function splitRawByMax(raw: string, maxChars: number): string[] {
  if (!raw.trim()) return []
  if (coreLength(raw) <= maxChars) return [raw]

  const tokens = raw.match(/\s+|\S+/g) ?? []
  const pieces: string[] = []
  let current = ''

  for (const token of tokens) {
    if (token.length > maxChars) {
      let prefix = current
      if (coreLength(prefix) > 0) {
        pieces.push(prefix)
        prefix = ''
      }
      current = ''

      let rest = token
      while (rest.length > 0) {
        const available = maxChars - coreLength(prefix)
        const take = Math.max(1, Math.min(rest.length, available))
        const piece = prefix + rest.slice(0, take)
        pieces.push(piece)
        prefix = ''
        rest = rest.slice(take)
      }
      continue
    }

    const candidate = current + token
    if (current && coreLength(candidate) > maxChars) {
      if (current.trim()) pieces.push(current)
      current = token
    } else {
      current = candidate
    }
  }

  if (current) {
    if (current.trim()) pieces.push(current)
    else if (pieces.length > 0) pieces[pieces.length - 1] += current
  }
  return pieces
}

function toTranslationChunk(raw: string): TranslationChunk {
  const leading = raw.match(/^\s*/)?.[0] ?? ''
  const trailing = raw.match(/\s*$/)?.[0] ?? ''
  const end = Math.max(leading.length, raw.length - trailing.length)
  return {
    leading,
    text: raw.slice(leading.length, end),
    trailing,
  }
}

/**
 * Split text into translation chunks while preserving every whitespace character.
 * Each chunk's `text` is translated; `leading`/`trailing` are re-added verbatim.
 */
export function splitTranslationChunks(
  text: string,
  maxChars = MAX_CHUNK_CHARS,
): TranslationChunk[] {
  if (!text.trim() || maxChars < 1) return []

  const pieces: string[] = []
  for (const atom of splitRawAtBoundaries(text)) {
    pieces.push(...splitRawByMax(atom, maxChars))
  }

  const grouped: string[] = []
  let current = ''
  for (const piece of pieces) {
    const candidate = current + piece
    if (current && coreLength(candidate) > maxChars) {
      grouped.push(current)
      current = piece
    } else {
      current = candidate
    }
  }
  if (current) grouped.push(current)

  const chunks: TranslationChunk[] = []
  for (const raw of grouped) {
    const chunk = toTranslationChunk(raw)
    if (chunk.text) chunks.push(chunk)
    else if (chunks.length > 0) {
      const last = chunks[chunks.length - 1]
      if (last) last.trailing += raw
    }
  }
  return chunks
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

function chromeCandidates(): string[] {
  const candidates: string[] = []

  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
    return candidates
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    const programFiles = process.env.PROGRAMFILES
    const programFilesX86 = process.env['PROGRAMFILES(X86)']
    if (localAppData) {
      candidates.push(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
    if (programFiles) {
      candidates.push(join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
    if (programFilesX86) {
      candidates.push(join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    )
    return candidates
  }

  candidates.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  )
  return candidates
}

function browserError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('browser-translate:')) {
    return error instanceof Error ? error : new Error(message)
  }
  return new Error(`browser-translate: ${message}`)
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function isClosedBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /target (?:page, context or browser|page|context|browser) has been closed|browser has been closed/i.test(
    message,
  )
}

async function startPageServer(html: string): Promise<PageServer> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405)
      response.end('Method Not Allowed')
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'close',
    })
    response.end(html)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

  const address: AddressInfo | string | null = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('browser-translate: failed to bind the local page server')
  }

  return { server, url: `http://127.0.0.1:${address.port}/` }
}

function loadPlaywright(): PlaywrightModule {
  const require = createRequire(import.meta.url)
  try {
    const loaded = require('playwright-core') as unknown as PlaywrightModule
    if (!loaded.chromium) {
      throw new Error('module has no chromium export')
    }
    return loaded
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `browser-translate: playwright-core is required (${reason}). Install it as a peer dependency.`,
    )
  }
}

function emptyOutput(): BrowserTranslateOutput {
  return {
    translatedText: '',
    engine: 'google-endpoint',
    model: 'google-translate-web',
    ms: 0,
  }
}

function resolveTargetLang(input: BrowserTranslateInput, options: BrowserTranslateOptions): string {
  const targetLang = input.targetLang?.trim() || options.targetLang?.trim()
  if (!targetLang) {
    throw new Error('browser-translate: targetLang is required (input.targetLang or tool option)')
  }
  return targetLang
}

async function translateOne(
  input: TranslateInput,
  options: BrowserTranslateOptions,
  engine: BrowserTranslateEngine,
): Promise<TranslateResult> {
  const targetLang = resolveTargetLang(input, options)
  const sourceLang = input.sourceLang?.trim() || 'auto'

  if (!input.text.trim()) {
    return {
      output: emptyOutput(),
      info: {
        engine: 'google-endpoint',
        model: 'google-translate-web',
        ms: 0,
        targetLang,
        sourceLang,
      },
    }
  }

  const started = performance.now()
  const translatedText = await engine.translate({
    text: input.text,
    sourceLang,
    targetLang,
  })
  const ms = Math.max(0, Math.round(performance.now() - started))

  return {
    output: {
      translatedText,
      engine: 'google-endpoint',
      model: 'google-translate-web',
      ms,
    },
    info: {
      engine: 'google-endpoint',
      model: 'google-translate-web',
      ms,
      targetLang,
      sourceLang,
    },
  }
}

async function* iterate<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build the local page that performs the translation from inside headless Chrome. */
export function buildTranslatePage(input: {
  text: string
  sourceLang?: string
  targetLang: string
}): string {
  const sourceLang = input.sourceLang?.trim()
  const htmlLang = !sourceLang || sourceLang === 'auto' ? 'en' : sourceLang
  const pageSourceLang = !sourceLang || sourceLang === 'auto' ? 'auto' : sourceLang
  const chunks = splitTranslationChunks(input.text)
  return `<!doctype html>
<html lang="${escapeHtml(htmlLang)}" data-source-lang="${escapeHtml(pageSourceLang)}" data-target-lang="${escapeHtml(input.targetLang)}">
<head>
<meta charset="utf-8">
<title>browser-translate</title>
</head>
<body>
<pre id="mt-source">${escapeHtml(input.text)}</pre>
<script id="mt-chunks" type="application/json">${safeJsonForScript(chunks)}</script>
<script>
${PAGE_SCRIPT}
</script>
</body>
</html>`
}

/** Resolve the Chrome executable: explicit option, `MT_CHROME_PATH`, then common system paths. */
export function resolveChromePath(configured?: string): string {
  const configuredPath = configured?.trim()
  if (configuredPath) {
    if (isFile(configuredPath)) return configuredPath
    throw new Error(
      `browser-translate: Chrome executable not found at ${configuredPath} (chromePath)`,
    )
  }

  const envPath = process.env.MT_CHROME_PATH?.trim()
  if (envPath) {
    if (isFile(envPath)) return envPath
    throw new Error(`browser-translate: Chrome executable not found at ${envPath} (MT_CHROME_PATH)`)
  }

  const candidates = chromeCandidates()
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate
  }

  throw new Error(
    `browser-translate: Chrome executable not found. Set options.chromePath or MT_CHROME_PATH, or install Google Chrome/Chromium. Checked: ${candidates.join(', ')}`,
  )
}

/** Headless Chrome engine backed by a local page and the Google Translate web endpoint. */
export function createHeadlessGoogleEngine(
  options: BrowserTranslateOptions = {},
): BrowserTranslateEngine {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  let browserPromise: Promise<PlaywrightBrowser> | undefined

  const launchBrowser = (): Promise<PlaywrightBrowser> => {
    const executablePath = resolveChromePath(options.chromePath)
    const playwright = loadPlaywright()
    const pending = playwright.chromium
      .launch({
        headless: options.headless ?? true,
        executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      .then((browser) => {
        browser.on('disconnected', () => {
          if (browserPromise === pending) browserPromise = undefined
        })
        return browser
      })
    return pending
  }

  const getBrowser = (): Promise<PlaywrightBrowser> => {
    const current = browserPromise
    if (current) return current

    const pending = launchBrowser()
    browserPromise = pending
    pending.catch(() => {
      if (browserPromise === pending) browserPromise = undefined
    })
    return pending
  }

  return {
    async translate(input): Promise<string> {
      let page: PlaywrightPage | undefined
      let server: Server | undefined

      try {
        const browser = await getBrowser()
        const html = buildTranslatePage(input)
        const started = await startPageServer(html)
        server = started.server

        page = await browser.newPage()
        await page.goto(started.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        await page.waitForFunction(
          () => {
            const state = window as Window & {
              __MT_TRANSLATE_DONE__?: boolean
              __MT_TRANSLATE_ERROR__?: string
            }
            return state.__MT_TRANSLATE_DONE__ === true || Boolean(state.__MT_TRANSLATE_ERROR__)
          },
          { timeout: timeoutMs },
        )

        const state = await page.evaluate(() => {
          const current = window as Window & {
            __MT_TRANSLATE_DONE__?: boolean
            __MT_TRANSLATE_RESULT__?: string
            __MT_TRANSLATE_ERROR__?: string
          }
          return {
            done: current.__MT_TRANSLATE_DONE__ === true,
            result: current.__MT_TRANSLATE_RESULT__,
            error: current.__MT_TRANSLATE_ERROR__,
          }
        })

        if (state.error) throw new Error(`browser-translate: ${state.error}`)
        if (!state.done || typeof state.result !== 'string') {
          throw new Error('browser-translate: page returned no translation')
        }
        return state.result
      } catch (error) {
        if (isClosedBrowserError(error)) browserPromise = undefined
        throw browserError(error)
      } finally {
        if (page) {
          try {
            await page.close()
          } catch {
            // Closing a failed page must not mask the translation error.
          }
        }
        if (server) {
          try {
            await closeServer(server)
          } catch {
            // The server may already be closed after a navigation failure.
          }
        }
      }
    },

    async close(): Promise<void> {
      const pending = browserPromise
      browserPromise = undefined
      if (!pending) return
      let browser: PlaywrightBrowser
      try {
        browser = await pending
      } catch {
        return
      }
      await browser.close()
    },
  }
}

/** Create a browser-backed translation tool; the engine is launched lazily per instance. */
export function createBrowserTranslate(
  options: BrowserTranslateOptions = {},
): Tool<TranslateInput, TranslateOutput> {
  const engine = options.engine ?? createHeadlessGoogleEngine(options)
  const concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY)

  return defineTool<TranslateInput, TranslateOutput>({
    name: 'browser-translate',
    version: '1.0.0',
    mdDescription:
      'Translates text through a headless Chrome page backed by the Google Translate web endpoint.',
    annotations: [
      tool('TL247', {
        name: 'browser-translate',
        description:
          'Translates text through headless Chrome and the Google Translate web endpoint.',
        refs: [],
      }),
      category(['translator']),
    ],
    async invoke(
      env: Exchange<TranslateInput>,
      _ctx: ToolContext,
    ): Promise<Exchange<TranslateOutput>> {
      const inputs = env.items ?? [env.item]
      const outputs: TranslateOutput[] = []
      const infos: BrowserTranslateVariable[] = []

      for await (const result of mapConcurrent(iterate(inputs), concurrency, async (input) =>
        translateOne(input, options, engine),
      )) {
        outputs.push(result.output)
        infos.push(result.info)
      }

      const first = outputs[0] ?? emptyOutput()
      let next = withItem(env, first)
      const info = env.items ? infos : infos[0]
      if (info) next = setVariable(next, 'browserTranslate', info)
      return env.items ? { ...next, items: outputs } : next
    },
  })
}

export const browserTranslate = createBrowserTranslate()
