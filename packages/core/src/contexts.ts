import type { Book } from './domain.js'
import type { Exchange } from './exchange.js'
import type { Settings } from './settings.js'
import type { Logger, RunEvents } from './types.js'
import type { Vault } from './vault.js'
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
