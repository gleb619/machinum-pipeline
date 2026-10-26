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

const EMBED_AAD = Buffer.from('mt-embed-v1', 'ascii')

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
    throw new Error(
      'Embedded store master password required: set MT_EMBED_PASSWORD (or MT_EMBED_PASSWORD_FILE)',
    )
  }
  return password
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

interface EmbedStore {
  version: 1
  entries: Record<string, { secret: string; username?: string; url?: string; notes?: string }>
}

function openFailure(path: string): Error {
  return new Error(
    `Cannot open embedded store ${path}: wrong master password, or a corrupted/tampered file`,
  )
}

function decryptStore(envelope: EmbedEnvelope, password: string, path: string): EmbedStore {
  let plaintext: string
  try {
    const key = scryptSync(password, Buffer.from(envelope.salt, 'base64'), 32, {
      N: envelope.n,
      r: envelope.r,
      p: envelope.p,
      maxmem: 64 * 1024 * 1024,
    })
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAAD(EMBED_AAD)
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf-8')
    const data: unknown = JSON.parse(plaintext)
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw openFailure(path)
    const store = data as Record<string, unknown>
    if (store.version !== 1) throw openFailure(path)
    if (
      typeof store.entries !== 'object' ||
      store.entries === null ||
      Array.isArray(store.entries)
    ) {
      throw openFailure(path)
    }
    return store as unknown as EmbedStore
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Cannot open embedded store')) throw err
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
        `Embedded store not found at ${path}. Set MT_EMBED_PATH or run \`mt vault embed-init\`.`,
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
    envelope.version !== 1 ||
    envelope.kdf !== 'scrypt'
  ) {
    throw new Error(`Invalid embedded store ${path}: expected version 1 with kdf "scrypt"`)
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
  const entry = Object.hasOwn(store.entries, id) ? store.entries[id] : undefined
  if (entry === undefined) {
    throw new Error(
      `Embedded store entry "${id}" not found. Check the name or run \`mt vault embed-list\`.`,
    )
  }
  return entry.secret
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
