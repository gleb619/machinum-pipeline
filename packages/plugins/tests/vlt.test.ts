import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VLT_REF_PREFIX,
  findVlt,
  getVltSecret,
  installVlt,
  resetVltCache,
  resolveVltValue,
} from '../src/vlt.js'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

type ShowResult = { stdout?: string; stderr?: string; error?: Error | null }

/** Route `vlt show <name> --stdout` calls through impl(name). */
function mockVltShow(impl: (name: string) => ShowResult): void {
  execFileMock.mockImplementation((_file: unknown, args: unknown, _opts: unknown, cb: unknown) => {
    const name = (args as string[])[1] as string
    const r = impl(name)
    ;(cb as (e: Error | null, so: string, se: string) => void)(
      r.error ?? null,
      r.stdout ?? '',
      r.stderr ?? '',
    )
  })
}

function execError(code: string | number): Error {
  return Object.assign(new Error(`exit ${code}`), { code })
}

/** Minimal single-file tar.gz (ustar-ish; only what extractTarGz reads). */
function makeTarGz(files: Record<string, Buffer>): Buffer {
  const chunks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf-8')
    header.write('0000644\0', 100, 'ascii')
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    header.write('0', 156, 'ascii')
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 0x20 : (header[i] as number)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    chunks.push(header, content)
    const padding = (512 - (content.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

const CHECKSUM_URL = 'https://example.test/vlt-cli_0.5.0_checksums.txt'

function checksumsTxt(entries: Record<string, Buffer>): string {
  return Object.entries(entries)
    .map(([name, buf]) => `${createHash('sha256').update(buf).digest('hex')}  ${name}`)
    .join('\n')
}

function stubFetch(assetUrl: string, archive: Buffer): string[] {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url)
      calls.push(u)
      if (u.includes('api.github.com')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.5.0',
            assets: [
              { name: 'vlt_0.5.0_linux_amd64.tar.gz', browser_download_url: assetUrl },
              { name: 'vlt_0.5.0_linux_amd64.zip', browser_download_url: `${assetUrl}.zip` },
              { name: 'vlt-cli_0.5.0_checksums.txt', browser_download_url: CHECKSUM_URL },
            ],
          }),
          { status: 200 },
        )
      }
      if (u === CHECKSUM_URL) {
        return new Response(checksumsTxt({ 'vlt_0.5.0_linux_amd64.tar.gz': archive }), {
          status: 200,
        })
      }
      return new Response(new Uint8Array(archive), { status: 200 })
    }),
  )
  return calls
}

describe('vlt', () => {
  let dir: string
  let home: string
  let binDir: string
  let savedHome: string | undefined
  let savedPath: string | undefined

  beforeEach(async () => {
    resetVltCache()
    execFileMock.mockReset()
    // Default: every child process succeeds silently (probe + show stubs override).
    execFileMock.mockImplementation((_f: unknown, _a: unknown, _o: unknown, cb: unknown) => {
      ;(cb as (e: Error | null, so: string, se: string) => void)(null, '', '')
    })
    dir = await mkdtemp(join(tmpdir(), 'mt-vlt-'))
    home = join(dir, 'home')
    binDir = join(dir, 'bin')
    await mkdir(home, { recursive: true })
    await mkdir(binDir, { recursive: true })
    savedHome = process.env.HOME
    savedPath = process.env.PATH
    process.env.HOME = home
    process.env.PATH = binDir
  })

  afterEach(async () => {
    if (savedHome === undefined) Reflect.deleteProperty(process.env, 'HOME')
    else process.env.HOME = savedHome
    if (savedPath === undefined) Reflect.deleteProperty(process.env, 'PATH')
    else process.env.PATH = savedPath
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  const placeBinary = async (dirPath: string, name = 'vlt'): Promise<string> => {
    const path = join(dirPath, name)
    await writeFile(path, '#!/bin/sh\n')
    await chmod(path, 0o755)
    return path
  }

  it('exposes the ref prefix', () => {
    expect(VLT_REF_PREFIX).toBe('vlt:')
  })

  it('passes non-ref values through untouched', async () => {
    await expect(resolveVltValue('sk-plain-key')).resolves.toBe('sk-plain-key')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('passes refs through when MT_VLT=false', async () => {
    await expect(resolveVltValue('vlt:main', { MT_VLT: 'false' })).resolves.toBe('vlt:main')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('findVlt prefers PATH over the managed copy, memoized', async () => {
    const pathBinary = await placeBinary(binDir)
    const managedDir = join(home, '.mt', 'bin')
    await mkdir(managedDir, { recursive: true })
    const managedBinary = await placeBinary(managedDir)
    await expect(findVlt(process.env)).resolves.toBe(pathBinary)
    // Remove the PATH binary: memoized result still wins.
    await rm(pathBinary)
    await expect(findVlt(process.env)).resolves.toBe(pathBinary)
    resetVltCache()
    await expect(findVlt(process.env)).resolves.toBe(managedBinary)
  })

  it('findVlt returns undefined when no binary exists', async () => {
    await expect(findVlt(process.env)).resolves.toBeUndefined()
  })

  it('resolves a ref, trims trailing whitespace, and sets VLT_CONFIG_PATH', async () => {
    await placeBinary(binDir)
    resetVltCache()
    let seenEnv: Record<string, string | undefined> | undefined
    execFileMock.mockImplementation((_file: unknown, args: unknown, opts: unknown, cb: unknown) => {
      seenEnv = (opts as { env: Record<string, string | undefined> }).env
      expect(args).toEqual(['show', 'main', '--stdout'])
      ;(cb as (e: Error | null, so: string, se: string) => void)(null, 'sk-resolved-value\n\n', '')
    })
    await expect(resolveVltValue('vlt:main', process.env)).resolves.toBe('sk-resolved-value')
    expect(seenEnv?.VLT_CONFIG_PATH).toBe(join(home, '.vlt.toml'))
  })

  it('errors on empty secret output without leaking it', async () => {
    await placeBinary(binDir)
    resetVltCache()
    mockVltShow(() => ({ stdout: '   \n' }))
    const err = await getVltSecret('main').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/empty/)
  })

  it('missing binary error points at vlt-install', async () => {
    mockVltShow(() => ({ error: execError('ENOENT') }))
    // No binary placed — force a lookup failure via a fresh env without PATH.
    const err = await getVltSecret('main', { PATH: join(dir, 'nowhere') }).catch((e: Error) => e)
    expect((err as Error).message).toContain('mt vault vlt-install')
  })

  it('classified errors never contain process output', async () => {
    const binary = await placeBinary(binDir)
    resetVltCache()
    const cases: Array<[ShowResult, RegExp]> = [
      [{ error: execError('ENOENT'), stderr: '' }, /mt vault vlt-install/],
      [{ error: execError(1), stderr: 'SECRETNAME not found in store' }, /not found in vlt vault/],
      [
        { error: execError(1), stderr: 'session expired, run login' },
        /session expired or vault locked/,
      ],
      [
        { error: execError(1), stderr: 'cryptic OUTPUTLEAK happened' },
        /Failed to resolve vlt secret "main"/,
      ],
    ]
    for (const [result, pattern] of cases) {
      execFileMock.mockReset()
      mockVltShow(() => result)
      const err = await getVltSecret('main').catch((e: Error) => e)
      expect((err as Error).message).toMatch(pattern)
      expect((err as Error).message).not.toContain('OUTPUTLEAK')
      expect((err as Error).message).not.toContain('SECRETNAME')
    }
    expect(binary).toBeTruthy()
  })

  it('installVlt rejects unsupported platforms', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      await expect(installVlt(process.env)).rejects.toThrow(/unsupported platform/)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('installVlt rejects unsupported architectures', async () => {
    const original = process.arch
    Object.defineProperty(process, 'arch', { value: 'ppc', configurable: true })
    try {
      await expect(installVlt(process.env)).rejects.toThrow(/unsupported architecture/)
    } finally {
      Object.defineProperty(process, 'arch', { value: original, configurable: true })
    }
  })

  it('installVlt reports network failure without details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        throw new Error('ECONNREFUSED 10.0.0.1:443')
      }),
    )
    await expect(installVlt(process.env)).rejects.toThrow(/failed to reach GitHub/)
  })

  it('installVlt downloads the linux tar.gz into ~/.mt/bin, mode 0755', async () => {
    const archive = makeTarGz({ vlt: Buffer.from('#!/bin/sh\necho vlt\n') })
    const calls = stubFetch('https://example.test/vlt.tar.gz', archive)
    const installed = await installVlt(process.env)
    expect(installed).toBe(join(home, '.mt', 'bin', 'vlt'))
    expect(calls[1]).toBe('https://example.test/vlt.tar.gz')
    const st = await stat(installed)
    expect(st.mode & 0o777).toBe(0o755)
    expect((await stat(installed)).size).toBeGreaterThan(0)
  })

  it('installVlt rejects a checksum mismatch and installs nothing', async () => {
    const archive = makeTarGz({ vlt: Buffer.from('#!/bin/sh\n') })
    stubFetch('https://example.test/vlt.tar.gz', archive)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown): Promise<Response> => {
        const u = String(url)
        if (u.includes('api.github.com')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v0.5.0',
              assets: [
                {
                  name: 'vlt_0.5.0_linux_amd64.tar.gz',
                  browser_download_url: 'https://example.test/vlt.tar.gz',
                },
                { name: 'vlt-cli_0.5.0_checksums.txt', browser_download_url: CHECKSUM_URL },
              ],
            }),
            { status: 200 },
          )
        }
        if (u === CHECKSUM_URL) {
          return new Response(`${'0'.repeat(64)}  vlt_0.5.0_linux_amd64.tar.gz`, { status: 200 })
        }
        return new Response(new Uint8Array(archive), { status: 200 })
      }),
    )
    const err = (await installVlt(process.env).catch((e: Error) => e)) as Error
    expect(err.message).toMatch(/sha256 mismatch/)
    await expect(stat(join(home, '.mt', 'bin', 'vlt'))).rejects.toThrow()
    await expect(stat(join(home, '.mt', 'bin', 'vltd'))).rejects.toThrow()
  })

  it('installVlt rejects a release without a checksum asset and installs nothing', async () => {
    const archive = makeTarGz({ vlt: Buffer.from('#!/bin/sh\n') })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown): Promise<Response> => {
        const u = String(url)
        if (u.includes('api.github.com')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v0.5.0',
              assets: [
                {
                  name: 'vlt_0.5.0_linux_amd64.tar.gz',
                  browser_download_url: 'https://example.test/vlt.tar.gz',
                },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response(new Uint8Array(archive), { status: 200 })
      }),
    )
    const err = (await installVlt(process.env).catch((e: Error) => e)) as Error
    expect(err.message).toMatch(/no checksum asset/)
    await expect(stat(join(home, '.mt', 'bin', 'vlt'))).rejects.toThrow()
  })

  it('installVlt installs unverified when MT_VLT_SKIP_VERIFY=true', async () => {
    const archive = makeTarGz({ vlt: Buffer.from('#!/bin/sh\n') })
    stubFetch('https://example.test/vlt.tar.gz', archive)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = { ...process.env, MT_VLT_SKIP_VERIFY: 'true' }
    await expect(installVlt(env)).resolves.toBe(join(home, '.mt', 'bin', 'vlt'))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipping sha256/))
    warn.mockRestore()
  })

  it('installVlt removes the binary and points at a static build when it does not run', async () => {
    const archive = makeTarGz({ vlt: Buffer.from('not a runnable binary') })
    stubFetch('https://example.test/vlt.tar.gz', archive)
    execFileMock.mockImplementation((_f: unknown, args: unknown, _o: unknown, cb: unknown) => {
      if ((args as string[])[0] === 'version') {
        ;(cb as (e: Error | null, so: string, se: string) => void)(
          execError(1),
          '',
          'GLIBC_2.34 not found',
        )
      } else {
        ;(cb as (e: Error | null, so: string, se: string) => void)(null, '', '')
      }
    })
    const err = (await installVlt(process.env).catch((e: Error) => e)) as Error
    expect(err.message).toMatch(/does not run/)
    expect(err.message).toContain('docker run')
    expect(err.message).not.toContain('GLIBC_2.34')
    await expect(stat(join(home, '.mt', 'bin', 'vlt'))).rejects.toThrow()
  })

  it('resolveVltValue auto-installs a missing binary once, then resolves', async () => {
    const archive = makeTarGz({ vlt: Buffer.from('#!/bin/sh\n') })
    stubFetch('https://example.test/vlt.tar.gz', archive)
    mockVltShow(() => ({ stdout: 'sk-auto-resolved\n' }))
    await expect(resolveVltValue('vlt:main', process.env)).resolves.toBe('sk-auto-resolved')
    expect(execFileMock).toHaveBeenCalled()
  })
})
