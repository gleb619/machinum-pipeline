/** `value` as an integer >= 1, or `fallback` when it is not a finite number. */
export function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

/** `value` as an integer >= 0, or `fallback` when it is not a finite number. */
export function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

/** `value` as a finite number, or `undefined` when it is not one. */
export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** `value` as a finite, non-negative number, or `undefined`. */
export function readCount(value: unknown): number | undefined {
  const n = readNumber(value)
  return n !== undefined && n >= 0 ? n : undefined
}

/** `value` as a finite number, or 0. */
export function numberOrZero(value: unknown): number {
  return readNumber(value) ?? 0
}

/** A count that may arrive as a numeric string; `undefined` when it is not one. */
export function parseCount(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/** The message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
