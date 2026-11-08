import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { atomicWriteFile } from './atomic.js'
import { readJsonOrThrow } from './json-file.js'
import { createConsoleLogger } from './logging.js'
import type {
  AddEmbedKeyOptions,
  CreateEmbedOptions,
  EmbedEntryInfo,
  EmbedKeyInfo,
  EmbedKeyringOptions,
  EmbedSecret,
  GenerateEmbedKeyOptions,
  MasterKeyPaths,
  MasterKeyResolution,
  RekeyEmbedOptions,
  RotateEmbedKeysOptions,
  RotateEmbedSecretOptions,
  SetEmbedSecretInput,
  SetEmbedSecretOptions,
  WriteMasterKeyOptions,
} from './types/secrets.js'
export type {
  EmbedSecret,
  EmbedEntryInfo,
  EmbedKeyInfo,
  CreateEmbedOptions,
  SetEmbedSecretInput,
  SetEmbedSecretOptions,
  MasterKeyPaths,
  MasterKeyResolution,
  WriteMasterKeyOptions,
  RotateEmbedSecretOptions,
  RekeyEmbedOptions,
  EmbedKeyringOptions,
  GenerateEmbedKeyOptions,
  AddEmbedKeyOptions,
  RotateEmbedKeysOptions,
} from './types/secrets.js'

const logger = createConsoleLogger()

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
 * - `MT_PROJECT_ROOT`        project root for the `.mt/master.key` lookup (default: cwd)
 *
 * Master-password resolution order (first hit wins): `MT_EMBED_PASSWORD` >
 * `MT_EMBED_PASSWORD_FILE` > project `<root>/.mt/master.key` > user
 * `$MT_HOME|~/.mt/master.key` > built-in {@link DEFAULT_EMBED_PASSWORD} (one-time warning —
 * the store is then only obfuscated, not protected). `mt init` and
 * `mt vault master-key generate` create a random master key file.
 * - `MT_EMBED=false`         disable resolution entirely (refs pass through)
 *
 * Store format v2 (keyring, envelope encryption): the master password (scrypt) unlocks a
 * keyring of named 256-bit ENCRYPTION keys (`kid`); each secret is sealed with AES-256-GCM
 * under one of those keys and records its `kid`, so different secrets can use different
 * keys and a key can be rotated or retired. Terminology: "master password" unlocks the store,
 * "encryption key" (kid) encrypts secrets, "secret" is the stored value (API key, token).
 *
 * Errors name the path and entry only — never a password, encryption key or secret value.
 */

export const EMBED_REF_PREFIX = 'embed:'

/**
 * Built-in fallback master password, used when neither `MT_EMBED_PASSWORD` nor
 * `MT_EMBED_PASSWORD_FILE` is set so `embed:` works out of the box. It is public, so a store
 * encrypted with it is only obfuscated, not protected.
 */
export const DEFAULT_EMBED_PASSWORD = 'mt-embed-default-password-NOT-SECRET'

export const DEFAULT_EMBED_WARNING =
  'mt: embedded secret store uses the built-in default password: secrets are only obfuscated, not protected. Run `mt vault master-key generate --rekey` to create a private master key and re-encrypt the store with it (or set MT_EMBED_PASSWORD / MT_EMBED_PASSWORD_FILE; `mt vault embed-rekey` changes the password explicitly).'

let defaultWarned = false

/** Forget that the default-password warning was shown (tests). */
export function resetEmbedDefaultWarning(): void {
  defaultWarned = false
}

function warnDefaultPassword(): void {
  if (defaultWarned) return
  defaultWarned = true
  logger.warn(DEFAULT_EMBED_WARNING)
}

const warnedKeyFiles = new Set<string>()

/** Forget which master-key files already produced a permissions warning (tests). */
export function resetMasterKeyWarnings(): void {
  warnedKeyFiles.clear()
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

/** True when a vault value is an embedded-store secret reference. */
export function isEmbedRef(value: string): boolean {
  return value.startsWith(EMBED_REF_PREFIX)
}

/** Resolution is disabled with `MT_EMBED=false`. */
export function embedDisabled(env: Env = process.env): boolean {
  return env.MT_EMBED === 'false'
}

/** True when a master password is explicitly configured via env (not a key file or the built-in default). */
export function embedCredentialsConfigured(env: Env = process.env): boolean {
  return Boolean(env.MT_EMBED_PASSWORD || env.MT_EMBED_PASSWORD_FILE)
}

interface KeyRecord {
  /** base64 256-bit encryption key */
  key: string
  createdAt: string
  status: 'active' | 'retired'
  note?: string
}

interface Keyring {
  keys: Record<string, KeyRecord>
}

interface StoredSecret {
  kid: string
  iv: string
  tag: string
  ciphertext: string
  createdAt: string
  rotatedAt?: string
}

interface SecretPayload {
  secret: string
  username?: string
  url?: string
  notes?: string
}

interface StoreData {
  keyring: Keyring
  secrets: Record<string, StoredSecret>
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

/** Where the active master password comes from. */
export type MasterKeySource = 'env' | 'env-file' | 'project' | 'user' | 'default'

/** Candidate master-key file locations: project `<root>/.mt/master.key`, user `$MT_HOME|~/.mt/master.key`. */
export function masterKeyPaths(env: Env = process.env): MasterKeyPaths {
  const root = resolve(env.MT_PROJECT_ROOT || process.cwd())
  return {
    project: join(root, '.mt', 'master.key'),
    user: join(env.MT_HOME || join(env.HOME || homedir(), '.mt'), 'master.key'),
  }
}

/** Permission bits beyond the owner (group/other) make a key file readable by others. */
export async function masterKeyFileTooOpen(path: string): Promise<boolean> {
  if (process.platform === 'win32') return false
  try {
    return ((await stat(path)).mode & 0o077) !== 0
  } catch {
    return false
  }
}

async function readKeyFile(path: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw new Error(`Cannot read master key file ${path}: ${code ?? 'unknown error'}`)
  }
  if (await masterKeyFileTooOpen(path)) {
    if (!warnedKeyFiles.has(path)) {
      warnedKeyFiles.add(path)
      logger.warn(
        `mt: master key file ${path} is readable by other users: run \`chmod 600 ${path}\``,
      )
    }
  }
  const key = raw.trim()
  if (key === '') throw new Error(`Master key file ${path} is empty: regenerate it`)
  return key
}

/**
 * Resolve the master password without the default fallback; `undefined` when nothing is
 * configured. Order: explicit > `MT_EMBED_PASSWORD` > `MT_EMBED_PASSWORD_FILE` > project key
 * file > user key file.
 */
export async function resolveMasterKey(
  env: Env = process.env,
  explicit?: string,
): Promise<MasterKeyResolution | undefined> {
  if (explicit !== undefined) return { source: 'env', password: explicit }
  if (env.MT_EMBED_PASSWORD !== undefined) {
    return { source: 'env', password: env.MT_EMBED_PASSWORD }
  }
  const file = env.MT_EMBED_PASSWORD_FILE
  if (file) {
    try {
      const password = (await readFile(resolve(file), 'utf-8')).replace(/\r?\n$/, '')
      return { source: 'env-file', path: resolve(file), password }
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'unknown error'
      throw new Error(`Cannot read MT_EMBED_PASSWORD_FILE ${resolve(file)}: ${code}`)
    }
  }
  const paths = masterKeyPaths(env)
  const project = await readKeyFile(paths.project)
  if (project !== undefined) return { source: 'project', path: paths.project, password: project }
  const user = await readKeyFile(paths.user)
  if (user !== undefined) return { source: 'user', path: paths.user, password: user }
  return undefined
}

async function requirePassword(env: Env, explicit: string | undefined): Promise<string> {
  const resolved = await resolveMasterKey(env, explicit)
  if (resolved === undefined) {
    warnDefaultPassword()
    return DEFAULT_EMBED_PASSWORD
  }
  if (resolved.password === '') {
    throw new Error(
      'Embedded store master password must be non-empty: fix MT_EMBED_PASSWORD (or MT_EMBED_PASSWORD_FILE), or unset both to use a master key file or the built-in default',
    )
  }
  return resolved.password
}

/** A fresh random 256-bit master key, base64url (43 chars, no padding). */
export function generateMasterKey(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Write a master key file atomically (temp + rename, mode 0600, parent dir 0700 when
 * created). Refuses to overwrite an existing file unless `force` — silently replacing a key
 * would make every secret sealed under it unrecoverable. Returns the path only; the key is
 * never returned or printed.
 */
export async function writeMasterKeyFile(
  path: string,
  options: WriteMasterKeyOptions = {},
): Promise<{ path: string }> {
  const target = resolve(path)
  if (!options.force) {
    const exists = await stat(target).then(
      () => true,
      () => false,
    )
    if (exists) {
      throw new Error(
        `Master key file ${target} already exists: refusing to overwrite (a replaced key makes secrets sealed under it unrecoverable). Use --force only after re-keying the store.`,
      )
    }
  }
  await atomicWriteFile(target, `${options.key ?? generateMasterKey()}\n`, {
    mode: 0o600,
    createParent: true,
    parentMode: 0o700,
  })
  return { path: target }
}

/** The active source for the embed master password (`default` when nothing is configured). Never exposes the key. */
export async function masterKeyStatus(
  env: Env = process.env,
): Promise<{ source: MasterKeySource; path?: string; tooOpen: boolean }> {
  const resolved = await resolveMasterKey(env)
  if (resolved === undefined) return { source: 'default', tooOpen: false }
  return {
    source: resolved.source,
    ...(resolved.path !== undefined && { path: resolved.path }),
    tooOpen: resolved.path !== undefined && (await masterKeyFileTooOpen(resolved.path)),
  }
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, {
    N: EMBED_KDF_N,
    r: EMBED_KDF_R,
    p: EMBED_KDF_P,
    maxmem: EMBED_MAXMEM,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateEnvelope(data: unknown, path: string): EmbedEnvelope {
  const fail = (msg: string): never => {
    throw new Error(`Invalid embedded store ${path}: ${msg}`)
  }
  if (!isRecord(data)) fail('expected a JSON object')
  const env = data as Record<string, unknown>
  if (env.version !== 2) fail('"version" must be 2')
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
  if (!isRecord(env.secrets)) fail('"secrets" must be an object')
  for (const stored of Object.values(env.secrets as Record<string, unknown>)) {
    if (!isRecord(stored)) fail('every secret must be an object')
    for (const key of ['kid', 'iv', 'tag', 'ciphertext', 'createdAt'] as const) {
      if (typeof (stored as Record<string, unknown>)[key] !== 'string') {
        fail(`every secret needs a string "${key}"`)
      }
    }
  }
  return env as unknown as EmbedEnvelope
}

/** One sanitized error for every decrypt/parse failure — never echoes password or content. */
function openFailure(path: string): Error {
  return new Error(
    `Cannot open embedded store ${path}: wrong master password, or a corrupted/tampered file`,
  )
}

function gcmOpen(key: Buffer, iv: string, tag: string, ciphertext: string, aad: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf-8')
}

function gcmSeal(key: Buffer, plaintext: string, aad: Buffer) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

function secretAad(name: string, kid: string): Buffer {
  return Buffer.from(`${SECRET_AAD_PREFIX}:${kid}:${name}`, 'utf-8')
}

function unlockKeyring(envelope: EmbedEnvelope, password: string, path: string): Keyring {
  let data: unknown
  try {
    const key = deriveKey(password, Buffer.from(envelope.salt, 'base64'))
    data = JSON.parse(gcmOpen(key, envelope.iv, envelope.tag, envelope.ciphertext, KEYRING_AAD))
  } catch {
    throw openFailure(path)
  }
  if (!isRecord(data) || !isRecord(data.keys)) throw openFailure(path)
  for (const record of Object.values(data.keys)) {
    if (
      !isRecord(record) ||
      typeof record.key !== 'string' ||
      typeof record.createdAt !== 'string' ||
      (record.status !== 'active' && record.status !== 'retired')
    ) {
      throw openFailure(path)
    }
  }
  return data as unknown as Keyring
}

function wrapKeyring(keyring: Keyring, password: string) {
  const salt = randomBytes(16)
  return {
    salt: salt.toString('base64'),
    ...gcmSeal(deriveKey(password, salt), JSON.stringify(keyring), KEYRING_AAD),
  }
}

function buildEnvelope(store: StoreData, password: string): EmbedEnvelope {
  return {
    version: 2,
    kdf: 'scrypt',
    n: EMBED_KDF_N,
    r: EMBED_KDF_R,
    p: EMBED_KDF_P,
    ...wrapKeyring(store.keyring, password),
    secrets: store.secrets,
  }
}

function keyMaterial(keyring: Keyring, kid: string, name: string): Buffer {
  const record = Object.hasOwn(keyring.keys, kid) ? keyring.keys[kid] : undefined
  if (record === undefined) {
    throw new Error(
      `Embedded store secret "${name}" is sealed with encryption key "${kid}", which is not in the keyring`,
    )
  }
  return Buffer.from(record.key, 'base64')
}

function openSecret(keyring: Keyring, name: string, stored: StoredSecret): SecretPayload {
  const key = keyMaterial(keyring, stored.kid, name)
  try {
    const data: unknown = JSON.parse(
      gcmOpen(key, stored.iv, stored.tag, stored.ciphertext, secretAad(name, stored.kid)),
    )
    if (!isRecord(data) || typeof data.secret !== 'string') throw new Error('shape')
    return data as unknown as SecretPayload
  } catch {
    throw new Error(`Embedded store secret "${name}" cannot be decrypted: corrupted or tampered`)
  }
}

function sealSecret(
  keyring: Keyring,
  kid: string,
  name: string,
  payload: SecretPayload,
  createdAt: string,
  rotatedAt?: string,
): StoredSecret {
  const sealed = gcmSeal(
    keyMaterial(keyring, kid, name),
    JSON.stringify(payload),
    secretAad(name, kid),
  )
  const stored: StoredSecret = { kid, ...sealed, createdAt }
  if (rotatedAt !== undefined) stored.rotatedAt = rotatedAt
  return stored
}

const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function checkKid(kid: string): string {
  const id = kid.trim()
  if (!KID_PATTERN.test(id)) {
    throw new Error(
      `Invalid encryption key id "${id}": use 1-64 letters, digits, "." "_" or "-", starting with a letter or digit`,
    )
  }
  return id
}

function activeKid(keyring: Keyring): string {
  for (const [kid, record] of Object.entries(keyring.keys)) {
    if (record.status === 'active') return kid
  }
  throw new Error(
    'Embedded store has no active encryption key (run `mt vault embed-keyring use <kid>`)',
  )
}

function nextKid(keyring: Keyring): string {
  for (let i = 1; ; i++) {
    if (!Object.hasOwn(keyring.keys, `k${i}`)) return `k${i}`
  }
}

function newKeyRecord(material: Buffer, status: 'active' | 'retired', note?: string): KeyRecord {
  const record: KeyRecord = {
    key: material.toString('base64'),
    createdAt: new Date().toISOString(),
    status,
  }
  if (note !== undefined && note !== '') record.note = note
  return record
}

/** Insert a key into a (cloned) keyring; an activated key demotes the previous active one. */
function withKey(
  keyring: Keyring,
  kid: string,
  material: Buffer,
  activate: boolean,
  note: string | undefined,
  path: string,
): Keyring {
  if (Object.hasOwn(keyring.keys, kid)) {
    throw new Error(`Encryption key "${kid}" already exists in ${path}`)
  }
  const makeActive = activate || Object.keys(keyring.keys).length === 0
  const keys: Record<string, KeyRecord> = {}
  for (const [id, record] of Object.entries(keyring.keys)) {
    keys[id] = makeActive ? { ...record, status: 'retired' } : record
  }
  keys[kid] = newKeyRecord(material, makeActive ? 'active' : 'retired', note)
  return { keys }
}

interface CacheEntry {
  signature: string
  store: Promise<StoreData>
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
 * store. Concurrent callers share one load; a failed load is not cached. Never mutate the
 * returned value: writers clone first.
 */
async function openStore(path: string, password: string): Promise<StoreData> {
  let signature: string
  try {
    const fingerprint = createHash('sha256').update(password).digest('hex')
    signature = `${await fileSignature(path)}:${fingerprint}`
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
  const store = (async (): Promise<StoreData> => {
    const data = await readJsonOrThrow(path, 'embedded store')
    const envelope = validateEnvelope(data, path)
    return { keyring: unlockKeyring(envelope, password, path), secrets: envelope.secrets }
  })()
  storeCache.set(key, { signature, store })
  store.catch(() => {
    if (storeCache.get(key)?.store === store) storeCache.delete(key)
  })
  return store
}

/** Like {@link openStore}, but a missing file yields a fresh store with one generated key. */
async function openOrNewStore(path: string, password: string): Promise<StoreData> {
  try {
    await stat(path)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return newStore(path)
    throw err
  }
  return openStore(path, password)
}

function newStore(path: string): StoreData {
  return {
    keyring: withKey({ keys: {} }, 'k1', randomBytes(32), true, undefined, path),
    secrets: {},
  }
}

async function writeStore(path: string, store: StoreData, password: string): Promise<void> {
  const envelope = buildEnvelope(store, password)
  await atomicWriteFile(path, `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o600,
    createParent: true,
  })
  resetEmbedCache(path)
}

interface StoreLocation {
  path: string
  password: string
}

async function locate(
  options: { path?: string; password?: string },
  env: Env,
): Promise<StoreLocation> {
  return {
    path: resolve(options.path ?? defaultEmbedPath(env)),
    password: await requirePassword(env, options.password),
  }
}

/** Create an empty store with one generated active key (mode 0600, atomic). */
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
  await writeStore(path, newStore(path), password)
  return path
}

function cleanName(name: string): string {
  return name
    .trim()
    .replace(/^embed:\/\//, '')
    .replace(/^embed:/, '')
}

/**
 * Add a secret to the store; the store file (with a generated encryption key) is created on
 * first use. An existing name is an error unless `overwrite` is set.
 */
export async function setEmbedSecret(
  input: SetEmbedSecretInput,
  options: SetEmbedSecretOptions = {},
  env: Env = process.env,
): Promise<{ path: string; kid: string }> {
  const name = input.name.trim()
  if (name === '') throw new Error('Embedded store entry name must be non-empty')
  const { path, password } = await locate(options, env)
  const store = await openOrNewStore(path, password)
  const previous = Object.hasOwn(store.secrets, name) ? store.secrets[name] : undefined
  if (previous !== undefined && options.overwrite !== true) {
    throw new Error(
      `Embedded store entry "${name}" already exists in ${path} (use --force to overwrite)`,
    )
  }
  const kid = options.kid !== undefined ? checkKid(options.kid) : activeKid(store.keyring)
  const payload: SecretPayload = { secret: input.secret }
  if (input.username !== undefined) payload.username = input.username
  if (input.url !== undefined) payload.url = input.url
  if (input.notes !== undefined) payload.notes = input.notes
  const now = new Date().toISOString()
  const sealed = sealSecret(
    store.keyring,
    kid,
    name,
    payload,
    previous?.createdAt ?? now,
    previous !== undefined ? now : undefined,
  )
  await writeStore(
    path,
    { keyring: store.keyring, secrets: { ...store.secrets, [name]: sealed } },
    password,
  )
  return { path, kid }
}

/** Read one secret by entry name (decrypted with the encryption key it records). */
export async function getEmbedSecret(name: string, env: Env = process.env): Promise<EmbedSecret> {
  const id = cleanName(name)
  if (id === '') throw new Error('Invalid embedded store reference: missing entry name')
  const path = defaultEmbedPath(env)
  const password = await requirePassword(env, undefined)
  const store = await openStore(path, password)
  const stored = Object.hasOwn(store.secrets, id) ? store.secrets[id] : undefined
  if (stored === undefined) {
    throw new Error(
      `Embedded store entry "${id}" not found. Check the name or run \`mt vault embed-list\`.`,
    )
  }
  const payload = openSecret(store.keyring, id, stored)
  const secret: EmbedSecret = { name: id, secret: payload.secret, kid: stored.kid }
  if (payload.username !== undefined) secret.username = payload.username
  if (payload.url !== undefined) secret.url = payload.url
  if (payload.notes !== undefined) secret.notes = payload.notes
  return secret
}

/** List entry metadata (names, kids, timestamps) — never secrets. Sorted by name. */
export async function listEmbedEntries(env: Env = process.env): Promise<EmbedEntryInfo[]> {
  const path = defaultEmbedPath(env)
  const password = await requirePassword(env, undefined)
  const store = await openStore(path, password)
  return Object.entries(store.secrets)
    .map(([name, stored]) => {
      const payload = openSecret(store.keyring, name, stored)
      const info: EmbedEntryInfo = { name, kid: stored.kid, createdAt: stored.createdAt }
      if (stored.rotatedAt !== undefined) info.rotatedAt = stored.rotatedAt
      if (payload.username !== undefined) info.username = payload.username
      if (payload.url !== undefined) info.url = payload.url
      if (payload.notes !== undefined) info.notes = payload.notes
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

/**
 * Replace the value of an existing entry, keeping its name (so `embed:<name>` refs stay
 * valid) and other metadata, and seal it under the ACTIVE encryption key. Stamps `rotatedAt`.
 */
export async function rotateEmbedSecret(
  input: { name: string; secret: string },
  options: RotateEmbedSecretOptions = {},
  env: Env = process.env,
): Promise<{ path: string; kid: string; rotatedAt: string }> {
  const name = cleanName(input.name)
  if (name === '') throw new Error('Embedded store entry name must be non-empty')
  if (input.secret === '') throw new Error('New secret value must be non-empty')
  const { path, password } = await locate(options, env)
  const store = await openStore(path, password)
  const previous = Object.hasOwn(store.secrets, name) ? store.secrets[name] : undefined
  if (previous === undefined) {
    throw new Error(
      `Embedded store entry "${name}" not found in ${path} (add it with \`mt vault embed-add ${name}\`)`,
    )
  }
  const payload: SecretPayload = {
    ...openSecret(store.keyring, name, previous),
    secret: input.secret,
  }
  const kid = activeKid(store.keyring)
  const rotatedAt = new Date().toISOString()
  const sealed = sealSecret(store.keyring, kid, name, payload, previous.createdAt, rotatedAt)
  await writeStore(
    path,
    { keyring: store.keyring, secrets: { ...store.secrets, [name]: sealed } },
    password,
  )
  return { path, kid, rotatedAt }
}

/**
 * Change the master password: the keyring is re-wrapped under the new password (fresh salt
 * and nonce). Works from the built-in default password or any custom one. The current
 * password is checked first (a wrong one changes nothing), the result is verified by
 * unlocking the temp file with the new password, then renamed over the store (atomic,
 * mode 0600). Secrets stay sealed under their encryption keys; run
 * {@link rotateEmbedKeys} with `reencrypt` afterwards to also replace the key material.
 */
export async function rekeyEmbedStore(
  options: RekeyEmbedOptions,
  env: Env = process.env,
): Promise<{ path: string; entries: number }> {
  const path = resolve(options.path ?? defaultEmbedPath(env))
  const current = await requirePassword(env, options.currentPassword)
  if (options.newPassword === '') {
    throw new Error('New embedded store master password must be non-empty')
  }
  if (options.newPassword === current) {
    throw new Error('New master password is identical to the current one: nothing to rotate')
  }
  resetEmbedCache(path)
  const store = await openStore(path, current)
  const envelope = buildEnvelope(store, options.newPassword)
  await atomicWriteFile(path, `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o600,
    verify: async (tmp) => {
      const written = validateEnvelope(JSON.parse(await readFile(tmp, 'utf-8')), tmp)
      const keyring = unlockKeyring(written, options.newPassword, path)
      if (
        JSON.stringify(keyring) !== JSON.stringify(store.keyring) ||
        JSON.stringify(written.secrets) !== JSON.stringify(store.secrets)
      ) {
        throw new Error(`Re-key verification failed for ${path}: store left unchanged`)
      }
    },
  })
  resetEmbedCache(path)
  return { path, entries: Object.keys(store.secrets).length }
}

// ---- keyring management ----------------------------------------------------------------

async function mutateKeyring(
  options: EmbedKeyringOptions,
  env: Env,
  fn: (store: StoreData, path: string) => StoreData,
): Promise<string> {
  const { path, password } = await locate(options, env)
  const next = fn(await openOrNewStore(path, password), path)
  await writeStore(path, next, password)
  return path
}

/** Keys in the keyring with status and per-key secret counts — never key material. */
export async function listEmbedKeys(
  options: EmbedKeyringOptions = {},
  env: Env = process.env,
): Promise<EmbedKeyInfo[]> {
  const { path, password } = await locate(options, env)
  const store = await openStore(path, password)
  return Object.entries(store.keyring.keys)
    .map(([kid, record]) => {
      const info: EmbedKeyInfo = {
        kid,
        status: record.status,
        createdAt: record.createdAt,
        secrets: Object.values(store.secrets).filter((s) => s.kid === kid).length,
      }
      if (record.note !== undefined) info.note = record.note
      return info
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.kid.localeCompare(b.kid))
}

/** Generate a random 256-bit encryption key and add it to the keyring. */
export async function generateEmbedKey(
  options: GenerateEmbedKeyOptions = {},
  env: Env = process.env,
): Promise<{ path: string; kid: string; active: boolean }> {
  let kid = ''
  let active = false
  const path = await mutateKeyring(options, env, (store, p) => {
    kid = options.kid !== undefined ? checkKid(options.kid) : nextKid(store.keyring)
    const keyring = withKey(
      store.keyring,
      kid,
      randomBytes(32),
      options.activate !== false,
      options.note,
      p,
    )
    active = keyring.keys[kid]?.status === 'active'
    return { keyring, secrets: store.secrets }
  })
  return { path, kid, active }
}

const SUPPLIED_KEY_SALT = 'mt-embed-v2-supplied-key:'
const MIN_PASSPHRASE_LENGTH = 12

/**
 * Turn user-supplied encryption-key text into 32 bytes. Accepted: 64 hex characters, or
 * base64 of exactly 32 bytes (44 chars with padding / 43 without); anything else is treated
 * as a passphrase (at least 12 characters) and stretched with scrypt (same parameters as the
 * master password KDF, salt `mt-embed-v2-supplied-key:<kid>`).
 */
export function parseSuppliedEmbedKey(text: string, kid: string): Buffer {
  const value = text.replace(/\r?\n$/, '')
  if (value === '') throw new Error('Supplied encryption key must be non-empty')
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex')
  if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    const raw = Buffer.from(value, 'base64')
    if (raw.length === 32) return raw
  }
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `Supplied encryption key is not 64 hex characters or 32 bytes of base64, and too short to be a passphrase (minimum ${MIN_PASSPHRASE_LENGTH} characters)`,
    )
  }
  return deriveKey(value, Buffer.from(`${SUPPLIED_KEY_SALT}${kid}`, 'utf-8'))
}

/** Add a user-supplied encryption key to the keyring. */
export async function addEmbedKey(
  options: AddEmbedKeyOptions,
  env: Env = process.env,
): Promise<{ path: string; kid: string; active: boolean }> {
  const kid = checkKid(options.kid)
  const material = parseSuppliedEmbedKey(options.key, kid)
  let active = false
  const path = await mutateKeyring(options, env, (store, p) => {
    const keyring = withKey(
      store.keyring,
      kid,
      material,
      options.activate !== false,
      options.note,
      p,
    )
    active = keyring.keys[kid]?.status === 'active'
    return { keyring, secrets: store.secrets }
  })
  return { path, kid, active }
}

function requireKey(keyring: Keyring, kid: string, path: string): KeyRecord {
  const record = Object.hasOwn(keyring.keys, kid) ? keyring.keys[kid] : undefined
  if (record === undefined) {
    throw new Error(
      `Encryption key "${kid}" not found in ${path} (see \`mt vault embed-keyring list\`)`,
    )
  }
  return record
}

/** Make `kid` the active encryption key for new writes (the previous one becomes retired). */
export async function useEmbedKey(
  kid: string,
  options: EmbedKeyringOptions = {},
  env: Env = process.env,
): Promise<string> {
  const id = checkKid(kid)
  return mutateKeyring(options, env, (store, path) => {
    requireKey(store.keyring, id, path)
    const keys: Record<string, KeyRecord> = {}
    for (const [k, record] of Object.entries(store.keyring.keys)) {
      keys[k] = { ...record, status: k === id ? 'active' : 'retired' }
    }
    return { keyring: { keys }, secrets: store.secrets }
  })
}

/** Retire a key: it still decrypts existing secrets but is never used for new writes. */
export async function retireEmbedKey(
  kid: string,
  options: EmbedKeyringOptions = {},
  env: Env = process.env,
): Promise<string> {
  const id = checkKid(kid)
  return mutateKeyring(options, env, (store, path) => {
    const record = requireKey(store.keyring, id, path)
    if (record.status === 'active') {
      throw new Error(
        `Encryption key "${id}" is active: activate another key first (embed-keyring use)`,
      )
    }
    return store
  })
}

/**
 * Remove a key from the keyring. Refused while any secret is still sealed with it unless
 * `force` (those secrets become undecryptable), and always refused for the active key.
 */
export async function removeEmbedKey(
  kid: string,
  options: EmbedKeyringOptions & { force?: boolean } = {},
  env: Env = process.env,
): Promise<string> {
  const id = checkKid(kid)
  return mutateKeyring(options, env, (store, path) => {
    const record = requireKey(store.keyring, id, path)
    if (record.status === 'active') {
      throw new Error(
        `Encryption key "${id}" is active: activate another key first (embed-keyring use)`,
      )
    }
    const used = Object.values(store.secrets).filter((s) => s.kid === id).length
    if (used > 0 && options.force !== true) {
      throw new Error(
        `Encryption key "${id}" still seals ${used} secret${used === 1 ? '' : 's'}: re-encrypt them first (embed-keyring rotate --reencrypt) or pass --force`,
      )
    }
    const keys = { ...store.keyring.keys }
    Reflect.deleteProperty(keys, id)
    return { keyring: { keys }, secrets: store.secrets }
  })
}

/**
 * Generate a new encryption key, activate it and (with `reencrypt`) re-seal every secret
 * under it. Without `reencrypt`, existing secrets stay readable under their old key.
 */
export async function rotateEmbedKeys(
  options: RotateEmbedKeysOptions = {},
  env: Env = process.env,
): Promise<{ path: string; kid: string; reencrypted: number }> {
  let kid = ''
  let reencrypted = 0
  const path = await mutateKeyring(options, env, (store, p) => {
    kid = options.kid !== undefined ? checkKid(options.kid) : nextKid(store.keyring)
    const keyring = withKey(store.keyring, kid, randomBytes(32), true, options.note, p)
    if (options.reencrypt !== true) return { keyring, secrets: store.secrets }
    const secrets: Record<string, StoredSecret> = {}
    for (const [name, stored] of Object.entries(store.secrets)) {
      const payload = openSecret(store.keyring, name, stored)
      secrets[name] = sealSecret(keyring, kid, name, payload, stored.createdAt, stored.rotatedAt)
      reencrypted++
    }
    return { keyring, secrets }
  })
  return { path, kid, reencrypted }
}
