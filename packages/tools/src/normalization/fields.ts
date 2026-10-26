import { getVariable } from '@mt/core'
import type { Exchange } from '@mt/core'

/**
 * Reads a tool-published field: the variable `name`, else the legacy `meta[name]` (hand-written
 * inputs and older pipelines still carry such fields in `meta`).
 */
export function exField<U>(
  ex: Pick<Exchange<unknown>, 'meta' | 'variables'>,
  name: string,
): U | undefined {
  const v = getVariable<U>(ex, name)
  if (v !== undefined) return v
  return (ex.meta as Record<string, unknown> | undefined)?.[name] as U | undefined
}
