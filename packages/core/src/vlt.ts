import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { tmpPathFor } from './atomic.js'

/**
 * vlt (https://github.com/ladzaretti/vlt-cli) backend for vault secrets.
 *
 * A vault `apiKey` / `apiKeys[]` value of the form `vlt:<name>` is a vlt secret
 * reference, resolved at load time via `vlt show <name> --stdout`. Resolution is
 * in-memory only: the vault file on disk keeps the original refs. All errors are
 * sanitized — stdout/stderr of the vlt process may contain secret material and
 * never leaks into error messages.
 *
 * Binary acquisition: `vlt` on PATH, then an mt-managed copy in `$MT_HOME|~/.mt/bin`.
 * `installVlt()` downloads the latest Linux release from GitHub into that directory.
 */

export const VLT_REF_PREFIX = 'vlt:'

const VLT_REPO = 'ladzaretti/vlt-cli'
const VLT_INSTALL_HINT =
  'vlt binary not found. Install it with `mt vault vlt-install`, or run: ' +
  'curl -sSL https://raw.githubusercontent.com/ladzaretti/vlt-cli/main/install.sh | bash'

const VLT_STATIC_BUILD_HINT =
  'Build a static binary instead: ' +
  'docker run --rm -v ~/.mt/bin:/out golang:1.24 bash -c ' +
  "'git clone --depth 1 https://github.com/ladzaretti/vlt-cli /src && cd /src && " +
  "CGO_ENABLED=0 make build && cp bin/vlt bin/vltd /out/'"

type Env = Record<string, string | undefined>

/** Directory holding the mt-managed vlt binary. */
export function vltBinDir(env: Env = process.env): string {
  return join(env.MT_HOME || join(env.HOME || homedir(), '.mt'), 'bin')
}

/** True when a vault value is a vlt secret reference. */
export function isVltRef(value: string): boolean {
  return value.startsWith(VLT_REF_PREFIX)
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK)
    .then(() => true)
    .catch(() => false)
}

/** True when the binary actually runs (guards against glibc-mismatched downloads). */
async function runsOk(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(path, ['version'], { timeout: 10_000 }, (error) => resolve(error === null))
  })
}

let cachedBinary: Promise<string | undefined> | undefined

/**
 * Locate the vlt binary: `vlt` on PATH first, then `$MT_HOME|~/.mt/bin/vlt`.
 * Memoized per process.
 */
export function findVlt(env: Env = process.env): Promise<string | undefined> {
  cachedBinary ??= locateVlt(env)
  return cachedBinary
}

async function locateVlt(env: Env): Promise<string | undefined> {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, 'vlt')
    if (await isExecutable(candidate)) return candidate
  }
  const managed = join(vltBinDir(env), 'vlt')
  if (await isExecutable(managed)) return managed
  return undefined
}

/** Same as {@link findVlt}, but the candidate must also respond to `vlt version`. */
/** Forget memoized state (post-install, tests). */
export function resetVltCache(): void {
  cachedBinary = undefined
  installAttempted = false
}

export function vltResolutionDisabled(env: Env = process.env): boolean {
  return env.MT_VLT === 'false'
}

/**
 * Read a secret from vlt. Never includes process output in thrown errors.
 */
export async function getVltSecret(name: string, env: Env = process.env): Promise<string> {
  const binary = await findVlt(env)
  if (!binary) throw new Error(VLT_INSTALL_HINT)
  return runVltShow(binary, name)
}

function runVltShow(binary: string, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['show', name, '--stdout'],
      {
        env: {
          ...process.env,
          VLT_CONFIG_PATH: process.env.VLT_CONFIG_PATH ?? join(homedir(), '.vlt.toml'),
        },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(classifyVltError(name, error, stderr))
          return
        }
        const value = stdout.replace(/\s+$/, '')
        if (value === '') {
          reject(new Error(`vlt secret "${name}" resolved to an empty value`))
          return
        }
        resolve(value)
      },
    )
  })
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

let installAttempted = false

/**
 * Resolve one vault key value: non-`vlt:` values pass through unchanged; refs are
 * resolved via `vlt show`. When no binary exists, installs one on demand (once)
 * and retries. Resolution is disabled entirely when `MT_VLT=false`.
 */
export async function resolveVltValue(value: string, env: Env = process.env): Promise<string> {
  if (!isVltRef(value) || vltResolutionDisabled(env)) return value
  const name = value.slice(VLT_REF_PREFIX.length)
  if (name === '') throw new Error('Invalid vlt secret reference "vlt:" (missing secret name)')
  let binary = await findVlt(env)
  if (!binary) {
    if (installAttempted) throw new Error(VLT_INSTALL_HINT)
    installAttempted = true
    await installVlt(env)
    binary = await findVlt(env)
  }
  if (!binary) throw new Error(VLT_INSTALL_HINT)
  return runVltShow(binary, name)
}

const GO_ARCH: Record<string, string> = { x64: 'amd64', arm64: 'arm64', ia32: '386' }

interface GithubAsset {
  name: string
  browser_download_url?: string
}

interface GithubRelease {
  tag_name?: string
  assets?: GithubAsset[]
}

/**
 * Download the latest vlt-cli release for this platform into `$MT_HOME|~/.mt/bin`
 * (mode 0755, temp-then-rename). Linux only. Returns the installed `vlt` path.
 */
export async function installVlt(env: Env = process.env): Promise<string> {
  if (process.platform !== 'linux') {
    throw new Error(
      `vlt install: unsupported platform "${process.platform}" — vlt provides Linux binaries only`,
    )
  }
  const arch = GO_ARCH[process.arch]
  if (arch === undefined) {
    throw new Error(`vlt install: unsupported architecture "${process.arch}"`)
  }
  const release = await fetchLatestRelease()
  const asset = pickAsset(release.assets ?? [], arch)
  if (asset?.browser_download_url === undefined) {
    throw new Error(`vlt install: no linux/${arch} asset in the latest vlt-cli release`)
  }
  const archive = await downloadAsset(asset.browser_download_url)
  const files = extractBinaries(asset.name, archive)
  const dir = vltBinDir(env)
  await mkdir(dir, { recursive: true })
  let main: string | undefined
  for (const [fileName, content] of files) {
    const target = join(dir, fileName)
    const tmp = tmpPathFor(target)
    await writeFile(tmp, content, { mode: 0o755 })
    await rename(tmp, target)
    if (fileName === 'vlt') main = target
  }
  resetVltCache()
  if (main === undefined) throw new Error('vlt install: archive contained no vlt binary')
  if (!(await runsOk(main))) {
    for (const [fileName] of files) await rm(join(dir, fileName), { force: true })
    throw new Error(
      `vlt install: the downloaded binary does not run on this system (glibc mismatch?). ${VLT_STATIC_BUILD_HINT}`,
    )
  }
  return main
}

function pickAsset(assets: GithubAsset[], arch: string): GithubAsset | undefined {
  const wanted = assets.filter(
    (a) =>
      a.name.includes('linux') &&
      a.name.includes(arch) &&
      (a.name.endsWith('.tar.gz') || a.name.endsWith('.zip')),
  )
  return wanted.find((a) => a.name.endsWith('.tar.gz')) ?? wanted[0]
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  let res: Response
  try {
    res = await fetch(`https://api.github.com/repos/${VLT_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mt-pipeline' },
    })
  } catch {
    throw new Error('vlt install: failed to reach GitHub (network error)')
  }
  if (!res.ok) throw new Error(`vlt install: GitHub API returned HTTP ${res.status}`)
  try {
    return (await res.json()) as GithubRelease
  } catch {
    throw new Error('vlt install: unexpected GitHub API response')
  }
}

async function downloadAsset(url: string): Promise<Buffer> {
  let res: Response
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'mt-pipeline' } })
  } catch {
    throw new Error('vlt install: failed to download the vlt release asset (network error)')
  }
  if (!res.ok) throw new Error(`vlt install: download failed with HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error('vlt install: downloaded asset is empty')
  return buf
}

const TAR_BLOCK = 512
const ZIP_LOCAL_HEADER = 0x04034b50
const ZIP_CENTRAL_HEADER = 0x02014b50
const ZIP_EOCD = 0x06054b50

/** Extract `vlt`/`vltd` from a release archive (tar.gz or zip). Stdlib only. */
function extractBinaries(assetName: string, archive: Buffer): Array<[string, Buffer]> {
  try {
    if (assetName.endsWith('.zip')) return extractZip(archive)
    return extractTarGz(archive)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('vlt install:')) throw err
    throw new Error('vlt install: failed to extract the release archive')
  }
}

function extractTarGz(archive: Buffer): Array<[string, Buffer]> {
  const tar = gunzipSync(archive)
  const out: Array<[string, Buffer]> = []
  let offset = 0
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf-8').replace(/\0.*$/, '')
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const size = Number.parseInt(
      header.subarray(124, 136).toString('utf-8').replace(/\0.*$/, '').trim(),
      8,
    )
    if (!Number.isFinite(size) || size < 0) break
    const base = fullName.split('/').pop() ?? fullName
    if (!fullName.endsWith('/') && (base === 'vlt' || base === 'vltd')) {
      out.push([base, Buffer.from(tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size))])
    }
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  if (out.length === 0) throw new Error('vlt install: archive contained no vlt binary')
  return out
}

function extractZip(archive: Buffer): Array<[string, Buffer]> {
  let eocd = -1
  const scanStart = Math.max(0, archive.length - 22 - 65_536)
  for (let i = archive.length - 22; i >= scanStart; i--) {
    if (archive.readUInt32LE(i) === ZIP_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('vlt install: failed to extract the release archive')
  const count = archive.readUInt16LE(eocd + 10)
  let offset = archive.readUInt32LE(eocd + 16)
  const out: Array<[string, Buffer]> = []
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) break
    const method = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const nameLen = archive.readUInt16LE(offset + 28)
    const extraLen = archive.readUInt16LE(offset + 30)
    const commentLen = archive.readUInt16LE(offset + 32)
    const localOffset = archive.readUInt32LE(offset + 42)
    const name = archive.subarray(offset + 46, offset + 46 + nameLen).toString('utf-8')
    const base = name.split('/').pop() ?? name
    if (!name.endsWith('/') && (base === 'vlt' || base === 'vltd')) {
      if (archive.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) {
        throw new Error('vlt install: failed to extract the release archive')
      }
      const localNameLen = archive.readUInt16LE(localOffset + 26)
      const localExtraLen = archive.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      const raw = archive.subarray(dataStart, dataStart + compressedSize)
      const content =
        method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : undefined
      if (content === undefined) {
        throw new Error('vlt install: unsupported compression in the release archive')
      }
      out.push([base, content])
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  if (out.length === 0) throw new Error('vlt install: archive contained no vlt binary')
  return out
}
