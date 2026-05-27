import { describe, expect, it } from 'vitest'
import { type Settings, getSetting } from '../src/settings.js'

describe('settings', () => {
  it('returns undefined when settings bag is missing', () => {
    expect(getSetting(undefined, 'waypoint', 'jsonl', 'defaultFolder')).toBeUndefined()
  })

  it('returns undefined for missing key', () => {
    const settings: Settings = { 'waypoint.jsonl.batchSize': '10' }
    expect(getSetting(settings, 'waypoint', 'jsonl', 'defaultFolder')).toBeUndefined()
  })

  it('reads a string setting', () => {
    const settings: Settings = { 'waypoint.jsonl.defaultFolder': './data' }
    expect(getSetting<string>(settings, 'waypoint', 'jsonl', 'defaultFolder')).toBe('./data')
  })

  it('reads a number setting', () => {
    const settings: Settings = { 'runner.concurrency.max': 8 }
    expect(getSetting<number>(settings, 'runner', 'concurrency', 'max')).toBe(8)
  })

  it('reads a nested object setting', () => {
    const nested = { host: 'localhost', port: 3000 }
    const settings: Settings = { 'router.http.options': nested }
    expect(getSetting<typeof nested>(settings, 'router', 'http', 'options')).toEqual(nested)
  })
})
