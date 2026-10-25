import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Router-local vault reader. Deliberate duplicate of the read half of `packages/core/src/vault.ts`
 * (format: `{ version: 1, entries: { <name>: VaultEntry } }`, same path lookup and precedence).
 * The router is standalone and must not import `@mt/*`; keep both formats in sync.
 *
 * Errors never contain file content or secret values: only the path and entry names.
 */

export const VAULT_PROVIDERS = [
  'ollama',
  'openrouter',
  'openai',
  'anthropic',
  'custom',
  'router',
] as const

export type VaultProvider = (typeof VAULT_PROVIDERS)[number]

export interface VaultEntry {
  provider: VaultProvider
  baseUrl?: string
  apiKey?: string
  apiKeys?: string[]
  headers?: Record<string, string>
  models?: string[]
  defaultModel?: string
}

type Env = Record<string, string | undefined>

/** Candidate vault paths in load order (later overrides earlier), as in core `vaultPaths`. */
export function vaultPaths(cwd: string = process.cwd(), env: Env = process.env): string[] {
  if (env.MT_VAULT) return [resolve(env.MT_VAULT)]
  const mtHome = env.MT_HOME || join(env.HOME || homedir(), '.mt')
  return [join(mtHome, 'vault.json'), join(resolve(cwd), '.mt', 'vault.json')]
}

/** Cheap change detector: mtime + size per path, `missing` when absent. Never reads content. */
export function vaultSignature(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const s = statSync(p)
        return `${s.mtimeMs}:${s.size}`
      } catch {
        return 'missing'
      }
    })
    .join('|')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readFile(path: string): Record<string, VaultEntry> | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') return undefined
    throw new Error(`Cannot read vault ${path}: ${code ?? 'unknown error'}`)
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid vault ${path}: malformed JSON`)
  }
  if (!isRecord(data)) throw new Error(`Invalid vault ${path}: expected a JSON object`)
  if (data.version !== 1) throw new Error(`Invalid vault ${path}: "version" must be 1`)
  if (!isRecord(data.entries)) throw new Error(`Invalid vault ${path}: "entries" must be an object`)
  const entries: Record<string, VaultEntry> = {}
  for (const [name, value] of Object.entries(data.entries)) {
    entries[name] = parseEntry(name, value, path)
  }
  return entries
}

function parseEntry(name: string, value: unknown, path: string): VaultEntry {
  const fail = (msg: string): never => {
    throw new Error(`Invalid vault ${path}: entry "${name}": ${msg}`)
  }
  if (name === '' || name.includes('/')) fail('name must be non-empty and contain no "/"')
  if (!isRecord(value)) return fail('expected an object')
  const provider = value.provider
  if (!VAULT_PROVIDERS.some((p) => p === provider)) {
    return fail(`"provider" must be one of ${VAULT_PROVIDERS.join(', ')}`)
  }
  const str = (key: string): string | undefined => {
    const v = value[key]
    if (v === undefined) return undefined
    return typeof v === 'string' ? v : fail(`"${key}" must be a string`)
  }
  const list = (key: string): string[] | undefined => {
    const v = value[key]
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      return fail(`"${key}" must be an array of strings`)
    }
    return v as string[]
  }
  const entry: VaultEntry = { provider: provider as VaultProvider }
  const baseUrl = str('baseUrl')
  if (baseUrl !== undefined) entry.baseUrl = baseUrl
  const apiKey = str('apiKey')
  if (apiKey !== undefined) entry.apiKey = apiKey
  const apiKeys = list('apiKeys')
  if (apiKeys !== undefined) entry.apiKeys = apiKeys
  const models = list('models')
  if (models !== undefined) entry.models = models
  const defaultModel = str('defaultModel')
  if (defaultModel !== undefined) entry.defaultModel = defaultModel
  const headers = value.headers
  if (headers !== undefined) {
    if (!isRecord(headers) || Object.values(headers).some((h) => typeof h !== 'string')) {
      fail('"headers" must be an object of strings')
    }
    entry.headers = { ...(headers as Record<string, string>) }
  }
  return entry
}

/** Reads and merges all vault files (project overrides user, whole entry). Missing files = empty. */
export function readVaultEntries(paths: string[]): Record<string, VaultEntry> {
  const merged: Record<string, VaultEntry> = {}
  for (const path of paths) Object.assign(merged, readFile(path))
  return merged
}
