import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { argon2d, argon2id } from 'hash-wasm'
import kdbxweb from 'kdbxweb'

/**
 * Router-local KeePass backend. Deliberate duplicate of `packages/core/src/keepass.ts`
 * (the router is standalone and must not import `@mt/*`; keep both in sync).
 *
 * Vault `apiKey` / `apiKeys[]` values of the form `keepass:<title|uuid>` are
 * resolved in memory. Loading is async (kdbxweb), so the vault reader exposes an
 * async path and `vault-upstreams.ts` swaps the cached result when the load
 * completes; synchronous getters keep serving the previous good result.
 *
 * Pure JS/WASM: kdbxweb + hash-wasm Argon2. Errors name the path and entry only.
 */

export const KEEPASS_REF_PREFIX = 'keepass:'

type Env = Record<string, string | undefined>

export function defaultKeepassPath(env: Env = process.env): string {
  const explicit = env.MT_KEEPASS_PATH
  if (explicit) return resolve(explicit)
  return join(env.MT_HOME || join(env.HOME || homedir(), '.mt'), 'secrets.kdbx')
}

export function isKeepassRef(value: string): boolean {
  return value.startsWith(KEEPASS_REF_PREFIX)
}

export function keepassDisabled(env: Env = process.env): boolean {
  return env.MT_KEEPASS === 'false'
}

let argon2Ready = false

function ensureArgon2(): void {
  if (argon2Ready) return
  kdbxweb.CryptoEngine.setArgon2Impl(
    async (password, salt, memory, iterations, length, parallelism, type) => {
      const argon2 = type === kdbxweb.CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id
      const hash = await argon2({
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        memorySize: memory,
        iterations,
        parallelism,
        hashLength: length,
        outputType: 'binary',
      })
      const copy = new Uint8Array(hash.length)
      copy.set(hash)
      return copy.buffer
    },
  )
  argon2Ready = true
}

interface ResolvedCredentials {
  credentials: kdbxweb.Credentials
  fingerprint: string
}

function masterPassword(env: Env, explicit: string | undefined): string | undefined {
  if (explicit !== undefined) return explicit
  if (env.MT_KEEPASS_PASSWORD !== undefined) return env.MT_KEEPASS_PASSWORD
  const file = env.MT_KEEPASS_PASSWORD_FILE
  if (!file) return undefined
  try {
    return readFileSync(resolve(file), 'utf-8').replace(/\r?\n$/, '')
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown error'
    throw new Error(`Cannot read MT_KEEPASS_PASSWORD_FILE ${resolve(file)}: ${code}`)
  }
}

async function makeCredentials(env: Env): Promise<ResolvedCredentials> {
  const pw = masterPassword(env, undefined)
  let key: Uint8Array | undefined
  if (env.MT_KEEPASS_KEY_FILE) {
    try {
      key = new Uint8Array(readFileSync(resolve(env.MT_KEEPASS_KEY_FILE)))
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'unknown error'
      throw new Error(`Cannot read KeePass key file ${resolve(env.MT_KEEPASS_KEY_FILE)}: ${code}`)
    }
  }
  if (pw === undefined && key === undefined) {
    throw new Error(
      'KeePass master password required: set MT_KEEPASS_PASSWORD (or MT_KEEPASS_PASSWORD_FILE / MT_KEEPASS_KEY_FILE)',
    )
  }
  const credentials = new kdbxweb.Credentials(
    pw === undefined ? null : kdbxweb.ProtectedValue.fromString(pw),
    key,
  )
  await credentials.ready
  const fingerprint = createHash('sha256')
    .update(pw ?? '')
    .update('\0')
    .update(key ?? new Uint8Array())
    .digest('hex')
  return { credentials, fingerprint }
}

interface CacheEntry {
  signature: string
  db: Promise<kdbxweb.Kdbx>
}

const dbCache = new Map<string, CacheEntry>()

export function resetKeepassState(): void {
  dbCache.clear()
}

/** Cheap change detector: database mtime + size + credential fingerprint. */
export function keepassSignature(env: Env = process.env): string {
  if (keepassDisabled(env)) return 'disabled'
  const path = defaultKeepassPath(env)
  try {
    const info = statSync(path)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return 'missing'
  }
}

async function openKeepass(path: string, resolved: ResolvedCredentials): Promise<kdbxweb.Kdbx> {
  let signature: string
  try {
    signature = `${statSync(path).mtimeMs}:${statSync(path).size}:${resolved.fingerprint}`
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') {
      throw new Error(
        `KeePass database not found at ${path}. Set MT_KEEPASS_PATH or run \`mt vault keepass-init\`.`,
      )
    }
    throw new Error(`Cannot read KeePass database ${path}: ${code ?? 'unknown error'}`)
  }
  const key = resolve(path)
  const cached = dbCache.get(key)
  if (cached?.signature === signature) return cached.db
  const db = (async () => {
    ensureArgon2()
    const bytes = readFileSync(path)
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    try {
      return await kdbxweb.Kdbx.load(buffer as ArrayBuffer, resolved.credentials)
    } catch {
      throw new Error(
        `Cannot open KeePass database ${path}: wrong master password/key file, or an unsupported format`,
      )
    }
  })()
  dbCache.set(key, { signature, db })
  db.catch(() => {
    if (dbCache.get(key)?.db === db) dbCache.delete(key)
  })
  return db
}

function fieldText(entry: kdbxweb.KdbxEntry, name: string): string | undefined {
  const value = entry.fields.get(name)
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : value.getText()
  return text === '' ? undefined : text
}

function entryTitle(entry: kdbxweb.KdbxEntry): string {
  return fieldText(entry, 'Title') ?? ''
}

function entryGroup(entry: kdbxweb.KdbxEntry, root: kdbxweb.KdbxGroup): string | undefined {
  const names: string[] = []
  let group = entry.parentGroup
  while (group !== undefined && group !== root) {
    if (group.name) names.unshift(group.name)
    group = group.parentGroup
  }
  return names.length > 0 ? names.join('/') : undefined
}

function entryPath(entry: kdbxweb.KdbxEntry, root: kdbxweb.KdbxGroup): string {
  const group = entryGroup(entry, root)
  return group ? `${group}/${entryTitle(entry)}` : entryTitle(entry)
}

function normalizeUuid(value: string): string {
  return value.toLowerCase().replace(/[{}\s-]/g, '')
}

function matches(entry: kdbxweb.KdbxEntry, root: kdbxweb.KdbxGroup, identifier: string): boolean {
  const id = identifier.trim()
  const title = entryTitle(entry)
  if (normalizeUuid(entry.uuid.toString()) === normalizeUuid(id)) return true
  if (title === id || entryPath(entry, root) === id) return true
  const lower = id.toLowerCase()
  return title.toLowerCase() === lower || entryPath(entry, root).toLowerCase() === lower
}

async function getSecret(identifier: string, env: Env): Promise<string> {
  const id = identifier.trim()
  if (id === '') throw new Error('Invalid KeePass reference: missing entry title or UUID')
  const path = defaultKeepassPath(env)
  const db = await openKeepass(path, await makeCredentials(env))
  const root = db.getDefaultGroup()
  for (const entry of root.allEntries()) {
    if (!matches(entry, root, id)) continue
    const password = fieldText(entry, 'Password')
    if (password === undefined) {
      throw new Error(`KeePass entry "${id}" has an empty password field`)
    }
    return password
  }
  throw new Error(
    `KeePass entry "${id}" not found. Check the title/UUID or run \`mt vault keepass-list\`.`,
  )
}

/**
 * Resolve one vault key value: non-`keepass:` values pass through unchanged;
 * refs resolve against the configured database. Disabled with `MT_KEEPASS=false`.
 */
export async function resolveKeepassValue(value: string, env: Env = process.env): Promise<string> {
  if (!isKeepassRef(value) || keepassDisabled(env)) return value
  const id = value.slice(KEEPASS_REF_PREFIX.length).replace(/^\/\//, '')
  if (id.trim() === '') {
    throw new Error('Invalid KeePass secret reference "keepass:" (missing entry title or UUID)')
  }
  return getSecret(id, env)
}
