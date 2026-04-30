import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Atomic file store for .mt/ operations.
 * All writes use temp+rename to prevent corruption on crash.
 */
export class Store {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  getRoot(): string {
    return this.root
  }

  resolve(...parts: string[]): string {
    return join(this.root, ...parts)
  }

  async ensureDir(...parts: string[]): Promise<string> {
    const dir = this.resolve(...parts)
    await mkdir(dir, { recursive: true })
    return dir
  }

  async exists(...parts: string[]): Promise<boolean> {
    return existsSync(this.resolve(...parts))
  }

  async read(...parts: string[]): Promise<string> {
    return readFile(this.resolve(...parts), 'utf-8')
  }

  async readJson<T>(...parts: string[]): Promise<T> {
    const content = await this.read(...parts)
    return JSON.parse(content) as T
  }

  async write(content: string, ...parts: string[]): Promise<string> {
    const filePath = this.resolve(...parts)
    await mkdir(dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    await writeFile(tmpPath, content, 'utf-8')
    await rename(tmpPath, filePath)
    return filePath
  }

  async writeJson(data: unknown, ...parts: string[]): Promise<string> {
    return this.write(JSON.stringify(data, null, 2) + '\n', ...parts)
  }

  async remove(...parts: string[]): Promise<void> {
    await unlink(this.resolve(...parts))
  }

  async append(content: string, ...parts: string[]): Promise<string> {
    const filePath = this.resolve(...parts)
    await mkdir(dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    const existing = existsSync(filePath) ? await readFile(filePath, 'utf-8') : ''
    await writeFile(tmpPath, existing + content, 'utf-8')
    await rename(tmpPath, filePath)
    return filePath
  }

  async appendLines(lines: string[], ...parts: string[]): Promise<string> {
    return this.append(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', ...parts)
  }
}
