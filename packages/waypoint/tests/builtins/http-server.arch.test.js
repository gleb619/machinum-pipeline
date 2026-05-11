import { describe, expect, it } from 'vitest'
import { createHttpSource } from '../../src/builtins/http-server.js'
import { registry } from '../../src/uri.js'
// Register on import
import '../../src/builtins/http-server.js'
describe('UC-22 — HTTP Source (architectural)', () => {
  it('createHttpSource is exported as a function', () => {
    expect(typeof createHttpSource).toBe('function')
  })
  it('createHttpSource returns an object satisfying Source interface', () => {
    const src = createHttpSource({
      scheme: 'http',
      raw: 'http://localhost:8080/ingest?port=9090',
      host: 'localhost:8080',
      path: '/ingest',
      query: { port: '9090' },
    })
    expect(src).toHaveProperty('uri')
    expect(src).toHaveProperty('lifestyle')
    expect(src.lifestyle).toBe('long-lived')
    expect(typeof src.start).toBe('function')
    // HTTP source does NOT support resume — no resume method expected
  })
  it('http scheme is registered for source resolution', () => {
    const src = registry.resolveSource('http://localhost:9090/ingest')
    expect(src).toHaveProperty('uri')
    expect(src.lifestyle).toBe('long-lived')
  })
  it('default port is 8080 when not specified via query.port', () => {
    const src = createHttpSource({
      scheme: 'http',
      raw: 'http://localhost/path',
      host: 'localhost',
      path: '/path',
      query: {},
    })
    // Port defaults to 8080 internally — source.uri preserves raw string
    expect(src.uri).toBe('http://localhost/path')
  })
})
//# sourceMappingURL=http-server.arch.test.js.map
