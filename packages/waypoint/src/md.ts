import { createWriteStream, mkdirSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceContext, TargetContext } from '@mt/core'
import type { Envelope, MdOutputEntry, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { registry } from '@mt/core'

async function discoverMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await discoverMarkdownFiles(fullPath)))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath)
    }
  }
  return files.sort()
}

export function createMdSource<T>(uri: ParsedUri): Source<T> {
  const filePath = uri.path || uri.host

  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(_ctx: SourceContext): AsyncIterable<Envelope<T>> {
      const stats = await stat(filePath)
      if (stats.isFile()) {
        const content = await readFile(filePath, 'utf-8')
        yield { item: content as T, meta: { filePath } }
      } else {
        const files = await discoverMarkdownFiles(filePath)
        for (const f of files) {
          const content = await readFile(f, 'utf-8')
          yield { item: content as T, meta: { filePath: f } }
        }
      }
    },
    async *resume(_ctx: SourceContext, _cursor: unknown): AsyncIterable<Envelope<T>> {
      const stats = await stat(filePath)
      if (stats.isFile()) {
        const content = await readFile(filePath, 'utf-8')
        yield { item: content as T, meta: { filePath } }
      } else {
        const files = await discoverMarkdownFiles(filePath)
        for (const f of files) {
          const content = await readFile(f, 'utf-8')
          yield { item: content as T, meta: { filePath: f } }
        }
      }
    },
  }
}

export function createMdTarget<T>(uri: ParsedUri): Target<T> {
  const filePath = uri.path || uri.host
  const isFileMode = filePath.endsWith('.md')
  let writeStream: ReturnType<typeof createWriteStream> | null = null
  let autoIndex = 0

  return {
    uri: uri.raw,
    async open(_ctx: TargetContext): Promise<void> {
      autoIndex = 0
      if (isFileMode) {
        writeStream = createWriteStream(filePath, { encoding: 'utf-8', flags: 'a' })
      }
    },
    async write(env: Envelope<T>, _ctx: TargetContext): Promise<void> {
      if (isFileMode) {
        if (!writeStream) {
          throw new Error('Target not opened. Call open() before write().')
        }
        const text = String(env.item)
        writeStream.write(`${text}\n`)
      } else {
        const mdOutputs = env.meta.mdOutputs as MdOutputEntry[] | undefined
        if (mdOutputs && mdOutputs.length > 0) {
          for (const output of mdOutputs) {
            mkdirSync(output.dir, { recursive: true })
            const text =
              typeof output.content === 'string' ? output.content : String(output.content)
            const { writeFile } = await import('node:fs/promises')
            await writeFile(join(output.dir, output.filename), text, 'utf-8')
          }
        } else {
          const chapterNum = env.meta.chapterNum || env.meta.chapter || ++autoIndex
          const baseDir = filePath
          mkdirSync(baseDir, { recursive: true })
          const text = String(env.item)
          const { writeFile } = await import('node:fs/promises')
          await writeFile(join(baseDir, `chapter${chapterNum}.md`), text, 'utf-8')
        }
      }
    },
    async close(_ctx: TargetContext): Promise<void> {
      if (writeStream) {
        const stream = writeStream
        writeStream = null
        await new Promise<void>((resolve, reject) => {
          stream.on('finish', resolve)
          stream.on('error', reject)
          stream.end()
        })
      }
    },
  }
}

registry.registerSource('md', createMdSource)
registry.registerTarget('md', createMdTarget)
