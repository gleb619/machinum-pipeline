import { createHash, timingSafeEqual } from 'node:crypto'
import { isSecretRef, readMtConfig, resolveEmbedValue } from '@mt/core'
import { resolveKeepassValue, resolveVltValue } from '@mt/plugins'

type Env = Record<string, string | undefined>

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i

/** True for `localhost`, `127.0.0.0/8`, `::1` and `[::1]`. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.trim())
}

/**
 * The admin API can start runs and read project state. A non-loopback bind is therefore
 * refused unless a token is configured. Throws with a fix hint otherwise.
 */
export function assertSafeServeBind(host: string, token: string | undefined): void {
  if (isLoopbackHost(host) || token) return
  throw new Error(
    [
      `Refusing to bind the admin API to non-loopback host '${host}' without a token.`,
      'Set MT_SERVE_TOKEN=<secret> or pass --token-ref <ENV_OR_REF>',
      '(clients send Authorization: Bearer <secret>), or bind to 127.0.0.1 / localhost.',
    ].join(' '),
  )
}

const BEARER = /^Bearer\s+(.+)$/i

/**
 * Constant-time bearer comparison. Both sides are SHA-256 digested first, so the
 * comparison never leaks the expected token's length.
 */
export function checkBearer(header: string | undefined, token: string): boolean {
  const match = BEARER.exec(header ?? '')
  const given = match?.[1]?.trim()
  if (!given) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(token).digest()
  return timingSafeEqual(a, b)
}

function envValue(name: string, env: Env): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(
      `Serve token environment variable "${name}" is not set or empty. Set it to the bearer secret.`,
    )
  }
  return value
}

async function resolveSecretRef(ref: string, env: Env): Promise<string> {
  let value = ref
  value = await resolveVltValue(value, env)
  value = await resolveKeepassValue(value, env)
  return resolveEmbedValue(value, env)
}

/** Resolve an explicit `env:NAME`, secret ref, or plaintext token (explicit/env only). */
async function resolveTokenValue(value: string, env: Env): Promise<string> {
  if (value.startsWith('env:')) return envValue(value.slice('env:'.length), env)
  if (isSecretRef(value)) return resolveSecretRef(value, env)
  return value
}

/**
 * Resolve `--token-ref <ENV_OR_REF>`: a bare name names an environment variable,
 * `env:NAME` does the same explicitly, and `vlt:` / `keepass:` / `embed:` refs are
 * resolved through the core vault machinery. Plaintext is deliberately not accepted.
 */
export async function resolveServeTokenRef(ref: string, env: Env = process.env): Promise<string> {
  const value = ref.trim()
  if (value === '')
    throw new Error('--token-ref requires an environment variable name or secret ref')
  if (value.startsWith('env:')) return envValue(value.slice('env:'.length), env)
  if (isSecretRef(value)) return resolveSecretRef(value, env)
  return envValue(value, env)
}

export interface ResolveServeTokenOptions {
  /** Explicit token or ref, highest priority (CLI `--token-ref`, `startBackend({ token })`). */
  token?: string
  /** Environment map; defaults to `process.env`. */
  env?: Env
  /** Project root for `mt.json -> serve.tokenRef`; defaults to `MT_PROJECT_ROOT` or cwd. */
  projectRoot?: string
}

/**
 * Token precedence: explicit `token` > `MT_SERVE_TOKEN` > `mt.json -> serve.tokenRef`.
 * Environment/explicit values may be plaintext or a secret ref; the config value must be
 * a ref so `mt.json` never carries a plaintext secret.
 */
export async function resolveServeToken(
  options: ResolveServeTokenOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env
  const explicit = options.token?.trim()
  if (explicit) return resolveTokenValue(explicit, env)

  const fromEnv = env.MT_SERVE_TOKEN?.trim()
  if (fromEnv) return resolveTokenValue(fromEnv, env)

  const projectRoot = options.projectRoot ?? env.MT_PROJECT_ROOT ?? process.cwd()
  const config = await readMtConfig(projectRoot)
  const ref = config.serve?.tokenRef?.trim()
  if (!ref) return undefined
  if (ref.startsWith('env:') || isSecretRef(ref)) return resolveTokenValue(ref, env)
  throw new Error(
    'Invalid mt.json serve.tokenRef: expected a secret reference (env:NAME, vlt:NAME, keepass:TITLE or embed:NAME), not plaintext.',
  )
}
