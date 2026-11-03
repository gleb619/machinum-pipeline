import { mkdirSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { SourceContext, TargetContext } from '@mt/core'
import { MD_OUTPUTS_VARIABLE } from '@mt/core'
import type {
  Exchange,
  ExchangeInput,
  MdOutputEntry,
  Source,
  Splitter,
  SplitterContext,
  Target,
} from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { AtomicStreamWriter, atomicWriteFile, registry } from '@mt/core'
import { exchangeField } from './fields.js'
import { resumeFrom } from './resume.js'
import { resolveWaypointPath, resolveWaypointRoot } from './settings.js'

const PATH_SEPARATOR_RE = /[\\/]/

/**
 * Compose the final path for a `mdOutputs` variable intent.
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

async function* readMdEnvelopes<T>(filePath: string): AsyncIterable<ExchangeInput<T>> {
  const stats = await stat(filePath)
  if (stats.isFile()) {
    const content = await readFile(filePath, 'utf-8')
    yield { id: `md:${filePath}`, item: content as T, meta: { filePath } }
  } else {
    const files = await discoverMarkdownFiles(filePath)
    for (const f of files) {
      const content = await readFile(f, 'utf-8')
      yield { id: `md:${f}`, item: content as T, meta: { filePath: f } }
    }
  }
}

export function createMdSource<T>(uri: ParsedUri): Source<T> {
  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(ctx: SourceContext): AsyncIterable<ExchangeInput<T>> {
      const filePath = resolveWaypointPath(
        uri,
        'md',
        ctx.run.global.settings,
        ctx.run.global.project.root,
      )
      yield* readMdEnvelopes(filePath)
    },
    async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<ExchangeInput<T>> {
      const filePath = resolveWaypointPath(
        uri,
        'md',
        ctx.run.global.settings,
        ctx.run.global.project.root,
      )
      yield* resumeFrom(() => readMdEnvelopes(filePath), cursor)
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
 * project root / `waypoint.md.defaultFolder`, and every `mdOutputs` variable intent
 * lands under it (`<root>/<subdir>/<filename>`). Tools never name the root.
 *
 * `?series=true` (or `?series=1`) runs each envelope through the registered `series`
 * splitter before writing, equivalent to `.subflow('#series')` followed by `.to(...)`.
 */
export function createMdTarget<T>(uri: ParsedUri): Target<T> {
  let writer: AtomicStreamWriter | null = null
  let autoIndex = 0
  let filePath = ''
  let isFileMode = false
  let writtenFiles = 0
  let seriesSplitter: Splitter<string> | null = null
  const seriesEnabled = uri.query.series === 'true' || uri.query.series === '1'

  async function appendFileValue(value: unknown): Promise<void> {
    if (!writer) {
      throw new Error('Target not opened. Call open() before write().')
    }
    await writer.write(`${String(value)}\n`)
  }

  /**
   * Write one envelope as `chapterN.md`. Series parts always take the next auto index:
   * reusing `meta.chapterNum` for every part would overwrite the same file.
   */
  async function writeChapterValue(
    env: Exchange<T>,
    value: unknown,
    autoNumber = false,
  ): Promise<void> {
    const chapterNum = autoNumber
      ? ++autoIndex
      : env.meta.chapterNum || env.meta.chapter || ++autoIndex
    const baseDir = filePath
    mkdirSync(baseDir, { recursive: true })
    await atomicWriteFile(join(baseDir, `chapter${chapterNum}.md`), String(value))
    writtenFiles += 1
  }

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      autoIndex = 0
      writtenFiles = 0
      seriesSplitter = null
      const projectRoot = ctx.run.global.project.root
      filePath = resolveWaypointRoot(uri, 'md', ctx.run.global.settings, projectRoot)
      isFileMode = filePath.endsWith('.md')
      if (seriesEnabled) {
        if (!registry.hasSplitter('series')) {
          throw new Error(
            [
              `md target '${uri.raw}': ?series=true requires a splitter named 'series'. `,
              `Import '@mt/tools' (which registers it) or register one with `,
              `registry.registerSplitter('series', ...).`,
            ].join(''),
          )
        }
        seriesSplitter = registry.resolveSplitter<string>('#series')
      }
      if (isFileMode) {
        writer = await AtomicStreamWriter.open(filePath, ctx.run.runId)
      }
    },
    async write(env: Exchange<T>, ctx: TargetContext): Promise<void> {
      if (!filePath) {
        throw new Error('Target not opened. Call open() before write().')
      }
      const mdOutputs = exchangeField<MdOutputEntry[]>(env, MD_OUTPUTS_VARIABLE)
      if (isFileMode && mdOutputs && mdOutputs.length > 0) {
        // File mode appends `env.item` to a single file — the per-file intents have
        // nowhere to go, so honouring them is impossible: reject instead of dropping
        // their content silently.
        throw new Error(
          [
            `md target '${uri.raw}': file mode cannot be combined with mdOutputs `,
            `intents (${mdOutputs.map((output) => output.name).join(', ')})`,
          ].join(''),
        )
      }
      if (seriesSplitter) {
        if (!isFileMode) {
          if (mdOutputs && mdOutputs.length > 0) {
            throw new Error(
              [
                `md target '${uri.raw}': ?series=true cannot be combined with mdOutputs `,
                'intents (no unambiguous filenames)',
              ].join(''),
            )
          }
        }
        const parts = await seriesSplitter.split(env, { run: ctx.run } satisfies SplitterContext)
        for (const part of parts) {
          if (isFileMode) {
            await appendFileValue(part)
          } else {
            await writeChapterValue(env, part, true)
          }
        }
        return
      }
      if (isFileMode) {
        await appendFileValue(env.item)
      } else {
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
            writtenFiles += 1
          }
        } else {
          await writeChapterValue(env, env.item)
        }
      }
    },
    async close(ctx: TargetContext): Promise<void> {
      if (writer) {
        const pending = writer
        writer = null
        await pending.commit()
      }
      if (!isFileMode && writtenFiles > 0) {
        ctx.run.logger?.info(
          `md target '${uri.raw}' wrote ${writtenFiles} file(s) under ${filePath}`,
        )
      }
    },
  }
}

registry.registerSource('md', createMdSource)
registry.registerTarget('md', createMdTarget)
