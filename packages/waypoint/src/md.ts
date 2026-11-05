import { mkdirSync } from 'node:fs'
import { access, copyFile, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { SourceContext, TargetContext } from '@mt/core'
import {
  BATCH_MEMBERS_VARIABLE,
  ITEM_VARIABLE,
  MD_OUTPUTS_VARIABLE,
  createExchange,
} from '@mt/core'
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
import {
  AtomicStreamWriter,
  annotate,
  atomicWriteFile,
  registry,
  tmpPathFor,
  truncateFileToBytes,
  waypoint,
} from '@mt/core'
import { exchangeField } from './fields.js'
import { resumeFrom } from './resume.js'
import { resolveWaypointPath, resolveWaypointRoot } from './settings.js'

const PATH_SEPARATOR_RE = /[\\/]/
const CHAPTER_FILE_RE = /^chapter(\d+)\.md$/i

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * File mode stages into `<final>.tmp.<runId>`; the offsets sidecar records the byte
 * boundary after every envelope so a resume can cut staged-but-uncommitted writes.
 */
function offsetsPathFor(stagingPath: string): string {
  return `${stagingPath}.offsets.json`
}

/** Remove offset sidecars left under the output root by earlier runs. */
async function removeStaleOffsetSidecars(filePath: string): Promise<void> {
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}.tmp.`
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.offsets.json'))
      .map((entry) => unlink(join(dir, entry)).catch(() => {})),
  )
}

/** Highest `chapterN.md` index directly under `root`, used to continue auto-numbering. */
async function seedAutoIndex(root: string): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return 0
  }
  let max = 0
  for (const entry of entries) {
    const match = CHAPTER_FILE_RE.exec(entry)
    const digits = match?.[1]
    if (!digits) continue
    const value = Number.parseInt(digits, 10)
    if (!Number.isNaN(value) && value > max) max = value
  }
  return max
}

interface OffsetSidecar {
  offsets: number[]
}

function parseOffsetSidecar(text: string): number[] {
  const parsed: unknown = JSON.parse(text)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as OffsetSidecar).offsets) ||
    !(parsed as OffsetSidecar).offsets.every((value) => typeof value === 'number')
  ) {
    throw new Error('invalid md target offsets sidecar: expected { offsets: number[] }')
  }
  return (parsed as OffsetSidecar).offsets
}

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

/** Values accepted by `md://...?split=<value>`. */
export const MD_SPLIT_VALUES = ['chunks', 'paragraphs', 'lines'] as const
export type MdSplitValue = (typeof MD_SPLIT_VALUES)[number]

/** Validate `?split=` at factory time; `undefined` means one envelope per file. */
function parseSplitValue(uri: ParsedUri): MdSplitValue | undefined {
  const value = uri.query.split
  if (value === undefined) return undefined
  if (!(MD_SPLIT_VALUES as readonly string[]).includes(value)) {
    throw new Error(
      `md source '${uri.raw}': unknown ?split value '${value}' ` +
        `(allowed: ${MD_SPLIT_VALUES.join(', ')})`,
    )
  }
  return value as MdSplitValue
}

/** Resolve the registered splitter for `?split=`; the check runs when the source starts. */
function resolveMdSplitter(
  uri: ParsedUri,
  split: MdSplitValue | undefined,
): Splitter<unknown> | null {
  if (!split) return null
  if (!registry.hasSplitter(split)) {
    throw new Error(
      [
        `md source '${uri.raw}': ?split=${split} requires a splitter named '${split}'. `,
        `Import '@mt/tools' (which registers it) or register one with `,
        `registry.registerSplitter('${split}', ...).`,
      ].join(''),
    )
  }
  return registry.resolveSplitter<unknown>(`#${split}`)
}

async function* readMdEnvelopes<T>(
  ctx: SourceContext,
  filePath: string,
  splitter: Splitter<unknown> | null,
): AsyncIterable<ExchangeInput<T>> {
  const stats = await stat(filePath)
  const files = stats.isFile() ? [filePath] : await discoverMarkdownFiles(filePath)
  for (const f of files) {
    const content = await readFile(f, 'utf-8')
    const base = createExchange(content, { id: `md:${f}`, meta: { filePath: f } })
    if (!splitter) {
      yield base as ExchangeInput<T>
      continue
    }
    const parts = await splitter.split(base, { run: ctx.run })
    const variables = base.variables.filter(
      (v) => v.name !== ITEM_VARIABLE && v.name !== BATCH_MEMBERS_VARIABLE,
    )
    let index = 0
    for (const part of parts) {
      yield createExchange(part as T, {
        id: `${base.id}.${index++}`,
        meta: { ...base.meta, parentId: base.id },
        variables,
      })
    }
  }
}

export function createMdSource<T>(uri: ParsedUri): Source<T> {
  const split = parseSplitValue(uri)
  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(ctx: SourceContext): AsyncIterable<ExchangeInput<T>> {
      const splitter = resolveMdSplitter(uri, split)
      const filePath = resolveWaypointPath(
        uri,
        'md',
        ctx.run.global.settings,
        ctx.run.global.project.root,
      )
      yield* readMdEnvelopes<T>(ctx, filePath, splitter)
    },
    async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<ExchangeInput<T>> {
      const splitter = resolveMdSplitter(uri, split)
      const filePath = resolveWaypointPath(
        uri,
        'md',
        ctx.run.global.settings,
        ctx.run.global.project.root,
      )
      yield* resumeFrom(() => readMdEnvelopes<T>(ctx, filePath, splitter), cursor)
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
 *
 * `checkpoint()` returns the envelopes durably written since `open()`. File mode keeps
 * a per-envelope byte-offset sidecar next to its staging file, so resume can truncate
 * staged lines the persisted cursor has not accounted for. Dir mode seeds its
 * auto-numbering from the chapters already on disk when resuming, so replay never
 * overwrites a lower chapter.
 */
export function createMdTarget<T>(uri: ParsedUri): Target<T> {
  let writer: AtomicStreamWriter | null = null
  let autoIndex = 0
  let filePath = ''
  let isFileMode = false
  let writtenFiles = 0
  let seriesSplitter: Splitter<string> | null = null
  let committedEnvelopes = 0
  /** Byte offset in the staging file where the current session starts appending. */
  let baseBytes = 0
  /** Envelope boundaries carried over from the persisted sidecar. */
  let baseOffsets: number[] = []
  /** Envelope boundaries produced by this session (appended to `baseOffsets`). */
  let newOffsets: number[] = []
  let sidecarPath = ''
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

  /** Book-keep one fully written envelope and, in file mode, its staging boundary. */
  function recordEnvelope(): void {
    committedEnvelopes += 1
    if (isFileMode && writer) newOffsets.push(baseBytes + writer.bytesWritten)
  }

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      autoIndex = 0
      writtenFiles = 0
      committedEnvelopes = 0
      baseBytes = 0
      baseOffsets = []
      newOffsets = []
      sidecarPath = ''
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
      const resumeCursor = ctx.resumeCursor
      if (!isFileMode) {
        if (resumeCursor !== undefined && resumeCursor > 0) {
          autoIndex = await seedAutoIndex(filePath)
        }
        return
      }

      const stagingPath = tmpPathFor(filePath, ctx.run.runId)
      sidecarPath = offsetsPathFor(stagingPath)
      if (resumeCursor === undefined) {
        await removeStaleOffsetSidecars(filePath)
        writer = await AtomicStreamWriter.open(filePath, ctx.run.runId)
        return
      }

      if (await pathExists(sidecarPath)) {
        const offsets = parseOffsetSidecar(await readFile(sidecarPath, 'utf-8'))
        if (resumeCursor > offsets.length) {
          throw new Error(
            `md target '${uri.raw}': resume cursor ${resumeCursor} exceeds the ` +
              `${offsets.length} envelope(s) recorded in ${sidecarPath}`,
          )
        }
        baseOffsets = offsets.slice(0, resumeCursor)
        baseBytes = resumeCursor === 0 ? 0 : (offsets[resumeCursor - 1] ?? 0)
      } else if (await pathExists(filePath)) {
        // A published file is the durable base; no per-envelope record survived.
        await copyFile(filePath, stagingPath)
        const stats = await stat(stagingPath)
        baseBytes = stats.size
        baseOffsets = new Array<number>(resumeCursor).fill(stats.size)
      } else if (resumeCursor === 0) {
        await writeFile(stagingPath, '')
      } else {
        throw new Error(
          `md target '${uri.raw}': cannot resume at cursor ${resumeCursor} — ` +
            `neither staged output nor an offsets sidecar exists for ${filePath}`,
        )
      }

      if (await pathExists(stagingPath)) {
        await truncateFileToBytes(stagingPath, baseBytes)
      } else {
        await writeFile(stagingPath, '')
      }
      writer = await AtomicStreamWriter.open(filePath, {
        tag: ctx.run.runId,
        append: true,
      })
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
        recordEnvelope()
        return
      }
      if (isFileMode) {
        await appendFileValue(env.item)
        recordEnvelope()
      } else {
        if (mdOutputs && mdOutputs.length > 0) {
          const claimed = new Map<string, string>()
          for (const output of mdOutputs) {
            const outPath = resolveOutputPath(filePath, output)
            const previous = claimed.get(outPath)
            if (previous !== undefined && previous !== output.name) {
              ctx.run.logger?.warn(
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
        recordEnvelope()
      }
    },
    async checkpoint(): Promise<number> {
      if (isFileMode && writer && sidecarPath) {
        await writer.sync()
        await atomicWriteFile(
          sidecarPath,
          JSON.stringify({ offsets: [...baseOffsets, ...newOffsets] }),
        )
      }
      return committedEnvelopes
    },
    async close(ctx: TargetContext): Promise<void> {
      if (writer) {
        const pending = writer
        writer = null
        await pending.commit()
      }
      if (isFileMode && sidecarPath) {
        await unlink(sidecarPath).catch(() => {})
      }
      if (!isFileMode && writtenFiles > 0) {
        ctx.run.logger?.info(
          `md target '${uri.raw}' wrote ${writtenFiles} file(s) under ${filePath}`,
        )
      }
    },
  }
}

annotate(
  createMdSource,
  waypoint('WT002', {
    name: 'md source',
    description: 'Reads a markdown file or directory of markdown files as envelopes.',
    meta: { schemes: ['md'], direction: 'source' },
  }),
)
annotate(
  createMdTarget,
  waypoint('WT002', {
    name: 'md target',
    description: 'Writes markdown to a single file or one atomic chapter file per envelope.',
    meta: { schemes: ['md'], direction: 'target' },
  }),
)
registry.registerSource('md', createMdSource)
registry.registerTarget('md', createMdTarget)
