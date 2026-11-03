import { definePipeline } from '@mt/core'
import { chapterDoc } from '@mt/tools'
import '@mt/waypoint'

export default definePipeline()
  .from('jsonl://./jsonl/*.jsonl')
  .use(chapterDoc)
  .log('chapter')
  .to('md://./chapters/en')
