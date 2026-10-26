import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DuplexLogger, createConsoleLogger } from '../../src/utils/logger.js'

/** Read `<dir>/<runId>/run.log`, retrying until the async write lands. */
async function readRunLog(dir: string, runId: string): Promise<string> {
  return vi.waitFor(() => readFile(join(dir, runId, 'run.log'), 'utf-8'))
}

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
    logger.setRunId('run-1')
    logger.info('test info', { key: 'value' })

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[INFO] test info {"key":"value"}'),
    )

    const logContent = await readRunLog(testDir, 'run-1')
    expect(logContent).toContain('[INFO] test info {"key":"value"}')
  })

  it('logs error to console and file', async () => {
    const logger = new DuplexLogger(testDir)
    logger.setRunId('run-1')
    logger.error('test error')

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ERROR] test error'))

    const logContent = await readRunLog(testDir, 'run-1')
    expect(logContent).toContain('[ERROR] test error')
  })

  it('logs debug only if MT_DEBUG is set', async () => {
    const logger = new DuplexLogger(testDir)
    logger.setRunId('run-1')

    // Not set
    logger.debug('should not see this')
    expect(console.debug).not.toHaveBeenCalled()

    // Set it
    process.env.MT_DEBUG = '1'
    logger.debug('test debug')
    expect(console.debug).toHaveBeenCalledWith(expect.stringContaining('[DEBUG] test debug'))
    process.env.MT_DEBUG = undefined

    const logContent = await readRunLog(testDir, 'run-1')
    expect(logContent).toContain('[DEBUG] test debug')
  })

  it('writes to <dir>/<runId>/run.log once the run id is known', async () => {
    const logger = new DuplexLogger(testDir)
    logger.setRunId('run-42')
    logger.info('per run line')

    const logContent = await readRunLog(testDir, 'run-42')
    expect(logContent).toContain('[INFO] per run line')
  })

  it('buffers lines logged before setRunId and flushes them to the run log', async () => {
    const logger = new DuplexLogger(testDir)
    logger.info('buffered line')

    // Nothing is written to disk while the run id is unknown.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(readFile(join(testDir, 'run.log'), 'utf-8')).rejects.toThrow()
    await expect(readFile(join(testDir, 'run-42', 'run.log'), 'utf-8')).rejects.toThrow()

    logger.setRunId('run-42')

    const logContent = await readRunLog(testDir, 'run-42')
    expect(logContent).toContain('[INFO] buffered line')
  })

  it('never creates a shared run.log in the runs root', async () => {
    const logger = new DuplexLogger(testDir)
    logger.setRunId('run-42')
    logger.info('per run line')

    await readRunLog(testDir, 'run-42')
    await expect(readFile(join(testDir, 'run.log'), 'utf-8')).rejects.toThrow()
  })

  it('flush resolves only after the queued lines are written', async () => {
    const logger = new DuplexLogger(testDir)
    logger.setRunId('run-42')
    logger.info('flushed line')

    await logger.flush()

    const logContent = await readFile(join(testDir, 'run-42', 'run.log'), 'utf-8')
    expect(logContent).toContain('[INFO] flushed line')
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
