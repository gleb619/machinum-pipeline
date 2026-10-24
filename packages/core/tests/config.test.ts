import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MT_CONFIG, loadGlobalContext, parseEnvFile } from '../src/config.js'

describe('loadGlobalContext', () => {
  let dir: string
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-config-'))
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  })

  function trackEnv(...keys: string[]): void {
    for (const key of keys) if (!(key in envBackup)) envBackup[key] = process.env[key]
  }

  it('falls back to DEFAULT_MT_CONFIG values when mt.json is absent', async () => {
    const ctx = await loadGlobalContext(dir)

    expect(ctx.project).toEqual({
      name: DEFAULT_MT_CONFIG.project.name,
      root: dir,
    })
    expect(ctx.defaults).toEqual({
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
      concurrency: DEFAULT_MT_CONFIG.defaults?.concurrency,
    })
    expect(ctx.settings).toEqual({})
  })

  it('throws naming the mt.json path when the file is malformed', async () => {
    const configPath = join(dir, 'mt.json')
    await writeFile(configPath, '{ not json')

    await expect(loadGlobalContext(dir)).rejects.toThrow(/mt\.json/)
    await expect(loadGlobalContext(dir)).rejects.toThrow(configPath)
  })

  it('reads project name and defaults from mt.json, filling gaps from defaults', async () => {
    await writeFile(
      join(dir, 'mt.json'),
      JSON.stringify({
        project: { name: 'custom-project' },
        defaults: { concurrency: 10 },
      }),
    )

    const ctx = await loadGlobalContext(dir)

    expect(ctx.project.name).toBe('custom-project')
    expect(ctx.defaults.concurrency).toBe(10)
    expect(ctx.defaults.retry).toEqual({ max: 3, backoffMs: 1000, strategy: 'exp' })
    expect(ctx.defaults.onError).toBe('fail-run')
  })

  it('never mints a book identity from mt.json metadata', async () => {
    await writeFile(
      join(dir, 'mt.json'),
      JSON.stringify({ book: { name: 'Moby Dick', author: 'Herman Melville', year: 1851 } }),
    )

    const ctx = await loadGlobalContext(dir)

    expect(ctx.book).toBeUndefined()
  })

  it('lands top-level uris in settings.uris alongside other settings', async () => {
    await writeFile(
      join(dir, 'mt.json'),
      JSON.stringify({
        uris: { en: 'md://./chapters/en' },
        settings: { 'waypoint.jsonl.defaultFolder': './custom/jsonl' },
      }),
    )

    const ctx = await loadGlobalContext(dir)

    expect(ctx.settings.uris).toEqual({ en: 'md://./chapters/en' })
    expect(ctx.settings['waypoint.jsonl.defaultFolder']).toBe('./custom/jsonl')
  })

  it('loads secrets.envFile into env without touching process.env', async () => {
    trackEnv('MT_TEST_LOADED', 'MT_TEST_PRESET')
    process.env.MT_TEST_PRESET = 'from-process'
    await writeFile(join(dir, 'mt.json'), JSON.stringify({ secrets: { envFile: 'secrets.env' } }))
    await writeFile(
      join(dir, 'secrets.env'),
      ['# comment', 'MT_TEST_LOADED=from-file', 'MT_TEST_PRESET=from-file'].join('\n'),
    )

    const ctx = await loadGlobalContext(dir)

    expect(ctx.env.MT_TEST_LOADED).toBe('from-file')
    expect(ctx.env.MT_TEST_PRESET).toBe('from-process')
    expect(process.env.MT_TEST_LOADED).toBeUndefined()
  })

  it('defaults to .env when secrets.envFile is not set', async () => {
    trackEnv('MT_TEST_DEFAULT_FILE')
    await writeFile(join(dir, '.env'), 'MT_TEST_DEFAULT_FILE=ok')

    const ctx = await loadGlobalContext(dir)

    expect(ctx.env.MT_TEST_DEFAULT_FILE).toBe('ok')
  })

  it('tolerates a missing secrets file', async () => {
    await writeFile(join(dir, 'mt.json'), JSON.stringify({ secrets: { envFile: 'nope.env' } }))

    const ctx = await loadGlobalContext(dir)

    expect(ctx.env).toBeTypeOf('object')
  })
})

describe('parseEnvFile', () => {
  it('parses plain, export-prefixed and quoted entries', () => {
    const parsed = parseEnvFile(
      [
        'PLAIN=value',
        'export EXPORTED=value two',
        'SINGLE="double quoted"',
        "DOUBLE='single quoted'",
        'EMPTY=',
        '',
        '   ',
        '# comment',
        'NO_EQUALS_LINE',
      ].join('\n'),
    )

    expect(parsed).toEqual({
      PLAIN: 'value',
      EXPORTED: 'value two',
      SINGLE: 'double quoted',
      DOUBLE: 'single quoted',
      EMPTY: '',
    })
  })

  it('keeps inline # in unquoted values only when not a trailing comment', () => {
    expect(parseEnvFile('A=va#lue\nB=value # trailing').A).toBe('va#lue')
  })
})
