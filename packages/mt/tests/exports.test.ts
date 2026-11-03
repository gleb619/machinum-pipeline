import { describe, expect, it } from 'vitest'
import { registerEmbeddedModules } from '../src/embed.js'
import * as root from '../src/index.js'
import * as tools from '../src/tools.js'
import * as waypoint from '../src/waypoint.js'

describe('mt umbrella exports', () => {
  it('root exposes core DSL and Runner', () => {
    expect(typeof root.definePipeline).toBe('function')
    expect(typeof root.defineTool).toBe('function')
    expect(typeof root.Runner).toBe('function')
  })

  it('mt/tools exposes chapter tools', () => {
    expect(tools.chapterDoc).toBeDefined()
    expect(tools.tokenCounter).toBeDefined()
  })

  it('mt/waypoint exposes sources/targets', () => {
    expect(typeof waypoint.createJsonlSource).toBe('function')
    expect(typeof waypoint.createMdTarget).toBe('function')
    expect(typeof waypoint.createEntityBufferSource).toBe('function')
  })

  it('ladder entity buffer schemes are source-only and auto-publishable', () => {
    for (const scheme of ['chapters', 'paragraphs', 'chunks', 'tokens', 'lines', 'words']) {
      expect(root.registry.resolveSource(`${scheme}://`)).toHaveProperty('start')
      expect(root.registry.hasTarget(scheme)).toBe(false)
      expect(root.registry.hasBufferWriter(scheme)).toBe(true)
    }
    expect(root.registry.hasSource('temp')).toBe(false)
    expect(root.registry.hasTarget('temp')).toBe(false)
  })

  it('mem:// is a bidirectional alias of ephemeral://', () => {
    expect(root.registry.hasSource('mem')).toBe(true)
    expect(root.registry.hasTarget('mem')).toBe(true)
    expect(root.registry.hasSource('ephemeral')).toBe(true)
  })

  it('embedded-module registration is a no-op outside Bun', () => {
    expect(registerEmbeddedModules()).toBe(
      typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined',
    )
  })
})
