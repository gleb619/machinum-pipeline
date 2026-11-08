import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { atomicWriteFile } from './atomic.js'
import { readJsonOrThrow } from './json-file.js'
import { isEmbedRef, resolveEmbedValue } from './secrets.js'
import type { LoadVaultOptions, ResolvedVaultRef, Vault, VaultEntry, VaultRef } from './types.js'

/**
 * Vault — gitignored store of sensitive LLM endpoint data (URLs, keys, headers).
 * Loaded from `~/.mt/vault.json` and `<project>/.mt/vault.json`; never serialized
 * into checkpoints, meta or logs. Error messages never echo secret values.
 *
 * `apiKey` / `apiKeys[]` values must be secret references, never plaintext:
 * `vlt:<name>` (vlt CLI), `keepass:<title|uuid>` (KeePass database) or `embed:<name>`
 * (embedded encrypted store, the default backend). Plaintext values are rejected at load
 * and at save. Refs are resolved in memory at load time; the file on disk keeps the refs.
 *
 * Ref resolution: `embed:` is built in (see `secrets.ts`). `vlt:` / `keepass:` are
 * resolved through {@link registerSecretResolver} — provided by `@mt/plugins`, which
 * registers them as an import side effect (`import '@mt/plugins'`).
 */

/** Resolves one vault secret ref (e.g. `vlt:<name>`) to its value, in memory only. */
export type SecretResolver = (
  value: string,
  env: Record<string, string | undefined>,
) => Promise<string>

const secretResolvers = new Map<string, SecretResolver>()

/**
 * Register a resolver for a secret-ref prefix (e.g. `vlt:`, including the colon).
 * Later registrations replace earlier ones. Called by `@mt/plugins` at import time.
 */
export function registerSecretResolver(prefix: string, resolver: SecretResolver): void {
  if (!/^[a-z][a-z0-9-]*:$/.test(prefix)) {
    throw new Error(`Invalid secret ref prefix "${prefix}": use lowercase "<name>:"`)
  }
  secretResolvers.set(prefix, resolver)
}

/** Remove all registered resolvers (tests). The built-in `embed:` resolution is unaffected. */
export function resetSecretResolvers(): void {
  secretResolvers.clear()
}

/** Prefixes with a registered resolver (tests/diagnostics). */
export function registeredSecretPrefixes(): string[] {
  return [...secretResolvers.keys()]
}

export const VAULT_PROVIDERS = [
  'ollama',
  'openrouter',
  'openai',
  'anthropic',
  'custom',
  'router',
] as const

export type VaultProvider = (typeof VAULT_PROVIDERS)[number]

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

const SECRET_REF_PREFIXES = ['vlt:', 'keepass:', 'embed:'] as const

/** True when a key value is a secret reference (`vlt:`, `keepass:` or `embed:`). */
export function isSecretRef(value: string): boolean {
  return SECRET_REF_PREFIXES.some((prefix) => value.startsWith(prefix))
}

/** Fields of an entry holding a plaintext (non-ref) key: `apiKey` and/or `apiKeys[i]`. */
export function findPlaintextKeys(entry: VaultEntry): string[] {
  const found: string[] = []
  if (entry.apiKey !== undefined && !isSecretRef(entry.apiKey)) found.push('apiKey')
  entry.apiKeys?.forEach((key, i) => {
    if (!isSecretRef(key)) found.push(`apiKeys[${i}]`)
  })
  return found
}

function plaintextMessage(name: string, fields: string[]): string {
  return `entry "${name}": plaintext ${fields.join(', ')} is not allowed (value not shown). Store the key in the embedded store and reference it as "embed:<name>" (or "vlt:<name>" / "keepass:<title>"), e.g. via \`mt vault add ${name} --api-key <key>\`.`
}

export async function loadVault(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
  options: LoadVaultOptions = {},
): Promise<Vault> {
  const vault = emptyVault()
  for (const path of vaultPaths(projectRoot, env)) {
    const file = await readVaultFile(path)
    if (file) Object.assign(vault.entries, file.entries)
  }
  if (options.resolveRefs !== false && options.resolveVlt !== false) {
    await resolveSecretRefs(vault, {
      ...env,
      MT_PROJECT_ROOT: env.MT_PROJECT_ROOT ?? resolve(projectRoot),
    })
  }
  return vault
}

/** Resolve secret refs in place. Errors name the entry and secret, never values. */
async function resolveSecretRefs(
  vault: Vault,
  env: Record<string, string | undefined>,
): Promise<void> {
  for (const [name, entry] of Object.entries(vault.entries)) {
    try {
      if (entry.apiKey !== undefined) entry.apiKey = await resolveSecretValue(entry.apiKey, env)
      if (entry.apiKeys !== undefined) {
        entry.apiKeys = await Promise.all(entry.apiKeys.map((key) => resolveSecretValue(key, env)))
      }
    } catch (err) {
      throw new Error(`Vault entry "${name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

async function resolveSecretValue(
  value: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  if (isEmbedRef(value)) return resolveEmbedValue(value, env)
  const colon = value.indexOf(':')
  if (colon > 0) {
    const resolver = secretResolvers.get(value.slice(0, colon + 1))
    if (resolver !== undefined) return resolver(value, env)
  }
  return value
}

async function readVaultFile(path: string): Promise<Vault | undefined> {
  const parsed = await readJsonOrThrow(path, 'vault', { ignoreMissing: true })
  if (parsed === undefined) return undefined
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
    const entry = validateEntry(name, value, path)
    const plain = findPlaintextKeys(entry)
    if (plain.length > 0) throw new Error(`Invalid vault ${path}: ${plaintextMessage(name, plain)}`)
    entries[name] = entry
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

/** Refs (`embed:x`) are not secrets and stay readable; anything else is masked. */
function maskKey(value: string): string {
  return isSecretRef(value) ? value : maskSecret(value)
}

/** Copy of the vault with apiKey / apiKeys / header values masked. */
export function maskVault(vault: Vault): Vault {
  const entries: Record<string, VaultEntry> = {}
  for (const [name, e] of Object.entries(vault.entries)) {
    const copy: VaultEntry = { ...e }
    if (e.apiKey !== undefined) copy.apiKey = maskKey(e.apiKey)
    if (e.apiKeys) copy.apiKeys = e.apiKeys.map(maskKey)
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

/** True for a known provider id. */
export function isVaultProvider(value: string): value is VaultProvider {
  return (VAULT_PROVIDERS as readonly string[]).includes(value)
}

/** Entry names are plain identifiers — non-empty and free of path separators. */
export function isValidEntryName(name: string): boolean {
  return name !== '' && !name.includes('/')
}

/** Add or replace an entry in a copy of the vault. Throws on an invalid name or provider. */
export function addEntry(vault: Vault, name: string, entry: VaultEntry): Vault {
  if (!isValidEntryName(name)) {
    throw new Error(`Invalid vault entry name "${name}": must be non-empty and contain no "/"`)
  }
  if (!isVaultProvider(entry.provider)) {
    throw new Error(
      `Invalid vault entry "${name}": "provider" must be one of ${VAULT_PROVIDERS.join(', ')}`,
    )
  }
  const plain = findPlaintextKeys(entry)
  if (plain.length > 0) throw new Error(`Invalid vault ${plaintextMessage(name, plain)}`)
  return { version: 1, entries: { ...vault.entries, [name]: entry } }
}

/** Remove an entry from a copy of the vault. Throws when the entry is missing. */
export function removeEntry(vault: Vault, name: string): Vault {
  if (!Object.hasOwn(vault.entries, name)) {
    throw new Error(`Unknown vault entry "${name}"`)
  }
  const entries = { ...vault.entries }
  delete entries[name]
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

/** Atomic write (temp-then-rename), file mode 0600; rejects plaintext keys, parent dir created if needed. */
export async function saveVault(path: string, vault: Vault): Promise<void> {
  for (const [name, entry] of Object.entries(vault.entries)) {
    const plain = findPlaintextKeys(entry)
    if (plain.length > 0)
      throw new Error(`Refusing to write ${path}: ${plaintextMessage(name, plain)}`)
  }
  await atomicWriteFile(path, `${JSON.stringify(vault, null, 2)}\n`, {
    mode: 0o600,
    createParent: true,
  })
}
