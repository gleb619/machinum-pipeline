/**
 * `mt` — umbrella package. Root entry = core DSL, types and Runner.
 * Also registers the built-in URI schemes (jsonl, md, http, ...) as a side effect so that
 * `.from('jsonl://...')` works with just `import { definePipeline } from 'mt'`.
 */
export * from '@mt/core'

import '@mt/waypoint'
