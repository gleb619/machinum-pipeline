import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type Source,
  type Target,
  definePipeline,
  defineSource,
  defineTarget,
  defineWaypoint,
  getVariable,
  log,
} from '@mt/core'
import {
  analyzeOutputs,
  chapterRecordMapper,
  createGlossaryExtractor,
  createLlmSummaryWithFallback,
  createLlmTypoFix,
  heuristicSummaryTool,
  lineTextToMarkdown,
  markdownFormatter,
  mdOutputEmitter,
  readGlossaryFile,
  termTagger,
  textNormalizer,
  typoFinder,
  unwrapMarkdownText,
} from '@mt/tools'
import '@mt/waypoint'
import { ROOT, pickFor } from '../lib/llm.js'

/**
 * PIPE 07 — normalize raw chapters, then analyze the clean corpus.
 *
 * Stage A (normalize) turns messy JSONL `{ key, value }` records into clean markdown chapters:
 * curly quotes, ellipses, zero-width characters and stray spacing fall away; every paragraph
 * line stays one line (`chapterRecordMapper → textNormalizer → lineTextToMarkdown →
 * markdownFormatter → unwrapMarkdownText`). The LLM typo fix is off by default
 * (`MT_LLM_TYPO_FIX=1` enables it).
 *
 * Stage B (analyze) reads `chapters/en` and writes, in one batch so the glossary is
 * cross-chapter:
 *   chapters/schema/chapterN.summary.md   heuristic per-chapter summary
 *   chapters/glossary.json                editable terms (type, count, first chapter, ru)
 *   chapters/glossary.graph.json          co-occurrence relations
 *   chapters/en-tagged/chapterN.md        EN text with `<term id="...">` wrappers
 *
 * The tagged copy is the handoff to pipe08 (translation): the tags tell the translator which
 * glossary entry each line uses, without changing the text.
 *
 * `waypointLogPipeline` re-runs the exact same normalize chain, but both endpoints are
 * `defineWaypoint` wrappers with lifecycle hooks that write `chapters/waypoint-log.jsonl`.
 */
const CHAPTERS = join(ROOT, 'chapters')
const GLOSSARY_PATH = join(CHAPTERS, 'glossary.json')

const llm = pickFor('normalize')

/** The normalize chain with injectable endpoints (the waypoint-log demo wraps them). */
export function buildNormalizeFlow(
  source: Source<unknown> | string,
  target: Target<unknown> | string,
  id = 'pipe07-normalize',
) {
  return definePipeline({ id })
    .from(source)
    .use(chapterRecordMapper)
    .use(textNormalizer)
    .use(createLlmTypoFix({ call: llm.schemaCall, enabled: process.env.MT_LLM_TYPO_FIX === '1' }))
    .use(lineTextToMarkdown)
    .use(typoFinder)
    .tap(async (env) => {
      const warnings = getVariable<unknown[]>(env, 'warnings')
      log.info('normalize', { chapter: env.meta.chapterNum, typoHints: warnings?.length ?? 0 })
    })
    .use(markdownFormatter)
    .use(unwrapMarkdownText)
    .use(
      mdOutputEmitter({ name: 'normalized', filename: (meta) => `chapter${meta.chapterNum}.md` }),
    )
    .to(target)
}

export const normalizePipeline = buildNormalizeFlow('jsonl://./jsonl/input.jsonl', '@en')

export const analyzePipeline = definePipeline({ id: 'pipe07-analyze' })
  .from('@en')
  .batch(100_000)
  .use(heuristicSummaryTool)
  .use(
    createLlmSummaryWithFallback({
      call: llm.schemaCall,
      enabled: process.env.MT_LLM_SUMMARY === '1',
    }),
  )
  .use(
    createGlossaryExtractor({
      load: () => readGlossaryFile(GLOSSARY_PATH),
      relations: { enabled: true, maxTerms: 4 },
    }),
  )
  .use(termTagger)
  .use(analyzeOutputs)
  .to('@chapters')

/** Both stages of the lesson, in order. */
export default definePipeline({ id: 'pipe07-normalize-analyze' })
  .subflow(normalizePipeline)
  .subflow(analyzePipeline)

// --- defineWaypoint lifecycle demo ---------------------------------------------------------

const LOG_PATH = join(CHAPTERS, 'waypoint-log.jsonl')
const events: string[] = []

function record(event: string, detail?: Record<string, unknown>): void {
  events.push(JSON.stringify({ ts: new Date().toISOString(), event, ...detail }))
}

/** Atomic write (temp + rename) of the audit log when the target closes. */
async function flushLog(): Promise<void> {
  await mkdir(dirname(LOG_PATH), { recursive: true })
  const tmp = `${LOG_PATH}.tmp`
  await writeFile(tmp, `${events.join('\n')}\n`, 'utf-8')
  await rename(tmp, LOG_PATH)
}

let skipped = 0

const loggedSource = defineWaypoint(defineSource<unknown>('jsonl://./jsonl/input.jsonl'), {
  onStart: () => record('source:start'),
  filter: (env) => {
    const item = env.item as { key?: string; value?: string }
    if ((item.value ?? '').trim() === '') {
      skipped += 1
      record('source:skip', { key: item.key })
      return false
    }
    return true
  },
  onItem: (env) => record('source:item', { key: (env.item as { key?: string }).key }),
})

const loggedTarget = defineWaypoint(defineTarget<unknown>('md://./chapters/en'), {
  onOpen: () => record('target:open'),
  onWrite: (env) =>
    record('target:write', { chapter: (env.meta as { chapterNum?: number }).chapterNum }),
  onClose: () => {
    record('target:close', { skipped })
    return flushLog()
  },
})

export const waypointLogPipeline = buildNormalizeFlow(
  loggedSource,
  loggedTarget,
  'pipe07-waypoint-log',
)

export { LOG_PATH }
