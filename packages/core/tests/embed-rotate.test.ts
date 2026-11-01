import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addEmbedKey,
  generateEmbedKey,
  getEmbedSecret,
  listEmbedEntries,
  listEmbedKeys,
  parseSuppliedEmbedKey,
  rekeyEmbedStore,
  removeEmbedKey,
  resetEmbedCache,
  resetEmbedDefaultWarning,
  resolveEmbedValue,
  retireEmbedKey,
  rotateEmbedKeys,
  rotateEmbedSecret,
  setEmbedSecret,
  useEmbedKey,
} from '../src/embed.js'

const OLD = 'old-master-password'
const NEW = 'new-master-password'
const SECRET = 'sk-or-v1-ROTATESECRET1234'
const NEXT_SECRET = 'sk-or-v1-NEXTSECRET5678'
const SUPPLIED = 'abcdefghijklmnop'

describe('embed rekey / rotate / keyring', () => {
  let dir: string
  let storePath: string

  const envWith = (password?: string): Record<string, string | undefined> => ({
    MT_EMBED_PATH: storePath,
    ...(password === undefined ? {} : { MT_EMBED_PASSWORD: password }),
  })
  const env = (): Record<string, string | undefined> => envWith(OLD)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-embed-rekey-'))
    storePath = join(dir, 'secrets.embed.json')
    resetEmbedCache()
    resetEmbedDefaultWarning()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    resetEmbedCache()
    await rm(dir, { recursive: true, force: true })
  })

  describe('master password rekey', () => {
    it('rekeys default -> custom password and the default stops working', async () => {
      await setEmbedSecret({ name: 'A', secret: SECRET }, {}, envWith())
      const result = await rekeyEmbedStore({ newPassword: NEW }, envWith())
      expect(result.entries).toBe(1)
      expect((await getEmbedSecret('A', envWith(NEW))).secret).toBe(SECRET)
      resetEmbedCache()
      await expect(getEmbedSecret('A', envWith())).rejects.toThrow('wrong master password')
      expect((await stat(storePath)).mode & 0o777).toBe(0o600)
    })

    it('rekeys custom -> custom with a fresh salt and nonce', async () => {
      await setEmbedSecret({ name: 'A', secret: SECRET }, {}, env())
      const before = JSON.parse(await readFile(storePath, 'utf-8')) as { salt: string; iv: string }
      await rekeyEmbedStore({ newPassword: NEW }, env())
      const after = JSON.parse(await readFile(storePath, 'utf-8')) as { salt: string; iv: string }
      expect(after.salt).not.toBe(before.salt)
      expect(after.iv).not.toBe(before.iv)
      resetEmbedCache()
      await expect(getEmbedSecret('A', env())).rejects.toThrow('wrong master password')
      expect((await getEmbedSecret('A', envWith(NEW))).secret).toBe(SECRET)
    })

    it('leaves the file byte-identical on a wrong current password, without leaking', async () => {
      await setEmbedSecret({ name: 'A', secret: SECRET }, {}, env())
      const before = await readFile(storePath)
      const err = await rekeyEmbedStore({ newPassword: NEW }, envWith('wrong-password')).catch(
        (e: unknown) => e as Error,
      )
      const message = (err as Error).message
      expect(message).toContain('wrong master password')
      for (const leaked of [SECRET, OLD, NEW, 'wrong-password']) {
        expect(message).not.toContain(leaked)
      }
      expect((await readFile(storePath)).equals(before)).toBe(true)
    })

    it('refuses new == current and an empty new password', async () => {
      await setEmbedSecret({ name: 'A', secret: SECRET }, {}, env())
      const before = await readFile(storePath)
      await expect(rekeyEmbedStore({ newPassword: OLD }, env())).rejects.toThrow('identical')
      await expect(rekeyEmbedStore({ newPassword: '' }, env())).rejects.toThrow('non-empty')
      expect((await readFile(storePath)).equals(before)).toBe(true)
    })

    it('leaves no temp files behind', async () => {
      await setEmbedSecret({ name: 'A', secret: SECRET }, {}, env())
      await rekeyEmbedStore({ newPassword: NEW }, env())
      expect(await readdir(dir)).toEqual(['secrets.embed.json'])
    })
  })

  describe('secret value rotation', () => {
    it('updates the value, keeps the name and metadata, stamps rotatedAt', async () => {
      await setEmbedSecret({ name: 'A', secret: SECRET, username: 'boris' }, {}, env())
      const result = await rotateEmbedSecret({ name: 'A', secret: NEXT_SECRET }, {}, env())
      const got = await getEmbedSecret('embed:A', env())
      expect(got.secret).toBe(NEXT_SECRET)
      expect(got.username).toBe('boris')
      const [info] = await listEmbedEntries(env())
      expect(info?.rotatedAt).toBe(result.rotatedAt)
      expect(info?.createdAt).toBeTypeOf('string')
      expect(JSON.stringify(info)).not.toContain(NEXT_SECRET)
      expect((await stat(storePath)).mode & 0o777).toBe(0o600)
    })

    it('errors on a missing secret and leaves the store untouched', async () => {
      await setEmbedSecret({ name: 'A', secret: SECRET }, {}, env())
      const before = await readFile(storePath)
      const err = await rotateEmbedSecret({ name: 'B', secret: NEXT_SECRET }, {}, env()).catch(
        (e: unknown) => e as Error,
      )
      expect((err as Error).message).toContain('mt vault embed-add B')
      expect((err as Error).message).not.toContain(NEXT_SECRET)
      expect((await readFile(storePath)).equals(before)).toBe(true)
    })

    it('re-seals under the active encryption key', async () => {
      await setEmbedSecret({ name: 'A', secret: SECRET }, {}, env())
      await generateEmbedKey({}, env())
      const result = await rotateEmbedSecret({ name: 'A', secret: NEXT_SECRET }, {}, env())
      expect(result.kid).toBe('k2')
      expect((await getEmbedSecret('A', env())).kid).toBe('k2')
    })
  })

  describe('keyring', () => {
    it('creates a store with a generated active key on first add', async () => {
      const { kid } = await setEmbedSecret({ name: 'A', secret: SECRET }, {}, env())
      expect(kid).toBe('k1')
      const keys = await listEmbedKeys({}, env())
      expect(keys).toEqual([expect.objectContaining({ kid: 'k1', status: 'active', secrets: 1 })])
      expect(JSON.stringify(keys)).not.toContain('"key"')
    })

    it('generates keys, uses a chosen key, and secrets under different kids both resolve', async () => {
      await setEmbedSecret({ name: 'A', secret: 'alpha' }, {}, env())
      const gen = await generateEmbedKey({ kid: 'prod', note: 'prod key' }, env())
      expect(gen).toMatchObject({ kid: 'prod', active: true })
      await setEmbedSecret({ name: 'B', secret: 'beta' }, {}, env())
      await setEmbedSecret({ name: 'C', secret: 'gamma' }, { kid: 'k1' }, env())

      expect((await getEmbedSecret('A', env())).kid).toBe('k1')
      expect((await getEmbedSecret('B', env())).kid).toBe('prod')
      expect(await resolveEmbedValue('embed:B', env())).toBe('beta')
      expect(await resolveEmbedValue('embed:C', env())).toBe('gamma')
      const keys = await listEmbedKeys({}, env())
      expect(keys.find((k) => k.kid === 'prod')).toMatchObject({
        status: 'active',
        note: 'prod key',
        secrets: 1,
      })
      expect(keys.find((k) => k.kid === 'k1')).toMatchObject({ status: 'retired', secrets: 2 })
    })

    it('--no-activate keeps the active key; use switches it', async () => {
      await setEmbedSecret({ name: 'A', secret: 'alpha' }, {}, env())
      const gen = await generateEmbedKey({ kid: 'spare', activate: false }, env())
      expect(gen.active).toBe(false)
      expect((await setEmbedSecret({ name: 'B', secret: 'b' }, {}, env())).kid).toBe('k1')
      await useEmbedKey('spare', {}, env())
      expect((await setEmbedSecret({ name: 'C', secret: 'c' }, {}, env())).kid).toBe('spare')
      await expect(useEmbedKey('nope', {}, env())).rejects.toThrow('not found')
    })

    it('a retired key still decrypts but is refused for activation-free retire of the active key', async () => {
      await setEmbedSecret({ name: 'A', secret: 'alpha' }, {}, env())
      await generateEmbedKey({ kid: 'k2' }, env())
      await retireEmbedKey('k1', {}, env())
      expect((await getEmbedSecret('A', env())).secret).toBe('alpha')
      await expect(retireEmbedKey('k2', {}, env())).rejects.toThrow('active')
    })

    it('rm refuses a key still in use unless forced, and never the active key', async () => {
      await setEmbedSecret({ name: 'A', secret: 'alpha' }, {}, env())
      await generateEmbedKey({ kid: 'k2' }, env())
      const before = await readFile(storePath)
      await expect(removeEmbedKey('k1', {}, env())).rejects.toThrow('still seals 1 secret')
      await expect(removeEmbedKey('k2', {}, env())).rejects.toThrow('active')
      expect((await readFile(storePath)).equals(before)).toBe(true)

      await removeEmbedKey('k1', { force: true }, env())
      expect((await listEmbedKeys({}, env())).map((k) => k.kid)).toEqual(['k2'])
      await expect(getEmbedSecret('A', env())).rejects.toThrow('not in the keyring')
    })

    it('rm removes an unused retired key without force', async () => {
      await setEmbedSecret({ name: 'A', secret: 'alpha' }, {}, env())
      await generateEmbedKey({ kid: 'spare', activate: false }, env())
      await removeEmbedKey('spare', {}, env())
      expect((await listEmbedKeys({}, env())).map((k) => k.kid)).toEqual(['k1'])
    })

    it('rotate adds and activates a key; --reencrypt moves every secret', async () => {
      await setEmbedSecret({ name: 'A', secret: 'alpha' }, {}, env())
      await setEmbedSecret({ name: 'B', secret: 'beta' }, {}, env())
      const plain = await rotateEmbedKeys({}, env())
      expect(plain).toMatchObject({ kid: 'k2', reencrypted: 0 })
      expect((await getEmbedSecret('A', env())).kid).toBe('k1')

      const full = await rotateEmbedKeys({ kid: 'k3', reencrypt: true }, env())
      expect(full).toMatchObject({ kid: 'k3', reencrypted: 2 })
      expect((await getEmbedSecret('A', env())).kid).toBe('k3')
      expect((await getEmbedSecret('B', env())).secret).toBe('beta')
      const keys = await listEmbedKeys({}, env())
      expect(keys.find((k) => k.kid === 'k3')?.secrets).toBe(2)
      // old key is now unused, so a plain rm works
      await removeEmbedKey('k1', {}, env())
      expect((await getEmbedSecret('B', env())).secret).toBe('beta')
    })

    it('accepts supplied keys (hex, base64, passphrase) and validates them', async () => {
      await setEmbedSecret({ name: 'A', secret: 'alpha' }, {}, env())
      await addEmbedKey({ kid: 'hex', key: 'ab'.repeat(32) }, env())
      await addEmbedKey({ kid: 'b64', key: Buffer.alloc(32, 7).toString('base64') }, env())
      await addEmbedKey({ kid: 'pass', key: 'correct horse battery staple' }, env())
      await setEmbedSecret({ name: 'B', secret: 'beta' }, { kid: 'hex' }, env())
      expect((await getEmbedSecret('B', env())).kid).toBe('hex')

      expect(parseSuppliedEmbedKey('ab'.repeat(32), 'x')).toHaveLength(32)
      expect(parseSuppliedEmbedKey(Buffer.alloc(32, 7).toString('base64'), 'x')).toHaveLength(32)
      expect(
        parseSuppliedEmbedKey('correct horse battery staple', 'x').equals(
          parseSuppliedEmbedKey('correct horse battery staple', 'y'),
        ),
      ).toBe(false)

      const err = await addEmbedKey({ kid: 'short', key: SUPPLIED.slice(0, 5) }, env()).catch(
        (e: unknown) => e as Error,
      )
      expect((err as Error).message).toContain('too short')
      expect((err as Error).message).not.toContain(SUPPLIED.slice(0, 5))
      await expect(addEmbedKey({ kid: 'hex', key: 'ab'.repeat(32) }, env())).rejects.toThrow(
        'already exists',
      )
      await expect(addEmbedKey({ kid: 'bad kid!', key: 'ab'.repeat(32) }, env())).rejects.toThrow(
        'Invalid encryption key id',
      )
      await expect(addEmbedKey({ kid: 'e', key: '' }, env())).rejects.toThrow('non-empty')
    })

    it('rekey keeps every kid and secret readable under the new master password', async () => {
      await setEmbedSecret({ name: 'A', secret: 'alpha' }, {}, envWith())
      await generateEmbedKey({ kid: 'prod' }, envWith())
      await setEmbedSecret({ name: 'B', secret: 'beta' }, {}, envWith())
      await rekeyEmbedStore({ newPassword: NEW }, envWith())
      expect(await resolveEmbedValue('embed:A', envWith(NEW))).toBe('alpha')
      expect((await getEmbedSecret('B', envWith(NEW))).kid).toBe('prod')
    })

    it('wrong master password changes nothing; no key material in file listings or errors', async () => {
      await setEmbedSecret({ name: 'A', secret: SECRET }, {}, env())
      const before = await readFile(storePath)
      const wrong = envWith('wrong-password')
      const attempts: Array<Promise<unknown>> = [
        generateEmbedKey({}, wrong),
        addEmbedKey({ kid: 'x', key: 'ab'.repeat(32) }, wrong),
        useEmbedKey('k1', {}, wrong),
        retireEmbedKey('k1', {}, wrong),
        removeEmbedKey('k1', { force: true }, wrong),
        rotateEmbedKeys({ reencrypt: true }, wrong),
        rotateEmbedSecret({ name: 'A', secret: NEXT_SECRET }, {}, wrong),
      ]
      for (const attempt of attempts) {
        const err = await attempt.catch((e: unknown) => e as Error)
        expect((err as Error).message).toContain('wrong master password')
        for (const leaked of [SECRET, NEXT_SECRET, 'wrong-password', 'ab'.repeat(32)]) {
          expect((err as Error).message).not.toContain(leaked)
        }
      }
      expect((await readFile(storePath)).equals(before)).toBe(true)

      const keys = await listEmbedKeys({}, env())
      const stored = await readFile(storePath, 'utf-8')
      expect(stored).not.toContain(SECRET)
      expect(JSON.stringify(keys)).not.toMatch(/[A-Za-z0-9+/]{43}=/)
    })

    it('a swapped ciphertext between entries fails authentication', async () => {
      await setEmbedSecret({ name: 'A', secret: 'alpha' }, {}, env())
      await setEmbedSecret({ name: 'B', secret: 'beta' }, {}, env())
      const file = JSON.parse(await readFile(storePath, 'utf-8')) as {
        secrets: Record<string, unknown>
      }
      const { writeFile } = await import('node:fs/promises')
      file.secrets.A = file.secrets.B
      await writeFile(storePath, JSON.stringify(file))
      resetEmbedCache()
      await expect(getEmbedSecret('A', env())).rejects.toThrow('cannot be decrypted')
    })
  })
})
