import { MT_VERSION, SYNC_PROTOCOL_VERSION } from '@mt/core'
import { defineEventHandler, getHeader } from 'h3'
import { detectCapabilities } from '../../utils/capabilities.js'
import { checkBearer, resolveServeToken } from '../../utils/serve-auth.js'

export interface HealthHandlerOptions {
  /** Resolved token; when omitted the handler resolves MT_SERVE_TOKEN/mt.json. */
  token?: string
  /** Force or disable config/env token resolution (default: resolve only when no token key). */
  resolveToken?: boolean
}

export function createHealthRoute(options: HealthHandlerOptions = {}) {
  return defineEventHandler(async (event) => {
    let token = options.token
    const shouldResolve = options.resolveToken ?? !('token' in options)
    if (shouldResolve) token = await resolveServeToken().catch(() => undefined)
    const authHeader = getHeader(event, 'authorization')
    if (token && !checkBearer(authHeader, token)) {
      // T202: keep the unauthenticated shape minimal even if a token is configured.
      return { status: 'ok' }
    }
    return {
      status: 'ok',
      version: MT_VERSION,
      capabilities: await detectCapabilities(),
      syncVersion: SYNC_PROTOCOL_VERSION,
    }
  })
}

export default createHealthRoute()
