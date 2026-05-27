import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseInitArgs } from '../../src/utils/args.js'

describe('parseInitArgs', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses empty args', () => {
    const result = parseInitArgs([])
    expect(result).toEqual({})
  })

  it('parses project name', () => {
    const result = parseInitArgs(['my-project'])
    expect(result).toEqual({ projectName: 'my-project' })
  })

  it('parses --settings flag with JSON', () => {
    const result = parseInitArgs(['--settings', '{"model":"gpt-4"}'])
    expect(result).toEqual({
      settings: { model: 'gpt-4' },
    })
  })

  it('parses -s flag with JSON', () => {
    const result = parseInitArgs(['-s', '{"model":"gpt-4"}'])
    expect(result).toEqual({
      settings: { model: 'gpt-4' },
    })
  })

  it('parses project name with settings', () => {
    const result = parseInitArgs(['my-project', '--settings', '{"model":"gpt-4"}'])
    expect(result).toEqual({
      projectName: 'my-project',
      settings: { model: 'gpt-4' },
    })
  })

  it('parses settings before project name', () => {
    const result = parseInitArgs(['--settings', '{"model":"gpt-4"}', 'my-project'])
    expect(result).toEqual({
      projectName: 'my-project',
      settings: { model: 'gpt-4' },
    })
  })

  it('errors on missing JSON argument', () => {
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`)
    }) as () => never)

    expect(() => parseInitArgs(['--settings'])).toThrow('exit 1')
    expect(console.error).toHaveBeenCalledWith('Error: --settings requires a JSON argument')
  })

  it('errors on invalid JSON', () => {
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`)
    }) as () => never)

    expect(() => parseInitArgs(['--settings', 'not-json'])).toThrow('exit 1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON'))
  })

  it('ignores unknown flags', () => {
    const result = parseInitArgs(['--unknown', 'value', 'my-project'])
    expect(result).toEqual({ projectName: 'my-project' })
  })
})
