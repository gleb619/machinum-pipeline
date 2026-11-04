import { type FSWatcher, watch } from 'node:fs'
import { createConsoleLogger, isProtectedSyncPath } from '@mt/core'
import {
  type RemoteSyncResult,
  resolveRemoteConfig,
  syncProjectPull,
  syncProjectPush,
} from '../utils/remote-client.js'

const logger = createConsoleLogger()

const USAGE = `Usage: mt remote sync [--push|--pull] [--dry-run] [--prune] [--force] [--watch]
                       [--url <url>] [--token-ref <ENV_OR_REF>] [--run <runId>]
                       [--allow-version-mismatch]

Push the project's sync scope to a remote mt serve mirror, or pull run outputs back.
Defaults: push, remote.url/remote.tokenRef from mt.json. --watch polls local edits
(debounced 300 ms) and is push-only.`

export interface RemoteSyncCliOptions {
  direction: 'push' | 'pull'
  dryRun: boolean
  prune: boolean
  force: boolean
  watch: boolean
  allowVersionMismatch: boolean
  url?: string
  tokenRef?: string
  runId?: string
}

export function parseRemoteArgs(args: readonly string[]): RemoteSyncCliOptions {
  const options: RemoteSyncCliOptions = {
    direction: 'push',
    dryRun: false,
    prune: false,
    force: false,
    watch: false,
    allowVersionMismatch: false,
  }
  let direction: 'push' | 'pull' | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--push' || arg === '--pull') {
      const next = arg === '--push' ? 'push' : 'pull'
      if (direction !== undefined && direction !== next) {
        throw new Error('--push and --pull are mutually exclusive')
      }
      direction = next
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--prune') {
      options.prune = true
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--watch') {
      options.watch = true
    } else if (arg === '--allow-version-mismatch') {
      options.allowVersionMismatch = true
    } else if (arg === '--url') {
      const value = args[++index]
      if (value === undefined) throw new Error('--url requires a value')
      options.url = value
    } else if (arg === '--token-ref') {
      const value = args[++index]
      if (value === undefined) throw new Error('--token-ref requires a value')
      options.tokenRef = value
    } else if (arg === '--run') {
      const value = args[++index]
      if (value === undefined) throw new Error('--run requires a runId')
      options.runId = value
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(USAGE)
    } else {
      throw new Error(`Unknown remote sync option: ${arg}\n\n${USAGE}`)
    }
  }
  options.direction = direction ?? 'push'
  if (options.watch && options.direction === 'pull') {
    throw new Error('--watch is only supported with --push')
  }
  return options
}

function printResult(result: RemoteSyncResult): void {
  if (result.dryRun) {
    for (const path of result.added) logger.info(`sync plan: add ${path}`)
    for (const path of result.changed) logger.info(`sync plan: update ${path}`)
    for (const path of result.removed) logger.info(`sync plan: delete ${path}`)
  }
  logger.info('remote sync complete', {
    direction: result.direction,
    projectId: result.projectId,
    url: result.url,
    added: result.added.length,
    changed: result.changed.length,
    removed: result.removed.length,
    transferred: result.transferred,
    deleted: result.deleted,
    bytes: result.bytes,
    dryRun: result.dryRun,
  })
}

function watchProject(root: string, onChange: () => void): FSWatcher {
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (filename === null) return
    const path = filename.split('\\').join('/')
    if (path === '.mt' || path.startsWith('.mt/')) return
    if (path === '.git' || path.startsWith('.git/')) return
    if (path === 'node_modules' || path.startsWith('node_modules/')) return
    if (path === 'dist' || path.startsWith('dist/')) return
    if (isProtectedSyncPath(path)) return
    onChange()
  })
  return watcher
}

async function syncOnce(options: RemoteSyncCliOptions): Promise<RemoteSyncResult> {
  const root = process.cwd()
  const config = await resolveRemoteConfig(root, {
    url: options.url,
    tokenRef: options.tokenRef,
  })
  const common = {
    root,
    url: config.url,
    token: config.token,
    projectId: config.projectId,
    include: config.include,
    exclude: config.exclude,
    maxFileBytes: config.maxFileBytes,
    dryRun: options.dryRun,
    prune: options.prune,
    force: options.force,
    allowVersionMismatch: options.allowVersionMismatch,
    runId: options.runId,
  }
  logger.info('remote sync start', {
    direction: options.direction,
    projectId: config.projectId,
    url: config.url,
    dryRun: options.dryRun,
    prune: options.prune,
  })
  const result =
    options.direction === 'push' ? await syncProjectPush(common) : await syncProjectPull(common)
  printResult(result)
  return result
}

async function watchLoop(options: RemoteSyncCliOptions): Promise<void> {
  await syncOnce(options)
  logger.info('remote sync watching for changes', { debounceMs: 300 })
  let timer: NodeJS.Timeout | undefined
  let running = false
  let pending = false
  const run = async (): Promise<void> => {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      await syncOnce(options)
    } catch (err) {
      logger.warn('remote sync failed; will retry on the next change', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      running = false
      if (pending) {
        pending = false
        await run()
      }
    }
  }
  const watcher = watchProject(process.cwd(), () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void run()
    }, 300)
  })
  await new Promise<void>((resolvePromise) => {
    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      watcher.close()
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolvePromise()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

export async function remoteCommand(args: string[]): Promise<void> {
  if (args[0] !== 'sync') {
    throw new Error(USAGE)
  }
  const options = parseRemoteArgs(args.slice(1))
  if (options.watch) await watchLoop(options)
  else await syncOnce(options)
}
