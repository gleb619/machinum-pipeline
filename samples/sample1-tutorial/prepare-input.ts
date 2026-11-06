import { join } from 'node:path'
import { writeFixtures } from './lib/fixtures.js'

/**
 * Writes the lorem-ipsum fixtures of the tutorial sample.
 *
 *   pnpm run prepare-input          # write the missing fixtures, keep the existing ones
 *   pnpm run prepare-input:force    # regenerate every fixture (deterministic)
 *
 * The real book data (`books/book1`) is read directly by `simulate-book1.ts`, so it never
 * needs a fixture here.
 */
const ROOT = join(import.meta.dirname)
const FORCE = process.argv.includes('--force')

async function main(): Promise<void> {
  const results = await writeFixtures(ROOT, FORCE)
  for (const { path, status } of results) {
    console.log(`${status === 'written' ? 'wrote  ' : 'kept   '} ${path}`)
  }
  if (results.every((result) => result.status === 'kept')) {
    console.log('All fixtures already exist. Use `pnpm run prepare-input:force` to regenerate.')
  }
}

main().catch((error: unknown) => {
  console.error(`prepare-input failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
