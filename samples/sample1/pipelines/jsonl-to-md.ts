import { definePipeline } from '@mt/core'

export default definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (item: any) => {
    return [`# ${item.title}\n\n${item.body}\n`]
  })
  .to('md://./md/output.md')
