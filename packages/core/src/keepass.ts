import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { argon2d, argon2id } from 'hash-wasm'
import kdbxweb from 'kdbxweb'
import { tmpPathFor } from './atomic.js'

/**
 * KeePass (`.kdbx`) backend for vault secrets.
 *
 * A vault `apiKey` / `apiKeys[]` value of the form `keepass:<title|uuid>` is a
 * reference into a KeePass database, resolved in memory at load time. The vault
 * file on disk keeps the reference; resolved values are never written back.
 *
 * Pure TypeScript/JavaScript: `kdbxweb` parses the database and `hash-wasm`
 * (WASM, embedded as base64) supplies Argon2, which kdbxweb deliberately leaves
 * to the host. No external binaries or native addons.
 *
 * Configuration (environment):
 * - `MT_KEEPASS_PATH`          database path (default `$MT_HOME|~/.mt/secrets.kdbx`)
 * - `MT_KEEPASS_PASSWORD`      master password
 * - `MT_KEEPASS_PASSWORD_FILE` master password read from a file (trailing newline stripped)
 * - `MT_KEEPASS_KEY_FILE`      optional key file
 * - `MT_KEEPASS=false`         disable resolution entirely (refs pass through)
 *
 * Errors name the path and entry only — never a password or a secret value.
 */

export const KEEPASS_REF_PREFIX = 'keepass:'

/** Default database path: `$MT_KEEPASS_PATH`, else `$MT_HOME|~/.mt/secrets.kdbx`. */
export function defaultKeepassPath(env: Env = process.env): string {
  const explicit = env.MT_KEEPASS_PATH
  if (explicit) return resolve(explicit)
  return join(env.MT_HOME || join(env.HOME || homedir(), '.mt'), 'secrets.kdbx')
}

/** True when a vault value is a KeePass secret reference. */
export function isKeepassRef(value: string): boolean {
  return value.startsWith(KEEPASS_REF_PREFIX)
}

/** Resolution is disabled with `MT_KEEPASS=false`. */
export function keepassDisabled(env: Env = process.env): boolean {
  return env.MT_KEEPASS === 'false'
}

/** True when a master password or key file is configured. */
export function keepassCredentialsConfigured(env: Env = process.env): boolean {
  return Boolean(env.MT_KEEPASS_PASSWORD || env.MT_KEEPASS_PASSWORD_FILE || env.MT_KEEPASS_KEY_FILE)
}

export interface KeepassSecret {
  title: string
  username?: string
  password: string
  uuid: string
  group?: string
  url?: string
  notes?: string
}

/** Entry metadata without the secret value (safe for list/status output). */
export interface KeepassEntryInfo {
  title: string
  username?: string
  uuid: string
  group?: string
  url?: string
}

export interface CreateKeepassOptions {
  /** Database path; defaults to {@link defaultKeepassPath}. */
  path?: string
  /** Master password; defaults to the environment. */
  password?: string
  /** Key file path; defaults to `MT_KEEPASS_KEY_FILE`. */
  keyFile?: string
  /** Database display name (default `mt`). */
  name?: string
}

export interface AddKeepassSecretInput {
  title: string
  secret: string
  username?: string
  group?: string
  url?: string
  notes?: string
}

export interface AddKeepassSecretOptions {
  /** Database path; defaults to {@link defaultKeepassPath}. */
  path?: string
  /** Master password; defaults to the environment. */
  password?: string
  /** Key file path; defaults to `MT_KEEPASS_KEY_FILE`. */
  keyFile?: string
}

type Env = Record<string, string | undefined>

let argon2Ready = false

/** Register the pure-WASM Argon2 implementation with kdbxweb (idempotent). */
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

async function masterPassword(env: Env, explicit: string | undefined): Promise<string | undefined> {
  if (explicit !== undefined) return explicit
  if (env.MT_KEEPASS_PASSWORD !== undefined) return env.MT_KEEPASS_PASSWORD
  const file = env.MT_KEEPASS_PASSWORD_FILE
  if (!file) return undefined
  try {
    return (await readFile(resolve(file), 'utf-8')).replace(/\r?\n$/, '')
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown error'
    throw new Error(`Cannot read MT_KEEPASS_PASSWORD_FILE ${resolve(file)}: ${code}`)
  }
}

async function readKeyFile(path: string | undefined): Promise<Uint8Array | undefined> {
  if (!path) return undefined
  try {
    return new Uint8Array(await readFile(resolve(path)))
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown error'
    throw new Error(`Cannot read KeePass key file ${resolve(path)}: ${code}`)
  }
}

interface ResolvedCredentials {
  credentials: kdbxweb.Credentials
  /** Hash of the password + key file; part of the cache key so a credential change reloads. */
  fingerprint: string
}

async function makeCredentials(
  env: Env,
  password: string | undefined,
  keyFile: string | undefined,
): Promise<ResolvedCredentials> {
  const pw = await masterPassword(env, password)
  const key = await readKeyFile(keyFile ?? env.MT_KEEPASS_KEY_FILE)
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

/** Forget a cached database (all paths when omitted). */
export function resetKeepassCache(path?: string): void {
  if (path === undefined) dbCache.clear()
  else dbCache.delete(resolve(path))
}

async function fileSignature(path: string): Promise<string> {
  const info = await stat(path)
  return `${info.mtimeMs}:${info.size}`
}

/**
 * Open (and memoize per path + mtime) the configured database. Concurrent
 * callers share one load; a failed load is not cached.
 */
async function openKeepass(path: string, resolved: ResolvedCredentials): Promise<kdbxweb.Kdbx> {
  let signature: string
  try {
    signature = `${await fileSignature(path)}:${resolved.fingerprint}`
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
    const bytes = await readFile(path)
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    try {
      return await kdbxweb.Kdbx.load(buffer as ArrayBuffer, resolved.credentials)
    } catch {
      // kdbxweb messages contain no secrets, but keep the contract simple and stable.
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
  if (title === id) return true
  if (entryPath(entry, root) === id) return true
  const lower = id.toLowerCase()
  return title.toLowerCase() === lower || entryPath(entry, root).toLowerCase() === lower
}

function findEntry(
  db: kdbxweb.Kdbx,
  identifier: string,
): { entry: kdbxweb.KdbxEntry; root: kdbxweb.KdbxGroup } {
  const root = db.getDefaultGroup()
  for (const entry of root.allEntries()) {
    if (matches(entry, root, identifier)) return { entry, root }
  }
  throw new Error(
    `KeePass entry "${identifier}" not found. Check the title/UUID or run \`mt vault keepass-list\`.`,
  )
}

/** Read one secret by entry title, group path (`group/title`) or UUID. */
export async function getKeepassSecret(
  identifier: string,
  env: Env = process.env,
): Promise<KeepassSecret> {
  const id = identifier.trim()
  if (id === '') throw new Error('Invalid KeePass reference: missing entry title or UUID')
  const path = defaultKeepassPath(env)
  const credentials = await makeCredentials(env, undefined, undefined)
  const db = await openKeepass(path, credentials)
  const { entry, root } = findEntry(db, id)
  const password = fieldText(entry, 'Password')
  if (password === undefined) {
    throw new Error(`KeePass entry "${id}" has an empty password field`)
  }
  const group = entryGroup(entry, root)
  return {
    title: entryTitle(entry),
    username: fieldText(entry, 'UserName'),
    password,
    uuid: entry.uuid.toString(),
    group,
    url: fieldText(entry, 'URL'),
    notes: fieldText(entry, 'Notes'),
  }
}

/** List entry metadata (titles, users, UUIDs) — never passwords. */
export async function listKeepassEntries(env: Env = process.env): Promise<KeepassEntryInfo[]> {
  const path = defaultKeepassPath(env)
  const credentials = await makeCredentials(env, undefined, undefined)
  const db = await openKeepass(path, credentials)
  const root = db.getDefaultGroup()
  const out: KeepassEntryInfo[] = []
  for (const entry of root.allEntries()) {
    out.push({
      title: entryTitle(entry),
      username: fieldText(entry, 'UserName'),
      uuid: entry.uuid.toString(),
      group: entryGroup(entry, root),
      url: fieldText(entry, 'URL'),
    })
  }
  return out.sort((a, b) => entryPathOf(a).localeCompare(entryPathOf(b)))
}

function entryPathOf(info: KeepassEntryInfo): string {
  return info.group ? `${info.group}/${info.title}` : info.title
}

/**
 * Resolve one vault key value: non-`keepass:` values pass through unchanged;
 * refs are resolved against the configured database. Disabled with `MT_KEEPASS=false`.
 */
export async function resolveKeepassValue(value: string, env: Env = process.env): Promise<string> {
  if (!isKeepassRef(value) || keepassDisabled(env)) return value
  const id = value.slice(KEEPASS_REF_PREFIX.length).replace(/^\/\//, '')
  if (id.trim() === '') {
    throw new Error('Invalid KeePass secret reference "keepass:" (missing entry title or UUID)')
  }
  const secret = await getKeepassSecret(id, env)
  return secret.password
}

async function writeDatabase(path: string, data: ArrayBuffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = tmpPathFor(path)
  try {
    await writeFile(tmp, Buffer.from(data), { mode: 0o600 })
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/** Create an empty `.kdbx` database (mode 0600, atomic). Returns the path. */
export async function createKeepassDatabase(
  options: CreateKeepassOptions = {},
  env: Env = process.env,
): Promise<string> {
  const path = resolve(options.path ?? defaultKeepassPath(env))
  ensureArgon2()
  const resolved = await makeCredentials(env, options.password, options.keyFile)
  const db = kdbxweb.Kdbx.create(resolved.credentials, options.name ?? 'mt')
  await writeDatabase(path, await db.save())
  resetKeepassCache(path)
  return path
}

function ensureGroup(db: kdbxweb.Kdbx, groupPath: string | undefined): kdbxweb.KdbxGroup {
  let group = db.getDefaultGroup()
  for (const name of (groupPath ?? '').split('/').filter(Boolean)) {
    group = group.groups.find((candidate) => candidate.name === name) ?? db.createGroup(group, name)
  }
  return group
}

/**
 * Add or update an entry (matched by `group/title` when a group is given, else
 * by title). Creates parent groups as needed. Returns the entry UUID.
 */
export async function addKeepassSecret(
  input: AddKeepassSecretInput,
  options: AddKeepassSecretOptions = {},
  env: Env = process.env,
): Promise<{ path: string; uuid: string }> {
  const title = input.title.trim()
  if (title === '') throw new Error('KeePass entry title must be non-empty')
  const path = resolve(options.path ?? defaultKeepassPath(env))
  const credentials = await makeCredentials(env, options.password, options.keyFile)
  const db = await openKeepass(path, credentials)
  const root = db.getDefaultGroup()
  const group = input.group?.trim()
  const wanted = group ? `${group}/${title}` : title

  let entry: kdbxweb.KdbxEntry | undefined
  for (const candidate of root.allEntries()) {
    const match = group ? entryPath(candidate, root) === wanted : entryTitle(candidate) === title
    if (match) {
      entry = candidate
      break
    }
  }
  entry ??= db.createEntry(ensureGroup(db, group))
  entry.fields.set('Title', title)
  if (input.username !== undefined) entry.fields.set('UserName', input.username)
  entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(input.secret))
  if (input.url !== undefined) entry.fields.set('URL', input.url)
  if (input.notes !== undefined) entry.fields.set('Notes', input.notes)

  await writeDatabase(path, await db.save())
  resetKeepassCache(path)
  return { path, uuid: entry.uuid.toString() }
}
