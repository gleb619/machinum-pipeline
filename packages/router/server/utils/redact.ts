import { getRouterConfig } from './router-config.js'
import { effectiveApiKeys, effectiveUpstreamSpecs } from './vault-upstreams.js'

/**
 * Secret scrubbing for anything that leaves the router (error bodies, logs, console). Known key
 * values (env, code, vault, router token) are replaced literally; unknown credentials are caught by
 * generic patterns (`Bearer <token>`, `sk-...`).
 */

const MASK = '***'
const MIN_SECRET_LENGTH = 4
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi
const SK_KEY = /\bsk-[A-Za-z0-9_-]{6,}/g
// Vault secret refs are not secrets themselves, but they name the secret — scrub them too.
const VLT_REF = /\bvlt:[A-Za-z0-9._-]+/g
const KEEPASS_REF = /\bkeepass:(?:\/\/)?[^\s,;]+/g
const EMBED_REF = /\bembed:(?:\/\/)?[^\s,;]+/g

function knownSecrets(): string[] {
  const secrets = new Set<string>()
  const add = (v: string | undefined) => {
    const s = v?.trim()
    if (s && s.length >= MIN_SECRET_LENGTH) secrets.add(s)
  }
  try {
    for (const k of effectiveApiKeys()) add(k)
    for (const spec of effectiveUpstreamSpecs()) {
      for (const k of spec.keys ?? []) add(k)
      for (const v of Object.values(spec.headers ?? {})) add(v)
    }
  } catch {
    // Redaction must never throw; fall through to config keys and patterns.
  }
  for (const k of getRouterConfig().apiKeys) add(k)
  add(getRouterConfig().token)
  // Longest first so a key that contains another is masked whole.
  return [...secrets].sort((a, b) => b.length - a.length)
}

export function redact(text: string): string {
  let out = text
  for (const secret of knownSecrets()) out = out.split(secret).join(MASK)
  return out
    .replace(BEARER, `Bearer ${MASK}`)
    .replace(SK_KEY, MASK)
    .replace(VLT_REF, `vlt:${MASK}`)
    .replace(KEEPASS_REF, `keepass:${MASK}`)
    .replace(EMBED_REF, `embed:${MASK}`)
}

export function redactError(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err))
}
