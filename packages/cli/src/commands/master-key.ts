import { existsSync } from 'node:fs'
import { readFile, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  DEFAULT_EMBED_PASSWORD,
  atomicWriteFile,
  defaultEmbedPath,
  generateMasterKey,
  masterKeyFileTooOpen,
  masterKeyPaths,
  masterKeyStatus,
  rekeyEmbedStore,
  resolveMasterKey,
  writeMasterKeyFile,
} from '@mt/core'

type Env = NodeJS.ProcessEnv

export interface GenerateMasterKeyOptions {
  /** Target file (default: project `.mt/master.key`, or the user one with `user`). */
  path?: string
  user?: boolean
  force?: boolean
  rekey?: boolean
}

export interface GenerateMasterKeyResult {
  path: string
  /** Number of secrets in the embed store that were re-wrapped (0 without `rekey`). */
  rekeyed: number
  storeExists: boolean
}

/** Default master key location for the project at `cwd` (or the user one). */
export function masterKeyTarget(options: { path?: string; user?: boolean }, env: Env): string {
  if (options.path) return resolve(options.path)
  const paths = masterKeyPaths(env)
  return options.user ? paths.user : paths.project
}

/**
 * Create a master key file. Never prints or returns the key. When an embed store already
 * exists it is sealed under the current password, so a new key file would lock it:
 * `rekey` re-wraps it under the new key (rolled back on failure); `force` skips that and
 * leaves the store unreadable until re-keyed by hand.
 */
export async function generateMasterKeyFile(
  options: GenerateMasterKeyOptions,
  env: Env,
): Promise<GenerateMasterKeyResult> {
  const target = masterKeyTarget(options, env)
  const storePath = defaultEmbedPath(env)
  const storeExists = existsSync(storePath)
  if (storeExists && !options.rekey && !options.force) {
    throw new Error(
      `An embedded store already exists (${storePath}) and is sealed under the current master password; a new key file would make it unreadable. Use --rekey to re-wrap it under the new key (or --force to proceed anyway and lose access).`,
    )
  }
  const previous = await readFile(target, 'utf-8').catch(() => undefined)
  if (options.rekey && storeExists) {
    const current = await resolveMasterKey(env)
    if (current && (current.source === 'env' || current.source === 'env-file')) {
      throw new Error(
        'The store password comes from MT_EMBED_PASSWORD(_FILE), which would keep overriding a key file: unset it, or use `mt vault embed-rekey` to change the password.',
      )
    }
    const key = generateMasterKey()
    await writeMasterKeyFile(target, { force: options.force, key })
    try {
      const after = await resolveMasterKey(env)
      if (after?.path !== target) {
        throw new Error(
          `${after?.path ?? 'another source'} takes precedence over ${target}: remove it or target that file`,
        )
      }
      const result = await rekeyEmbedStore(
        {
          path: storePath,
          currentPassword: current?.password ?? DEFAULT_EMBED_PASSWORD,
          newPassword: key,
        },
        env,
      )
      return { path: target, rekeyed: result.entries, storeExists }
    } catch (err) {
      if (previous === undefined) await unlink(target).catch(() => {})
      else await atomicWriteFile(target, previous)
      throw err
    }
  }
  await writeMasterKeyFile(target, { force: options.force })
  return { path: target, rekeyed: 0, storeExists }
}

export type ProjectMasterKeyOutcome =
  | { status: 'created'; path: string }
  | { status: 'exists'; path: string }
  | { status: 'skipped'; reason: string }

/**
 * `mt init` hook: give a new project its own master key unless one is already configured
 * (a project key would shadow it) or an embed store exists (a new key would lock it).
 */
export async function ensureProjectMasterKey(
  projectRoot: string,
  env: Env = process.env,
): Promise<ProjectMasterKeyOutcome> {
  const scoped: Env = { ...env, MT_PROJECT_ROOT: projectRoot }
  const path = join(resolve(projectRoot), '.mt', 'master.key')
  if (existsSync(path)) return { status: 'exists', path }
  const active = await masterKeyStatus(scoped)
  if (active.source !== 'default') {
    return {
      status: 'skipped',
      reason: `master key already configured (${active.source}${active.path ? `: ${active.path}` : ''})`,
    }
  }
  const store = defaultEmbedPath(scoped)
  if (existsSync(store)) {
    return {
      status: 'skipped',
      reason: `embedded store ${store} exists: run \`mt vault master-key generate --rekey\` to move it to a private key`,
    }
  }
  await writeMasterKeyFile(path)
  return { status: 'created', path }
}

const SOURCE_LABEL: Record<string, string> = {
  env: 'MT_EMBED_PASSWORD',
  'env-file': 'MT_EMBED_PASSWORD_FILE',
  project: 'project master.key',
  user: 'user master.key',
  default: 'built-in default (obfuscation only, public password)',
}

export async function masterKeyStatusCommand(env: Env): Promise<void> {
  const active = await masterKeyStatus(env)
  const paths = masterKeyPaths(env)
  console.log(`source: ${active.source} (${SOURCE_LABEL[active.source]})`)
  if (active.path) {
    console.log(`  path: ${active.path}`)
    const mode = (await stat(active.path)).mode & 0o777
    const open = await masterKeyFileTooOpen(active.path)
    console.log(
      `  mode: ${mode.toString(8).padStart(4, '0')}${open ? ' (too open: run chmod 600)' : ' ok'}`,
    )
  }
  console.log(
    `project key: ${paths.project} (${existsSync(paths.project) ? 'present' : 'missing'})`,
  )
  console.log(`user key:    ${paths.user} (${existsSync(paths.user) ? 'present' : 'missing'})`)
  if (active.source === 'default') {
    console.log('  next: run `mt vault master-key generate` (add --rekey if a store exists)')
  }
}

export function masterKeyShowPathCommand(env: Env): void {
  const paths = masterKeyPaths(env)
  console.log(`project: ${paths.project}`)
  console.log(`user:    ${paths.user}`)
}

export async function masterKeyGenerateCommand(
  options: GenerateMasterKeyOptions,
  env: Env,
): Promise<void> {
  const result = await generateMasterKeyFile(options, env)
  console.log(`Generated master key: ${result.path} (mode 0600)`)
  if (result.rekeyed > 0 || (options.rekey && result.storeExists)) {
    console.log(
      `  re-keyed ${result.rekeyed} secret${result.rekeyed === 1 ? '' : 's'} in the embedded store`,
    )
  } else if (result.storeExists) {
    console.log(
      '  WARNING: existing embedded store is now unreadable until re-keyed (it was sealed under the previous password)',
    )
  }
  console.log(
    `  BACK UP ${result.path}: losing it makes embed secrets unrecoverable. Do not commit it.`,
  )
}
