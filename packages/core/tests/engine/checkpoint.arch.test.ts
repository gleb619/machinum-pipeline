import { describe, expect, it } from 'vitest'
import {
  addChild,
  countByState,
  createRootCheckpoint,
  deserializeTree,
  findFirstNonDone,
  findNode,
  isAllDone,
  markDone,
  markFailed,
  markInProgress,
  serializeTree,
  walkTree,
} from '../../src/engine/checkpoint.js'
import type { CheckpointNode } from '../../src/types.js'

describe('UC-15 — Checkpoint tree shape & operations (architectural)', () => {
  it('createRootCheckpoint returns a CheckpointNode with correct shape', () => {
    const node = createRootCheckpoint('root')
    expect(node).toHaveProperty('stepId', 'root')
    expect(node).toHaveProperty('state', 'pending')
    expect(Array.isArray(node.children)).toBe(true)
    expect(node.children?.length).toBe(0)
  })

  it('CheckpointNode supports optional cursor, error, outputHash', () => {
    const node: CheckpointNode = {
      stepId: 's1',
      state: 'done',
      cursor: { offset: 42 },
      error: 'something went wrong',
      outputHash: 'abc123',
    }
    expect(node.cursor).toEqual({ offset: 42 })
    expect(node.error).toBe('something went wrong')
    expect(node.outputHash).toBe('abc123')
  })

  it('findNode locates a node by stepId in nested tree', () => {
    const root = createRootCheckpoint('root')
    const child = createRootCheckpoint('child')
    root.children = [child]

    const found = findNode(root, 'child')
    expect(found).toBeDefined()
    expect(found?.stepId).toBe('child')
  })

  it('markDone transitions node state to done', () => {
    const node = createRootCheckpoint('s1')
    markDone(node)
    expect(node.state).toBe('done')
  })

  it('markFailed transitions node state to failed', () => {
    const node = createRootCheckpoint('s1')
    markFailed(node, 'test error')
    expect(node.state).toBe('failed')
    expect(node.error).toBe('test error')
  })

  it('markInProgress transitions node state to in-progress', () => {
    const node = createRootCheckpoint('s1')
    markInProgress(node)
    expect(node.state).toBe('in-progress')
  })

  it('addChild appends a child node', () => {
    const parent = createRootCheckpoint('parent')
    const child = createRootCheckpoint('child')
    addChild(parent, child)
    expect(parent.children?.length).toBe(1)
    expect(parent.children?.[0].stepId).toBe('child')
  })

  it('isAllDone returns true when all children and root are done', () => {
    const root = createRootCheckpoint('root')
    const c1 = createRootCheckpoint('c1')
    const c2 = createRootCheckpoint('c2')
    markDone(c1)
    markDone(c2)
    root.children = [c1, c2]
    markDone(root)
    expect(isAllDone(root)).toBe(true)
  })

  it('countByState tallies nodes by state', () => {
    const root = createRootCheckpoint('root')
    const c1 = createRootCheckpoint('c1')
    const c2 = createRootCheckpoint('c2')
    markDone(c1)
    markInProgress(c2)
    root.children = [c1, c2]
    const counts = countByState(root)
    expect(counts.done).toBe(1)
    expect(counts['in-progress']).toBe(1)
    expect(counts.pending).toBe(1) // root
  })

  it('serializeTree / deserializeTree round-trips', () => {
    const original = createRootCheckpoint('root')
    const child = createRootCheckpoint('child')
    markDone(child)
    original.children = [child]

    const serialized = serializeTree(original)
    const restored = deserializeTree(serialized)
    expect(restored.stepId).toBe('root')
    expect(restored.children?.[0].stepId).toBe('child')
    expect(restored.children?.[0].state).toBe('done')
  })

  it('walkTree visits all nodes depth-first', () => {
    const root = createRootCheckpoint('root')
    const c1 = createRootCheckpoint('c1')
    const c2 = createRootCheckpoint('c2')
    root.children = [c1, c2]

    const visited: string[] = []
    walkTree(root, (node, _depth) => {
      visited.push(node.stepId)
    })
    expect(visited).toContain('root')
    expect(visited).toContain('c1')
    expect(visited).toContain('c2')
  })

  it('findFirstNonDone returns first non-done node', () => {
    const root = createRootCheckpoint('root')
    markDone(root)
    const c1 = createRootCheckpoint('c1')
    markDone(c1)
    const c2 = createRootCheckpoint('c2') // pending
    root.children = [c1, c2]

    const first = findFirstNonDone(root)
    expect(first).toBeDefined()
    expect(first?.stepId).toBe('c2')
  })
})

describe('UC-16 — RunStateData shape & recovery (architectural)', () => {
  it('RunStateData has required fields: runId, pipelineId, state, checkpoint, contextRef', () => {
    const data: import('../../src/types.js').RunStateData = {
      runId: 'r1',
      pipelineId: 'p1',
      state: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      checkpoint: createRootCheckpoint('root'),
      contextRef: 'runs/r1/context.json',
    }
    expect(data.runId).toBe('r1')
    expect(data.pipelineId).toBe('p1')
    expect(data.state).toBe('running')
    expect(data.contextRef).toBe('runs/r1/context.json')
  })
})
