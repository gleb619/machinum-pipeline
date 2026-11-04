import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CACHE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 2_000

export interface HealthCapabilities {
  chrome: boolean
  docker: boolean
  playwright: boolean
  ollama: boolean
}

interface CapabilityCache {
  expiresAt: number
  value: HealthCapabilities
}

let cache: CapabilityCache | undefined

async function commandWorks(command: string, args: string[] = ['--version']): Promise<boolean> {
  try {
    await execFileAsync(command, args, {
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

async function anyCommandWorks(commands: readonly string[]): Promise<boolean> {
  for (const command of commands) {
    if (await commandWorks(command)) return true
  }
  return false
}

async function detectChrome(): Promise<boolean> {
  return anyCommandWorks([
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'chrome',
  ])
}

async function detectDocker(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

async function detectPlaywright(): Promise<boolean> {
  return anyCommandWorks(['playwright'])
}

async function detectOllama(): Promise<boolean> {
  if (process.env.MT_OLLAMA_URL?.trim()) return true
  return anyCommandWorks(['ollama'])
}

/**
 * Cheap, cached capability probe for `/api/health`. Every probe catches its own
 * failure, so this function never throws and a missing tool only reports `false`.
 */
export async function detectCapabilities(now = Date.now()): Promise<HealthCapabilities> {
  if (cache && cache.expiresAt > now) return cache.value
  const [chrome, docker, playwright, ollama] = await Promise.all([
    detectChrome(),
    detectDocker(),
    detectPlaywright(),
    detectOllama(),
  ])
  const value: HealthCapabilities = { chrome, docker, playwright, ollama }
  cache = { expiresAt: now + CACHE_TTL_MS, value }
  return value
}

/** Test hook; the runtime never needs to reset the cache. */
export function resetCapabilityCache(): void {
  cache = undefined
}
