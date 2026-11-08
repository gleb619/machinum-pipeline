import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  VAULT_PROVIDERS,
  addEmbedKey,
  addEntry,
  annotate,
  createEmbedStore,
  defaultEmbedPath,
  embedCredentialsConfigured,
  emptyVault,
  generateEmbedKey,
  getEmbedSecret,
  isSecretRef,
  isVaultProvider,
  listEmbedEntries,
  listEmbedKeys,
  loadVault,
  maskVault,
  rekeyEmbedStore,
  removeEmbedKey,
  removeEntry,
  retireEmbedKey,
  rotateEmbedKeys,
  rotateEmbedSecret,
  saveVault,
  setEmbedSecret,
  useCase,
  useEmbedKey,
  vaultPaths,
} from '@mt/core'
import type { Vault, VaultEntry, VaultProvider } from '@mt/core'
import {
  addKeepassSecret,
  createKeepassDatabase,
  defaultKeepassPath,
  findVlt,
  installVlt,
  keepassCredentialsConfigured,
  listKeepassEntries,
} from '@mt/plugins'
import { VAULT_IGNORE_PATTERNS, ensureIgnorePatterns } from '../utils/gitignore.js'
import {
  masterKeyGenerateCommand,
  masterKeyShowPathCommand,
  masterKeyStatusCommand,
} from './master-key.js'

const USAGE = `Usage: mt vault <subcommand> [options]

Manage the vault: gitignored store of LLM endpoint data (URLs, key refs, headers).
Keys are never stored in plaintext: vault files hold only embed:<name>, vlt:<name> or
keepass:<title> refs. The embedded store is the default backend and works without setup
(built-in default password, obfuscation only; set MT_EMBED_PASSWORD to protect it).

Subcommands:
  list                  List entries (provider, base URL, model count)
  show <name>           Show one entry (secrets masked)
  add <name>            Add an entry (flags, or prompts when a TTY is attached);
                        a plaintext --api-key/--api-keys goes into the embedded store,
                        only the embed:<name> ref is written to the vault file
  rm <name>             Remove an entry
  path                  Print the resolved vault paths and whether they exist
  init                  Create an empty vault file
  vlt-install           Download the vlt binary into ~/.mt/bin
  vlt-status            Show vlt binary location, version and session state
  keepass-init          Create an empty KeePass database
  keepass-add <title>   Add or update an entry in the KeePass database
  keepass-list          List KeePass entry titles (no secrets)
  keepass-status        KeePass database path and whether it can be unlocked
  embed-init            Create an empty embedded encrypted secrets store
  embed-add <name>      Add or update a secret in the embedded store
  embed-list            List embedded store entry names (no secrets)
  embed-status          Embedded store path and whether it can be unlocked
  embed-rekey           Change the store MASTER PASSWORD (default -> custom, or custom -> custom).
                        Current: MT_EMBED_PASSWORD(_FILE) or the built-in default; new:
                        --new-password-file, $MT_EMBED_NEW_PASSWORD(_FILE) or hidden prompt
  master-key <action>   Master key file that seals the embedded store (random 256-bit):
      generate [--user] [--path <file>] [--force] [--rekey]
                        create <project>/.mt/master.key (or ~/.mt/master.key with --user);
                        refuses to overwrite; --rekey re-wraps an existing store under it
      status            active source (env / env-file / project / user / default); never the key
      show-path         project and user key file locations
  embed-rotate <name>   Replace the VALUE of an existing embedded secret under the active
                        encryption key, keeping its embed:<name> ref (value: --value-file,
                        stdin or hidden prompt)
  embed-keyring <action>  Manage the ENCRYPTION keys (kid) that seal secrets in the store:
      generate [--kid <kid>] [--note <text>] [--no-activate]   random 256-bit key
      add --kid <kid> [--enc-key-file <file>] [--note <text>] [--no-activate]
                        supplied key (64 hex chars, 32-byte base64, or a >=12 char
                        passphrase stretched with scrypt); file, stdin or hidden prompt
      list              kid, status, created, secret count (never key material)
      use <kid>         make a key the active one for NEW secrets
      retire <kid>      still decrypts existing secrets, never used for new ones
      rm <kid> [--force]  remove a key (refused while secrets still use it)
      rotate [--kid <kid>] [--reencrypt]  generate + activate a new key; --reencrypt
                        re-seals every secret under it

Options:
  --provider <name>     Provider: ${VAULT_PROVIDERS.join(' | ')}
  --base-url <url>      Base URL of the endpoint
  --api-key <key>       API key (masked in all output)
  --api-keys <k1,k2>    API key pool
  --models <a,b>        Available models
  --default-model <m>   Default model
  --notes <text>        Free-form note
  --secret <value>      Secret value for keepass-add / embed-add (never logged)
  --username <name>     User name for keepass-add / embed-add
  --group <path>        KeePass group for keepass-add (e.g. LLM/API)
  --path <file>         KeePass / embedded store path (--path or $MT_KEEPASS_PATH / $MT_EMBED_PATH)
  --key-file <file>     KeePass key file
  --user                Use the user vault (~/.mt/vault.json) instead of the project one
  --reveal              Print secret values unmasked
  --new-password-file <file>  New master password for embed-rekey (never a CLI value)
  --value-file <file>   New secret value for embed-rotate (never a CLI value)
  --enc-key-file <file> Supplied encryption key for embed-keyring add (never a CLI value)
  --kid <kid>           Encryption key id: embed-add stores the secret under it
                        (default: active key); embed-keyring uses it as the key id
  --note <text>         Note for embed-keyring generate / add (same as --notes)
  --no-activate         embed-keyring generate / add: keep the current active key
  --rekey               master-key generate: re-wrap the existing embedded store under the new key
  --reencrypt           embed-keyring rotate: re-seal all secrets under the new key
  --force               Overwrite an existing entry / embedded secret
  -h, --help            Show this help
`

interface VaultOptions {
  user: boolean
  reveal: boolean
  force: boolean
  help: boolean
  provider?: string
  baseUrl?: string
  apiKey?: string
  apiKeys?: string[]
  models?: string[]
  defaultModel?: string
  notes?: string
  secret?: string
  username?: string
  group?: string
  path?: string
  keyFile?: string
  newPasswordFile?: string
  encKeyFile?: string
  kid?: string
  noActivate: boolean
  reencrypt: boolean
  rekey: boolean
  valueFile?: string
  positionals: string[]
}

/** Resolved vault locations: read order, plus the file writes go to. */
interface VaultTargets {
  user: string
  project: string
  read: string[]
  write: string
}

function fail(message: string): never {
  throw new Error(message)
}

function splitList(value: string): string[] | undefined {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (value === undefined) fail(`Option ${flag} requires a value`)
  return value
}

function parseArgs(args: string[]): VaultOptions {
  const options: VaultOptions = {
    user: false,
    reveal: false,
    force: false,
    noActivate: false,
    reencrypt: false,
    rekey: false,
    help: false,
    positionals: [],
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg) continue
    switch (arg) {
      case '--provider':
        options.provider = takeValue(args, i, arg)
        i++
        break
      case '--base-url':
        options.baseUrl = takeValue(args, i, arg)
        i++
        break
      case '--api-key':
        options.apiKey = takeValue(args, i, arg)
        i++
        break
      case '--api-keys':
        options.apiKeys = splitList(takeValue(args, i, arg))
        i++
        break
      case '--models':
        options.models = splitList(takeValue(args, i, arg))
        i++
        break
      case '--default-model':
        options.defaultModel = takeValue(args, i, arg)
        i++
        break
      case '--note':
      case '--notes':
        options.notes = takeValue(args, i, arg)
        i++
        break
      case '--secret':
        options.secret = takeValue(args, i, arg)
        i++
        break
      case '--username':
        options.username = takeValue(args, i, arg)
        i++
        break
      case '--group':
        options.group = takeValue(args, i, arg)
        i++
        break
      case '--path':
        options.path = takeValue(args, i, arg)
        i++
        break
      case '--key-file':
        options.keyFile = takeValue(args, i, arg)
        i++
        break
      case '--new-password-file':
        options.newPasswordFile = takeValue(args, i, arg)
        i++
        break
      case '--enc-key-file':
        options.encKeyFile = takeValue(args, i, arg)
        i++
        break
      case '--kid':
        options.kid = takeValue(args, i, arg)
        i++
        break
      case '--no-activate':
        options.noActivate = true
        break
      case '--reencrypt':
        options.reencrypt = true
        break
      case '--rekey':
        options.rekey = true
        break
      case '--value-file':
        options.valueFile = takeValue(args, i, arg)
        i++
        break
      case '--user':
        options.user = true
        break
      case '--reveal':
        options.reveal = true
        break
      case '--force':
        options.force = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        if (arg.startsWith('-')) fail(`Unknown option: ${arg}`)
        options.positionals.push(arg)
    }
  }
  return options
}

/** Vault file locations: `MT_VAULT` wins, then the user file, then the project file. */
function resolveTargets(options: VaultOptions, cwd: string, env: NodeJS.ProcessEnv): VaultTargets {
  const mtHome = env.MT_HOME || join(env.HOME || homedir(), '.mt')
  const user = join(mtHome, 'vault.json')
  const project = join(resolve(cwd), '.mt', 'vault.json')
  const read = vaultPaths(cwd, env)
  const write = env.MT_VAULT ? resolve(env.MT_VAULT) : options.user ? user : project
  return { user, project, read, write }
}

/** Load a single vault file (the merged view would pull in the other files' entries).
 * Resolution of secret refs is skipped so stored refs round-trip unchanged on save. */
function loadSingle(path: string, env: NodeJS.ProcessEnv): Promise<Vault> {
  return loadVault(process.cwd(), { ...env, MT_VAULT: path }, { resolveRefs: false })
}

function unknownEntryMessage(name: string, vault: Vault): string {
  const names = Object.keys(vault.entries)
  return `Unknown vault entry "${name}". Available entries: ${names.length ? names.join(', ') : '(none)'}`
}

/** Plain prompt for a non-secret value; undefined when no TTY is attached. */
async function askText(label: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${label}: `)).trim()
    return answer === '' ? undefined : answer
  } finally {
    rl.close()
  }
}

/** Prompt with the keystrokes hidden — used for API keys. */
function askSecret(label: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    if (!stdin.isTTY) {
      resolve(undefined)
      return
    }
    let value = ''
    const finish = (result: string | undefined): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf-8')) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          finish(value === '' ? undefined : value)
          return
        }
        if (char === '\u0003') {
          finish(undefined)
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
    process.stdout.write(`${label}: `)
  })
}

/** Build the entry from flags, falling back to prompts when a TTY is attached. */
async function buildEntry(options: VaultOptions): Promise<VaultEntry> {
  const providerRaw = options.provider ?? (await askText('Provider'))
  if (!providerRaw) {
    fail(`Missing --provider (one of: ${VAULT_PROVIDERS.join(', ')})`)
  }
  if (!isVaultProvider(providerRaw)) {
    fail(`Unknown provider "${providerRaw}" (expected one of: ${VAULT_PROVIDERS.join(', ')})`)
  }
  const provider: VaultProvider = providerRaw

  const baseUrl = options.baseUrl ?? (await askText('Base URL (optional)'))
  const apiKey = options.apiKey ?? (await askSecret('API key (optional)'))
  const models = options.models ?? splitList((await askText('Models (comma separated)')) ?? '')
  const defaultModel = options.defaultModel ?? (await askText('Default model (optional)'))
  const notes = options.notes ?? (await askText('Notes (optional)'))

  if (defaultModel && models && !models.includes(defaultModel)) {
    fail(`Default model "${defaultModel}" is not in the model list (${models.join(', ')})`)
  }

  const entry: VaultEntry = { provider }
  if (baseUrl) entry.baseUrl = baseUrl
  if (apiKey) entry.apiKey = apiKey
  if (options.apiKeys?.length) entry.apiKeys = options.apiKeys
  if (models) entry.models = models
  if (defaultModel) entry.defaultModel = defaultModel
  if (notes) entry.notes = notes
  return entry
}

async function listCommand(): Promise<void> {
  const vault = await loadVault(process.cwd(), process.env, { resolveRefs: false })
  const names = Object.keys(vault.entries).sort()
  if (names.length === 0) {
    console.log('Vault is empty. Add an entry with: mt vault add <name> --provider <provider>')
    return
  }
  const rows = names.map((name) => {
    const entry = vault.entries[name] as VaultEntry
    return {
      name,
      provider: entry.provider,
      baseUrl: entry.baseUrl ?? '-',
      models: entry.models?.length ?? 0,
    }
  })
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length))
  const providerWidth = Math.max(8, ...rows.map((row) => row.provider.length))
  const urlWidth = Math.max(7, ...rows.map((row) => row.baseUrl.length))
  for (const row of rows) {
    const models = `${row.models} model${row.models === 1 ? '' : 's'}`
    console.log(
      `${row.name.padEnd(nameWidth)}  ${row.provider.padEnd(providerWidth)}  ${row.baseUrl.padEnd(urlWidth)}  ${models}`,
    )
  }
}

annotate(listCommand, useCase('UC073'))

async function showCommand(options: VaultOptions, name: string): Promise<void> {
  if (!name) fail('Usage: mt vault show <name>')
  const vault = await loadVault(process.cwd(), process.env, { resolveRefs: false })
  const entry = vault.entries[name]
  if (!entry) fail(unknownEntryMessage(name, vault))
  const shown = options.reveal
    ? entry
    : (maskVault({ version: 1, entries: { [name]: entry } }).entries[name] as VaultEntry)
  console.log(JSON.stringify(shown, null, 2))
}

annotate(showCommand, useCase('UC073'))

async function addCommand(
  options: VaultOptions,
  name: string,
  targets: VaultTargets,
): Promise<void> {
  if (!name) fail('Usage: mt vault add <name> [--provider <provider>] [--base-url <url>] ...')
  if (name.includes('/')) {
    fail(`Invalid entry name "${name}": names must be non-empty and contain no "/"`)
  }
  const entry = await buildEntry(options)
  const target = targets.write
  const existing = await loadSingle(target, process.env)
  if (existing.entries[name] && !options.force) {
    fail(`Entry "${name}" already exists in ${target} (use --force to overwrite)`)
  }
  const env = embedEnv(options)
  const stored = await moveKeysToEmbed(name, entry, options.force, env)
  await saveVault(target, addEntry(existing, name, entry))
  console.log(`Added entry "${name}" to ${target}`)
  if (entry.apiKey) console.log(`  apiKey: ${entry.apiKey}`)
  if (entry.apiKeys?.length) console.log(`  apiKeys: ${entry.apiKeys.join(', ')}`)
  if (stored > 0) {
    console.log(`  ${stored} key${stored === 1 ? '' : 's'} stored in ${defaultEmbedPath(env)}`)
  }
}

annotate(addCommand, useCase('UC068'))

/**
 * Replace every plaintext key of `entry` with an `embed:<name>` ref, storing the value in the
 * embedded store (`<entry>` for `apiKey`, `<entry>-<n>` for `apiKeys[n-1]`). Returns the number
 * of keys moved. Secret values never reach output or errors.
 */
async function moveKeysToEmbed(
  entryName: string,
  entry: VaultEntry,
  force: boolean,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let moved = 0
  const store = async (secretName: string, value: string): Promise<string> => {
    if (isSecretRef(value)) return value
    const existing = await getEmbedSecret(secretName, env).catch(() => undefined)
    if (existing?.secret !== value) {
      if (existing && !force) {
        fail(
          `Embedded store already has a different secret "${secretName}" (use --force to overwrite, or pass --api-key embed:<other-name>)`,
        )
      }
      await setEmbedSecret({ name: secretName, secret: value }, { overwrite: true }, env)
    }
    moved++
    return `embed:${secretName}`
  }
  if (entry.apiKey !== undefined) entry.apiKey = await store(entryName, entry.apiKey)
  if (entry.apiKeys !== undefined) {
    const refs: string[] = []
    for (const [i, key] of entry.apiKeys.entries())
      refs.push(await store(`${entryName}-${i + 1}`, key))
    entry.apiKeys = refs
  }
  return moved
}

annotate(moveKeysToEmbed, useCase('UC069'))

async function rmCommand(
  options: VaultOptions,
  name: string,
  targets: VaultTargets,
): Promise<void> {
  if (!name) fail('Usage: mt vault rm <name>')
  const candidates = process.env.MT_VAULT
    ? [resolve(process.env.MT_VAULT)]
    : options.user
      ? [targets.user]
      : [targets.project, targets.user]
  for (const candidate of candidates) {
    const vault = await loadSingle(candidate, process.env)
    if (!vault.entries[name]) continue
    await saveVault(candidate, removeEntry(vault, name))
    console.log(`Removed entry "${name}" from ${candidate}`)
    return
  }
  const merged = await loadVault(process.cwd(), process.env)
  fail(unknownEntryMessage(name, merged))
}

annotate(rmCommand, useCase('UC073'))

async function pathCommand(targets: VaultTargets): Promise<void> {
  const label = (path: string): string => {
    if (path === targets.user) return 'user'
    if (path === targets.project) return 'project'
    return 'vault'
  }
  const labelWidth = Math.max(5, ...targets.read.map((path) => label(path).length))
  for (const path of targets.read) {
    const state = existsSync(path) ? 'exists' : 'missing'
    console.log(`${label(path).padEnd(labelWidth)}  ${path}  ${state}`)
  }
}

annotate(pathCommand, useCase('UC073'))

async function initCommand(targets: VaultTargets): Promise<void> {
  if (existsSync(targets.write)) {
    console.log(`Vault already exists: ${targets.write}`)
    return
  }
  await saveVault(targets.write, emptyVault())
  console.log(`Created ${targets.write}`)
  if (targets.write === targets.project) {
    const ignored = await ensureIgnorePatterns(process.cwd(), VAULT_IGNORE_PATTERNS)
    if (ignored.length > 0) console.log(`Added to .gitignore: ${ignored.join(', ')}`)
  }
}

annotate(initCommand, useCase('UC073'))

/** Probe `vlt --version` (falling back to `vlt version`); undefined when it fails. */
function vltVersion(binary: string): string | undefined {
  for (const flag of ['--version', 'version']) {
    try {
      const out = execFileSync(binary, [flag], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      })
      const line = out.trim().split('\n')[0]?.trim()
      if (line) return line
    } catch {
      // try the next invocation shape
    }
  }
  return undefined
}

annotate(vltVersion, useCase('UC073'))

async function vltInstallCommand(): Promise<void> {
  const installed = await installVlt()
  console.log(`Installed vlt to ${installed}`)
  const version = vltVersion(installed)
  console.log(`  version: ${version ?? 'unknown (vlt --version failed)'}`)
}

annotate(vltInstallCommand, useCase('UC073'))

async function vltStatusCommand(): Promise<void> {
  const binary = await findVlt()
  if (!binary) {
    console.log('vlt: not found')
    console.log('  Install with: mt vault vlt-install')
    console.log(
      '  or: curl -sSL https://raw.githubusercontent.com/ladzaretti/vlt-cli/main/install.sh | bash',
    )
    return
  }
  console.log(`vlt: found at ${binary}`)
  const version = vltVersion(binary)
  if (version) console.log(`  version: ${version}`)
  // Probe the session without printing anything the vault holds (names or values).
  try {
    execFileSync(binary, ['find'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
    console.log('  session: active (vault unlocked)')
  } catch {
    console.log('  session: locked or expired — run `vlt login` and retry')
  }
}

annotate(vltStatusCommand, useCase('UC073'))

/**
 * Environment for the KeePass commands. `--path` / `--key-file` override the
 * environment; when no credentials are configured and a TTY is attached, the
 * master password is prompted for (keystrokes hidden). Otherwise the core
 * resolver reports the missing configuration.
 */
async function keepassEnv(options: VaultOptions, prompt: boolean): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (options.path) env.MT_KEEPASS_PATH = options.path
  if (options.keyFile) env.MT_KEEPASS_KEY_FILE = options.keyFile
  if (prompt && !keepassCredentialsConfigured(env)) {
    const password = await askSecret('KeePass master password')
    if (password) env.MT_KEEPASS_PASSWORD = password
  }
  return env
}

annotate(keepassEnv, useCase('UC066'))

async function keepassInitCommand(options: VaultOptions): Promise<void> {
  const path = resolve(options.path ?? defaultKeepassPath(process.env))
  if (existsSync(path)) {
    fail(`KeePass database already exists: ${path} (remove it first or pick --path)`)
  }
  const env = await keepassEnv(options, false)
  let password = env.MT_KEEPASS_PASSWORD
  if (!keepassCredentialsConfigured(env)) {
    if (!process.stdin.isTTY) {
      fail(
        'Missing KeePass credentials: set MT_KEEPASS_PASSWORD (or MT_KEEPASS_KEY_FILE) for non-interactive use',
      )
    }
    const first = await askSecret('Master password')
    if (!first) fail('Master password must be non-empty (or pass --key-file)')
    const second = await askSecret('Repeat master password')
    if (first !== second) fail('Passwords do not match')
    password = first
  }
  const created = await createKeepassDatabase({ path, password, keyFile: options.keyFile }, env)
  console.log(`Created ${created}`)
  console.log('  mode: 0600')
}

annotate(keepassInitCommand, useCase('UC066'))

async function keepassAddCommand(options: VaultOptions): Promise<void> {
  const title = options.positionals[1]
  if (!title) {
    fail(
      'Usage: mt vault keepass-add <title> [--secret <value>] [--username <name>] [--group <path>]',
    )
  }
  const env = await keepassEnv(options, true)
  const secret = options.secret ?? (await askSecret(`Secret for "${title}"`))
  if (!secret) fail('Missing secret: pass --secret (or run on a TTY to be prompted)')
  const result = await addKeepassSecret(
    {
      title,
      secret,
      username: options.username,
      group: options.group,
      notes: options.notes,
    },
    { path: options.path, keyFile: options.keyFile },
    env,
  )
  console.log(`Saved KeePass entry "${title}" in ${result.path}`)
  console.log(`  uuid: ${result.uuid}`)
}

annotate(keepassAddCommand, useCase('UC066'))

async function keepassListCommand(options: VaultOptions): Promise<void> {
  const env = await keepassEnv(options, true)
  const path = defaultKeepassPath(env)
  const entries = await listKeepassEntries(env)
  console.log(path)
  if (entries.length === 0) {
    console.log('  No entries.')
    return
  }
  const rows = entries.map((entry) => ({
    title: entry.group ? `${entry.group}/${entry.title}` : entry.title,
    username: entry.username ?? '-',
    uuid: entry.uuid,
  }))
  const titleWidth = Math.max(5, ...rows.map((row) => row.title.length))
  const userWidth = Math.max(8, ...rows.map((row) => row.username.length))
  for (const row of rows) {
    console.log(`  ${row.title.padEnd(titleWidth)}  ${row.username.padEnd(userWidth)}  ${row.uuid}`)
  }
}

annotate(keepassListCommand, useCase('UC066'))

async function keepassStatusCommand(options: VaultOptions): Promise<void> {
  const env = await keepassEnv(options, false)
  const path = defaultKeepassPath(env)
  console.log(`database: ${path}`)
  console.log(`  state: ${existsSync(path) ? 'exists' : 'missing'}`)
  const configured = keepassCredentialsConfigured(env)
  console.log(
    `  credentials: ${configured ? 'configured' : 'missing — set MT_KEEPASS_PASSWORD or MT_KEEPASS_PASSWORD_FILE'}`,
  )
  if (!existsSync(path) || !configured) return
  try {
    const entries = await listKeepassEntries(env)
    console.log(`  unlocked: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
  } catch (err) {
    console.log(`  locked: ${err instanceof Error ? err.message : String(err)}`)
  }
}

annotate(keepassStatusCommand, useCase('UC066'))

/**
 * Environment for the embedded-store commands. `--path` overrides the environment. Without
 * `MT_EMBED_PASSWORD(_FILE)` the core falls back to the built-in default password (with a
 * one-time warning), so no prompting is needed.
 */
function embedEnv(options: VaultOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (options.path) env.MT_EMBED_PATH = options.path
  return env
}

async function embedInitCommand(options: VaultOptions): Promise<void> {
  const path = resolve(options.path ?? defaultEmbedPath(process.env))
  if (existsSync(path)) {
    fail(`Embedded store already exists: ${path} (remove it first or pick --path)`)
  }
  const created = await createEmbedStore({ path }, embedEnv(options))
  console.log(`Created ${created}`)
  console.log('  mode: 0600')
}

annotate(embedInitCommand, useCase('UC067'))

async function embedAddCommand(options: VaultOptions): Promise<void> {
  const name = options.positionals[1]
  if (!name) {
    fail('Usage: mt vault embed-add <name> [--secret <value>] [--username <name>]')
  }
  const env = embedEnv(options)
  const secret = options.secret ?? (await askSecret(`Secret for "${name}"`))
  if (!secret) fail('Missing secret: pass --secret (or run on a TTY to be prompted)')
  const result = await setEmbedSecret(
    { name, secret, username: options.username, notes: options.notes },
    { path: options.path, overwrite: options.force, kid: options.kid },
    env,
  )
  console.log(`Saved embedded secret "${name}" in ${result.path} (encryption key: ${result.kid})`)
}

annotate(embedAddCommand, useCase('UC067'))

async function embedListCommand(options: VaultOptions): Promise<void> {
  const env = embedEnv(options)
  const path = defaultEmbedPath(env)
  const entries = await listEmbedEntries(env)
  console.log(path)
  if (entries.length === 0) {
    console.log('  No entries.')
    return
  }
  const nameWidth = Math.max(4, ...entries.map((entry) => entry.name.length))
  const userWidth = Math.max(8, ...entries.map((entry) => (entry.username ?? '-').length))
  const kidWidth = Math.max(3, ...entries.map((entry) => entry.kid.length))
  for (const entry of entries) {
    const stamps = [
      `created ${entry.createdAt}`,
      entry.rotatedAt ? `rotated ${entry.rotatedAt}` : '',
    ]
    console.log(
      `  ${entry.name.padEnd(nameWidth)}  ${(entry.username ?? '-').padEnd(userWidth)}  ${entry.kid.padEnd(kidWidth)}  ${stamps.filter(Boolean).join('  ')}`,
    )
  }
}

annotate(embedListCommand, useCase('UC067'))

async function embedStatusCommand(options: VaultOptions): Promise<void> {
  const env = embedEnv(options)
  const path = defaultEmbedPath(env)
  console.log(`store: ${path}`)
  console.log(`  state: ${existsSync(path) ? 'exists' : 'missing'}`)
  const configured = embedCredentialsConfigured(env)
  console.log(
    `  credentials: ${configured ? 'configured' : 'no env password: see `mt vault master-key status` (key file, else built-in default = obfuscation only)'}`,
  )
  if (!existsSync(path)) return
  try {
    const entries = await listEmbedEntries(env)
    const keys = await listEmbedKeys({ path: options.path }, env)
    console.log(`  unlocked: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
    const active = keys.find((key) => key.status === 'active')
    console.log(`  encryption keys: ${keys.length} (active: ${active?.kid ?? 'none'})`)
  } catch (err) {
    console.log(`  locked: ${err instanceof Error ? err.message : String(err)}`)
  }
}

annotate(embedStatusCommand, useCase('UC067'))

/** Read a secret from a file, dropping one trailing newline. */
async function readSecretFile(path: string, label: string): Promise<string> {
  try {
    return (await readFile(resolve(path), 'utf-8')).replace(/\r?\n$/, '')
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown error'
    return fail(`Cannot read ${label} ${resolve(path)}: ${code}`)
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks)
    .toString('utf-8')
    .replace(/\r?\n$/, '')
}

async function resolveNewPassword(options: VaultOptions, env: NodeJS.ProcessEnv): Promise<string> {
  let password: string | undefined
  if (options.newPasswordFile) {
    password = await readSecretFile(options.newPasswordFile, 'new password file')
  } else if (env.MT_EMBED_NEW_PASSWORD !== undefined) {
    password = env.MT_EMBED_NEW_PASSWORD
  } else if (env.MT_EMBED_NEW_PASSWORD_FILE) {
    password = await readSecretFile(env.MT_EMBED_NEW_PASSWORD_FILE, 'MT_EMBED_NEW_PASSWORD_FILE')
  } else if (process.stdin.isTTY) {
    const first = await askSecret('New master password')
    if (!first) fail('New master password must be non-empty')
    const second = await askSecret('Repeat new master password')
    if (first !== second) fail('Passwords do not match')
    password = first
  } else {
    fail(
      'Missing new master password: pass --new-password-file, set MT_EMBED_NEW_PASSWORD(_FILE), or run on a TTY',
    )
  }
  if (!password) fail('New master password must be non-empty')
  return password
}

/** Value from a file, a hidden TTY prompt, or stdin (in that order); never an argument. */
async function readSuppliedValue(
  file: string | undefined,
  label: string,
  prompt: string,
): Promise<string | undefined> {
  if (file) return readSecretFile(file, label)
  if (process.stdin.isTTY) return askSecret(prompt)
  return readStdin()
}

async function embedKeyringCommand(options: VaultOptions): Promise<void> {
  const action = options.positionals[1]
  const kidArg = options.positionals[2]
  const env = embedEnv(options)
  const where = { path: options.path }
  const usage = 'Usage: mt vault embed-keyring generate|add|list|use|retire|rm|rotate [options]'
  const needKid = (): string => kidArg ?? fail(`${usage}\n  ${action} needs a <kid>`)
  switch (action) {
    case 'generate': {
      const result = await generateEmbedKey(
        { ...where, kid: options.kid, note: options.notes, activate: !options.noActivate },
        env,
      )
      console.log(`Generated encryption key "${result.kid}" in ${result.path}`)
      console.log(`  status: ${result.active ? 'active' : 'retired (not used for new secrets)'}`)
      return
    }
    case 'add': {
      if (!options.kid)
        fail('Usage: mt vault embed-keyring add --kid <kid> [--enc-key-file <file>]')
      const key = await readSuppliedValue(
        options.encKeyFile,
        'encryption key file',
        `Encryption key for "${options.kid}"`,
      )
      if (!key)
        fail('Missing encryption key: use --enc-key-file, pipe it on stdin, or run on a TTY')
      const result = await addEmbedKey(
        { ...where, kid: options.kid, key, note: options.notes, activate: !options.noActivate },
        env,
      )
      console.log(`Added encryption key "${result.kid}" to ${result.path}`)
      console.log(`  status: ${result.active ? 'active' : 'retired (not used for new secrets)'}`)
      return
    }
    case 'list': {
      const keys = await listEmbedKeys(where, env)
      console.log(defaultEmbedPath(env))
      const kidWidth = Math.max(3, ...keys.map((key) => key.kid.length))
      for (const key of keys) {
        const note = key.note ? `  ${key.note}` : ''
        console.log(
          `  ${key.kid.padEnd(kidWidth)}  ${key.status.padEnd(7)}  ${key.secrets} secret${key.secrets === 1 ? ' ' : 's'}  created ${key.createdAt}${note}`,
        )
      }
      return
    }
    case 'use':
      await useEmbedKey(needKid(), where, env)
      console.log(`Encryption key "${kidArg}" is now active for new secrets`)
      return
    case 'retire':
      await retireEmbedKey(needKid(), where, env)
      console.log(`Encryption key "${kidArg}" retired (still decrypts existing secrets)`)
      return
    case 'rm':
      await removeEmbedKey(needKid(), { ...where, force: options.force }, env)
      console.log(`Removed encryption key "${kidArg}"`)
      return
    case 'rotate': {
      const result = await rotateEmbedKeys(
        { ...where, kid: options.kid, note: options.notes, reencrypt: options.reencrypt },
        env,
      )
      console.log(`Generated and activated encryption key "${result.kid}" in ${result.path}`)
      console.log(
        options.reencrypt
          ? `  re-encrypted ${result.reencrypted} secret${result.reencrypted === 1 ? '' : 's'}`
          : '  existing secrets keep their old key (use --reencrypt to move them)',
      )
      return
    }
    default:
      return fail(usage)
  }
}

annotate(embedKeyringCommand, useCase('UC070'))

async function embedRekeyCommand(options: VaultOptions): Promise<void> {
  const env = embedEnv(options)
  const newPassword = await resolveNewPassword(options, env)
  const result = await rekeyEmbedStore({ path: options.path, newPassword }, env)
  console.log(
    `Re-keyed ${result.entries} secret${result.entries === 1 ? '' : 's'} in ${result.path}`,
  )
  console.log('  mode: 0600')
  console.log('  next: export the new password as MT_EMBED_PASSWORD (or MT_EMBED_PASSWORD_FILE)')
  console.log(
    '  tip: `mt vault embed-keyring rotate --reencrypt` also replaces the encryption keys',
  )
}

annotate(embedRekeyCommand, useCase('UC072'))

async function embedRotateCommand(options: VaultOptions): Promise<void> {
  const name = options.positionals[1]
  if (!name || options.secret !== undefined) {
    fail(
      'Usage: mt vault embed-rotate <name> [--value-file <file>] (value via file, stdin or hidden prompt; never an argument)',
    )
  }
  const env = embedEnv(options)
  const value = await readSuppliedValue(options.valueFile, 'value file', `New value for "${name}"`)
  if (!value) fail('Missing new value: use --value-file, pipe it on stdin, or run on a TTY')
  const result = await rotateEmbedSecret({ name, secret: value }, { path: options.path }, env)
  console.log(`Rotated embedded secret "${name}" in ${result.path}`)
  console.log(`  rotatedAt: ${result.rotatedAt}`)
}

annotate(embedRotateCommand, useCase('UC074'))

async function masterKeyCommandDispatch(options: VaultOptions): Promise<void> {
  const action = options.positionals[1]
  const env: NodeJS.ProcessEnv = { ...process.env }
  switch (action) {
    case 'generate':
      return masterKeyGenerateCommand(
        { path: options.path, user: options.user, force: options.force, rekey: options.rekey },
        env,
      )
    case 'status':
      return masterKeyStatusCommand(env)
    case 'show-path':
      return masterKeyShowPathCommand(env)
    default:
      return fail(
        'Usage: mt vault master-key <generate [--user] [--path <file>] [--force] [--rekey] | status | show-path>',
      )
  }
}

async function dispatch(args: string[]): Promise<void> {
  const options = parseArgs(args)
  if (options.help) {
    console.log(USAGE)
    return
  }
  const subcommand = options.positionals[0]
  if (!subcommand) {
    console.error(USAGE)
    fail('Missing vault subcommand')
  }
  const name = options.positionals[1] ?? ''
  const targets = resolveTargets(options, process.cwd(), process.env)
  switch (subcommand) {
    case 'list':
      return listCommand()
    case 'show':
      return showCommand(options, name)
    case 'add':
      return addCommand(options, name, targets)
    case 'rm':
      return rmCommand(options, name, targets)
    case 'path':
      return pathCommand(targets)
    case 'init':
      return initCommand(targets)
    case 'vlt-install':
      return vltInstallCommand()
    case 'vlt-status':
      return vltStatusCommand()
    case 'keepass-init':
      return keepassInitCommand(options)
    case 'keepass-add':
      return keepassAddCommand(options)
    case 'keepass-list':
      return keepassListCommand(options)
    case 'keepass-status':
      return keepassStatusCommand(options)
    case 'embed-init':
      return embedInitCommand(options)
    case 'embed-add':
      return embedAddCommand(options)
    case 'embed-list':
      return embedListCommand(options)
    case 'embed-status':
      return embedStatusCommand(options)
    case 'embed-keyring':
      return embedKeyringCommand(options)
    case 'embed-rekey':
      return embedRekeyCommand(options)
    case 'embed-rotate':
      return embedRotateCommand(options)
    case 'master-key':
      return masterKeyCommandDispatch(options)
    default:
      return fail(`Unknown vault subcommand: ${subcommand}\n\n${USAGE}`)
  }
}

/** `mt vault` — manage the gitignored vault of LLM endpoint data. */
export async function vaultCommand(args: string[]): Promise<void> {
  try {
    await dispatch(args)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

annotate(vaultCommand, useCase('UC073'))
