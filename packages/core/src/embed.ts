import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { tmpPathFor } from './atomic.js'

/**
 * Embedded encrypted store backend for vault secrets.
 *
 * A vault `apiKey` / `apiKeys[]` value of the form `embed:<name>` is a reference into a
 * small JSON file encrypted with AES-256-GCM, resolved in memory at load time. The vault
 * file on disk keeps the reference; resolved values are never written back.
 *
 * Pure Node stdlib: `node:crypto` (scrypt KDF + AES-256-GCM) — no dependencies, no native
 * addons, no external binaries.
 *
 * Configuration (environment):
 * - `MT_EMBED_PATH`          store path (default `$MT_HOME|~/.mt/secrets.embed.json`)
 * - `MT_EMBED_PASSWORD`      master password
 * - `MT_EMBED_PASSWORD_FILE` master password read from a file (trailing newline stripped)
 * - `MT_EMBED=false`         disable resolution entirely (refs pass through)
 *
 * Errors name the path and entry only — never a password or a secret value.
 */

export const EMBED_REF_PREFIX = 'embed:'

const EMBED_AAD = Buffer.from('mt-embed-v1', 'ascii')
const EMBED_KDF_N = 16384
const EMBED_KDF_R = 8
const EMBED_KDF_P = 1
const EMBED_MAXMEM = 64 * 1024 * 1024

type Env = Record<string, string | undefined>

/** Default store path: `$MT_EMBED_PATH`, else `$MT_HOME|~/.mt/secrets.embed.json`. */
export function defaultEmbedPath(env: Env = process.env): string {
  const explicit = env.MT_EMBED_PATH
  if (explicit) return resolve(explicit)
  return join(env.MT_HOME || join(env.HOME || homedir(), '.mt'), 'secrets.embed.json')
}

/** True when a vault value is an embedded-store secret reference. */
export function isEmbedRef(value: string): boolean {
  return value.startsWith(EMBED_REF_PREFIX)
}

/** Resolution is disabled with `MT_EMBED=false`. */
export function embedDisabled(env: Env = process.env): boolean {
  return env.MT_EMBED === 'false'
}

/** True when a master password is configured. */
export function embedCredentialsConfigured(env: Env = process.env): boolean {
  return Boolean(env.MT_EMBED_PASSWORD || env.MT_EMBED_PASSWORD_FILE)
}

export interface EmbedSecret {
  name: string
  secret: string
  username?: string
  url?: string
  notes?: string
}

/** Entry metadata without the secret value (safe for list/status output). */
export interface EmbedEntryInfo {
  name: string
  username?: string
  url?: string
  notes?: string
}

export interface CreateEmbedOptions {
  /** Store path; defaults to {@link defaultEmbedPath}. */
  path?: string
  /** Master password; defaults to the environment. */
  password?: string
}

export interface SetEmbedSecretInput {
  name: string
  secret: string
  username?: string
  url?: string
  notes?: string
}

export interface SetEmbedSecretOptions {
  /** Store path; defaults to {@link defaultEmbedPath}. */
  path?: string
  /** Master password; defaults to the environment. */
  password?: string
  /** default false: an existing name is an error (CLI --force sets true) */
  overwrite?: boolean
}

interface EmbedEntry {
  secret: string
  username?: string
  url?: string
  notes?: string
}

interface EmbedStore {
  version: 1
  entries: Record<string, EmbedEntry>
}

interface EmbedEnvelope {
  version: number
  kdf: string
  n: number
  r: number
  p: number
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

async function masterPassword(env: Env, explicit: string | undefined): Promise<string | undefined> {
  if (explicit !== undefined) return explicit
  if (env.MT_EMBED_PASSWORD !== undefined) return env.MT_EMBED_PASSWORD
  const file = env.MT_EMBED_PASSWORD_FILE
  if (!file) return undefined
  try {
    return (await readFile(resolve(file), 'utf-8')).replace(/\r?\n$/, '')
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown error'
    throw new Error(`Cannot read MT_EMBED_PASSWORD_FILE ${resolve(file)}: ${code}`)
  }
}

async function requirePassword(env: Env, explicit: string | undefined): Promise<string> {
  const password = await masterPassword(env, explicit)
  if (password === undefined || password === '') {
    throw new Error(
      'Embedded store master password required (non-empty): set MT_EMBED_PASSWORD (or MT_EMBED_PASSWORD_FILE)',
    )
  }
  return password
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, {
    N: EMBED_KDF_N,
    r: EMBED_KDF_R,
    p: EMBED_KDF_P,
    maxmem: EMBED_MAXMEM,
  })
}

function validateEnvelope(data: unknown, path: string): EmbedEnvelope {
  const fail = (msg: string): never => {
    throw new Error(`Invalid embedded store ${path}: ${msg}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    fail('expected a JSON object')
  }
  const env = data as Record<string, unknown>
  if (env.version !== 1) fail('"version" must be 1')
  if (env.kdf !== 'scrypt') fail('"kdf" must be "scrypt"')
  for (const key of ['n', 'r', 'p'] as const) {
    if (typeof env[key] !== 'number' || !Number.isInteger(env[key]) || (env[key] as number) <= 0) {
      fail(`"${key}" must be a positive integer`)
    }
  }
  if (env.n !== EMBED_KDF_N || env.r !== EMBED_KDF_R || env.p !== EMBED_KDF_P) {
    fail(`"n"/"r"/"p" must be ${EMBED_KDF_N}/${EMBED_KDF_R}/${EMBED_KDF_P} (fixed KDF parameters)`)
  }
  for (const key of ['salt', 'iv', 'tag', 'ciphertext'] as const) {
    if (typeof env[key] !== 'string') fail(`"${key}" must be a base64 string`)
  }
  return env as unknown as EmbedEnvelope
}

/** One sanitized error for every decrypt/parse failure — never echoes password or content. */
function openFailure(path: string): Error {
  return new Error(
    `Cannot open embedded store ${path}: wrong master password, or a corrupted/tampered file`,
  )
}

function decryptStore(envelope: EmbedEnvelope, password: string, path: string): EmbedStore {
  let plaintext: string
  try {
    const key = deriveKey(password, Buffer.from(envelope.salt, 'base64'))
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAAD(EMBED_AAD)
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf-8')
  } catch {
    throw openFailure(path)
  }
  let data: unknown
  try {
    data = JSON.parse(plaintext)
  } catch {
    throw openFailure(path)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw openFailure(path)
  }
  const store = data as Record<string, unknown>
  if (store.version !== 1) throw openFailure(path)
  if (typeof store.entries !== 'object' || store.entries === null || Array.isArray(store.entries)) {
    throw openFailure(path)
  }
  for (const entry of Object.values(store.entries)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw openFailure(path)
    }
    if (typeof (entry as Record<string, unknown>).secret !== 'string') {
      throw openFailure(path)
    }
  }
  return store as unknown as EmbedStore
}

function encryptStore(store: EmbedStore, password: string): EmbedEnvelope {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv)
  cipher.setAAD(EMBED_AAD)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(store), 'utf-8'), cipher.final()])
  return {
    version: 1,
    kdf: 'scrypt',
    n: EMBED_KDF_N,
    r: EMBED_KDF_R,
    p: EMBED_KDF_P,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

interface CacheEntry {
  signature: string
  store: Promise<EmbedStore>
}

const storeCache = new Map<string, CacheEntry>()

/** Forget a cached store (all paths when omitted). */
export function resetEmbedCache(path?: string): void {
  if (path === undefined) storeCache.clear()
  else storeCache.delete(resolve(path))
}

async function fileSignature(path: string): Promise<string> {
  const info = await stat(path)
  return `${info.mtimeMs}:${info.size}`
}

/**
 * Open (and memoize per path + mtime + size + password fingerprint) the configured
 * store. Concurrent callers share one load; a failed load is not cached.
 */
async function openStore(path: string, password: string): Promise<EmbedStore> {
  let signature: string
  try {
    const fingerprint = createHash('sha256').update(password).digest('hex')
    signature = `${await fileSignature(path)}:${fingerprint}`
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') {
      throw new Error(
        `Embedded store not found at ${path}. Set MT_EMBED_PATH or run \`mt vault embed-init\`.`,
      )
    }
    throw new Error(`Cannot read embedded store ${path}: ${code ?? 'unknown error'}`)
  }
  const key = resolve(path)
  const cached = storeCache.get(key)
  if (cached?.signature === signature) return cached.store
  const store = (async (): Promise<EmbedStore> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'unknown error'
      throw new Error(`Cannot read embedded store ${path}: ${code}`)
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error(`Invalid embedded store ${path}: malformed JSON`)
    }
    return decryptStore(validateEnvelope(data, path), password, path)
  })()
  storeCache.set(key, { signature, store })
  store.catch(() => {
    if (storeCache.get(key)?.store === store) storeCache.delete(key)
  })
  return store
}

async function writeStore(path: string, store: EmbedStore, password: string): Promise<void> {
  const envelope = encryptStore(store, password)
  await mkdir(dirname(path), { recursive: true })
  const tmp = tmpPathFor(path)
  try {
    await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
  resetEmbedCache(path)
}

/** Create an empty store (mode 0600, atomic). Refuses an existing path. Returns the path. */
export async function createEmbedStore(
  options: CreateEmbedOptions = {},
  env: Env = process.env,
): Promise<string> {
  const path = resolve(options.path ?? defaultEmbedPath(env))
  try {
    await stat(path)
    throw new Error(`Embedded store already exists: ${path} (remove it first or pick --path)`)
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }
  const password = await requirePassword(env, options.password)
  await writeStore(path, { version: 1, entries: {} }, password)
  return path
}

/**
 * Add a secret to an existing store (requires `mt vault embed-init` first). An existing
 * name is an error unless `overwrite` is set.
 */
export async function setEmbedSecret(
  input: SetEmbedSecretInput,
  options: SetEmbedSecretOptions = {},
  env: Env = process.env,
): Promise<{ path: string }> {
  const name = input.name.trim()
  if (name === '') throw new Error('Embedded store entry name must be non-empty')
  const path = resolve(options.path ?? defaultEmbedPath(env))
  const password = await requirePassword(env, options.password)
  const store = await openStore(path, password)
  const exists = Object.hasOwn(store.entries, name)
  if (exists && options.overwrite !== true) {
    throw new Error(
      `Embedded store entry "${name}" already exists in ${path} (use --force to overwrite)`,
    )
  }
  const entry: EmbedEntry = { secret: input.secret }
  if (input.username !== undefined) entry.username = input.username
  if (input.url !== undefined) entry.url = input.url
  if (input.notes !== undefined) entry.notes = input.notes
  // Clone before mutating: the cached store must not gain an unsaved entry if the write fails.
  const next: EmbedStore = { version: 1, entries: { ...store.entries, [name]: entry } }
  await writeStore(path, next, password)
  return { path }
}

/** Read one secret by entry name. */
export async function getEmbedSecret(name: string, env: Env = process.env): Promise<EmbedSecret> {
  const id = name
    .trim()
    .replace(/^embed:\/\//, '')
    .replace(/^embed:/, '')
  if (id === '') throw new Error('Invalid embedded store reference: missing entry name')
  const path = defaultEmbedPath(env)
  const password = await requirePassword(env, undefined)
  const store = await openStore(path, password)
  const entry = Object.hasOwn(store.entries, id) ? store.entries[id] : undefined
  if (entry === undefined) {
    throw new Error(
      `Embedded store entry "${id}" not found. Check the name or run \`mt vault embed-list\`.`,
    )
  }
  const secret: EmbedSecret = { name: id, secret: entry.secret }
  if (entry.username !== undefined) secret.username = entry.username
  if (entry.url !== undefined) secret.url = entry.url
  if (entry.notes !== undefined) secret.notes = entry.notes
  return secret
}

/** List entry metadata (names, users) — never secrets. Sorted by name. */
export async function listEmbedEntries(env: Env = process.env): Promise<EmbedEntryInfo[]> {
  const path = defaultEmbedPath(env)
  const password = await requirePassword(env, undefined)
  const store = await openStore(path, password)
  return Object.entries(store.entries)
    .map(([name, entry]) => {
      const info: EmbedEntryInfo = { name }
      if (entry.username !== undefined) info.username = entry.username
      if (entry.url !== undefined) info.url = entry.url
      if (entry.notes !== undefined) info.notes = entry.notes
      return info
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve one vault key value: non-`embed:` values pass through unchanged; refs are
 * resolved against the configured store. Disabled with `MT_EMBED=false`.
 */
export async function resolveEmbedValue(value: string, env: Env = process.env): Promise<string> {
  if (!isEmbedRef(value) || embedDisabled(env)) return value
  const id = value.slice(EMBED_REF_PREFIX.length).replace(/^\/\//, '')
  if (id.trim() === '') {
    throw new Error('Invalid embedded store secret reference "embed:" (missing entry name)')
  }
  const secret = await getEmbedSecret(id, env)
  return secret.secret
}
