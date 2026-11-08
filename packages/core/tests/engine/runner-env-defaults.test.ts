import { afterEach, describe, expect, it, vi } from 'vitest'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, Pipeline, Tool } from '../../src/types.js'
import type { GlobalContext, ToolContext } from '../../src/types.js'
import { registry } from '../../src/uri.js'

vi.mock('../../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockResolvedValue(undefined)
    readJson = vi.fn().mockResolvedValue({ state: 'done', checkpoint: { stepId: 'root' } })
    append = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('../../src/engine/cache.js', () => ({
  Cache: class {
    computeKey = vi.fn().mockReturnValue('key')
    has = vi.fn().mockResolvedValue(false)
    get = vi.fn().mockResolvedValue(undefined)
    set = vi.fn().mockResolvedValue(undefined)
  },
}))

registry.registerSource('env-src', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    yield { id: '1', item: 'x' }
  },
}))

registry.registerTarget('env-tgt', (_uri) => ({
  uri: _uri.raw,
  async open() {},
  async write(_env: Envelope<unknown>) {},
  async close() {},
}))

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-env-defaults' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 1,
  },
  settings: {},
  env: {},
}

const retry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

describe('runner envDefaults', () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, 'MT_TEST_ENV_DEFAULT')
  })

  function probeTool(seen: Record<string, unknown>): Tool<unknown, unknown> {
    return {
      name: 'probe',
      version: '1.0.0',
      mdDescription: 'Test tool',
      invoke: vi.fn(async (env: Envelope<unknown>, ctx: ToolContext) => {
        seen.globalEnv = { ...process.env, ...ctx.run.global.env }
        return env
      }),
    }
  }

  function pipeline(tool: Tool<unknown, unknown>, envDefaults?: Record<string, string>): Pipeline {
    return {
      id: 'env-defaults-pipeline',
      retry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'env-src://x' } },
        { type: 'tool', config: { name: tool.name, version: tool.version, tool } },
        { type: 'target', config: { uri: 'env-tgt://x' } },
      ],
      envDefaults,
    }
  }

  it('applies env defaults for keys absent from process.env', async () => {
    const seen: Record<string, unknown> = {}
    await new Runner(
      pipeline(probeTool(seen), { MT_TEST_ENV_DEFAULT: 'from-default' }),
      globalContext,
    ).start()
    expect(seen.globalEnv).toMatchObject({ MT_TEST_ENV_DEFAULT: 'from-default' })
  })

  it('process.env wins over env defaults', async () => {
    process.env.MT_TEST_ENV_DEFAULT = 'from-process-env'
    const seen: Record<string, unknown> = {}
    await new Runner(
      pipeline(probeTool(seen), { MT_TEST_ENV_DEFAULT: 'from-default' }),
      globalContext,
    ).start()
    expect(seen.globalEnv).toMatchObject({ MT_TEST_ENV_DEFAULT: 'from-process-env' })
  })

  it('mt.json env wins over env defaults', async () => {
    const ctx: GlobalContext = { ...globalContext, env: { MT_TEST_ENV_DEFAULT: 'from-mt-json' } }
    const seen: Record<string, unknown> = {}
    await new Runner(
      pipeline(probeTool(seen), { MT_TEST_ENV_DEFAULT: 'from-default' }),
      ctx,
    ).start()
    expect(seen.globalEnv).toMatchObject({ MT_TEST_ENV_DEFAULT: 'from-mt-json' })
  })
})
