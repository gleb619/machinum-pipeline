import type { CheckpointNode } from '../types.js'

/**
 * Checkpoint tree — tracks progress of a run as a tree of steps, forks, and sub-runs.
 * Used for crash recovery and resume.
 */

/**
 * Create a root checkpoint node.
 */
export function createRootCheckpoint(stepId: string): CheckpointNode {
  return {
    stepId,
    state: 'pending',
    children: [],
  }
}

/**
 * Find a node by stepId in the checkpoint tree (depth-first search).
 */
export function findNode(root: CheckpointNode, stepId: string): CheckpointNode | undefined {
  if (root.stepId === stepId) return root
  for (const child of root.children ?? []) {
    const found = findNode(child, stepId)
    if (found) return found
  }
  return undefined
}

/**
 * Get the first non-done node in the tree (depth-first).
 * This is where a resume should start from.
 */
export function findFirstNonDone(root: CheckpointNode): CheckpointNode | undefined {
  if (root.state !== 'done') return root
  for (const child of root.children ?? []) {
    const found = findFirstNonDone(child)
    if (found) return found
  }
  return undefined
}

/**
 * Add a child node to a parent node.
 */
export function addChild(parent: CheckpointNode, child: CheckpointNode): void {
  if (!parent.children) {
    parent.children = []
  }
  parent.children.push(child)
}

/**
 * Mark a node as done with an optional output hash.
 */
export function markDone(node: CheckpointNode, outputHash?: string): void {
  node.state = 'done'
  if (outputHash) {
    node.outputHash = outputHash
  }
}

/**
 * Mark a node as failed with an error message.
 */
export function markFailed(node: CheckpointNode, error: string): void {
  node.state = 'failed'
  node.error = error
}

/**
 * Mark a node as in-progress.
 */
export function markInProgress(node: CheckpointNode): void {
  node.state = 'in-progress'
}

/**
 * Check if all nodes in the tree are done.
 */
export function isAllDone(root: CheckpointNode): boolean {
  if (root.state !== 'done') return false
  return (root.children ?? []).every(isAllDone)
}

/**
 * Count nodes by state.
 */
export function countByState(root: CheckpointNode): Record<string, number> {
  const counts: Record<string, number> = {}
  countNodes(root, counts)
  return counts
}

function countNodes(node: CheckpointNode, counts: Record<string, number>): void {
  counts[node.state] = (counts[node.state] ?? 0) + 1
  for (const child of node.children ?? []) {
    countNodes(child, counts)
  }
}

/**
 * Serialize a checkpoint tree to a plain JSON object.
 */
export function serializeTree(root: CheckpointNode): CheckpointNode {
  return JSON.parse(JSON.stringify(root)) as CheckpointNode
}

/**
 * Deserialize a checkpoint tree from a plain JSON object.
 */
export function deserializeTree(data: CheckpointNode): CheckpointNode {
  return data
}

/**
 * Walk the tree depth-first, calling a visitor for each node.
 */
export function walkTree(
  root: CheckpointNode,
  visitor: (node: CheckpointNode, depth: number) => void,
  depth = 0,
): void {
  visitor(root, depth)
  for (const child of root.children ?? []) {
    walkTree(child, visitor, depth + 1)
  }
}
