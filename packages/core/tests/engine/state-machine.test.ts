import { describe, expect, it } from 'vitest'
import { RunStateMachine } from '../../src/engine/state-machine.js'

describe('RunStateMachine', () => {
  it('starts in pending state', () => {
    const sm = new RunStateMachine()
    expect(sm.current).toBe('pending')
  })

  it('transitions from pending to running', () => {
    const sm = new RunStateMachine()
    sm.transition('running')
    expect(sm.current).toBe('running')
  })

  it('transitions from running to done', () => {
    const sm = new RunStateMachine('running')
    sm.transition('done')
    expect(sm.current).toBe('done')
    expect(sm.isTerminal).toBe(true)
  })

  it('transitions from running to failed', () => {
    const sm = new RunStateMachine('running')
    sm.transition('failed')
    expect(sm.current).toBe('failed')
    expect(sm.isTerminal).toBe(true)
  })

  it('transitions from running to checkpoint', () => {
    const sm = new RunStateMachine('running')
    sm.transition('checkpoint')
    expect(sm.current).toBe('checkpoint')
  })

  it('transitions from checkpoint to paused', () => {
    const sm = new RunStateMachine('checkpoint')
    sm.transition('paused')
    expect(sm.current).toBe('paused')
  })

  it('transitions from paused to resumed to running', () => {
    const sm = new RunStateMachine('paused')
    sm.transition('resumed')
    expect(sm.current).toBe('resumed')
    sm.transition('running')
    expect(sm.current).toBe('running')
  })

  it('throws on invalid transition', () => {
    const sm = new RunStateMachine('done')
    expect(() => sm.transition('running')).toThrow('Invalid state transition')
  })

  it('canTransition returns false for invalid transitions', () => {
    const sm = new RunStateMachine('done')
    expect(sm.canTransition('running')).toBe(false)
  })

  it('canTransition returns true for valid transitions', () => {
    const sm = new RunStateMachine('pending')
    expect(sm.canTransition('running')).toBe(true)
  })

  it('reset changes state without validation', () => {
    const sm = new RunStateMachine('done')
    sm.reset('pending')
    expect(sm.current).toBe('pending')
  })
})
