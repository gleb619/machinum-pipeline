import { isAbsolute, relative, resolve } from 'node:path'

/** Thrown when a requested path resolves outside the given root directory. */
export class PathOutsideRootError extends Error {
  constructor(
    readonly root: string,
    readonly requested: string,
  ) {
    super(`Path outside root: ${requested} (root: ${root})`)
    this.name = 'PathOutsideRootError'
  }
}

/**
 * Resolve `requested` against `root`, guaranteeing the result stays inside `root`.
 * Both relative and absolute `requested` paths are accepted as long as they do not
 * escape `root` (lexically — symlinks are not followed).
 */
export function resolveInsideRoot(root: string, requested: string): string {
  const base = resolve(root)
  const target = resolve(base, requested)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathOutsideRootError(base, requested)
  }
  return target
}
