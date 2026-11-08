import {
  type Exchange,
  type Variable,
  batchMembersOf,
  groupVariableEdits,
  unbatchExchange,
  withVariable,
} from './exchange.js'
import type { BatchScope } from './types.js'

/**
 * Scope state of one `.batch(opts, nested)` group.
 *
 * Lives only in memory (the nested run's `RunContext.batchScope`): the member envelopes are an
 * ephemeral variable by design, so after a crash the group is re-formed from the outer source
 * cursor and the nested pipeline simply runs again for it.
 *
 * Two views over the same group, one commit point:
 * - {@link BatchScope.group}: the whole package as ONE exchange (`item` = `items[]`)
 * - {@link BatchScope.members}: every member as its own exchange (own id / meta / variables)
 * - {@link BatchScope.commit}: hand a result back. The group exchange contributes its changed
 *   variables (stamped on every member); a member exchange replaces that member (matched by id).
 */
export function createBatchScope(folded: Exchange<unknown>): BatchScope {
  const original = batchMembersOf(folded)
  if (!original || original.length === 0) {
    throw new Error('createBatchScope: group exchange carries no member envelopes')
  }
  const memberIds = new Set(original.map((m) => m.id))
  let groupVars: Variable[] = []
  const patched = new Map<string, Exchange<unknown>>()
  let commits = 0

  const groupView = (): Exchange<unknown> =>
    groupVars.length > 0 ? withVariable(folded, ...groupVars) : folded

  const memberViews = (): Exchange<unknown>[] =>
    unbatchExchange(groupView()).map((m) => patched.get(m.id) ?? m)

  return {
    groupId: folded.id,
    get commits() {
      return commits
    },
    group: groupView,
    members: memberViews,
    commit(env: Exchange<unknown>): void {
      if (env.id === folded.id) {
        // Group result: only its variable edits travel back (the payload may be a title list,
        // a packet, ... - never a replacement of the members' own payloads).
        for (const v of groupVariableEdits(env, folded)) {
          groupVars = [
            ...groupVars.filter((g) => !(g.name === v.name && g.qualifier === v.qualifier)),
            v,
          ]
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
