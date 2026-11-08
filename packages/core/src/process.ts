import type { Runner } from './engine/runner.js'
import type { GlobalContext } from './types.js'
import type { Pipeline, RunnerOptions } from './types.js'
import type { Process } from './types.js'

export type ProcessMode = 'sync' | 'parallel'

export function isProcess(value: unknown): value is Process {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Partial<Process>
  return (
    candidate.kind === 'process' &&
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.pipelines) &&
    typeof candidate.run === 'function'
  )
}
