import { defineTool } from '@mt/core'
import type { Envelope } from '@mt/core'

export interface HeuristicSummaryOptions {
  /** Max sentences in the summary. Default: 4. */
  sentences?: number
}

const STOP = new Set(
  (
    'a an the and or but if then than so as at by for from in into of on onto to with without ' +
    "is are was were be been being am do does did done have has had having it its it's he she " +
    'they them his her their theirs we us our you your i me my mine this that these those there ' +
    'here what which who whom whose when where why how not no yes just very can could would ' +
    'should will shall may might must also only even still too all any each some such one two'
  ).split(' '),
)

function tokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []
}

/** Splits prose into sentences (keeps each sentence's text trimmed). */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '' || /^#{1,6}\s/.test(t) || /^(```|~~~)/.test(t)) continue
    for (const m of t.matchAll(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)) {
      const s = m[0].trim()
      if (s.split(/\s+/).length >= 4) out.push(s)
    }
  }
  return out
}

/**
 * Offline extractive summary: the lead sentence plus the most informative sentences (sum of
 * term frequencies of non-stopwords, length-damped), emitted in original order.
 */
export function summarizeHeuristic(md: string, options: HeuristicSummaryOptions = {}): string {
  const limit = options.sentences ?? 4
  const sentences = splitSentences(md)
  if (sentences.length <= limit) return sentences.join(' ')
  const freq = new Map<string, number>()
  for (const s of sentences) {
    for (const w of tokens(s)) if (!STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  const scored = sentences.map((s, i) => {
    const ws = tokens(s).filter((w) => !STOP.has(w))
    const sum = ws.reduce((a, w) => a + (freq.get(w) ?? 0), 0)
    return { i, score: ws.length === 0 ? 0 : sum / Math.sqrt(ws.length) }
  })
  const picked = new Set<number>([0])
  for (const { i } of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (picked.size >= limit) break
    picked.add(i)
  }
  return [...picked]
    .sort((a, b) => a - b)
    .map((i) => sentences[i])
    .join(' ')
}

/** Chapter title: first `# ` heading, else empty. */
export function chapterTitle(md: string): string {
  return /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? ''
}

/**
 * Tool: heuristic (no LLM) summary of `env.item` / `env.items`. Same meta contract as
 * `summaryTool`: `meta.summary`, `meta.summaryByItem`; also `meta.heuristicSummaryByItem`
 * so an LLM step can fall back to it.
 */
export function createHeuristicSummaryTool(options: HeuristicSummaryOptions = {}) {
  return defineTool<string | string[], string | string[]>({
    name: 'heuristic-summary',
    version: '1.0.0',
    mdDescription:
      'Offline extractive summary: lead sentence + highest term-frequency sentences, original ' +
      'order. Stores `meta.summary` / `meta.summaryByItem` / `meta.heuristicSummaryByItem`.',
    async invoke(env: Envelope<string | string[]>): Promise<Envelope<string | string[]>> {
      const inputs = (env.items ?? [env.item]).flat()
      const summaries = inputs.map((t) => summarizeHeuristic(t, options))
      return {
        ...env,
        meta: {
          ...env.meta,
          summary: summaries[0] ?? '',
          summaryByItem: summaries,
          heuristicSummaryByItem: summaries,
        },
      }
    },
  })
}

export const heuristicSummaryTool = createHeuristicSummaryTool()
