import { type Exchange, getVariable } from '@mt/core'

/**
 * Read a tool-published field from an exchange: the variable of that name, else the legacy
 * `meta` key (hand-written jsonl inputs and older pipelines still carry such fields in `meta`).
 */
export function exchangeField<U>(ex: Exchange<unknown>, name: string): U | undefined {
  const v = getVariable<U>(ex, name)
  if (v !== undefined) return v
  return (ex.meta as Record<string, unknown> | undefined)?.[name] as U | undefined
}
