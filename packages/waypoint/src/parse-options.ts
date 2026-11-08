/**
 * Query-option parsers shared by the HTTP waypoints.
 *
 * The `label` prefixes the error message so the offending waypoint is named
 * (`http target: timeoutMs must be a positive integer, got 'x'`).
 */

/** Parse a positive integer option; an absent option yields the fallback. */
export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string,
  label: string,
): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}: ${name} must be a positive integer, got '${value}'`)
  }
  return parsed
}

/** Parse an integer option that may be zero; an absent option yields the fallback. */
export function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
  name: string,
  label: string,
): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label}: ${name} must be an integer >= 0, got '${value}'`)
  }
  return parsed
}

/** Parse a boolean option (`true`/`1`/`false`/`0`); an absent option is `false`. */
export function parseBoolean(value: string | undefined, name: string, label: string): boolean {
  if (value === undefined) return false
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`${label}: ${name} must be true or false, got '${value}'`)
}

/**
 * Parse a size limit, falling back to the default instead of throwing — the
 * HTTP source must never fail to start because of a bad limit.
 */
export function parseSizeOption(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed
}
