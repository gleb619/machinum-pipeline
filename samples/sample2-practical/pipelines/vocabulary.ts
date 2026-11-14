import { definePipeline } from '@mt/core'
import { defineStatFreq } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../lib/input.js'
import { VOCAB_MAX_NGRAM, VOCAB_MIN_WORD_LEN, VOCAB_TOP_K, writeVocabulary } from '../lib/vocab.js'

/**
 * Stage 4 of the book flow: statistical 4/3/2/1-gram vocabulary (CPU only, 0 LLM calls).
 *
 *   books/book2 chapters → batch://?size=100 → defineStatFreq (book total) → writeVocabulary
 *                                          → chapters/schema/vocabulary.json
 *
 * The book-wide report ranks the candidates; `writeVocabulary` recounts every chapter with the
 * exported pure `buildStatFreqReport` for `chapters[]`/`df` and adds the capitalisation signal.
 * This pipe never imports `lib/llm.ts`: no `pickFor`, no model resolution, no backend.
 */
const vocabChild = definePipeline({ id: 'practical-vocabulary-child' })
  .use(
    defineStatFreq({
      maxNgram: VOCAB_MAX_NGRAM,
      minWordLen: VOCAB_MIN_WORD_LEN,
      topK: VOCAB_TOP_K,
    }),
  )
  .use(writeVocabulary)
  .to('@schema')

export default definePipeline({ id: 'practical-vocabulary' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=100', vocabChild)
