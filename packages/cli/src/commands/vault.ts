import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  VAULT_PROVIDERS,
  addEntry,
  addKeepassSecret,
  createKeepassDatabase,
  defaultKeepassPath,
  emptyVault,
  findVlt,
  installVlt,
  isVaultProvider,
  keepassCredentialsConfigured,
  listKeepassEntries,
  loadVault,
  maskSecret,
  maskVault,
  removeEntry,
  saveVault,
  vaultPaths,
} from '@mt/core'
import type { Vault, VaultEntry, VaultProvider } from '@mt/core'
import { VAULT_IGNORE_PATTERNS, ensureIgnorePatterns } from '../utils/gitignore.js'

const USAGE = `Usage: mt vault <subcommand> [options]

Manage the vault: gitignored store of LLM endpoint data (URLs, API keys, headers).

Subcommands:
  list                  List entries (provider, base URL, model count)
  show <name>           Show one entry (secrets masked)
  add <name>            Add an entry (flags, or prompts when a TTY is attached)
  rm <name>             Remove an entry
  path                  Print the resolved vault paths and whether they exist
  init                  Create an empty vault file
  vlt-install           Download the vlt binary into ~/.mt/bin
  vlt-status            Show vlt binary location, version and session state
  keepass-init          Create an empty KeePass database
  keepass-add <title>   Add or update an entry in the KeePass database
  keepass-list          List KeePass entry titles (no secrets)
  keepass-status        KeePass database path and whether it can be unlocked

Options:
  --provider <name>     Provider: ${VAULT_PROVIDERS.join(' | ')}
  --base-url <url>      Base URL of the endpoint
  --api-key <key>       API key (masked in all output)
  --api-keys <k1,k2>    API key pool
  --models <a,b>        Available models
  --default-model <m>   Default model
  --notes <text>        Free-form note
  --secret <value>      Secret value for keepass-add (never logged)
  --username <name>     User name for keepass-add
  --group <path>        KeePass group for keepass-add (e.g. LLM/API)
  --path <file>         KeePass database path (default $MT_KEEPASS_PATH or ~/.mt/secrets.kdbx)
  --key-file <file>     KeePass key file
  --user                Use the user vault (~/.mt/vault.json) instead of the project one
  --reveal              Print secret values unmasked
  --force               Overwrite an existing entry
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
  await saveVault(target, addEntry(existing, name, entry))
  console.log(`Added entry "${name}" to ${target}`)
  if (entry.apiKey) console.log(`  apiKey: ${maskSecret(entry.apiKey)}`)
  if (entry.apiKeys?.length) {
    console.log(`  apiKeys: ${entry.apiKeys.map((key) => maskSecret(key)).join(', ')}`)
  }
}

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

async function vltInstallCommand(): Promise<void> {
  const installed = await installVlt()
  console.log(`Installed vlt to ${installed}`)
  const version = vltVersion(installed)
  console.log(`  version: ${version ?? 'unknown (vlt --version failed)'}`)
}

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
