import type { ParsedUri } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { resolveWaypointPath, resolveWaypointRoot } from '../src/settings.js'

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

const projectRoot = '/project'

describe('resolveWaypointPath', () => {
  it('anchors a bare filename at projectRoot when no defaultFolder is configured', () => {
    const uri = makeUri('data.jsonl')
    expect(resolveWaypointPath(uri, 'jsonl', undefined, projectRoot)).toBe('/project/data.jsonl')
  })

  it('applies defaultFolder to bare filename under projectRoot', () => {
    const uri = makeUri('data.jsonl')
    const settings = { 'waypoint.jsonl.defaultFolder': './custom/jsonl' }
    expect(resolveWaypointPath(uri, 'jsonl', settings, projectRoot)).toBe(
      '/project/custom/jsonl/data.jsonl',
    )
  })

  it('does not apply defaultFolder when path has directory separator', () => {
    const uri = makeUri('./data/test.jsonl')
    const settings = { 'waypoint.jsonl.defaultFolder': './custom/jsonl' }
    expect(resolveWaypointPath(uri, 'jsonl', settings, projectRoot)).toBe(
      '/project/data/test.jsonl',
    )
  })

  it('does not apply defaultFolder to absolute paths', () => {
    const uri = makeUri('/absolute/path.jsonl')
    const settings = { 'waypoint.jsonl.defaultFolder': './custom/jsonl' }
    expect(resolveWaypointPath(uri, 'jsonl', settings, projectRoot)).toBe('/absolute/path.jsonl')
  })

  it('anchors glob patterns at projectRoot', () => {
    const uri = makeUri('*.jsonl')
    const settings = { 'waypoint.jsonl.defaultFolder': './custom/jsonl' }
    expect(resolveWaypointPath(uri, 'jsonl', settings, projectRoot)).toBe('/project/*.jsonl')
  })

  it('anchors paths with wildcards at projectRoot', () => {
    const uri = makeUri('data?.jsonl')
    const settings = { 'waypoint.jsonl.defaultFolder': './custom/jsonl' }
    expect(resolveWaypointPath(uri, 'jsonl', settings, projectRoot)).toBe('/project/data?.jsonl')
  })
})

describe('resolveWaypointRoot', () => {
  it('resolves a relative path against projectRoot', () => {
    const uri = makeUri('./chapters')
    expect(resolveWaypointRoot(uri, 'md', undefined, projectRoot)).toBe('/project/chapters')
  })

  it('joins defaultFolder under projectRoot', () => {
    const uri = makeUri('chapters')
    const settings = { 'waypoint.md.defaultFolder': 'out' }
    expect(resolveWaypointRoot(uri, 'md', settings, projectRoot)).toBe('/project/out/chapters')
  })

  it('returns absolute paths unchanged', () => {
    const uri = makeUri('/var/out')
    const settings = { 'waypoint.md.defaultFolder': 'out' }
    expect(resolveWaypointRoot(uri, 'md', settings, projectRoot)).toBe('/var/out')
  })
})
