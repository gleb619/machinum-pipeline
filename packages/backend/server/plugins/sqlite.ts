import type { NitroApp } from 'nitropack'
import { initSqlite, closeSqlite } from '../utils/sqlite.js'

export default function sqlitePlugin(nitroApp: NitroApp): void {
  const projectRoot = process.env.MT_PROJECT_ROOT || process.cwd()
  initSqlite(projectRoot)

  nitroApp.hooks.hook('close', () => {
    closeSqlite()
  })
}
