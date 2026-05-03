import type { RunState } from '../types.js'

/**
 * Run state machine — manages state transitions for a pipeline run.
 * States: pending -> running <-> checkpoint -> paused/done/failed
 *         paused -> resumed -> running
 */

/**
 * Valid state transitions.
 */
const TRANSITIONS: Record<RunState, RunState[]> = {
  pending: ['running'],
  running: ['checkpoint', 'done', 'failed', 'paused'],
  checkpoint: ['running', 'paused', 'done', 'failed'],
  paused: ['resumed'],
  resumed: ['running'],
  done: [],
  failed: [],
}

/**
 * State machine for a pipeline run.
 */
export class RunStateMachine {
  private state: RunState

  constructor(initialState: RunState = 'pending') {
    this.state = initialState
  }

  /**
   * Get the current state.
   */
  get current(): RunState {
    return this.state
  }

  /**
   * Transition to a new state.
   * Throws if the transition is invalid.
   */
  transition(to: RunState): RunState {
    const allowed = TRANSITIONS[this.state]
    if (!allowed?.includes(to)) {
      throw new Error(
        `Invalid state transition: ${this.state} -> ${to}. Allowed: ${(allowed ?? []).join(', ') || 'none'}`,
      )
    }
    this.state = to
    return this.state
  }

  /**
   * Check if a transition is valid.
   */
  canTransition(to: RunState): boolean {
    const allowed = TRANSITIONS[this.state]
    return allowed?.includes(to) ?? false
  }

  /**
   * Check if the run is in a terminal state.
   */
  get isTerminal(): boolean {
    return this.state === 'done' || this.state === 'failed'
  }

  /**
   * Check if the run is active (not terminal).
   */
  get isActive(): boolean {
    return !this.isTerminal
  }

  /**
   * Reset to a specific state (for loading from persistence).
   */
  reset(state: RunState): void {
    this.state = state
  }
}
