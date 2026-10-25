import { execFileSync } from 'node:child_process'
import { constants, accessSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Router-local vlt backend. Deliberate duplicate of `packages/core/src/vlt.ts`
 * (the router is standalone and must not import `@mt/*`; keep both in sync).
 *
 * Vault `apiKey` / `apiKeys[]` values of the form `vlt:<name>` are vlt secret
 * references, resolved synchronously via `vlt show <name> --stdout`. Everything
 * is sync here because the vault reader and hot-reload poll are sync.
 *
 * Resolved values are memoized by secret name so the ≤2s hot-reload poll never
 * forks `vlt` repeatedly; a failed `vlt show` clears the memo entry so the next
 * reload re-resolves. Errors are sanitized — process output may contain secret
 * material and never leaks.
 */

export const VLT_REF_PREFIX = 'vlt:'

const VLT_INSTALL_HINT =
  'vlt binary not found. Install it with `mt vault vlt-install`, or run: ' +
  'curl -sSL https://raw.githubusercontent.com/ladzaretti/vlt-cli/main/install.sh | bash'

type Env = Record<string, string | undefined>

function vltBinDir(env: Env = process.env): string {
  return join(env.MT_HOME || join(env.HOME || homedir(), '.mt'), 'bin')
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let cachedBinary: string | undefined | null = null
const secretMemo = new Map<string, string>()

/** Locate the vlt binary: `vlt` on PATH first, then `$MT_HOME|~/.mt/bin/vlt`. */
export function findVltSync(env: Env = process.env): string | undefined {
  if (cachedBinary !== null) return cachedBinary
  let found: string | undefined
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, 'vlt')
    if (isExecutable(candidate)) {
      found = candidate
      break
    }
  }
  if (found === undefined) {
    const managed = join(vltBinDir(env), 'vlt')
    if (isExecutable(managed)) found = managed
  }
  cachedBinary = found
  return found
}

/** Forget memoized state (tests). */
export function resetVltState(): void {
  cachedBinary = null
  secretMemo.clear()
}

export function isVltRef(value: string): boolean {
  return value.startsWith(VLT_REF_PREFIX)
}

/**
 * Resolve one vault key value: non-`vlt:` values pass through unchanged; refs
 * resolve via `vlt show` (memoized per secret name). Disabled when `MT_VLT=false`.
 */
export function resolveVltValueSync(value: string, env: Env = process.env): string {
  if (!isVltRef(value) || env.MT_VLT === 'false') return value
  const name = value.slice(VLT_REF_PREFIX.length)
  if (name === '') throw new Error('Invalid vlt secret reference "vlt:" (missing secret name)')
  const memoized = secretMemo.get(name)
  if (memoized !== undefined) return memoized
  const binary = findVltSync(env)
  if (binary === undefined) throw new Error(VLT_INSTALL_HINT)
  const value2 = runVltShow(binary, name)
  secretMemo.set(name, value2)
  return value2
}

/** Memoized resolved values, for redaction of anything that leaves the router. */
export function memoizedVltSecrets(): string[] {
  return [...secretMemo.values()]
}

function runVltShow(binary: string, name: string): string {
  let stdout: string
  let stderr: string
  try {
    const out = execFileSync(binary, ['show', name, '--stdout'], {
      env: {
        ...process.env,
        VLT_CONFIG_PATH: process.env.VLT_CONFIG_PATH ?? join(homedir(), '.vlt.toml'),
      },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    })
    stdout = out
    stderr = ''
  } catch (err) {
    const failed = err as { code?: string; stdout?: string | Buffer; stderr?: string | Buffer }
    stdout = typeof failed.stdout === 'string' ? failed.stdout : (failed.stdout?.toString() ?? '')
    stderr = typeof failed.stderr === 'string' ? failed.stderr : (failed.stderr?.toString() ?? '')
    // Session expiry invalidates the memoized value: the next reload re-resolves.
    secretMemo.delete(name)
    throw classifyVltError(name, err, stderr)
  }
  const value = stdout.replace(/\s+$/, '')
  if (value === '') {
    secretMemo.delete(name)
    throw new Error(`vlt secret "${name}" resolved to an empty value`)
  }
  return value
}

/** Map a failed `vlt show` to a sanitized, actionable error. Output never leaks. */
function classifyVltError(name: string, error: unknown, stderr: string): Error {
  const code = (error as { code?: string }).code
  if (code === 'ENOENT') return new Error(VLT_INSTALL_HINT)
  if (/not[ -]?found|no such secret|does not exist|unknown secret/i.test(stderr)) {
    return new Error(`Secret "${name}" not found in vlt vault. Run \`vlt find\` to list secrets.`)
  }
  if (/session|locked|unauthor|not logged|authentication/i.test(stderr)) {
    return new Error('vlt session expired or vault locked. Run `vlt login` and retry.')
  }
  return new Error(`Failed to resolve vlt secret "${name}".`)
}
