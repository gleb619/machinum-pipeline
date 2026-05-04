import { readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

function getLogDir(): string {
  const mtHome = process.env.MT_HOME || join(process.env.HOME || '/root', '.mt')
  return join(mtHome, 'router')
}

export async function rotateLogs(retentionDays = 30): Promise<void> {
  const logDir = getLogDir()

  try {
    const entries = await readdir(logDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const dateStr = entry.name
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue

      const entryPath = join(logDir, entry.name)
      const logFilePath = join(entryPath, 'log.jsonl')

      try {
        const stats = await stat(logFilePath)
        if (stats.size > 5 * 1024 * 1024) {
          const rotatedPath = join(entryPath, `log-${Date.now()}.jsonl`)
          await rename(logFilePath, rotatedPath)
        }
      } catch {
        // File doesn't exist, skip
      }

      const entryDate = new Date(dateStr)
      const cutoffDate = new Date()
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays)

      if (entryDate < cutoffDate) {
        const files = await readdir(entryPath)
        for (const file of files) {
          await unlink(join(entryPath, file))
        }
      }
    }
  } catch (err) {
    console.error('Log rotation error:', err)
  }
}
