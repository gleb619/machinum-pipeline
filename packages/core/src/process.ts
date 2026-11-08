import type { GlobalContext } from './contexts.js'
import type { Runner } from './engine/runner.js'
import type { Pipeline, RunnerOptions } from './types.js'
import type { Process } from './types/process.js'
export type { ProcessRunOptions, Process } from './types/process.js'

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
