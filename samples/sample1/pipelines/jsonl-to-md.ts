import { definePipeline, source, target } from '@mt/core'

export default definePipeline({
  id: 'jsonl-to-md',
  retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
  onError: 'fail-run',
})
  .from(source('jsonl://./jsonl/input.jsonl'))
  .flatMap(async (item: any) => {
    return [`# ${item.title}\n\n${item.body}\n`]
  })
  .to(target('md://./md/output.md'))
