import { readFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import {
  type H3Event,
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  setResponseHeader,
  toNodeListener,
} from 'h3'
import healthRoute from './routes/api/health.js'
import pipelinesRoute from './routes/api/pipelines.js'
import runRoute from './routes/api/runs/[id].js'
import eventsRoute from './routes/api/runs/[id]/events.js'
import itemsRoute from './routes/api/runs/[id]/items.js'
import pauseRoute from './routes/api/runs/[id]/pause.js'
import resumeRoute from './routes/api/runs/[id]/resume.js'
import runsRoute from './routes/api/runs/index.js'
import startRoute from './routes/api/runs/start.js'
import { closeSqlite, initSqlite } from './utils/sqlite.js'

/**
 * Nitro-free runtime for the admin API. Mounts the very same h3 handlers that Nitro file-routing
 * serves in dev (`server/routes/api/**`) on a plain h3 app + `node:http`, so it runs under Node
 * and inside the Bun single-file binary (Bun implements `node:http`), without nitropack.
 */

/** Embedded UI: URL path -> file path (set by the Bun binary build as `globalThis.__MT_UI__`). */
export type EmbeddedUi = Record<string, string>

export interface StartBackendOptions {
  port?: number
  host?: string
  /** Directory with the built admin UI (vite `dist`). Ignored when `ui` is given. */
  uiDir?: string
  /** Embedded UI map (single-file binary). Defaults to `globalThis.__MT_UI__`. */
  ui?: EmbeddedUi
}

export interface BackendHandle {
  host: string
  port: number
  url: string
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

type UiLookup = (urlPath: string) => string | undefined

function embeddedLookup(ui: EmbeddedUi): UiLookup {
  return (p) => ui[p]
}

function dirLookup(dir: string): UiLookup {
  const root = resolve(dir)
  return (p) => {
    const full = normalize(join(root, p))
    return full === root || full.startsWith(root + sep) ? full : undefined
  }
}

async function tryRead(path: string | undefined): Promise<Buffer | null> {
  if (!path) return null
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

function uiHandler(lookup: UiLookup) {
  return defineEventHandler(async (event: H3Event) => {
    const method = event.method
    const pathname = decodeURIComponent((event.path ?? '/').split('?')[0] ?? '/')
    if (pathname.startsWith('/api/') || (method !== 'GET' && method !== 'HEAD')) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' })
    }
    const wanted = pathname === '/' ? '/index.html' : pathname
    let file = wanted
    let body = await tryRead(lookup(wanted))
    if (!body && !extname(wanted)) {
      // SPA fallback
      file = '/index.html'
      body = await tryRead(lookup(file))
    }
    if (!body) throw createError({ statusCode: 404, statusMessage: 'Not found' })
    setResponseHeader(event, 'Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
    return method === 'HEAD' ? '' : body
  })
}

export function createBackendApp(options: Pick<StartBackendOptions, 'uiDir' | 'ui'> = {}) {
  const app = createApp()
  const router = createRouter()
  router.use('/api/health', healthRoute)
  router.use('/api/pipelines', pipelinesRoute)
  router.use('/api/runs', runsRoute)
  router.use('/api/runs/start', startRoute)
  router.use('/api/runs/:id', runRoute)
  router.use('/api/runs/:id/events', eventsRoute)
  router.use('/api/runs/:id/items', itemsRoute)
  router.use('/api/runs/:id/pause', pauseRoute)
  router.use('/api/runs/:id/resume', resumeRoute)
  app.use(router)

  const embedded = options.ui ?? (globalThis as { __MT_UI__?: EmbeddedUi }).__MT_UI__
  if (options.uiDir && !options.ui) app.use(uiHandler(dirLookup(options.uiDir)))
  else if (embedded && Object.keys(embedded).length > 0) {
    app.use(uiHandler(embeddedLookup(embedded)))
  }
  return app
}

export async function startBackend(options: StartBackendOptions = {}): Promise<BackendHandle> {
  const host = options.host ?? 'localhost'
  initSqlite(process.env.MT_PROJECT_ROOT || process.cwd())

  const server: Server = createServer(toNodeListener(createBackendApp(options)))
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port ?? 3000, host, () => resolveListen())
  })
  const port = (server.address() as AddressInfo).port

  return {
    host,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => {
          closeSqlite()
          resolveClose()
        })
      }),
  }
}
