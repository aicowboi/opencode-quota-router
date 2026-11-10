// Reasons to pass over a chain entry that have nothing to do with pool health: spend caps, pacing, schedules, project
// rules. Each policy is a pure function from a chain entry to a block (or nothing), and the router asks them in order.
import type { ModelRef } from "./types.ts"

/** Why an entry is passed over, and when to look again. Without `until` the block lasts until the policy changes. */
export type Block = { reason: string; until?: number }
export type Gate = (entry: ModelRef) => Block | undefined

/** One gate from several: the first policy that blocks an entry decides. */
export function composeGates(gates: Array<Gate | undefined>): Gate | undefined {
  const list = gates.filter((g): g is Gate => !!g)
  if (list.length === 0) return undefined
  return (entry) => {
    for (const gate of list) {
      const block = gate(entry)
      if (block) return block
    }
    return undefined
  }
}
