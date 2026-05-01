import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DuplexLogger, createConsoleLogger } from '../../src/utils/logger.js'

describe('DuplexLogger', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-logger-test-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('logs info to console and file', async () => {
    const logger = new DuplexLogger(testDir)
    logger.info('test info', { key: 'value' })

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[INFO] test info {"key":"value"}'),
    )

    // Wait a bit for file write (it's 'voided' in DuplexLogger)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const logContent = await readFile(join(testDir, 'run.log'), 'utf-8')
    expect(logContent).toContain('[INFO] test info {"key":"value"}')
  })

  it('logs error to console and file', async () => {
    const logger = new DuplexLogger(testDir)
    logger.error('test error')

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ERROR] test error'))

    await new Promise((resolve) => setTimeout(resolve, 50))

    const logContent = await readFile(join(testDir, 'run.log'), 'utf-8')
    expect(logContent).toContain('[ERROR] test error')
  })

  it('logs debug only if MT_DEBUG is set', async () => {
    const logger = new DuplexLogger(testDir)

    // Not set
    logger.debug('should not see this')
    expect(console.debug).not.toHaveBeenCalled()

    // Set it
    process.env.MT_DEBUG = '1'
    logger.debug('test debug')
    expect(console.debug).toHaveBeenCalledWith(expect.stringContaining('[DEBUG] test debug'))
    process.env.MT_DEBUG = undefined

    await new Promise((resolve) => setTimeout(resolve, 50))
    const logContent = await readFile(join(testDir, 'run.log'), 'utf-8')
    expect(logContent).toContain('[DEBUG] test debug')
  })
})

describe('createConsoleLogger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs to console', () => {
    const logger = createConsoleLogger()
    logger.info('info message')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[INFO] info message'))

    logger.warn('warn message')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[WARN] warn message'))

    logger.error('error message')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ERROR] error message'))
  })
})
