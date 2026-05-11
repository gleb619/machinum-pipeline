import { definePipeline } from '@mt/core'
import { chapterDoc } from '@mt/tools'
import '@mt/waypoint'

export default definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(chapterDoc)
  .to('md://./chapters/en')
