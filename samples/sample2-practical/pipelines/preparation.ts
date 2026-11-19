import { defineProcess } from '@mt/core'
import glossaryIndex from './stages/glossary-index.js'
import glossary from './stages/glossary.js'
import ner from './stages/ner.js'
import preprocess from './stages/preprocess.js'
import quality from './stages/quality.js'
import summary from './stages/summary.js'
import vocabulary from './stages/vocabulary.js'

/**
 * Phase 2 — preparation.
 *
 * Build every artefact the translation prompts need and pick the source branch: summaries,
 * entities, vocabulary, glossary, the per-chapter glossary index, the quality verdict, and the
 * conditional preprocess/clean branch.
 *
 *   summary → NER → vocabulary → glossary → glossary-index → quality → preprocess
 *
 * `quality` runs after `glossary` because the gate uses the glossary as a proper-noun
 * allowlist. `preprocess` runs last and reads the verdict lazily, so the no-op `translate`
 * branch costs no LLM call and writes no file.
 */
export default defineProcess(
  [summary, ner, vocabulary, glossary, glossaryIndex, quality, preprocess],
  { id: 'practical-preparation' },
)
