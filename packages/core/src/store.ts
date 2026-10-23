import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWriteFile } from './atomic.js'

/**
 * Atomic file store for .mt/ operations.
 * Whole-file writes use temp+rename to prevent corruption on crash.
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
    await atomicWriteFile(filePath, content)
    return filePath
  }

  async writeJson(data: unknown, ...parts: string[]): Promise<string> {
    return this.write(JSON.stringify(data, null, 2) + '\n', ...parts)
  }

  async remove(...parts: string[]): Promise<void> {
    await unlink(this.resolve(...parts))
  }

  /**
   * Append to an append-only log (run logs, dead-letter queue).
   *
   * Deliberately NOT temp+rename: these files grow line by line and are never
   * re-read whole, so rewriting them per line would make every append O(size).
   * The OS keeps a single `write(2)` of the appended chunk below PIPE_BUF-level
   * tears, and a truncated last line is recoverable from the checkpoint tree.
   */
  async append(content: string, ...parts: string[]): Promise<string> {
    const filePath = this.resolve(...parts)
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, content, 'utf-8')
    return filePath
  }

  async appendLines(lines: string[], ...parts: string[]): Promise<string> {
    return this.append(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', ...parts)
  }
}
