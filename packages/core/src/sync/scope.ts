import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, posix, resolve } from 'node:path'
import { DEFAULT_MT_CONFIG, readMtConfig } from '../config.js'
import type { SyncOutputScopeOptions, SyncScopeOptions } from 'types.js'

/** Default source scope: every pipeline module plus the project config. */
export const DEFAULT_SYNC_INCLUDE = ['pipelines/**', 'mt.json']

/**
 * Hard exclusions. These win over user globs and are also enforced by the server.
 * `vault.json`, `*.kdbx`, `*.embed.json`, `*.key` etc. are deliberately listed by
 * shape so a renamed secret store still cannot travel.
 */
export const DEFAULT_SYNC_EXCLUDE = [
  '.mt',
  '.mt/**',
  '.git',
  '.git/**',
  'node_modules',
  'node_modules/**',
  'dist',
  'dist/**',
  '.env',
  '.env.*',
  '*.env',
  'vault.json',
  '*.vault.json',
  '*.kdbx',
  '*.embed.json',
  '*.key',
  '*.pem',
  'master.key',
  'secrets.embed.json',
]

/** Per-file transfer cap when `mt.json -> remote.sync.maxFileBytes` is absent. */
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024

/** One HTTP request may carry at most this much file body. */
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024

/** A single mirrored project may occupy at most this much space. */
export const MAX_PROJECT_BYTES = 500 * 1024 * 1024

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const RESOLVE_EXTENSIONS = [...CODE_EXTENSIONS, '.json']
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function segmentMatches(pattern: string, segment: string): boolean {
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i)
    if (char === '*') {
      source += '.*'
    } else if (char === '?') {
      source += '.'
    } else if (char === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end === -1) {
        source += '\\['
      } else {
        const body = pattern.slice(i + 1, end)
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
        i = end
      }
    } else {
      source += escapeRegExp(char)
    }
  }
  source += '$'
  try {
    return new RegExp(source).test(segment)
  } catch {
    return false
  }
}

function matchSegments(
  pathSegments: readonly string[],
  patternSegments: readonly string[],
  pathIndex = 0,
  patternIndex = 0,
): boolean {
  if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length
  const pattern = patternSegments[patternIndex]
  if (pattern === undefined) return false
  if (pattern === '**') {
    for (let next = pathIndex; next <= pathSegments.length; next++) {
      if (matchSegments(pathSegments, patternSegments, next, patternIndex + 1)) return true
    }
    return false
  }
  const segment = pathSegments[pathIndex]
  if (segment === undefined || !segmentMatches(pattern, segment)) return false
  return matchSegments(pathSegments, patternSegments, pathIndex + 1, patternIndex + 1)
}

/** Minimal, dependency-free glob matcher used by both the CLI and the server. */
export function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = normalizePattern(path)
  const normalizedPattern = normalizePattern(pattern)
  if (normalizedPattern === '') return false
  const pathSegments = normalizedPath.split('/').filter(Boolean)
  const patternSegments = normalizedPattern.split('/').filter(Boolean)
  if (patternSegments.length === 0) return false
  // A slash-less pattern behaves like a basename match anywhere in the tree.
  if (patternSegments.length === 1 && !normalizedPattern.includes('/')) {
    const single = patternSegments[0]
    if (single === undefined) return false
    return pathSegments.some((segment) => segmentMatches(single, segment))
  }
  return matchSegments(pathSegments, patternSegments)
}

export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern))
}

/** Normalize a wire path to a POSIX path with no absolute prefix or `..` segment. */
export function normalizeSyncPath(input: string): string | undefined {
  if (typeof input !== 'string' || input === '' || input.includes('\0') || input.includes('\\')) {
    return undefined
  }
  if (isAbsolute(input) || /^[A-Za-z]:/.test(input)) return undefined
  const normalized = posix.normalize(input)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined
  if (normalized.startsWith('/')) return undefined
  return normalized
}

export function isSafeSyncPath(path: string): boolean {
  return normalizeSyncPath(path) !== undefined
}

function sensitiveBasename(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    lower.endsWith('.env') ||
    lower === 'vault.json' ||
    lower.endsWith('.vault.json') ||
    lower.endsWith('.kdbx') ||
    lower.endsWith('.embed.json') ||
    lower.endsWith('.key') ||
    lower.endsWith('.pem') ||
    lower === 'secrets.embed.json'
  )
}

/**
 * Hard exclusion check for manifest/transfer paths. `.mt/runs/<id>/...` may be
 * explicitly allowed for pull/output manifests, but secrets inside a run directory
 * are still rejected.
 */
export function isProtectedSyncPath(
  path: string,
  options: { allowRunState?: boolean } = {},
): boolean {
  const normalized = normalizeSyncPath(path)
  if (normalized === undefined) return true
  const segments = normalized.split('/')
  const name = segments.at(-1) ?? ''
  if (sensitiveBasename(name) || sensitiveBasename(segments[0] ?? '')) return true
  if (segments.includes('.git') || segments.includes('node_modules') || segments.includes('dist')) {
    return true
  }
  if (segments[0] === '.mt') {
    return !(options.allowRunState === true && segments[1] === 'runs' && segments.length >= 3)
  }
  return false
}

function isHardExcluded(path: string, options: SyncScopeOptions): boolean {
  const runStatePath = path === '.mt' || path === '.mt/runs' || path.startsWith('.mt/runs/')
  if (options.allowRunState === true && runStatePath) {
    return matchesAnyGlob(
      path,
      DEFAULT_SYNC_EXCLUDE.filter((pattern) => pattern !== '.mt' && pattern !== '.mt/**'),
    )
  }
  if (isProtectedSyncPath(path, { allowRunState: options.allowRunState })) return true
  return matchesAnyGlob(path, DEFAULT_SYNC_EXCLUDE)
}

function toPosixPath(path: string): string {
  return path.split('\\').join('/')
}

async function walkDirectory(
  root: string,
  relativeDir: string,
  options: SyncScopeOptions,
  out: string[],
): Promise<void> {
  let entries: Dirent[] = []
  try {
    entries = await readdir(join(root, relativeDir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
    if (isHardExcluded(relativePath, options)) continue
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await walkDirectory(root, relativePath, options, out)
    } else if (entry.isFile()) {
      out.push(relativePath)
    }
  }
}

/**
 * Walk regular files under `root`, skipping symlinks and hard exclusions. User excludes
 * are applied on top; `include` (when given) only filters the result.
 */
export async function walkSyncFiles(
  root: string,
  options: SyncScopeOptions = {},
): Promise<string[]> {
  const files: string[] = []
  await walkDirectory(root, '', options, files)
  const excludes = options.exclude ?? []
  const includes = options.include
  return files
    .filter((path) => !matchesAnyGlob(path, excludes))
    .filter(
      (path) => includes === undefined || includes.length === 0 || matchesAnyGlob(path, includes),
    )
    .sort()
}

function extractSpecifiers(source: string): string[] {
  const specifiers = new Set<string>()
  const pattern =
    /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  let match = pattern.exec(source)
  while (match) {
    const specifier = match[1]
    if (specifier !== undefined) specifiers.add(specifier)
    match = pattern.exec(source)
  }
  return [...specifiers]
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

export async function resolveLocalImport(
  root: string,
  importer: string,
  specifier: string,
): Promise<string | undefined> {
  if (!specifier.startsWith('.')) return undefined
  const clean = specifier.split('?')[0]?.split('#')[0] ?? specifier
  const candidate = toPosixPath(
    posix.normalize(posix.join(posix.dirname(importer), clean)).replace(/^\/+/, ''),
  )
  if (candidate.startsWith('../') || candidate === '..') return undefined

  const absolute = join(root, ...candidate.split('/'))
  if (await isRegularFile(absolute)) return candidate
  // TS ESM projects import `./helper.js` while the file on disk is `helper.ts`.
  const jsSuffix = /\.(?:js|mjs|cjs)$/.exec(candidate)
  if (jsSuffix) {
    const stem = candidate.slice(0, -jsSuffix[0].length)
    const replacements =
      jsSuffix[0] === '.mjs'
        ? ['.mts', '.ts']
        : jsSuffix[0] === '.cjs'
          ? ['.cts', '.ts']
          : ['.ts', '.tsx']
    const stemAbsolute = join(root, ...stem.split('/'))
    for (const extension of replacements) {
      if (await isRegularFile(`${stemAbsolute}${extension}`)) return `${stem}${extension}`
    }
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    if (await isRegularFile(`${absolute}${extension}`)) return `${candidate}${extension}`
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    const index = `${candidate}/index${extension}`
    if (await isRegularFile(join(root, ...index.split('/')))) return index
  }
  return undefined
}

function pipelineConfigPaths(): string[] {
  return DEFAULT_MT_CONFIG.pipelines ?? []
}

/** Pipeline modules declared under `pipelines/` plus `mt.json -> pipelines`. */
export async function collectPipelineFiles(root: string): Promise<string[]> {
  const files = new Set<string>()
  const pipelineDir = join(root, 'pipelines')
  if (await isDirectory(pipelineDir)) {
    for (const path of await walkSyncFiles(root)) {
      if (path.startsWith('pipelines/')) files.add(path)
    }
  }
  let declared = pipelineConfigPaths()
  try {
    declared = (await readMtConfig(root)).pipelines ?? declared
  } catch {
    // A malformed config is reported by the sync command/route itself; keep the default scan.
  }
  for (const entry of declared) {
    const normalized = normalizeSyncPath(entry)
    if (normalized === undefined) continue
    const absolute = join(root, ...normalized.split('/'))
    if (await isRegularFile(absolute)) files.add(normalized)
    else if (await isDirectory(absolute)) {
      for (const path of await walkSyncFiles(root)) {
        if (path === normalized || path.startsWith(`${normalized}/`)) files.add(path)
      }
    }
  }
  return [...files].sort()
}

function extractWaypointUris(source: string, operation: 'from' | 'to'): string[] {
  const pattern = new RegExp(`\\.${operation}\\s*\\(\\s*['"]([^'"]+)['"]`, 'g')
  const values: string[] = []
  let match = pattern.exec(source)
  while (match) {
    const value = match[1]
    if (value !== undefined) values.push(value)
    match = pattern.exec(source)
  }
  return values
}

interface ParsedLocalUri {
  scheme: string
  path: string
}

function parseLocalUri(uri: string): ParsedLocalUri | undefined {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^?#]+)/i.exec(uri)
  if (!match) return undefined
  const scheme = match[1]?.toLowerCase()
  const rawPath = match[2]
  if (scheme === undefined || rawPath === undefined) return undefined
  if (scheme !== 'jsonl' && scheme !== 'md' && scheme !== 'chapter' && scheme !== 'schema-doc') {
    return undefined
  }
  if (rawPath === '' || rawPath.startsWith('/') || rawPath.startsWith('~')) return undefined
  let decoded = rawPath
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    // Keep the raw path; a bad escape is best treated as a literal file name.
  }
  return { scheme, path: decoded.replace(/^\.\//, '') }
}

function globPattern(path: string): boolean {
  return /[*?[]/.test(path)
}

async function expandLocalUri(
  root: string,
  uri: string,
  allFiles: readonly string[],
): Promise<string[]> {
  const parsed = parseLocalUri(uri)
  if (!parsed) return []
  const normalized = normalizeSyncPath(parsed.path)
  if (normalized === undefined) return []
  if (globPattern(normalized)) {
    return allFiles.filter((path) => matchesGlob(path, normalized))
  }
  const absolute = join(root, ...normalized.split('/'))
  if (await isRegularFile(absolute)) return [normalized]
  if (await isDirectory(absolute)) {
    return allFiles.filter((path) => path === normalized || path.startsWith(`${normalized}/`))
  }
  return []
}

/**
 * Resolve the default push scope: pipelines, `mt.json`, transitive relative imports
 * of those modules, and relative `jsonl://` / `md://` inputs declared with `.from()`.
 * A user `include` list replaces the default derivation but never bypasses hard excludes.
 */
export async function collectSyncScope(
  root: string,
  options: SyncScopeOptions = {},
): Promise<string[]> {
  const allFiles = await walkSyncFiles(root, {
    exclude: options.exclude,
    allowRunState: false,
  })
  const allSet = new Set(allFiles)
  const selected = new Set<string>()

  const include = options.include
  if (include !== undefined && include.length > 0) {
    for (const path of allFiles) {
      if (matchesAnyGlob(path, include)) selected.add(path)
    }
  } else {
    if (allSet.has('mt.json')) selected.add('mt.json')
    const pipelineFiles = await collectPipelineFiles(root)
    const queue = [...pipelineFiles]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const path = queue.shift()
      if (path === undefined || visited.has(path)) continue
      visited.add(path)
      if (!allSet.has(path)) continue
      selected.add(path)
      if (!CODE_EXTENSIONS.some((extension) => path.endsWith(extension))) continue
      let source: string
      try {
        source = await readFile(join(root, ...path.split('/')), 'utf8')
      } catch {
        continue
      }
      for (const specifier of extractSpecifiers(source)) {
        const imported = await resolveLocalImport(root, path, specifier)
        if (imported !== undefined && allSet.has(imported)) queue.push(imported)
      }
      for (const uri of extractWaypointUris(source, 'from')) {
        for (const input of await expandLocalUri(root, uri, allFiles)) selected.add(input)
      }
    }
  }

  return [...selected]
    .filter((path) => !isHardExcluded(path, { ...options, allowRunState: false }))
    .filter((path) => !matchesAnyGlob(path, options.exclude ?? []))
    .sort()
}

/**
 * Output/pull scope: files under `.mt/runs/<runId>/` plus relative targets declared
 * by pipeline `.to(...)` calls. This is deliberately disjoint from the source scope.
 */
export async function collectOutputScope(
  root: string,
  options: SyncOutputScopeOptions = {},
): Promise<string[]> {
  const allFiles = await walkSyncFiles(root, { allowRunState: true })
  const allSet = new Set(allFiles)
  const selected = new Set<string>()
  const runPrefix = options.runId === undefined ? '.mt/runs/' : `.mt/runs/${options.runId}/`
  for (const path of allFiles) {
    if (path.startsWith(runPrefix)) selected.add(path)
  }

  const pipelineFiles = await collectPipelineFiles(root)
  for (const pipeline of pipelineFiles) {
    if (!CODE_EXTENSIONS.some((extension) => pipeline.endsWith(extension))) continue
    let source: string
    try {
      source = await readFile(join(root, ...pipeline.split('/')), 'utf8')
    } catch {
      continue
    }
    for (const uri of extractWaypointUris(source, 'to')) {
      for (const output of await expandLocalUri(root, uri, allFiles)) {
        if (allSet.has(output)) selected.add(output)
      }
    }
  }
  return [...selected].filter((path) => !isProtectedSyncPath(path, { allowRunState: true })).sort()
}

export function projectIdFor(root: string): string {
  const absolute = resolve(root)
  const slug =
    basename(absolute)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project'
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 8)
  return `${slug}-${hash}`
}

export function isValidProjectId(projectId: string): boolean {
  return SAFE_PROJECT_ID.test(projectId) && projectId !== '.' && projectId !== '..'
}

/** Resolve a declared or computed project id, rejecting unsafe path segments. */
export function resolveProjectId(root: string, declared?: string): string {
  const projectId = declared?.trim() || projectIdFor(root)
  if (!isValidProjectId(projectId)) {
    throw new Error(`Invalid projectId '${projectId}': expected a safe path segment`)
  }
  return projectId
}
