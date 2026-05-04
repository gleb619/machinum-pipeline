import { definePipeline, source, target } from '@mt/core'

export default definePipeline({
  id: 'http-to-jsonl',
  retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
  onError: 'fail-run',
})
  .from(source('hs://localhost:9876/'))
  .to(target('jsonl://./jsonl/output.jsonl'))
