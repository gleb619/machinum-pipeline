import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('UC-28,30,31 - REST API routes for runs (architectural)', () => {
  describe('runs list route', () => {
    it('exists and exports default defineEventHandler', async () => {
      const routePath = join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', 'index.ts')
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/export default defineEventHandler/)
    })

    it('returns RunInfo shape with id and state fields', async () => {
      const routePath = join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', 'index.ts')
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/id:/)
      expect(source).toMatch(/state:/)
      expect(source).toMatch(/started/)
    })
  })

  describe('runs start route', () => {
    it('exists and exports default defineEventHandler', async () => {
      const routePath = join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', 'start.ts')
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/export default defineEventHandler/)
    })

    it('imports Runner from @mt/core', async () => {
      const routePath = join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', 'start.ts')
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/from ['"]@mt\/core['"]/)
      expect(source).toMatch(/new Runner/)
    })

    it('returns {runId} in response', async () => {
      const routePath = join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', 'start.ts')
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/runId/)
    })
  })

  describe('run detail route', () => {
    it('exists with [id] parameter', async () => {
      const routePath = join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', '[id].ts')
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/export default defineEventHandler/)
    })

    it('uses getRouterParam for id extraction', async () => {
      const routePath = join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', '[id].ts')
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/getRouterParam/)
    })
  })

  describe('run pause route', () => {
    it('exists and calls runner.pause()', async () => {
      const routePath = join(
        __dirname,
        '..',
        '..',
        'server',
        'routes',
        'api',
        'runs',
        '[id]',
        'pause.ts',
      )
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/export default defineEventHandler/)
      expect(source).toMatch(/\.pause\(\)/)
    })

    it('returns runId and state: paused', async () => {
      const routePath = join(
        __dirname,
        '..',
        '..',
        'server',
        'routes',
        'api',
        'runs',
        '[id]',
        'pause.ts',
      )
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/runId.*id/)
      expect(source).toMatch(/state.*['"]paused['"]/)
    })
  })

  describe('run resume route', () => {
    it('exists and calls runner.unpause()', async () => {
      const routePath = join(
        __dirname,
        '..',
        '..',
        'server',
        'routes',
        'api',
        'runs',
        '[id]',
        'resume.ts',
      )
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/export default defineEventHandler/)
      expect(source).toMatch(/\.unpause\(\)/)
    })

    it('returns runId and state: running', async () => {
      const routePath = join(
        __dirname,
        '..',
        '..',
        'server',
        'routes',
        'api',
        'runs',
        '[id]',
        'resume.ts',
      )
      const source = await readFile(routePath, 'utf-8')
      expect(source).toMatch(/runId.*id/)
      expect(source).toMatch(/state.*['"]running['"]/)
    })
  })

  describe('h3 imports', () => {
    it('all route files import defineEventHandler from h3', async () => {
      const routeFiles = [
        join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', 'index.ts'),
        join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', 'start.ts'),
        join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', '[id].ts'),
        join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', '[id]', 'pause.ts'),
        join(__dirname, '..', '..', 'server', 'routes', 'api', 'runs', '[id]', 'resume.ts'),
      ]
      for (const routeFile of routeFiles) {
        const source = await readFile(routeFile, 'utf-8')
        expect(source).toMatch(/from ['"]h3['"]/)
      }
    })
  })
})
