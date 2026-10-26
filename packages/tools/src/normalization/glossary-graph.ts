import type { Glossary, GlossaryTermType } from './term-tagger.js'

/**
 * Relation graph of a glossary (machinum-llm `findReferences` over a term graph).
 *
 * A node is a glossary term, an edge is a relation between two terms:
 * `references` = semantic relation reported by the model, `co-occurrence` = both terms
 * appear in the same sentence of the analysed corpus.
 */

/** Edge kind. */
export type GlossaryEdgeKind = 'references' | 'co-occurrence'

/** One glossary term in the graph. */
export interface GlossaryGraphNode {
  id: string
  term: string
  type: GlossaryTermType
}

/** A relation between two glossary terms. */
export interface GlossaryGraphEdge {
  from: string
  to: string
  kind: GlossaryEdgeKind
}

/** The relation graph of a glossary. */
export interface GlossaryGraph {
  nodes: GlossaryGraphNode[]
  edges: GlossaryGraphEdge[]
}

/** Resolves a term name (or alias) to the id of the glossary entry. */
function resolver(glossary: Glossary): (name: string) => string | undefined {
  const bySurface = new Map<string, string>()
  for (const t of glossary.terms) {
    bySurface.set(t.term.trim().toLowerCase(), t.id)
    for (const alias of t.aliases ?? []) bySurface.set(alias.trim().toLowerCase(), t.id)
  }
  return (name) => bySurface.get(name.trim().toLowerCase())
}

/**
 * Builds the relation graph of a glossary: one node per term, one edge per relation
 * (`term.references`). Relations pointing to an unknown term are dropped.
 *
 * `coOccurrences` (term name -> related term names) marks the heuristic relations: an edge
 * between two terms that share a sentence of the corpus is a `co-occurrence` edge, every
 * other relation is a `references` edge (the ones the model reported).
 */
export function buildGlossaryGraph(
  glossary: Glossary,
  coOccurrences: Map<string, string[]> = new Map(),
): GlossaryGraph {
  const resolve = resolver(glossary)
  const nodes: GlossaryGraphNode[] = glossary.terms.map((t) => ({
    id: t.id,
    term: t.term,
    type: t.type,
  }))
  const edges: GlossaryGraphEdge[] = []
  const seen = new Set<string>()
  const coOccurrencePairs = new Set<string>()

  const push = (from: string, to: string, kind: GlossaryEdgeKind): void => {
    if (from === to) return
    const key = `${from}|${to}|${kind}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from, to, kind })
  }

  for (const [fromName, targets] of coOccurrences) {
    const from = resolve(fromName)
    if (!from) continue
    for (const targetName of targets) {
      const to = resolve(targetName)
      if (to) coOccurrencePairs.add(`${from}|${to}`)
    }
  }
  for (const term of glossary.terms) {
    for (const reference of term.references ?? []) {
      const target = resolve(reference)
      if (!target) continue
      const kind: GlossaryEdgeKind = coOccurrencePairs.has(`${term.id}|${target}`)
        ? 'co-occurrence'
        : 'references'
      push(term.id, target, kind)
    }
  }
  for (const pair of coOccurrencePairs) {
    const [from, to] = pair.split('|') as [string, string]
    push(from, to, 'co-occurrence')
  }
  return { nodes, edges }
}

/**
 * Ids of the terms related to `term` within `hops` hops (1..3, like the Java
 * `findReferences(chapter, references, bookId, hops)`).
 */
export function findReferences(graph: GlossaryGraph, term: string, hops = 1): string[] {
  const wanted = term.trim().toLowerCase()
  const node = graph.nodes.find(
    (n) => n.id.toLowerCase() === wanted || n.term.trim().toLowerCase() === wanted,
  )
  if (!node) return []
  const maxHops = Math.min(3, Math.max(1, Math.trunc(hops)))
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from])
  }
  const seen = new Set<string>([node.id])
  const out: string[] = []
  let frontier = [node.id]
  for (let depth = 0; depth < maxHops; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbour of adjacency.get(id) ?? []) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        out.push(neighbour)
        next.push(neighbour)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return out
}

/** Stable pretty JSON for `glossary.graph.json`. */
export function serializeGlossaryGraph(graph: GlossaryGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`
}

/** Parses a `glossary.graph.json` text; `undefined` for empty or malformed input. */
export function parseGlossaryGraph(json: string): GlossaryGraph | undefined {
  try {
    const raw = JSON.parse(json) as Partial<GlossaryGraph>
    if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return undefined
    return { nodes: raw.nodes, edges: raw.edges }
  } catch {
    return undefined
  }
}
