/** Replacement written over every credential-looking value. */
export const MASKED = '***'

/**
 * Keys whose values are treated as credentials (`apiKey`, `apiKeys`, `tokens`,
 * `authorization`, `openrouterKey`, `client_secret`, ...). `mt info` uses this masker;
 * `mt explain` keeps its own narrower env-only masker.
 */
const SECRET_KEY_PATTERN =
  /(?:^|_)(api_?keys?|tokens?|secrets?|passwords?|passwd|credentials?|private_key|auth|authorization|bearer|access_key|client_secret|(?:[a-z0-9]+_)*keys?)(?:_|$)/i

/**
 * `secrets` is a config container, not a secret: its `envFile` path must stay readable.
 * Child keys are still inspected (and masked when they look like credentials).
 */
const SECRET_CONTAINER_KEYS = new Set(['secrets'])

/** Path-valued config keys: never treat the value itself as a credential. */
const PATH_VALUE_KEYS = new Set(['envfile'])

const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /^(?:Bearer|Basic|Digest)\s+\S+/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i,
  /^(?:[0-9a-f]{32,}|[A-Za-z0-9+=_-]{32,})$/,
]

/** True when a config key names a credential. */
export function isCredentialKey(key: string): boolean {
  const normalized = normalizeKey(key)
  return SECRET_KEY_PATTERN.test(normalized) && !SECRET_CONTAINER_KEYS.has(normalized)
}

/** `apiKey`/`x-api-key`/`api.key` all normalize to the same `api_key` token. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.-]/g, '_')
    .toLowerCase()
}

/** True when a free-form string itself looks like a credential. */
export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))
}

/**
 * Recursively mask credentials in a config-like value.
 *
 * - A key matching {@link isCredentialKey} replaces its whole value with `***`.
 * - String values that look like credentials (`sk-...`, `Bearer ...`, URLs with
 *   `user:pass@`, long hex/base64-ish blobs) are replaced with `***`.
 * - Arrays and plain objects are copied; nothing is mutated.
 */
export function maskSecrets<T>(value: T): T {
  return maskValue(value, undefined) as T
}

function maskValue(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && isCredentialKey(key)) return MASKED
  if (typeof value === 'string') {
    return key !== undefined && PATH_VALUE_KEYS.has(key.toLowerCase())
      ? value
      : looksLikeCredential(value)
        ? MASKED
        : value
  }
  if (Array.isArray(value)) return value.map((entry) => maskValue(entry, undefined))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    // `secrets` is a container: mask every child value except the env-file path, so
    // an unknown key there cannot leak a credential just because its name is unusual.
    const secretContainer = key?.toLowerCase() === 'secrets'
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] =
        secretContainer && childKey.toLowerCase() !== 'envfile'
          ? MASKED
          : maskValue(childValue, childKey)
    }
    return out
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
