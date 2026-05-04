import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('UC-54 - SQLite persistence (architectural)', () => {
  describe('Nitro plugin', () => {
    const pluginPath = join(__dirname, '..', 'server', 'plugins', 'sqlite.ts')

    it('exists and exports default function', async () => {
      const source = await readFile(pluginPath, 'utf-8')
      expect(source).toMatch(/export default function/)
    })

    it('imports initSqlite and closeSqlite from utils', async () => {
      const source = await readFile(pluginPath, 'utf-8')
      expect(source).toMatch(/from ['"].*utils\/sqlite/)
      expect(source).toMatch(/initSqlite/)
      expect(source).toMatch(/closeSqlite/)
    })

    it('hooks nitroApp close event for cleanup', async () => {
      const source = await readFile(pluginPath, 'utf-8')
      expect(source).toMatch(/nitroApp\.hooks/)
      expect(source).toMatch(/['"]close['"]/)
      expect(source).toMatch(/closeSqlite/)
    })
  })

  describe('SQLite utilities', () => {
    const utilsPath = join(__dirname, '..', 'server', 'utils', 'sqlite.ts')

    it('exports initSqlite, closeSqlite, getDb', async () => {
      const source = await readFile(utilsPath, 'utf-8')
      expect(source).toMatch(/export function initSqlite/)
      expect(source).toMatch(/export function closeSqlite/)
      expect(source).toMatch(/export function getDb/)
    })

    it('creates runs table with required columns', async () => {
      const source = await readFile(utilsPath, 'utf-8')
      expect(source).toMatch(/CREATE TABLE.*runs/)
      expect(source).toMatch(/id/)
      expect(source).toMatch(/state/)
      expect(source).toMatch(/pipeline_id/)
      expect(source).toMatch(/started_at/)
      expect(source).toMatch(/updated_at/)
      expect(source).toMatch(/created_at/)
    })

    it('creates run_events table with required columns', async () => {
      const source = await readFile(utilsPath, 'utf-8')
      expect(source).toMatch(/CREATE TABLE.*run_events/)
      expect(source).toMatch(/id/)
      expect(source).toMatch(/run_id/)
      expect(source).toMatch(/type/)
      expect(source).toMatch(/data/)
      expect(source).toMatch(/timestamp/)
    })

    it('sets WAL journal mode', async () => {
      const source = await readFile(utilsPath, 'utf-8')
      expect(source).toMatch(/journal_mode.*WAL/)
    })

    it('uses .mt/mt.sqlite database path', async () => {
      const source = await readFile(utilsPath, 'utf-8')
      expect(source).toMatch(/\.mt['"]?,?['"]?\s*,\s*['"]?mt\.sqlite/)
    })

    it('uses better-sqlite3 via createRequire', async () => {
      const source = await readFile(utilsPath, 'utf-8')
      expect(source).toMatch(/createRequire/)
      expect(source).toMatch(/better-sqlite3/)
    })
  })
})
