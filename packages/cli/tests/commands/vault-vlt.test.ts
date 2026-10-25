import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultCommand } from '../../src/commands/vault.js'

const { execFileSyncMock, findVltMock, installVltMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  findVltMock: vi.fn(),
  installVltMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

vi.mock('@mt/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mt/core')>()
  return { ...actual, findVlt: findVltMock, installVlt: installVltMock }
})

/** Everything console.log printed during the test. */
function logged(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
}

describe('vault vlt subcommands', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset()
    findVltMock.mockReset()
    installVltMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`EXIT ${code}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('vlt-install prints the installed path and version', async () => {
    installVltMock.mockResolvedValue('/home/u/.mt/bin/vlt')
    execFileSyncMock.mockReturnValue('vlt version 0.5.0\n')

    await vaultCommand(['vlt-install'])

    const output = logged().join('\n')
    expect(output).toContain('/home/u/.mt/bin/vlt')
    expect(output).toContain('0.5.0')
  })

  it('vlt-install reports the error and exits non-zero on failure', async () => {
    installVltMock.mockRejectedValue(new Error('vlt install: failed to reach GitHub'))

    await expect(vaultCommand(['vlt-install'])).rejects.toThrow('EXIT 1')
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      'failed to reach GitHub',
    )
  })

  it('vlt-status prints location, version and an active session', async () => {
    findVltMock.mockResolvedValue('/usr/local/bin/vlt')
    execFileSyncMock.mockImplementation((_bin: unknown, args: unknown) =>
      (args as string[])[0] === '--version' ? 'vlt version 0.4.2\n' : '',
    )

    await vaultCommand(['vlt-status'])

    const output = logged().join('\n')
    expect(output).toContain('found at /usr/local/bin/vlt')
    expect(output).toContain('0.4.2')
    expect(output).toContain('session: active')
  })

  it('vlt-status prints location and a locked session when the probe fails', async () => {
    findVltMock.mockResolvedValue('/usr/local/bin/vlt')
    execFileSyncMock.mockImplementation((_bin: unknown, args: unknown) => {
      if ((args as string[])[0] === '--version') return 'vlt version 0.4.2\n'
      throw Object.assign(new Error('exit 1'), { code: 1 })
    })

    await vaultCommand(['vlt-status'])

    const output = logged().join('\n')
    expect(output).toContain('found at /usr/local/bin/vlt')
    expect(output).toContain('session: locked or expired')
  })

  it('vlt-status points at the installer when vlt is missing', async () => {
    findVltMock.mockResolvedValue(undefined)

    await vaultCommand(['vlt-status'])

    const output = logged().join('\n')
    expect(output).toContain('vlt: not found')
    expect(output).toContain('mt vault vlt-install')
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })
})
