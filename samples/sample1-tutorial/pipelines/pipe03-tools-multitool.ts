import {
  batchMembersOf,
  definePipeline,
  defineProcess,
  defineTool,
  getVariable,
  itemsOf,
  log,
  withItem,
} from '@mt/core'
import {
  chapterIndexer,
  chapterValidator,
  forbiddenCharDetector,
  mdOutputEmitter,
  statFreq,
  tokenCounter,
  wordCounter,
} from '@mt/tools'
import '@mt/waypoint'

/**
 * PIPE 03 — chaining many tools, batching them, and composing subflows.
 *
 * A pipeline is a list of tools; every tool receives the envelope of the one before it and
 * returns a new one. Nothing is global: the tools communicate through the envelope
 * (the item) and its variables.
 *
 *   Flow A  a long tool chain — six tools, one markdown chapter in, one file out
 *   Flow B  `.subflow('batch://...', pipe)` — group the stream, so one tool call sees the
 *           whole package
 *   Flow C  `.subflow(...)` — compose whole pipelines, not just tools
 */

/**
 * Flow A — the tool chain.
 *
 * Every tool adds exactly one property to the envelope:
 *   `wordCounter`          → variable `wordCount`
 *   `tokenCounter`         → variable `tokenCount`
 *   `chapterIndexer`       → `meta.chapterNum`
 *   `chapterValidator`     → variables `valid` / `errors`
 *   `forbiddenCharDetector` → variable `forbidden`
 *   `mdOutputEmitter`      → the `mdOutputs` intent the `md://` target writes
 */
export const toolChainPipeline = definePipeline({ id: 'pipe03-tool-chain' })
  .from('jsonl://./jsonl/entities.jsonl')
  .use(wordCounter)
  .use(tokenCounter)
  .use(chapterIndexer)
  .use(chapterValidator)
  .use(forbiddenCharDetector)
  .tap((env) => {
    log.info('pipe03 chapter checked', {
      chapterNum: env.meta.chapterNum ?? 0,
      words: getVariable<number>(env, 'wordCount') ?? 0,
      tokens: getVariable<number>(env, 'tokenCount') ?? 0,
      valid: getVariable<boolean>(env, 'valid') ?? false,
      forbidden: getVariable<unknown[]>(env, 'forbidden')?.length ?? 0,
    })
  })
  .use(
    mdOutputEmitter({ name: 'verified', filename: (meta) => `chapter${meta.chapterNum ?? 0}.md` }),
  )
  .to('md://./chapters/verified')

/**
 * Flow B — batching.
 *
 * `.subflow('batch://?size=2', pipe)` groups the stream into packages of two and runs the child
 * pipeline ONCE per package. The package is the child's input: `env.item` and `env.items` are the
 * two chapters, so a tool that needs the whole picture — like `statFreq` — works on the corpus
 * instead of one chapter. The child ends with `void://`: the statistics are only logged.
 */
const batchStats = definePipeline({ id: 'pipe03-batch-stats' })
  .use(statFreq)
  .tap((env) => {
    const report = getVariable<{ totalWords?: number; uniqueWords?: number }>(env, 'statFreq')
    log.info('pipe03 batch stats', {
      items: env.items?.length ?? 1,
      totalWords: report?.totalWords ?? 0,
      uniqueWords: report?.uniqueWords ?? 0,
    })
  })
  .to('void://')

export const batchPipeline = definePipeline({ id: 'pipe03-batch' })
  .from('jsonl://./jsonl/entities.jsonl')
  .subflow('batch://?size=2', batchStats)

/**
 * Flow C — subflows.
 *
 * A subflow is a whole pipeline used as one step of another pipeline. The first stage writes
 * the chapters, the second stage reads them back from disk and counts their words.
 */
const writeStage = definePipeline({ id: 'pipe03-write-stage' })
  .from('jsonl://./jsonl/entities.jsonl')
  .use(chapterIndexer)
  .use(
    mdOutputEmitter({ name: 'subflow', filename: (meta) => `chapter${meta.chapterNum ?? 0}.md` }),
  )
  .to('md://./chapters/subflow')

const readStage = definePipeline({ id: 'pipe03-read-stage' })
  .from('md://./chapters/subflow')
  .use(wordCounter)
  .tap((env) => {
    log.info('pipe03 subflow chapter', {
      words: getVariable<number>(env, 'wordCount') ?? 0,
    })
  })
  .to('void://')

export const subflowPipeline = definePipeline({ id: 'pipe03-subflow' })
  .subflow(writeStage)
  .subflow(readStage)

export const toolSuite = defineProcess([toolChainPipeline, batchPipeline, subflowPipeline], {
  id: 'pipe03-suite',
}).parallel(true)

export default toolChainPipeline

/**
 * Flow D — the real batch case: translating chapter titles.
 *
 * The child below sees one package of five chapters (`env.item` = the five payloads, `env.items`
 * = the same array) and does the whole per-package job in three tool calls:
 *
 *   collectTitles   join the five H1 titles into ONE text — the "document" a translation call
 *                   would receive
 *   translateTitles one text in, one text out (offline stand-in for the LLM call)
 *   applyTitles     parse the lines back and return the patched package
 *
 * `applyTitles` returns an array of exactly five patched chapters, so the package payload ZIPS
 * back onto the members by index: the parent stream continues with the original five chapter
 * envelopes (own id, meta, variables), each with its new title.
 *
 * Multi-stage work can use the explicit `batch://group` (the package as one exchange) and
 * `batch://members` (every member as its own exchange) views instead — the package input above is
 * the same envelope, so simple cases need no `.from()` at all.
 */
const titleOf = (text: string): string => text.match(/^#\s+(.+)$/m)?.[1] ?? ''

const retitle = (text: string, title: string): string => text.replace(/^#\s+.+$/m, `# ${title}`)

const collectTitles = defineTool<unknown, unknown>({
  name: 'pipe03-collect-titles',
  version: '1.0.0',
  mdDescription: 'Joins the H1 of every package member into one text block.',
  async invoke(env) {
    return withItem(env, itemsOf<string>(env).map(titleOf).join('\n'))
  },
})

const translateTitles = defineTool<string, string>({
  name: 'pipe03-translate-titles',
  version: '1.0.0',
  mdDescription: 'One text in, one text out — the offline stand-in for a translation call.',
  async invoke(env) {
    return withItem(env, env.item.toUpperCase())
  },
})

const applyTitles = defineTool<string, unknown>({
  name: 'pipe03-apply-titles',
  version: '1.0.0',
  mdDescription: 'Parses the translated titles back into the chapter payloads (package zip).',
  async invoke(env) {
    const titles = String(env.item).split('\n')
    // `withItem` clears `items`, so the package members come from the ephemeral batch variable;
    // that keeps the original chapter texts available through scalar tool calls.
    const sources =
      batchMembersOf<string>(env)?.map((member) => member.item) ?? itemsOf<string>(env)
    const patched = sources.map((text, index) => retitle(text, titles[index] ?? titleOf(text)))
    return withItem(env, patched)
  },
})

const titlePipe = definePipeline({ id: 'pipe03-title-pipe' })
  .use(collectTitles)
  .use(translateTitles)
  .use(applyTitles) // no .to(): `batch://return` is injected and the patched package zips back

export const packagedTitlesPipeline = definePipeline({ id: 'pipe03-packaged-titles' })
  .from('jsonl://./jsonl/entities.jsonl')
  .subflow('batch://?size=5', titlePipe)
  .to('md://./chapters/packaged')
