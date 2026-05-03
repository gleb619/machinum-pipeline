import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { main } from '../src/index.js'
import { initCommand } from '../src/commands/init.js'
import { runCommand } from '../src/commands/run.js'
import { listRunsCommand } from '../src/commands/list.js'
import { inspectCommand } from '../src/commands/inspect.js'

vi.mock('../src/commands/init.js', () => ({
  initCommand: vi.fn()
}))

vi.mock('../src/commands/run.js', () => ({
  runCommand: vi.fn()
}))

vi.mock('../src/commands/list.js', () => ({
  listRunsCommand: vi.fn()
}))

vi.mock('../src/commands/inspect.js', () => ({
  inspectCommand: vi.fn()
}))

describe('CLI entry point', () => {
  let originalArgv: string[]

  beforeEach(() => {
    originalArgv = process.argv
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit called with ${code}`)
    })
  })

  afterEach(() => {
    process.argv = originalArgv
    vi.restoreAllMocks()
  })

  it('calls init command', async () => {
    process.argv = ['node', 'mt', 'init', 'my-project']
    await main()
    expect(initCommand).toHaveBeenCalledWith(['my-project'])
  })

  it('calls run command', async () => {
    process.argv = ['node', 'mt', 'run', 'pipeline.ts']
    await main()
    expect(runCommand).toHaveBeenCalledWith(['pipeline.ts'])
  })

  it('calls ls runs command', async () => {
    process.argv = ['node', 'mt', 'ls', 'runs']
    await main()
    expect(listRunsCommand).toHaveBeenCalledWith([])
  })

  it('calls inspect command', async () => {
    process.argv = ['node', 'mt', 'inspect', 'run-123']
    await main()
    expect(inspectCommand).toHaveBeenCalledWith(['run-123'])
  })

  it('shows help for --help', async () => {
    process.argv = ['node', 'mt', '--help']
    await main()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage: mt <command>'))
  })

  it('shows version for --version', async () => {
    process.argv = ['node', 'mt', '--version']
    await main()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('mt 0.1.0'))
  })

  it('fails for unknown command', async () => {
    process.argv = ['node', 'mt', 'unknown']
    await expect(main()).rejects.toThrow('process.exit called with 1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown command: unknown'))
  })
})
