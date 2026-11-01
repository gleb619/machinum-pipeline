import { createDecipheriv, createHash, scryptSync } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Router-local embedded encrypted store backend. Deliberate sync duplicate of
 * `packages/core/src/embed.ts` (the router is standalone and must not import `@mt/*`;
 * keep both in sync). Everything is synchronous: `readFileSync`/`statSync` plus
 * `scryptSync`/`createDecipheriv` from `node:crypto`.
 *
 * Vault `apiKey` / `apiKeys[]` values of the form `embed:<name>` are resolved in
 * memory against the encrypted JSON store. Errors name the path and entry only.
 */

export const EMBED_REF_PREFIX = 'embed:'

/** Built-in fallback password; keep in sync with `DEFAULT_EMBED_PASSWORD` in `@mt/core`. */
export const DEFAULT_EMBED_PASSWORD = 'mt-embed-default-password-NOT-SECRET'

export const DEFAULT_EMBED_WARNING =
  'mt: embedded secret store uses the built-in default password: secrets are only obfuscated, not protected. Set MT_EMBED_NEW_PASSWORD (or MT_EMBED_NEW_PASSWORD_FILE) to a private value and run `mt vault embed-rekey` to re-encrypt the store with it, then export it as MT_EMBED_PASSWORD (or MT_EMBED_PASSWORD_FILE).'

let defaultWarned = false

function warnDefaultPassword(): void {
  if (defaultWarned) return
  defaultWarned = true
  console.warn(DEFAULT_EMBED_WARNING)
}

const KEYRING_AAD = Buffer.from('mt-embed-v2-keyring', 'ascii')
const SECRET_AAD_PREFIX = 'mt-embed-v2-secret'
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

export function isEmbedRef(value: string): boolean {
  return value.startsWith(EMBED_REF_PREFIX)
}

export function embedDisabled(env: Env = process.env): boolean {
  return env.MT_EMBED === 'false'
}

function masterPassword(env: Env): string | undefined {
  if (env.MT_EMBED_PASSWORD !== undefined) return env.MT_EMBED_PASSWORD
  const file = env.MT_EMBED_PASSWORD_FILE
  if (!file) return undefined
  try {
    return readFileSync(resolve(file), 'utf-8').replace(/\r?\n$/, '')
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown error'
    throw new Error(`Cannot read MT_EMBED_PASSWORD_FILE ${resolve(file)}: ${code}`)
  }
}

function requirePassword(env: Env): string {
  const password = masterPassword(env)
  if (password === undefined) {
    warnDefaultPassword()
    return DEFAULT_EMBED_PASSWORD
  }
  if (password === '') {
    throw new Error(
      'Embedded store master password must be non-empty: fix MT_EMBED_PASSWORD (or MT_EMBED_PASSWORD_FILE), or unset both to use the built-in default',
    )
  }
  return password
}

interface StoredSecret {
  kid: string
  iv: string
  tag: string
  ciphertext: string
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
  secrets: Record<string, StoredSecret>
}

/** Unlocked store: encryption keys (kid -> 32-byte key) plus the sealed secrets. */
interface EmbedStore {
  keys: Record<string, Buffer>
  secrets: Record<string, StoredSecret>
}

function openFailure(path: string): Error {
  return new Error(
    `Cannot open embedded store ${path}: wrong master password, or a corrupted/tampered file`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function gcmOpen(key: Buffer, part: StoredSecret | EmbedEnvelope, aad: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(part.iv, 'base64'))
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(part.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(part.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf-8')
}

function decryptStore(envelope: EmbedEnvelope, password: string, path: string): EmbedStore {
  if (!isRecord(envelope.secrets)) throw openFailure(path)
  for (const stored of Object.values(envelope.secrets)) {
    if (
      !isRecord(stored) ||
      typeof stored.kid !== 'string' ||
      typeof stored.iv !== 'string' ||
      typeof stored.tag !== 'string' ||
      typeof stored.ciphertext !== 'string'
    ) {
      throw openFailure(path)
    }
  }
  try {
    const key = scryptSync(password, Buffer.from(envelope.salt, 'base64'), 32, {
      N: EMBED_KDF_N,
      r: EMBED_KDF_R,
      p: EMBED_KDF_P,
      maxmem: EMBED_MAXMEM,
    })
    const data: unknown = JSON.parse(gcmOpen(key, envelope, KEYRING_AAD))
    if (!isRecord(data) || !isRecord(data.keys)) throw openFailure(path)
    const keys: Record<string, Buffer> = {}
    for (const [kid, record] of Object.entries(data.keys)) {
      if (!isRecord(record) || typeof record.key !== 'string') throw openFailure(path)
      keys[kid] = Buffer.from(record.key, 'base64')
    }
    return { keys, secrets: envelope.secrets }
  } catch {
    throw openFailure(path)
  }
}

interface CacheEntry {
  signature: string
  store: EmbedStore
}

const storeCache = new Map<string, CacheEntry>()

export function resetEmbedState(): void {
  storeCache.clear()
  defaultWarned = false
}

/** Cheap change detector: store mtime + size. Never reads content. */
export function embedSignature(env: Env = process.env): string {
  if (embedDisabled(env)) return 'disabled'
  const path = defaultEmbedPath(env)
  try {
    const info = statSync(path)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return 'missing'
  }
}

function openStore(path: string, password: string): EmbedStore {
  const fingerprint = createHash('sha256').update(password).digest('hex')
  let signature: string
  try {
    const info = statSync(path)
    signature = `${info.mtimeMs}:${info.size}:${fingerprint}`
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') {
      throw new Error(
        `Embedded store not found at ${path}. Set MT_EMBED_PATH or add a secret with \`mt vault embed-add <name>\`.`,
      )
    }
    throw new Error(`Cannot read embedded store ${path}: ${code ?? 'unknown error'}`)
  }
  const key = resolve(path)
  const cached = storeCache.get(key)
  if (cached?.signature === signature) return cached.store
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
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
  const envelope = data as EmbedEnvelope
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    envelope.version !== 2 ||
    envelope.kdf !== 'scrypt'
  ) {
    throw new Error(`Invalid embedded store ${path}: expected version 2 with kdf "scrypt"`)
  }
  if (envelope.n !== EMBED_KDF_N || envelope.r !== EMBED_KDF_R || envelope.p !== EMBED_KDF_P) {
    throw new Error(
      `Invalid embedded store ${path}: unsupported scrypt parameters (expected n/r/p ${EMBED_KDF_N}/${EMBED_KDF_R}/${EMBED_KDF_P})`,
    )
  }
  const store = decryptStore(envelope, password, path)
  storeCache.set(key, { signature, store })
  return store
}

function getSecret(name: string, env: Env): string {
  const id = name.trim()
  if (id === '') throw new Error('Invalid embedded store reference: missing entry name')
  const path = defaultEmbedPath(env)
  const store = openStore(path, requirePassword(env))
  const stored = Object.hasOwn(store.secrets, id) ? store.secrets[id] : undefined
  if (stored === undefined) {
    throw new Error(
      `Embedded store entry "${id}" not found. Check the name or run \`mt vault embed-list\`.`,
    )
  }
  const key = Object.hasOwn(store.keys, stored.kid) ? store.keys[stored.kid] : undefined
  if (key === undefined) {
    throw new Error(
      `Embedded store secret "${id}" is sealed with encryption key "${stored.kid}", which is not in the keyring`,
    )
  }
  try {
    const data: unknown = JSON.parse(
      gcmOpen(key, stored, Buffer.from(`${SECRET_AAD_PREFIX}:${stored.kid}:${id}`, 'utf-8')),
    )
    if (!isRecord(data) || typeof data.secret !== 'string') throw new Error('shape')
    return data.secret
  } catch {
    throw new Error(`Embedded store secret "${id}" cannot be decrypted: corrupted or tampered`)
  }
}

/**
 * Resolve one vault key value: non-`embed:` values pass through unchanged; refs
 * resolve against the configured store. Disabled with `MT_EMBED=false`.
 */
export function resolveEmbedValue(value: string, env: Env = process.env): string {
  if (!isEmbedRef(value) || embedDisabled(env)) return value
  const id = value.slice(EMBED_REF_PREFIX.length).replace(/^\/\//, '')
  if (id.trim() === '') {
    throw new Error('Invalid embedded store secret reference "embed:" (missing entry name)')
  }
  return getSecret(id, env)
}
