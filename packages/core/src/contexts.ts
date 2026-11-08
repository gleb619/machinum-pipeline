import type { Book } from './types.js'
import type { Exchange } from './types.js'
import type { Settings } from './types.js'
import type { Logger, RunEvents } from './types.js'
import type { Vault } from './types.js'
export type {
  GlobalContext,
  RunContext,
  SplitterContext,
  BatchScope,
  ToolContext,
  SourceContext,
  TargetContext,
  CheckpointHandle,
  StepInfo,
  RetryPolicy,
} from './types/contexts.js'

/**
 * Error policy — what to do when a step fails.
 */
export type ErrorPolicy = 'fail-run' | 'skip-item' | 'dead-letter'

/**
 * Retry strategy types.
 */
export type RetryStrategy = 'fixed' | 'linear' | 'exp'
