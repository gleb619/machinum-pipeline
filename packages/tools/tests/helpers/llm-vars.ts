import type { Exchange } from '@mt/core'

/** Flatten an exchange's `new` variables into a plain record (for toMatchObject assertions). */
export function varsOf(ex: Exchange<unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ex.variables.filter((v) => v.qualifier === 'new').map((v) => [v.name, v.value]),
  )
}
