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
import auth from './middleware/auth.js'
import rateLimit from './middleware/rate-limit.js'
import { startLogRotation } from './plugins/log-rotation.js'
import { startMockMode } from './plugins/mock-mode.js'
import chatCompletionsRoute from './routes/api/chat/completions.js'
import dashboardRoute from './routes/api/dashboard.js'
import healthRoute from './routes/api/health.js'
import logsRoute from './routes/api/logs.js'
import modelsRoute from './routes/api/models.js'
import poolRoute from './routes/api/pool.js'
import translateRoute from './routes/api/translate.js'
import translateConfigRoute from './routes/api/translate/config.js'
import translateHealthRoute from './routes/api/translate/health.js'
import { assertSafeBind } from './utils/bind-guard.js'
import { redact } from './utils/redact.js'
import { type RouterConfigInput, getRouterConfig, setRouterConfig } from './utils/router-config.js'
import { refreshVaultUpstreams, resetVaultState } from './utils/vault-upstreams.js'

/**
 * Nitro-free runtime for the LLM router. Mounts the very same h3 handlers that Nitro file-routing
 * serves in dev (`server/routes|middleware|plugins`) on a plain h3 app + `node:http`, so it runs
 * under Node and inside the Bun single-file binary (Bun implements `node:http`), without nitropack.
 *
 * The two Nitro plugins cannot be auto-discovered here, so `startRouter()` runs them explicitly.
 */

/** Embedded dashboard assets: URL path -> file path (set by the Bun binary build). */
export type EmbeddedDashboard = Record<string, string>

export interface StartRouterOptions extends RouterConfigInput {
  /** Directory holding the dashboard (`packages/router/public`). Ignored when `dashboard` is given. */
  dashboardDir?: string
  /** Embedded dashboard assets (single-file binary). Defaults to `globalThis.__MT_ROUTER_UI__`. */
  dashboard?: EmbeddedDashboard
}

export interface RouterHandle {
  host: string
  port: number
  url: string
  mock: boolean
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
  '.txt': 'text/plain; charset=utf-8',
}

type DashboardLookup = (urlPath: string) => string | undefined

function embeddedLookup(dashboard: EmbeddedDashboard): DashboardLookup {
  return (p) => dashboard[p]
}

function dirLookup(dir: string): DashboardLookup {
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

/** The dashboard is a plain `index.html` + `app.js`; no SPA routing, so unknown paths stay 404s. */
function dashboardHandler(lookup: DashboardLookup) {
  return defineEventHandler(async (event: H3Event) => {
    const method = event.method
    const pathname = decodeURIComponent((event.path ?? '/').split('?')[0] ?? '/')
    if (pathname.startsWith('/api/') || (method !== 'GET' && method !== 'HEAD')) {
      throw createError({ statusCode: 404, statusMessage: 'Not found' })
    }
    const wanted = pathname === '/' ? '/index.html' : pathname
    const body = await tryRead(lookup(wanted))
    if (!body) throw createError({ statusCode: 404, statusMessage: 'Not found' })
    setResponseHeader(event, 'Content-Type', MIME[extname(wanted)] ?? 'application/octet-stream')
    return method === 'HEAD' ? '' : body
  })
}

export function createRouterApp(
  options: Pick<StartRouterOptions, 'dashboardDir' | 'dashboard'> = {},
) {
  const app = createApp({
    // Error bodies can echo upstream text; scrub every known key before it leaves.
    onError(error, event) {
      const status = error.statusCode || 500
      const res = event.node.res
      if (res.headersSent) return
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: redact(error.statusMessage || error.message || 'Error') }))
    },
  })
  app.use(auth)
  app.use(rateLimit)

  const router = createRouter()
  router.use('/api/health', healthRoute)
  router.use('/api/dashboard', dashboardRoute)
  router.use('/api/logs', logsRoute)
  router.use('/api/pool', poolRoute)
  router.get('/api/models', modelsRoute)
  router.use('/api/chat/completions', chatCompletionsRoute)
  router.use('/api/translate', translateRoute)
  router.use('/api/translate/health', translateHealthRoute)
  router.use('/api/translate/config', translateConfigRoute)
  app.use(router)

  const embedded =
    options.dashboard ?? (globalThis as { __MT_ROUTER_UI__?: EmbeddedDashboard }).__MT_ROUTER_UI__
  if (options.dashboardDir && !options.dashboard) {
    app.use(dashboardHandler(dirLookup(options.dashboardDir)))
  } else if (embedded && Object.keys(embedded).length > 0) {
    app.use(dashboardHandler(embeddedLookup(embedded)))
  }
  return app
}

export async function startRouter(options: StartRouterOptions = {}): Promise<RouterHandle> {
  const config = setRouterConfig(options)
  assertSafeBind(config.host, config.token)
  resetVaultState()
  if (config.vault) await refreshVaultUpstreams()
  startMockMode()
  await startLogRotation()

  const server: Server = createServer(toNodeListener(createRouterApp(options)))
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(config.port, config.host, () => resolveListen())
  })
  const port = (server.address() as AddressInfo).port

  return {
    host: config.host,
    port,
    url: `http://${config.host}:${port}`,
    mock: config.mock,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      }),
  }
}

/** Effective config after `startRouter()`; useful for callers that report the bound address. */
export function getActiveRouterConfig(): ReturnType<typeof getRouterConfig> {
  return getRouterConfig()
}
