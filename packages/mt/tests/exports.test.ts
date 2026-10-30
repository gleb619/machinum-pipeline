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

  it('entity buffer schemes are registered globally by the umbrella', () => {
    for (const scheme of ['chapters', 'paragraphs', 'lines', 'words']) {
      expect(root.registry.resolveSource(`${scheme}://`)).toHaveProperty('start')
      expect(root.registry.resolveTarget(`${scheme}://`)).toHaveProperty('write')
    }
  })

  it('embedded-module registration is a no-op outside Bun', () => {
    expect(registerEmbeddedModules()).toBe(
      typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined',
    )
  })
})
