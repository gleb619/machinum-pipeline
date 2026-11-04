import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { acquireListener } from '@mt/core'
import type { HttpRouteHandler } from '@mt/core'
import {
  createRouterApp,
  handleRouterError,
  isRouterApiPath,
  prepareRouterRuntime,
} from '@mt/router/standalone'
import {
  type H3Event,
  createApp,
  createError,
  createRouter,
  defineEventHandler,
  getHeader,
  setResponseHeader,
  setResponseStatus,
  toNodeListener,
} from 'h3'
import { createHealthRoute } from './routes/api/health.js'
import registerIngestRoute from './routes/api/ingest/register.js'
import pipelinesRoute from './routes/api/pipelines.js'
import runRoute from './routes/api/runs/[id].js'
import artifactsRoute from './routes/api/runs/[id]/artifacts.js'
import eventsRoute from './routes/api/runs/[id]/events.js'
import itemsRoute from './routes/api/runs/[id]/items.js'
import pauseRoute from './routes/api/runs/[id]/pause.js'
import resumeRoute from './routes/api/runs/[id]/resume.js'
import runsRoute from './routes/api/runs/index.js'
import startRoute from './routes/api/runs/start.js'
import syncFilesRoute from './routes/api/sync/files.js'
import syncManifestRoute from './routes/api/sync/manifest.js'
import { attachIngestMount, detachIngestMount } from './utils/ingest-forwarder.js'
import { assertSafeServeBind, checkBearer, resolveServeToken } from './utils/serve-auth.js'
import { closeSqlite, initSqlite } from './utils/sqlite.js'

export { resolveServeTokenRef } from './utils/serve-auth.js'

/**
 * Nitro-free runtime for the admin API. Mounts the very same h3 handlers that Nitro file-routing
 * serves in dev (`server/routes/api/**`) on a plain h3 app + `node:http`, so it runs under Node
 * and inside the Bun single-file binary (Bun implements `node:http`), without nitropack.
 */

/** Embedded UI: URL path -> file path (set by the Bun binary build as `globalThis.__MT_UI__`). */
export type EmbeddedUi = Record<string, string>

/** Mount point supplied by `startBackend`; lets `createBackendApp` register its h3 app. */
export interface BackendMount {
  addRoute(path: string, handler: HttpRouteHandler): () => void
}

export interface StartBackendOptions {
  port?: number
  host?: string
  /** Directory with the built admin UI (vite `dist`). Ignored when `ui` is given. */
  uiDir?: string
  /** Embedded UI map (single-file binary). Defaults to `globalThis.__MT_UI__`. */
  ui?: EmbeddedUi
  /** Mount the router API on the same port (default: true). */
  router?: boolean
  /** Bearer token for `/api/*`; resolved from CLI/env/config when omitted. Never logged. */
  token?: string
  /** Optional shared-listener mount (used by `startBackend`; tests can omit it). */
  mount?: BackendMount
  /** Project root to serve; defaults to `MT_PROJECT_ROOT` or cwd. */
  projectRoot?: string
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

function serveAuthHandler(token: string) {
  return defineEventHandler((event: H3Event) => {
    const path = (event.path ?? '').split('?')[0] ?? ''
    if (!path.startsWith('/api/')) return
    if (path === '/api/health' && event.method === 'GET') return
    if (checkBearer(getHeader(event, 'authorization'), token)) return

    setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
    setResponseStatus(event, 401)
    return { error: 'Unauthorized' }
  })
}

export function createBackendApp(
  options: Pick<
    StartBackendOptions,
    'uiDir' | 'ui' | 'router' | 'token' | 'mount' | 'projectRoot'
  > = {},
) {
  const app = createApp({
    onError(error, event) {
      if (isRouterApiPath(event.path ?? '')) handleRouterError(error, event)
    },
  })
  const projectRoot = options.projectRoot ?? process.env.MT_PROJECT_ROOT ?? process.cwd()
  app.use(
    defineEventHandler((event: H3Event) => {
      const context = event.context as { mtProjectRoot?: string }
      context.mtProjectRoot = projectRoot
    }),
  )
  // Before any route: one guard covers the admin API and the embedded router on the same port.
  if (options.token) app.use(serveAuthHandler(options.token))
  const adminRouter = createRouter()
  adminRouter.use('/api/health', createHealthRoute({ token: options.token }))
  adminRouter.use('/api/pipelines', pipelinesRoute)
  adminRouter.use('/api/ingest/register', registerIngestRoute)
  adminRouter.use('/api/runs', runsRoute)
  adminRouter.use('/api/runs/start', startRoute)
  adminRouter.use('/api/runs/:id', runRoute)
  adminRouter.use('/api/runs/:id/artifacts', artifactsRoute)
  adminRouter.use('/api/runs/:id/events', eventsRoute)
  adminRouter.use('/api/runs/:id/items', itemsRoute)
  adminRouter.use('/api/runs/:id/pause', pauseRoute)
  adminRouter.use('/api/runs/:id/resume', resumeRoute)
  adminRouter.use('/api/sync/manifest', syncManifestRoute)
  adminRouter.use('/api/sync/files', syncFilesRoute)
  app.use(adminRouter)

  if (options.router !== false) {
    const routerApp = createRouterApp()
    app.use({ match: (path) => isRouterApiPath(path), handler: routerApp.handler })
  }

  const embedded = options.ui ?? (globalThis as { __MT_UI__?: EmbeddedUi }).__MT_UI__
  if (options.uiDir && !options.ui) app.use(uiHandler(dirLookup(options.uiDir)))
  else if (embedded && Object.keys(embedded).length > 0) {
    app.use(uiHandler(embeddedLookup(embedded)))
  }
  options.mount?.addRoute('*', toNodeListener(app))
  return app
}

export async function startBackend(options: StartBackendOptions = {}): Promise<BackendHandle> {
  const host = options.host ?? 'localhost'
  const projectRoot = options.projectRoot ?? process.env.MT_PROJECT_ROOT ?? process.cwd()
  const token = await resolveServeToken({ token: options.token, projectRoot })
  // Refuse a non-loopback bind without a token before touching the router or the listener.
  assertSafeServeBind(host, token)
  if (options.router !== false) await prepareRouterRuntime({ host })
  initSqlite(projectRoot)

  const listener = await acquireListener(host, options.port ?? 3000)
  try {
    attachIngestMount(listener)
    createBackendApp({ ...options, token, projectRoot, mount: listener })
  } catch (error) {
    detachIngestMount()
    await listener.release()
    throw error
  }

  return {
    host,
    port: listener.port,
    url: `http://${host}:${listener.port}`,
    close: async () => {
      detachIngestMount()
      try {
        await listener.release()
      } finally {
        closeSqlite()
      }
    },
  }
}
