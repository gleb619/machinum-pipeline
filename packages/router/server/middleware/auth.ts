import { timingSafeEqual } from 'node:crypto'
import { createError, defineEventHandler, getHeader } from 'h3'
import { getRouterConfig } from '../utils/router-config.js'

/** Constant-time string compare (length is not secret-worthy, content is). */
export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  const padded = Buffer.alloc(Math.max(a.length, b.length))
  const paddedExpected = Buffer.alloc(padded.length)
  a.copy(padded)
  b.copy(paddedExpected)
  return timingSafeEqual(padded, paddedExpected) && a.length === b.length
}

/**
 * Optional router access token. Unset: open (loopback only, see bind guard). Set: every /api/*
 * request except GET /api/health needs `Authorization: Bearer <token>`. The header is never
 * forwarded upstream (completions.ts builds upstream headers from scratch).
 */
export default defineEventHandler((event) => {
  const token = getRouterConfig().token
  if (!token) return
  const path = (event.path ?? '').split('?')[0] ?? ''
  if (!path.startsWith('/api/')) return
  if (path === '/api/health' && event.method === 'GET') return

  const header = getHeader(event, 'authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (match?.[1] && tokenMatches(match[1].trim(), token)) return

  event.node.res.setHeader('WWW-Authenticate', 'Bearer')
  throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
})
