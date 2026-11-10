// Reasons to pass over a chain entry that have nothing to do with pool health: spend caps, pacing, schedules, project
// rules. Each policy is a pure function from a chain entry to a block (or nothing), and the router asks them in order.
import type { Config } from "./config.ts"
import { nextLocalDay, nextLocalMonth } from "./resets.ts"
import type { ModelRef } from "./types.ts"

/**
 * Why an entry is passed over, and when the policy lifts. The router never waits for a policy to lift: a spend cap or
 * a schedule is a decision not to use a provider, unlike a limit that is waited out.
 */
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

/** Actual spend in US dollars per provider, for the current local day and month. */
export type Spend = { day: Record<string, number>; month: Record<string, number> }

const total = (by: Record<string, number>) => Object.values(by).reduce((a, b) => a + b, 0)
const usd = (n: number) => `$${n.toFixed(2)}`

/** The caps that are reached right now: per provider, and `*` for the caps across all providers. */
export function spendBlocks(config: Config, spent: Spend, now: number): Record<string, Block> {
  const out: Record<string, Block> = {}
  const check = (key: string, cap: { dailyUsd: number; monthlyUsd: number }, day: number, month: number, where: string) => {
    if (cap.monthlyUsd > 0 && month >= cap.monthlyUsd) out[key] = { reason: `monthly spend cap reached (${usd(month)} of ${usd(cap.monthlyUsd)}${where})`, until: nextLocalMonth(now) }
    else if (cap.dailyUsd > 0 && day >= cap.dailyUsd) out[key] = { reason: `daily spend cap reached (${usd(day)} of ${usd(cap.dailyUsd)}${where})`, until: nextLocalDay(now) }
  }
  check("*", config.spend, total(spent.day), total(spent.month), " across pay-per-use providers")
  for (const [id, cap] of Object.entries(config.spend.providers)) check(id, cap, spent.day[id] ?? 0, spent.month[id] ?? 0, ` on ${id}`)
  return out
}

/** Pay-per-use providers are passed over once their own cap, or the cap across all of them, is reached. */
export function spendGate(config: Config, spent: Spend, now: number): Gate | undefined {
  const blocks = spendBlocks(config, spent, now)
  if (Object.keys(blocks).length === 0) return undefined
  return (entry) => ((config.providers[entry.providerID]?.kind ?? "metered") === "metered" ? (blocks[entry.providerID] ?? blocks["*"]) : undefined)
}
