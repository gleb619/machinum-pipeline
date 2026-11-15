import { join } from 'node:path'
import { definePipeline } from '@mt/core'
import '@mt/waypoint'
import { writeGlossaryIndexTool } from '../lib/glossary-index.js'
import { ROOT } from '../lib/llm.js'

/**
 * Stage between `glossary` and the quality gate: the book-wide glossary projected onto the
 * chapters it actually occurs in (CPU only, 0 LLM calls).
 *
 *   chapters/en + chapters/glossary.json → write-glossary-index → chapters/glossary-index.json
 *
 * A missing `glossary.json` is not an error (the chain may run before the first extraction):
 * the step logs `index: no glossary` and writes nothing. `translate-chapters` reads the index to
 * render the "terms so far" prompt block.
 */
const CHAPTERS = join(ROOT, 'chapters')

const indexChild = definePipeline({ id: 'practical-glossary-index-child' })
  .use(writeGlossaryIndexTool(CHAPTERS))
  .to('void://')

export default definePipeline({ id: 'practical-glossary-index' })
  .from('md://./chapters/en')
  .subflow('batch://?size=1000', indexChild)
