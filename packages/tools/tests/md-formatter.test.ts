import { describe, expect, it } from 'vitest'

import { formatString, mdFormatter, mdFormatterTool } from '../src/md-formatter.js'

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
// formatString — real remark pipeline
// ---------------------------------------------------------------------------

describe('formatString', () => {
  it('should format simple markdown', async () => {
    const input = '# Hello\n\nThis is a test.'
    const result = await formatString(input)
    expect(result.formatted).toBeTruthy()
    expect(typeof result.formatted).toBe('string')
    expect(result.formatted.length).toBeGreaterThan(0)
  })

  it('should preserve already-formatted markdown', async () => {
    const input = '# Title\n\nBody text.\n'
    const result = await formatString(input)
    expect(result.formatted).toBe(input)
    expect(result.alreadyFormatted).toBe(true)
  })

  it('should reformat unformatted markdown', async () => {
    const input = '# Title\n\nBody text.'
    const result = await formatString(input)
    expect(result.formatted).not.toBe(input)
    expect(result.alreadyFormatted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe('empty input', () => {
  it('should handle empty string', async () => {
    const result = await formatString('')
    expect(result.formatted).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Tool invoke — real remark pipeline
// ---------------------------------------------------------------------------

describe('mdFormatter tool invoke', () => {
  it('should format envelope item', async () => {
    const result = await mdFormatter.invoke({ item: '# Test\n\nContent.', meta: {} }, {} as any)
    expect(result.item).toBeTruthy()
    expect(typeof result.item).toBe('string')
    expect(result.meta.mdFormatted).toBe(true)
  })

  it('should set mdAlreadyFormatted true when no change needed', async () => {
    const input = '# Title\n\nBody text.\n'
    const result = await mdFormatter.invoke({ item: input, meta: {} }, {} as any)
    expect(result.meta.mdAlreadyFormatted).toBe(true)
  })

  it('should set mdAlreadyFormatted false when reformatted', async () => {
    const input = '# Title\n\nBody text.'
    const result = await mdFormatter.invoke({ item: input, meta: {} }, {} as any)
    expect(result.meta.mdAlreadyFormatted).toBe(false)
  })

  it('should use per-envelope options from meta.mdFormatOptions', async () => {
    const result = await mdFormatter.invoke(
      { item: 'test', meta: { mdFormatOptions: { wrapMode: 'never' } } },
      {} as any,
    )
    expect(result.item).toBeTruthy()
    expect(result.meta.mdFormatted).toBe(true)
  })
})
