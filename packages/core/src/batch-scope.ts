import {
  batchMembersOf,
  groupVariableEdits,
  unbatchExchange,
  withItem,
  withVariable,
} from './exchange.js'
import type { BatchScope, Exchange, Variable } from './types.js'

/**
 * Scope state of one `batch` step (`.subflow('batch://...', pipe)`).
 *
 * Lives only in memory (the nested run's `RunContext.batchScope`): the member envelopes are an
 * ephemeral variable by design, so after a crash the package is re-formed from the outer source
 * cursor and the nested pipeline simply runs again for it.
 *
 * Two views over the same package, one commit point:
 * - {@link BatchScope.group}: the whole package as ONE exchange (`item` = `items[]`)
 * - {@link BatchScope.members}: every member as its own exchange (own id / meta / variables)
 * - {@link BatchScope.commit}: hand a result back. The group exchange contributes its changed
 *   variables (stamped on every member) and — when its payload is an array with exactly one
 *   element per member — zips that payload back onto the members by index; a member exchange
 *   replaces that member (matched by id) and wins over the zip.
 */
export function createBatchScope(folded: Exchange<unknown>): BatchScope {
  const original = batchMembersOf(folded)
  if (!original || original.length === 0) {
    throw new Error('createBatchScope: group exchange carries no member envelopes')
  }
  const memberIds = new Set(original.map((m) => m.id))
  let groupVars: Variable[] = []
  /** Payload array of the committed group, zipped onto members by index (same length only). */
  let groupPayload: unknown[] | undefined
  const patched = new Map<string, Exchange<unknown>>()
  let commits = 0

  const groupView = (): Exchange<unknown> =>
    groupVars.length > 0 ? withVariable(folded, ...groupVars) : folded

  const memberViews = (): Exchange<unknown>[] =>
    unbatchExchange(groupView()).map((member, index) => {
      const explicit = patched.get(member.id)
      if (explicit) return explicit
      if (groupPayload) return withItem(member, groupPayload[index])
      return member
    })

  return {
    groupId: folded.id,
    get commits() {
      return commits
    },
    group: groupView,
    members: memberViews,
    commit(env: Exchange<unknown>): void {
      if (env.id === folded.id) {
        // Group result: its variable edits travel back to every member, and a payload array of
        // exactly one element per member is zipped back onto them (a title list, a packet, ...
        // of another length is not a per-member payload and is ignored).
        for (const v of groupVariableEdits(env, folded)) {
          groupVars = [
            ...groupVars.filter((g) => !(g.name === v.name && g.qualifier === v.qualifier)),
            v,
          ]
        }
        if (Array.isArray(env.item) && env.item.length === original.length) {
          groupPayload = env.item
        }
      } else if (memberIds.has(env.id)) {
        patched.set(env.id, env)
      } else {
        throw new Error(
          `batch://return: exchange '${env.id}' is neither the group ('${folded.id}') nor one of its members`,
        )
      }
      commits += 1
    },
    result(): Exchange<unknown>[] {
      const hadIndex = new Map(original.map((m) => [m.id, 'batchIndex' in m.meta]))
      return memberViews().map((m) => {
        if (hadIndex.get(m.id)) return m
        const { batchIndex: _drop, ...meta } = m.meta
        return { ...m, meta }
      })
    },
  }
}
