import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registry } from '@mt/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackendHandle, startBackend } from '../../server/standalone.js'

/**
 * T092: the admin start route must build its GlobalContext from mt.json like the CLI
 * does, so a pipeline addressed by a named URI alias (`@en`) resolves there too.
 */
describe('POST /api/runs/start resolves mt.json URI aliases', () => {
  let dir: string
  let previousCwd: string
  let handle: BackendHandle
  const sourceUris: string[] = []

  async function until(
    label: string,
    cond: () => Promise<boolean>,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!(await cond())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  beforeAll(async () => {
    // Under the vitest root so the runtime-written pipeline module stays resolvable
    dir = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), 'runs-start-alias.ignore.'))
    previousCwd = process.cwd()

    await writeFile(
      join(dir, 'mt.json'),
      JSON.stringify({
        project: { name: 'alias-fixture' },
        uris: { en: 'aliasprobe://./chapters/en' },
      }),
    )
    await writeFile(
      join(dir, 'pipeline.mjs'),
      `export default {
  id: 'alias-fixture',
  retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
  onError: 'fail-run',
  steps: [
    { type: 'source', config: { uri: '@en' } },
    {
      type: 'tap',
      config: {
        fn: async (env) => {
          globalThis['__MT_ALIAS_ITEM__'] = env.item
        },
      },
    },
  ],
}
`,
    )

    registry.registerSource('aliasprobe', (uri) => {
      sourceUris.push(uri.raw)
      return {
        uri: uri.raw,
        lifestyle: 'resumable',
        async *start() {
          yield { item: { id: 'chapter-1', bookId: 'aliasprobe' }, meta: {} }
        },
      }
    })

    process.chdir(dir)
    handle = await startBackend({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    ;(globalThis as Record<string, unknown>).__MT_ALIAS_ITEM__ = undefined
    await handle?.close()
    process.chdir(previousCwd)
    await rm(dir, { recursive: true, force: true })
  })

  it('expands @en through the settings loaded from mt.json', async () => {
    const started = await fetch(`${handle.url}/api/runs/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipeline: 'pipeline.mjs' }),
    })
    expect(started.status).toBe(200)
    const { runId } = (await started.json()) as { runId: string }

    await until(
      'the aliased run to finish',
      async () =>
        ((await (await fetch(`${handle.url}/api/runs/${runId}`)).json()) as { state: string })
          .state === 'done',
    )

    expect(sourceUris).toEqual(['aliasprobe://./chapters/en'])
    expect((globalThis as Record<string, unknown>).__MT_ALIAS_ITEM__).toEqual({
      id: 'chapter-1',
      bookId: 'aliasprobe',
    })
  })
})
