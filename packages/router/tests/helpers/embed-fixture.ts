import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'

const KEYRING_AAD = Buffer.from('mt-embed-v2-keyring', 'ascii')

function seal(key: Buffer, plaintext: string, aad: Buffer) {
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

/**
 * Fixture writer mirroring store format v2 (router tests must not import `@mt/*`): one random
 * encryption key per distinct `kid` (default `k1`), each secret sealed under its own key.
 */
export function encryptFixture(
  entries: Record<string, { secret: string; kid?: string }>,
  password: string,
): string {
  const keys: Record<string, Buffer> = {}
  for (const entry of Object.values(entries)) keys[entry.kid ?? 'k1'] ??= randomBytes(32)
  keys.k1 ??= randomBytes(32)
  const salt = randomBytes(16)
  const master = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const keyring = {
    keys: Object.fromEntries(
      Object.entries(keys).map(([kid, key]) => [
        kid,
        {
          key: key.toString('base64'),
          createdAt: '2026-01-01T00:00:00.000Z',
          status: kid === 'k1' ? 'active' : 'retired',
        },
      ]),
    ),
  }
  const secrets = Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => {
      const kid = entry.kid ?? 'k1'
      const aad = Buffer.from(`mt-embed-v2-secret:${kid}:${name}`, 'utf-8')
      const key = keys[kid] as Buffer
      return [
        name,
        {
          kid,
          ...seal(key, JSON.stringify({ secret: entry.secret }), aad),
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]
    }),
  )
  return JSON.stringify({
    version: 2,
    kdf: 'scrypt',
    n: 16384,
    r: 8,
    p: 1,
    salt: salt.toString('base64'),
    ...seal(master, JSON.stringify(keyring), KEYRING_AAD),
    secrets,
  })
}
