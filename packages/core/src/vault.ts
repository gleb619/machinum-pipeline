import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { tmpPathFor } from './atomic.js'

/**
 * Vault — gitignored store of sensitive LLM endpoint data (URLs, keys, headers).
 * Loaded from `~/.mt/vault.json` and `<project>/.mt/vault.json`; never serialized
 * into checkpoints, meta or logs. Error messages never echo secret values.
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
  notes?: string
}

export interface Vault {
  version: 1
  entries: Record<string, VaultEntry>
}

export interface VaultRef {
  entry: string
  model?: string
}

export interface ResolvedVaultRef {
  entry: VaultEntry
  name: string
  model: string | undefined
}

export function emptyVault(): Vault {
  return { version: 1, entries: {} }
}

/** Candidate vault file paths in load order (later overrides earlier). */
export function vaultPaths(projectRoot: string, env: Record<string, string | undefined>): string[] {
  const override = env.MT_VAULT
  if (override) return [resolve(override)]
  const mtHome = env.MT_HOME || join(env.HOME || homedir(), '.mt')
  return [join(mtHome, 'vault.json'), join(resolve(projectRoot), '.mt', 'vault.json')]
}

export async function loadVault(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Vault> {
  const vault = emptyVault()
  for (const path of vaultPaths(projectRoot, env)) {
    const file = await readVaultFile(path)
    if (file) Object.assign(vault.entries, file.entries)
  }
  return vault
}

async function readVaultFile(path: string): Promise<Vault | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'ENOENT') return undefined
    const code = (err as { code?: string }).code ?? 'unknown error'
    throw new Error(`Cannot read vault ${path}: ${code}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Parser messages can quote file content; keep secrets out.
    throw new Error(`Invalid vault ${path}: malformed JSON`)
  }
  return validateVault(parsed, path)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateVault(data: unknown, path: string): Vault {
  if (!isRecord(data)) throw new Error(`Invalid vault ${path}: expected a JSON object`)
  if (data.version !== 1) throw new Error(`Invalid vault ${path}: "version" must be 1`)
  if (!isRecord(data.entries)) throw new Error(`Invalid vault ${path}: "entries" must be an object`)
  const entries: Record<string, VaultEntry> = {}
  for (const [name, value] of Object.entries(data.entries)) {
    entries[name] = validateEntry(name, value, path)
  }
  return { version: 1, entries }
}

function validateEntry(name: string, value: unknown, path: string): VaultEntry {
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
    if (typeof v !== 'string') return fail(`"${key}" must be a string`)
    return v
  }
  const strList = (key: string): string[] | undefined => {
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
  const apiKeys = strList('apiKeys')
  if (apiKeys !== undefined) entry.apiKeys = apiKeys
  const models = strList('models')
  if (models !== undefined) entry.models = models
  const defaultModel = str('defaultModel')
  if (defaultModel !== undefined) entry.defaultModel = defaultModel
  const notes = str('notes')
  if (notes !== undefined) entry.notes = notes
  const headers = value.headers
  if (headers !== undefined) {
    if (!isRecord(headers) || Object.values(headers).some((h) => typeof h !== 'string')) {
      fail('"headers" must be an object of strings')
    }
    entry.headers = { ...(headers as Record<string, string>) }
  }
  return entry
}

/** Mask a secret: `sk-…abcd` (prefix up to first '-', last 4 chars); short values fully hidden. */
export function maskSecret(secret: string): string {
  if (secret.length < 12) return '…'
  const dash = secret.indexOf('-')
  const prefix = dash > 0 && dash <= 6 ? secret.slice(0, dash + 1) : ''
  return `${prefix}…${secret.slice(-4)}`
}

/** Copy of the vault with apiKey / apiKeys / header values masked. */
export function maskVault(vault: Vault): Vault {
  const entries: Record<string, VaultEntry> = {}
  for (const [name, e] of Object.entries(vault.entries)) {
    const copy: VaultEntry = { ...e }
    if (e.apiKey !== undefined) copy.apiKey = maskSecret(e.apiKey)
    if (e.apiKeys) copy.apiKeys = e.apiKeys.map(maskSecret)
    if (e.headers) {
      copy.headers = Object.fromEntries(
        Object.entries(e.headers).map(([k, v]) => [k, maskSecret(v)]),
      )
    }
    if (e.models) copy.models = [...e.models]
    entries[name] = copy
  }
  return { version: 1, entries }
}

/** Parse `vault://<entry>[/<model>]` or `@vault/<entry>[/<model>]`; undefined if not a ref. */
export function parseVaultRef(ref: string): VaultRef | undefined {
  let rest: string
  if (ref.startsWith('vault://')) rest = ref.slice('vault://'.length)
  else if (ref.startsWith('@vault/')) rest = ref.slice('@vault/'.length)
  else return undefined
  const slash = rest.indexOf('/')
  const entry = slash === -1 ? rest : rest.slice(0, slash)
  if (entry === '') return undefined
  const model = slash === -1 ? '' : rest.slice(slash + 1)
  return model === '' ? { entry } : { entry, model }
}

export function resolveVaultRef(vault: Vault, ref: string): ResolvedVaultRef {
  const parsed = parseVaultRef(ref)
  if (!parsed) throw new Error(`Not a vault reference: "${ref}"`)
  const found = Object.hasOwn(vault.entries, parsed.entry) ? vault.entries[parsed.entry] : undefined
  if (!found) {
    const names = Object.keys(vault.entries)
    throw new Error(
      `Vault ref "${ref}": unknown entry "${parsed.entry}". Available entries: ${
        names.length ? names.join(', ') : '(none)'
      }`,
    )
  }
  const model = parsed.model ?? found.defaultModel
  if (model !== undefined && found.models && !found.models.includes(model)) {
    throw new Error(
      `Vault ref "${ref}": model "${model}" not in entry "${parsed.entry}". Available models: ${
        found.models.join(', ') || '(none)'
      }`,
    )
  }
  return { entry: found, name: parsed.entry, model }
}

/** Atomic write (temp-then-rename), file mode 0600, parent dir created if needed. */
export async function saveVault(path: string, vault: Vault): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = tmpPathFor(path)
  try {
    await writeFile(tmp, `${JSON.stringify(vault, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}
