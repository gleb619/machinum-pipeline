import type { Exchange, ParsedUri, Target, TargetContext } from '@mt/core'
import { registry } from '@mt/core'

export type ConsoleFormat = 'auto' | 'json' | 'pretty'
export type ConsoleStream = 'stdout' | 'stderr'

export interface ConsoleTargetOptions {
  format?: ConsoleFormat
  prefix?: string
  envelope?: boolean
  stream?: ConsoleStream
  /** Inject a sink for tests/programmatic use; defaults to process[stream].write */
  sink?: (chunk: string) => void
}

interface ResolvedConsoleOptions {
  format: ConsoleFormat
  prefix: string
  envelope: boolean
  stream: ConsoleStream
  sink?: (chunk: string) => void
}

function parseFormat(value: string | undefined): ConsoleFormat {
  if (value === undefined) return 'auto'
  if (value === 'auto' || value === 'json' || value === 'pretty') return value
  throw new Error(`Invalid console:// format '${value}'. Expected one of: auto, json, pretty`)
}

function parseStream(value: string | undefined): ConsoleStream {
  if (value === undefined) return 'stdout'
  if (value === 'stdout' || value === 'stderr') return value
  throw new Error(`Invalid console:// stream '${value}'. Expected one of: stdout, stderr`)
}

function resolveOptions(
  uri: ParsedUri,
  options: ConsoleTargetOptions | undefined,
): ResolvedConsoleOptions {
  return {
    format: parseFormat(options?.format ?? uri.query.format),
    prefix: options?.prefix ?? uri.query.prefix ?? '',
    envelope: options?.envelope ?? (uri.query.envelope === 'true' || uri.query.envelope === '1'),
    stream: parseStream(options?.stream ?? uri.query.stream),
    ...(options?.sink === undefined ? {} : { sink: options.sink }),
  }
}

function stringify(value: unknown, format: ConsoleFormat): string {
  const serialized = JSON.stringify(value, null, format === 'pretty' ? 2 : undefined)
  return serialized === undefined ? String(value) : serialized
}

function renderItem(item: unknown, format: ConsoleFormat): string {
  if (format === 'auto' && typeof item === 'string') return item
  return stringify(item, format)
}

function renderEnvelope<T>(env: Exchange<T>, format: ConsoleFormat): string {
  const payload: Record<string, unknown> = {
    id: env.id,
    item: env.item,
  }
  if (env.items !== undefined) payload.items = env.items
  payload.meta = env.meta
  payload.variables = env.variables
  return stringify(payload, format)
}

function finishOutput(rendered: string, prefix: string): string {
  const withoutTrailingNewlines = rendered.replace(/(?:\r?\n)+$/, '')
  const prefixed = withoutTrailingNewlines
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
  return `${prefixed}\n`
}

/**
 * Render one exchange as console text, including the trailing newline. Pure: performs no I/O.
 */
export function renderConsoleExchange<T>(env: Exchange<T>, options?: ConsoleTargetOptions): string {
  const format = parseFormat(options?.format)
  const rendered =
    options?.envelope === true ? renderEnvelope(env, format) : renderItem(env.item, format)
  return finishOutput(rendered, options?.prefix ?? '')
}

/**
 * Console Target — writes every envelope to stdout or stderr as it arrives.
 *
 * URI scheme: console://[?format=auto|json|pretty][&prefix=<text>][&envelope=true|1][&stream=stdout|stderr]
 *
 * Streaming keeps interactive runs observable without buffering. There is deliberately NO
 * checkpoint(): stdout/stderr are not durable storage, so a crash resume replays safely.
 */
export function createConsoleTarget<T>(uri: ParsedUri, options?: ConsoleTargetOptions): Target<T> {
  const resolved = resolveOptions(uri, options)
  const sink =
    resolved.sink ??
    ((chunk: string): void => {
      if (resolved.stream === 'stderr') {
        process.stderr.write(chunk)
        return
      }
      process.stdout.write(chunk)
    })

  return {
    uri: uri.raw,
    async open(_ctx: TargetContext): Promise<void> {
      // No-op
    },
    async write(env: Exchange<T>, _ctx: TargetContext): Promise<void> {
      sink(renderConsoleExchange(env, resolved))
    },
    async close(_ctx: TargetContext): Promise<void> {
      // No-op: every envelope is already written by write().
    },
  }
}

// Register built-in console target (target-only: no source registration)
registry.registerTarget('console', createConsoleTarget)
