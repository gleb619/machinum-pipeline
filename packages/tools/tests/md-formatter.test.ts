import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}))

// ── Imports (after mocks so they see the mocked modules) ────────────────────

import {
  formatMarkdown,
  formatString,
  mdFormatter,
  mdFormatterTool,
} from '../src/md-formatter.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a mock child process object that fires data/close events synchronously. */
function makeMockChild(stdoutData?: string, exitCode = 0): any {
  return {
    stdout: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data' && stdoutData !== undefined) {
          cb(Buffer.from(stdoutData))
        }
      }),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      if (event === 'close') {
        cb(exitCode)
      }
    }),
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
  }
}

/** Reset all mocks before each test. */
beforeEach(() => {
  vi.clearAllMocks()
})

// ── Tests ───────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// mdFormatter tool definition
// ---------------------------------------------------------------------------

describe('mdFormatter', () => {
  it('should have correct name and version', () => {
    expect(mdFormatter.name).toBe('md-formatter')
    expect(mdFormatter.version).toBe('1.0.0')
  })

  it('should have invoke as a function', () => {
    expect(typeof mdFormatter.invoke).toBe('function')
  })

  it('should have exec set to inproc', () => {
    expect(mdFormatter.exec).toBe('inproc')
  })
})

// ---------------------------------------------------------------------------
// mdFormatterTool factory
// ---------------------------------------------------------------------------

describe('mdFormatterTool', () => {
  it('should create a tool with correct name and version', () => {
    const tool = mdFormatterTool()
    expect(tool.name).toBe('md-formatter')
    expect(tool.version).toBe('1.0.0')
  })

  it('should accept default options', () => {
    const tool = mdFormatterTool({ width: 90, wrapMode: 'preserve' })
    expect(tool.name).toBe('md-formatter')
    expect(tool.version).toBe('1.0.0')
    expect(typeof tool.invoke).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// formatString
// ---------------------------------------------------------------------------

describe('formatString', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReturnValue(makeMockChild() as any)
  })

  it('should format a simple markdown string', async () => {
    const input = '# Hello\n\nThis is a test.'
    vi.mocked(spawn).mockReturnValue(
      makeMockChild('# Hello\n\nThis is a test.') as any,
    )

    const result = await formatString(input)
    expect(result).toHaveProperty('formatted')
    expect(result).toHaveProperty('alreadyFormatted')
    expect(typeof result.formatted).toBe('string')
    expect(typeof result.alreadyFormatted).toBe('boolean')
  })

  it('should detect when output matches input (already formatted)', async () => {
    const input = '# Title\n\nBody text.'
    vi.mocked(spawn).mockReturnValue(makeMockChild(input) as any)

    const result = await formatString(input)
    expect(result.formatted).toBe(input)
    expect(result.alreadyFormatted).toBe(true)
  })

  it('should detect when formatter changed the content', async () => {
    const input = '# Title\n\nBody text.'
    const formatted = '# Title\n\nBody text.\n'
    vi.mocked(spawn).mockReturnValue(makeMockChild(formatted) as any)

    const result = await formatString(input)
    expect(result.formatted).toBe(formatted)
    expect(result.alreadyFormatted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Width clamping (80–120)
// ---------------------------------------------------------------------------

describe('width clamping', () => {
  it('should clamp width below 80 up to 80', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChild('test') as any)

    await formatString('test', { width: 50 })
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined
    const widthIdx = args?.indexOf('--width') ?? -1
    expect(args?.[widthIdx + 1]).toBe('80')
  })

  it('should clamp width above 120 down to 120', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChild('test') as any)

    await formatString('test', { width: 200 })
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined
    const widthIdx = args?.indexOf('--width') ?? -1
    expect(args?.[widthIdx + 1]).toBe('120')
  })

  it('should pass width within range unchanged', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChild('test') as any)

    await formatString('test', { width: 100 })
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined
    const widthIdx = args?.indexOf('--width') ?? -1
    expect(args?.[widthIdx + 1]).toBe('100')
  })

  it('should use default width 100 when not specified', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChild('test') as any)

    await formatString('test')
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined
    const widthIdx = args?.indexOf('--width') ?? -1
    expect(args?.[widthIdx + 1]).toBe('100')
  })
})

// ---------------------------------------------------------------------------
// --wrap never option
// ---------------------------------------------------------------------------

describe('--wrap never option', () => {
  it('should pass --wrap never when wrapMode is never', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChild('test') as any)

    await formatString('test', { wrapMode: 'never' })
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined
    const wrapIdx = args?.indexOf('--wrap') ?? -1
    expect(wrapIdx).toBeGreaterThanOrEqual(0)
    expect(args?.[wrapIdx + 1]).toBe('never')
  })

  it('should pass --wrap always by default', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChild('test') as any)

    await formatString('test')
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined
    const wrapIdx = args?.indexOf('--wrap') ?? -1
    expect(wrapIdx).toBeGreaterThanOrEqual(0)
    expect(args?.[wrapIdx + 1]).toBe('always')
  })

  it('should pass --wrap preserve when wrapMode is preserve', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChild('test') as any)

    await formatString('test', { wrapMode: 'preserve' })
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined
    const wrapIdx = args?.indexOf('--wrap') ?? -1
    expect(args?.[wrapIdx + 1]).toBe('preserve')
  })
})

// ---------------------------------------------------------------------------
// Empty input handling
// ---------------------------------------------------------------------------

describe('empty input', () => {
  it('should handle empty string input without throwing', async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChild('') as any)

    const result = await formatString('')
    expect(result).toBeDefined()
    expect(result.formatted).toBe('')
    expect(result.alreadyFormatted).toBe(true)
  })

  it('should handle whitespace-only input', async () => {
    const input = '   \n\n  '
    vi.mocked(spawn).mockReturnValue(makeMockChild(input) as any)

    const result = await formatString(input)
    expect(result).toBeDefined()
    expect(typeof result.formatted).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Non-.md file skipping (formatMarkdown read mode)
// ---------------------------------------------------------------------------

describe('non-.md files', () => {
  it('should skip non-.md files gracefully and return empty string', async () => {
    // Mock stat to return a regular file (not directory)
    vi.mocked(stat).mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
    } as any)

    const result = await formatMarkdown('test.txt')
    expect(result).toBe('')
  })

  it('should collect and format .md files', async () => {
    vi.mocked(stat).mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
    } as any)
    vi.mocked(readFile).mockResolvedValue('# Hello\n\nWorld')
    vi.mocked(spawn).mockReturnValue(makeMockChild('# Hello\n\nWorld') as any)

    const result = await formatMarkdown('test.md')
    // Should contain formatted content, not empty
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
  })

  it('should skip paths that throw during stat', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))

    const result = await formatMarkdown('nonexistent.md')
    // Non-existent path is caught and skipped, returns empty
    expect(result).toBe('')
  })
})
