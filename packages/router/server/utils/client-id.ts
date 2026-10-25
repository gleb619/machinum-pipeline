import { type H3Event, getHeader } from 'h3'

export const ANONYMOUS_CLIENT = 'anonymous'
const MAX_LEN = 64

/**
 * Sanitise a raw `X-MT-Client` value: keep `[A-Za-z0-9._-]`, replace the rest with `_`, cap at 64
 * chars. Empty / missing => `anonymous`. The raw value is never echoed anywhere.
 */
export function sanitizeClientId(raw: string | undefined | null): string {
  const cleaned = (raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, MAX_LEN)
  return cleaned || ANONYMOUS_CLIENT
}

export function clientIdFrom(event: H3Event): string {
  return sanitizeClientId(getHeader(event, 'x-mt-client'))
}
