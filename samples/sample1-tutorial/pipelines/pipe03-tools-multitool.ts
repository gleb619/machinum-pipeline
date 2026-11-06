import { definePipeline, defineProcess, getVariable, log } from '@mt/core'
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
 *   Flow B  `.batch(n)` — group the stream, so a tool sees many items at once
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
 * `.batch(2)` hands the downstream tool two chapters at a time (`env.items`), so a tool that
 * needs the whole picture — like `statFreq` — can work on the corpus instead of one chapter.
 */
export const batchPipeline = definePipeline({ id: 'pipe03-batch' })
  .from('jsonl://./jsonl/entities.jsonl')
  .batch(2)
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
