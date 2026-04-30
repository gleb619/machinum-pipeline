import { describe, it, expect } from 'vitest'
import {
  createRootCheckpoint,
  findNode,
  findFirstNonDone,
  addChild,
  markDone,
  markFailed,
  markInProgress,
  isAllDone,
  countByState,
} from '../../src/engine/checkpoint.js'

describe('checkpoint tree', () => {
  it('creates a root checkpoint in pending state', () => {
    const root = createRootCheckpoint('root')
    expect(root.stepId).toBe('root')
    expect(root.state).toBe('pending')
    expect(root.children).toEqual([])
  })

  it('finds a node by stepId', () => {
    const root = createRootCheckpoint('root')
    const child = createRootCheckpoint('child1')
    addChild(root, child)
    const found = findNode(root, 'child1')
    expect(found).toBeDefined()
    expect(found?.stepId).toBe('child1')
  })

  it('returns undefined for non-existent node', () => {
    const root = createRootCheckpoint('root')
    const found = findNode(root, 'nonexistent')
    expect(found).toBeUndefined()
  })

  it('marks a node as done', () => {
    const node = createRootCheckpoint('step1')
    markDone(node, 'hash123')
    expect(node.state).toBe('done')
    expect(node.outputHash).toBe('hash123')
  })

  it('marks a node as failed', () => {
    const node = createRootCheckpoint('step1')
    markFailed(node, 'Something went wrong')
    expect(node.state).toBe('failed')
    expect(node.error).toBe('Something went wrong')
  })

  it('marks a node as in-progress', () => {
    const node = createRootCheckpoint('step1')
    markInProgress(node)
    expect(node.state).toBe('in-progress')
  })

  it('finds first non-done node (depth-first)', () => {
    const root = createRootCheckpoint('root')
    markDone(root)
    const child1 = createRootCheckpoint('child1')
    markDone(child1)
    const child2 = createRootCheckpoint('child2')
    addChild(root, child1)
    addChild(root, child2)

    const first = findFirstNonDone(root)
    expect(first?.stepId).toBe('child2')
  })

  it('isAllDone returns true when all nodes done', () => {
    const root = createRootCheckpoint('root')
    markDone(root)
    const child = createRootCheckpoint('child')
    markDone(child)
    addChild(root, child)
    expect(isAllDone(root)).toBe(true)
  })

  it('isAllDone returns false when any node not done', () => {
    const root = createRootCheckpoint('root')
    markDone(root)
    const child = createRootCheckpoint('child')
    addChild(root, child)
    expect(isAllDone(root)).toBe(false)
  })

  it('countByState returns correct counts', () => {
    const root = createRootCheckpoint('root')
    markDone(root)
    const child1 = createRootCheckpoint('child1')
    markDone(child1)
    const child2 = createRootCheckpoint('child2')
    addChild(root, child1)
    addChild(root, child2)

    const counts = countByState(root)
    expect(counts.done).toBe(2)
    expect(counts.pending).toBe(1)
  })
})
