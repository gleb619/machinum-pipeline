import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defineSource, defineTarget, defineWaypoint } from '@mt/core'
import '@mt/waypoint'
import { buildNormalizeFlow } from './normalize.js'

// === `defineWaypoint` demo: the exact normalize chain, but both endpoints are NEW waypoints
// composed from the stock `jsonl`/`md` ones via lifecycle hooks. Every hook appends an event to a
// custom audit log (`chapters/waypoint-log.jsonl`), flushed atomically when the target closes.
//
// - source wrapper: `onStart` + `filter` (empty chapters are skipped and logged) + `onItem`.
// - target wrapper: `onOpen` / `onWrite` / `onClose` around the inner `md` target.
//
// Note: pass SOURCE/TARGET INSTANCES, not URI strings — `defineWaypoint('md://…', …)` would
// resolve source-first (the `md` scheme is registered for both), see docs/steering/core.md.

const LOG_PATH = resolve(import.meta.dirname, '..', 'chapters', 'waypoint-log.jsonl')

const events: string[] = []

function log(event: string, detail?: Record<string, unknown>): void {
  events.push(JSON.stringify({ ts: new Date().toISOString(), event, ...detail }))
}

/** Atomic write (temp + rename) of the buffered audit log. */
async function flushLog(): Promise<void> {
  await mkdir(dirname(LOG_PATH), { recursive: true })
  const tmp = `${LOG_PATH}.tmp`
  await writeFile(tmp, `${events.join('\n')}\n`, 'utf-8')
  await rename(tmp, LOG_PATH)
}

let skipped = 0

const loggedSource = defineWaypoint(defineSource<unknown>('jsonl://./jsonl/input.jsonl'), {
  onStart: () => log('source:start'),
  filter: (env) => {
    const item = env.item as { key?: string; value?: string }
    if ((item.value ?? '').trim() === '') {
      skipped++
      log('source:skip', { key: item.key })
      return false
    }
    return true
  },
  onItem: (env) => log('source:item', { key: (env.item as { key?: string }).key }),
})

const loggedTarget = defineWaypoint(defineTarget<unknown>('md://./chapters/en'), {
  onOpen: () => log('target:open'),
  onWrite: (env) =>
    log('target:write', { chapter: (env.meta as { chapterNum?: number }).chapterNum }),
  onClose: () => {
    log('target:close', { skipped })
    return flushLog()
  },
})

const waypointLogFlow = buildNormalizeFlow(loggedSource, loggedTarget)

export { waypointLogFlow, LOG_PATH }
export default waypointLogFlow
