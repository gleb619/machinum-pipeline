import { createExchange, setVariables } from '@mt/core'
import type { Exchange } from '@mt/core'

const META_KEYS = new Set(['chapterId', 'paragraphId', 'lineId', 'chapterNum', 'chapter', 'lang'])

/**
 * Test helper: builds an Exchange; identity keys (chapterId, chapterNum, ...) of `fields` go to
 * `meta`, every other key becomes a variable of the same name.
 */
export function exchangeOf<T>(
  item: T,
  fields: Record<string, unknown> = {},
  items?: T[],
): Exchange<T> {
  const meta: Record<string, unknown> = {}
  const vars: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) (META_KEYS.has(k) ? meta : vars)[k] = v
  return setVariables(createExchange(item, { meta, items }), vars)
}
