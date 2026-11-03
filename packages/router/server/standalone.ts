import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type H3Error, type H3Event, createApp, createRouter, toNodeListener } from 'h3'
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
 * The two Nitro plugins cannot be auto-discovered here, so `prepareRouterRuntime()` runs them
 * explicitly. `createRouterApp()` is also embedded in `@mt/webui` (`mt serve`).
 */

export type StartRouterOptions = RouterConfigInput

export interface RouterHandle {
  host: string
  port: number
  url: string
  mock: boolean
  close(): Promise<void>
}

/** Router routes embedded in `mt serve`; `/api/health` intentionally belongs to the admin API. */
const EMBEDDED_ROUTER_PATHS = [
  '/api/chat/completions',
  '/api/translate',
  '/api/pool',
  '/api/models',
  '/api/dashboard',
  '/api/logs',
  '/api/router/health',
] as const

/** True when a request path belongs to the router API mounted inside `mt serve`. */
export function isRouterApiPath(path: string): boolean {
  const pathname = path.split('?')[0] ?? '/'
  return EMBEDDED_ROUTER_PATHS.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  )
}

/** Redacted error body; shared by the standalone server and the embedded router. */
export function handleRouterError(error: H3Error, event: H3Event): void {
  const status = error.statusCode || 500
  const res = event.node.res
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: redact(error.statusMessage || error.message || 'Error') }))
}

/** Build the API-only router app: all `/api/*` routes plus auth and rate-limit middleware. */
export function createRouterApp() {
  const app = createApp({ onError: handleRouterError })
  app.use(auth)
  app.use(rateLimit)

  const router = createRouter()
  router.use('/api/health', healthRoute)
  router.use('/api/router/health', healthRoute)
  router.use('/api/dashboard', dashboardRoute)
  router.use('/api/logs', logsRoute)
  router.use('/api/pool', poolRoute)
  router.get('/api/models', modelsRoute)
  router.use('/api/chat/completions', chatCompletionsRoute)
  router.use('/api/translate', translateRoute)
  router.use('/api/translate/health', translateHealthRoute)
  router.use('/api/translate/config', translateConfigRoute)
  app.use(router)
  return app
}

/** Apply config, bind guard and one-time router startup work. Safe to call from `mt serve`. */
export async function prepareRouterRuntime(options: StartRouterOptions = {}): Promise<void> {
  const config = setRouterConfig(options)
  assertSafeBind(config.host, config.token)
  resetVaultState()
  if (config.vault) await refreshVaultUpstreams()
  startMockMode()
  await startLogRotation()
}

export async function startRouter(options: StartRouterOptions = {}): Promise<RouterHandle> {
  await prepareRouterRuntime(options)
  const config = getRouterConfig()

  const server: Server = createServer(toNodeListener(createRouterApp()))
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
