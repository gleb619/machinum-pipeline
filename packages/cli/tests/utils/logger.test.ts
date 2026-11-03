import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConsoleLogger } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DuplexLogger } from '../../src/utils/logger.js'

const LOG_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[(DEBUG|INFO|WARN|ERROR)\] /

/** Read `<dir>/<runId>/run.log`, retrying until the async write lands. */
async function readRunLog(dir: string, runId: string): Promise<string> {
  return vi.waitFor(() => readFile(join(dir, runId, 'run.log'), 'utf-8'))
}

function timestampOf(line: string): string {
  return line.slice(0, 24)
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

  it('logs info to console and file with the shared line format', async () => {
    const logger = new DuplexLogger(testDir)
    logger.setRunId('run-1')
    logger.info('test info', { key: 'value' })

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] test info \{"key":"value"\}$/,
      ),
    )

    const logContent = await readRunLog(testDir, 'run-1')
    expect(logContent).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] test info \{"key":"value"\}\n$/,
    )
  })

  it('uses the same timestamp shape in console and run.log', async () => {
    const logger = new DuplexLogger(testDir)
    logger.setRunId('run-1')
    logger.info('same prefix')

    const consoleLine = String(vi.mocked(console.log).mock.calls[0]?.[0])
    const fileLine = (await readRunLog(testDir, 'run-1')).trimEnd()

    expect(consoleLine).toMatch(LOG_PREFIX)
    expect(fileLine).toMatch(LOG_PREFIX)
    // Full ISO-8601 UTC timestamp with milliseconds, not HH:MM:SS.mmm
    expect(timestampOf(consoleLine)).toBe(timestampOf(fileLine))
    expect(timestampOf(consoleLine)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('logs error to console and file', async () => {
    const logger = new DuplexLogger(testDir)
    logger.setRunId('run-1')
    logger.error('test error')

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/\[ERROR\] test error$/))

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

  it('writes one physical line per call when the message contains a newline', async () => {
    const logger = new DuplexLogger(testDir)
    logger.setRunId('run-1')
    logger.info('first\nsecond')

    const logContent = await readRunLog(testDir, 'run-1')
    expect(logContent.split('\n')).toHaveLength(2)
    expect(logContent).toMatch(/\[INFO\] first\\nsecond\n$/)
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

  it('logs to console with one string argument in the shared format', () => {
    const logger = createConsoleLogger()
    logger.info('info message')
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^\S+Z \[INFO\] info message$/))
    expect(vi.mocked(console.log).mock.calls[0]).toHaveLength(1)

    logger.warn('warn message')
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^\S+Z \[WARN\] warn message$/))

    logger.error('error message')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\S+Z \[ERROR\] error message$/),
    )
  })
})
