import { readFile } from 'node:fs/promises'

/**
 * Guarded JSON reads — one error shape for every file kind.
 *
 * `label` names the kind of file in the error message ("vault", "embedded store").
 * Parser errors are never echoed: they can quote the file content, which may hold secrets.
 */

/** Options for {@link readJsonOrThrow}. */
export interface ReadJsonOptions {
  /** Yield `undefined` instead of throwing when the file does not exist. */
  ignoreMissing?: boolean
}

/**
 * Read `path` and parse it as JSON.
 *
 * Throws `Cannot read <label> <path>: <code>` when the file cannot be read and
 * `Invalid <label> <path>: malformed JSON` when it is not valid JSON.
 */
export async function readJsonOrThrow(
  path: string,
  label: string,
  options: ReadJsonOptions = {},
): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown error'
    if (options.ignoreMissing && code === 'ENOENT') return undefined
    throw new Error(`Cannot read ${label} ${path}: ${code}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`Invalid ${label} ${path}: malformed JSON`)
  }
}
