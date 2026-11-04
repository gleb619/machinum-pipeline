import {
  type H3Event,
  defineEventHandler,
  getHeader,
  setResponseHeader,
  setResponseStatus,
} from 'h3'
import { checkBearer, resolveServeToken } from '../utils/serve-auth.js'

let tokenPromise: Promise<string | undefined> | undefined

function loadToken(): Promise<string | undefined> {
  tokenPromise ??= resolveServeToken().catch((err: unknown) => {
    tokenPromise = undefined
    throw err
  })
  return tokenPromise
}

/**
 * Nitro dev/middleware equivalent of the standalone guard. `mt serve` mounts the same
 * check directly in `createBackendApp`; this file only covers `pnpm dev` / `build:nitro`.
 * Bind safety stays a standalone concern (`startBackend`), because Nitro owns its listener.
 */
export default defineEventHandler(async (event: H3Event) => {
  const path = (event.path ?? '').split('?')[0] ?? ''
  if (!path.startsWith('/api/')) return
  if (path === '/api/health' && event.method === 'GET') return

  const token = await loadToken()
  if (!token) return
  if (checkBearer(getHeader(event, 'authorization'), token)) return

  setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
  setResponseStatus(event, 401)
  return { error: 'Unauthorized' }
})
