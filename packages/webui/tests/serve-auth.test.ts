import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmbedStore, resetEmbedCache, setEmbedSecret } from '@mt/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertSafeServeBind,
  checkBearer,
  isLoopbackHost,
  resolveServeToken,
  resolveServeTokenRef,
} from '../server/utils/serve-auth.js'

describe('serve bind guard', () => {
  it.each(['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.5'])('%s is loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
    expect(() => assertSafeServeBind(host, undefined)).not.toThrow()
  })

  it('refuses a non-loopback bind without a token, with a fix hint', () => {
    expect(() => assertSafeServeBind('0.0.0.0', undefined)).toThrow(/MT_SERVE_TOKEN/)
    expect(() => assertSafeServeBind('10.0.0.2', '')).toThrow(/--token-ref/)
  })

  it('allows a non-loopback bind with a token', () => {
    expect(() => assertSafeServeBind('0.0.0.0', 'tok')).not.toThrow()
  })
})

describe('checkBearer', () => {
  it('accepts only the exact bearer token, including different lengths', () => {
    expect(checkBearer('Bearer abc', 'abc')).toBe(true)
    expect(checkBearer('bearer abc', 'abc')).toBe(true)
    expect(checkBearer('Bearer abd', 'abc')).toBe(false)
    expect(checkBearer('Bearer abcd', 'abc')).toBe(false)
    expect(checkBearer('Bearer abcde', 'abc')).toBe(false)
    expect(checkBearer('Basic abc', 'abc')).toBe(false)
    expect(checkBearer('Bearer ', 'abc')).toBe(false)
    expect(checkBearer(undefined, 'abc')).toBe(false)
  })
})

describe('resolveServeToken', () => {
  let dir: string
  let embedPath: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-serve-auth-'))
    embedPath = join(dir, 'store.embed.json')
    await writeFile(join(dir, 'mt.json'), JSON.stringify({ serve: { tokenRef: 'env:CONF' } }))
    resetEmbedCache()
  })

  afterAll(async () => {
    resetEmbedCache()
    await rm(dir, { recursive: true, force: true })
  })

  it('prefers an explicit token over env and config', async () => {
    const token = await resolveServeToken({
      token: 'explicit',
      projectRoot: dir,
      env: { MT_SERVE_TOKEN: 'from-env', CONF: 'from-config' },
    })
    expect(token).toBe('explicit')
  })

  it('uses MT_SERVE_TOKEN when no explicit token is given', async () => {
    const token = await resolveServeToken({
      projectRoot: dir,
      env: { MT_SERVE_TOKEN: 'from-env', CONF: 'from-config' },
    })
    expect(token).toBe('from-env')
  })

  it('resolves mt.json serve.tokenRef through env:', async () => {
    const token = await resolveServeToken({
      projectRoot: dir,
      env: { CONF: 'from-config' },
    })
    expect(token).toBe('from-config')
  })

  it('rejects a plaintext mt.json serve.tokenRef', async () => {
    const plainDir = join(dir, 'plain')
    await mkdir(plainDir, { recursive: true })
    await writeFile(join(plainDir, 'mt.json'), JSON.stringify({ serve: { tokenRef: 'nope' } }))
    await expect(resolveServeToken({ projectRoot: plainDir, env: {} })).rejects.toThrow(
      /secret reference/,
    )
  })

  it('resolves an embedded-store ref (vault ref machinery)', async () => {
    const env = {
      MT_EMBED_PATH: embedPath,
      MT_EMBED_PASSWORD: 'test-password',
    }
    resetEmbedCache()
    await createEmbedStore({ path: embedPath }, env)
    await setEmbedSecret({ name: 'serve-token', secret: 'vault-token' }, {}, env)
    resetEmbedCache()

    expect(await resolveServeToken({ token: 'embed:serve-token', env })).toBe('vault-token')
    expect(await resolveServeToken({ env: { ...env, MT_SERVE_TOKEN: 'embed:serve-token' } })).toBe(
      'vault-token',
    )
    expect(await resolveServeTokenRef('embed:serve-token', env)).toBe('vault-token')
  })

  it('resolves --token-ref bare names as environment variables', async () => {
    expect(await resolveServeTokenRef('MY_TOKEN', { MY_TOKEN: 'env-token' })).toBe('env-token')
    expect(await resolveServeTokenRef('env:MY_TOKEN', { MY_TOKEN: 'env-token' })).toBe('env-token')
    await expect(resolveServeTokenRef('MISSING', {})).rejects.toThrow(/MISSING/)
  })
})
