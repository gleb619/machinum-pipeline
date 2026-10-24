import { defineTool } from '../../src/dsl.js'
import type { Envelope } from '../../src/types.js'

export interface EchoInput {
  value: string
}

/**
 * Fixture tool for child-process (out-of-process) execution tests.
 *
 * Echoes the value and the step name from the ToolContext, so tests can prove
 * the NDJSON init line actually reached the worker.
 */
export const echoTool = defineTool<EchoInput, EchoInput>({
  name: 'fixture-echo',
  version: '1.0.0',
  mdDescription: 'Echo fixture tool.',
  exec: 'bun',
  module: import.meta.filename,
  invoke: async (env: Envelope<EchoInput>, ctx): Promise<Envelope<EchoInput>> => ({
    item: { value: `echo:${env.item.value}` },
    meta: { ...env.meta, stepName: ctx.step?.name },
  }),
})

/**
 * Fixture tool that always throws — used to assert the parent surfaces the
 * child's stderr.
 */
export const failingTool = defineTool<EchoInput, EchoInput>({
  name: 'fixture-fail',
  version: '1.0.0',
  mdDescription: 'Echo fixture tool.',
  exec: 'bun',
  module: import.meta.filename,
  invoke: async (): Promise<Envelope<EchoInput>> => {
    throw new Error('fixture-exploded')
  },
})

/** Fixture tool exported as a record — exercises the worker export lookup. */
export const tools = {
  'fixture-recorded': defineTool<EchoInput, EchoInput>({
    name: 'fixture-recorded',
    version: '1.0.0',
    mdDescription: 'Recorded echo fixture tool.',
    exec: 'bun',
    module: import.meta.filename,
    invoke: async (env: Envelope<EchoInput>): Promise<Envelope<EchoInput>> => ({
      item: { value: `recorded:${env.item.value}` },
      meta: env.meta,
    }),
  }),
}
