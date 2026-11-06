import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, run } from './helpers.js'

const GLOSSARY = join(CHAPTERS, 'glossary.json')
let hasFailure = false

beforeAll(async () => {
  await clean(GLOSSARY, join(CHAPTERS, 'glossary.graph.json'), join(SAMPLE_DIR, '.mt'))
  run('glossary.ts', { env: { MT_ONLY_CHAPTERS: '1,2' } })
}, 60_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean(GLOSSARY, join(CHAPTERS, 'glossary.graph.json'))
})

describe('glossary', () => {
  it('extracts the recurring characters and places of book2', async () => {
    const glossary = JSON.parse(await readFile(GLOSSARY, 'utf-8')) as {
      terms: Array<{ term: string; type: string; ru: string | null }>
    }
    const byTerm = (term: string) => glossary.terms.find((entry) => entry.term === term)
    expect(byTerm('Nadia Okonkwo')).toMatchObject({ type: 'character', ru: null })
    expect(byTerm('Emeka Okonkwo')).toMatchObject({ type: 'character' })
    expect(byTerm('Marrow Bay')).toMatchObject({ type: 'place' })
    expect(glossary.terms.length).toBeGreaterThan(5)
  })
})
