import { mkdirSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { SourceContext, TargetContext } from '@mt/core'
import type { Envelope, MdOutputEntry, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { AtomicStreamWriter, atomicWriteFile, registry } from '@mt/core'
import { resolveWaypointPath, resolveWaypointRoot } from './settings.js'

const PATH_SEPARATOR_RE = /[\\/]/

/**
 * Compose the final path for a `meta.mdOutputs` intent.
 *
 * The target owns the root; tools only supply `subdir` (relative, `''` = root)
 * and `filename` (basename). Absolute paths and `..` escapes are rejected
 * rather than normalized — a violation is a tool bug, not something to hide.
 */
function resolveOutputPath(root: string, entry: MdOutputEntry): string {
  const subdir = entry.subdir ?? entry.dir ?? ''
  if (isAbsolute(subdir)) {
    throw new Error(
      `md:// output '${entry.name}': subdir must be relative to the target root, got '${subdir}'`,
    )
  }
  const segments = subdir.split(PATH_SEPARATOR_RE).filter((s) => s.length > 0 && s !== '.')
  if (segments.includes('..')) {
    throw new Error(
      `md:// output '${entry.name}': subdir must not escape the target root: '${subdir}'`,
    )
  }
  if (entry.filename.length === 0) {
    throw new Error(`md:// output '${entry.name}': filename must not be empty`)
  }
  if (PATH_SEPARATOR_RE.test(entry.filename) || entry.filename === '.' || entry.filename === '..') {
    throw new Error(
      `md:// output '${entry.name}': filename must be a basename, got '${entry.filename}'`,
    )
  }
  return join(root, ...segments, entry.filename)
}

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
  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(ctx: SourceContext): AsyncIterable<Envelope<T>> {
      const filePath = resolveWaypointPath(uri, 'md', ctx.run.global.settings)
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
    async *resume(ctx: SourceContext, _cursor: unknown): AsyncIterable<Envelope<T>> {
      const filePath = resolveWaypointPath(uri, 'md', ctx.run.global.settings)
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

/**
 * Markdown Target — two modes:
 *   - file mode (`md://./out.md`): one stream accumulated to a temp file and
 *     renamed onto the final path in `close()` (atomic — never partially written)
 *   - dir mode (`md://./chapters/`): one atomic file per envelope, written as
 *     it arrives so a crash keeps every chapter finished so far
 *
 * In dir mode the URI is the output *root*: the target resolves it against the
 * project root / `waypoint.md.defaultFolder`, and every `meta.mdOutputs` intent
 * lands under it (`<root>/<subdir>/<filename>`). Tools never name the root.
 */
export function createMdTarget<T>(uri: ParsedUri): Target<T> {
  let writer: AtomicStreamWriter | null = null
  let autoIndex = 0
  let filePath = ''
  let isFileMode = false

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      autoIndex = 0
      const projectRoot = ctx.run.global.project?.root ?? process.cwd()
      filePath = resolveWaypointRoot(uri, 'md', ctx.run.global.settings, projectRoot)
      isFileMode = filePath.endsWith('.md')
      if (isFileMode) {
        writer = await AtomicStreamWriter.open(filePath, ctx.run.runId)
      }
    },
    async write(env: Envelope<T>, _ctx: TargetContext): Promise<void> {
      if (!filePath) {
        throw new Error('Target not opened. Call open() before write().')
      }
      if (isFileMode) {
        if (!writer) {
          throw new Error('Target not opened. Call open() before write().')
        }
        const text = String(env.item)
        writer.write(`${text}\n`)
      } else {
        const mdOutputs = env.meta.mdOutputs as MdOutputEntry[] | undefined
        if (mdOutputs && mdOutputs.length > 0) {
          const claimed = new Map<string, string>()
          for (const output of mdOutputs) {
            const outPath = resolveOutputPath(filePath, output)
            const previous = claimed.get(outPath)
            if (previous !== undefined && previous !== output.name) {
              console.warn(
                `[md] outputs '${previous}' and '${output.name}' both target ${outPath}; last write wins`,
              )
            }
            claimed.set(outPath, output.name)
            mkdirSync(dirname(outPath), { recursive: true })
            const text =
              typeof output.content === 'string' ? output.content : String(output.content)
            await atomicWriteFile(outPath, text)
          }
        } else {
          const chapterNum = env.meta.chapterNum || env.meta.chapter || ++autoIndex
          const baseDir = filePath
          mkdirSync(baseDir, { recursive: true })
          const text = String(env.item)
          await atomicWriteFile(join(baseDir, `chapter${chapterNum}.md`), text)
        }
      }
    },
    async close(_ctx: TargetContext): Promise<void> {
      if (writer) {
        const pending = writer
        writer = null
        await pending.commit()
      }
    },
  }
}

registry.registerSource('md', createMdSource)
registry.registerTarget('md', createMdTarget)
