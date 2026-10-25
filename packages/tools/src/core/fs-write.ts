import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile as coreAtomicWriteFile } from '@mt/core'

/**
 * The single write tool module of @mt/tools: every file write delegates to
 * {@link atomicWriteFile} from @mt/core (temp-then-rename, so a crash never
 * leaves a half-written file). The parent directory must already exist —
 * same contract as the core helper — unless {@link ensureParentDir} is called first.
 */

/** Atomic write via @mt/core: temp file + rename into place. */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  return coreAtomicWriteFile(filePath, content)
}

/** Create the parent directory of `filePath` (recursively) when it is missing. */
export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}
