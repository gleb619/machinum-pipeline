import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, run } from './helpers.js'

const TITLES = join(CHAPTERS, 'titles.json')
let hasFailure = false

beforeAll(async () => {
  await clean(TITLES, join(SAMPLE_DIR, '.mt'))
  run('translate-titles.ts', { env: { MT_ONLY_CHAPTERS: '1,2' } })
}, 60_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean(TITLES)
})

describe('translate-titles', () => {
  it('writes EN/RU pairs for the selected chapters', async () => {
    const titles = JSON.parse(await readFile(TITLES, 'utf-8')) as Record<
      string,
      { en: string; ru: string }
    >
    expect(Object.keys(titles).sort()).toEqual(['1', '2'])
    expect(titles['1']).toEqual({ en: 'Chapter 1: The Donation', ru: 'слово 1: слово слово' })
    expect(titles['2']).toEqual({ en: 'Chapter 2: Hiss', ru: 'слово 2: слово' })
  })
})
