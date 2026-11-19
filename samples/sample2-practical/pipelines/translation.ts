import { defineProcess } from '@mt/core'
import assemble from './stages/assemble.js'
import translateChapters from './stages/translate-chapters.js'
import translateTitles from './stages/translate-titles.js'

/**
 * Phase 3 — translation.
 *
 * Translate the titles and the body, then assemble the result into one book. `translate-titles`
 * keeps `chapters/titles.json` mergeable for partial runs; `translate-chapters` uses it plus the
 * prepared summary/glossary context; `assemble` sorts numerically and writes `book://`.
 *
 *   translate-titles → translate-chapters → assemble
 */
export default defineProcess([translateTitles, translateChapters, assemble], {
  id: 'practical-translation',
})
