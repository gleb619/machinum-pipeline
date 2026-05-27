import { describe, expect, it } from 'vitest'
import { resolveWaypointPath } from '../src/settings.js'
import type { ParsedUri } from '@mt/core'

function makeUri(path: string, host = ''): ParsedUri {
  return {
    scheme: 'jsonl',
    raw: `jsonl://${path}`,
    host,
    path,
    query: {},
    fragment: '',
  }
}

describe('resolveWaypointPath', () => {
  it('returns raw path when no defaultFolder is configured', () => {
    const uri = makeUri('data.jsonl')
    expect(resolveWaypointPath(uri, 'jsonl', undefined)).toBe('data.jsonl')
  })

  it('applies defaultFolder to bare filename', () => {
    const uri = makeUri('data.jsonl')
    const settings = { 'waypoint.jsonl.defaultFolder': './custom/jsonl' }
    expect(resolveWaypointPath(uri, 'jsonl', settings)).toBe('custom/jsonl/data.jsonl')
  })

  it('does not apply defaultFolder when path has directory separator', () => {
    const uri = makeUri('./data/test.jsonl')
    const settings = { 'waypoint.jsonl.defaultFolder': './custom/jsonl' }
    expect(resolveWaypointPath(uri, 'jsonl', settings)).toBe('./data/test.jsonl')
  })

  it('does not apply defaultFolder to absolute paths', () => {
    const uri = makeUri('/absolute/path.jsonl')
    const settings = { 'waypoint.jsonl.defaultFolder': './custom/jsonl' }
    expect(resolveWaypointPath(uri, 'jsonl', settings)).toBe('/absolute/path.jsonl')
  })

  it('does not apply defaultFolder to glob patterns', () => {
    const uri = makeUri('*.jsonl')
    const settings = { 'waypoint.jsonl.defaultFolder': './custom/jsonl' }
    expect(resolveWaypointPath(uri, 'jsonl', settings)).toBe('*.jsonl')
  })

  it('does not apply defaultFolder to paths with wildcards', () => {
    const uri = makeUri('data?.jsonl')
    const settings = { 'waypoint.jsonl.defaultFolder': './custom/jsonl' }
    expect(resolveWaypointPath(uri, 'jsonl', settings)).toBe('data?.jsonl')
  })
})
