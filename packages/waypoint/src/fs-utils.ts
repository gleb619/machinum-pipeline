import { access } from 'node:fs/promises'

/** True when `filePath` exists (any type). */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
