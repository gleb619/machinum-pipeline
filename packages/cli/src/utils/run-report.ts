import { open, stat } from 'node:fs/promises'
import type { RemoteRunLogger } from './remote-run.js'
import { postRunEvents } from './worker-client.js'

export interface RunReporterOptions {
  mainUrl: string
  token?: string
  runId: string
  eventsPath: string
  logger: RemoteRunLogger
  intervalMs?: number
}

const MAX_BATCH_LINES = 500

/**
 * Tail the child's local `events.jsonl` and forward new complete lines to the main
 * `mt serve` worker ingest endpoint. The offset only advances after a successful POST,
 * so a reconnect retries the same batch instead of dropping events.
 */
export class RunReporter {
  private readonly options: RunReporterOptions
  private offset = 0
  private timer: NodeJS.Timeout | undefined
  private chain: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(options: RunReporterOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    await this.tick()
    if (this.stopped) return
    const interval = this.options.intervalMs ?? 200
    this.timer = setInterval(() => {
      void this.tick()
    }, interval)
  }

  /** Stop polling and send everything written so far. */
  async flush(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.chain
    await this.tick()
    await this.chain
  }

  private tick(): Promise<void> {
    const next = this.chain.then(() => this.sendNewLines())
    this.chain = next.catch(() => undefined)
    return next
  }

  private async sendNewLines(): Promise<void> {
    let text: string
    try {
      const info = await stat(this.options.eventsPath)
      if (info.size <= this.offset) return
      const handle = await open(this.options.eventsPath, 'r')
      try {
        const length = info.size - this.offset
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, this.offset)
        text = buffer.toString('utf8')
      } finally {
        await handle.close()
      }
    } catch {
      return
    }
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) return
    const complete = text.slice(0, lastNewline + 1)
    const lines = complete.split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) {
      this.offset += Buffer.byteLength(complete, 'utf8')
      return
    }
    let sent = 0
    for (let index = 0; index < lines.length; index += MAX_BATCH_LINES) {
      const batch = lines.slice(index, index + MAX_BATCH_LINES)
      try {
        await postRunEvents(
          { url: this.options.mainUrl, token: this.options.token },
          this.options.runId,
          `${batch.join('\n')}\n`,
        )
      } catch (error) {
        this.options.logger.warn('Worker event report failed; will retry', {
          runId: this.options.runId,
          error: error instanceof Error ? error.message : String(error),
        })
        break
      }
      sent += batch.length
    }
    if (sent === lines.length) this.offset += Buffer.byteLength(complete, 'utf8')
  }
}
