// Reasons to pass over a chain entry that have nothing to do with pool health: spend caps, pacing, schedules, project
// rules. Each policy is a pure function from a chain entry to a block (or nothing), and the router asks them in order.
import type { Config } from "./config.ts"
import { nextLocalDay, nextLocalMonth } from "./resets.ts"
import type { ModelInfo, ModelRef } from "./types.ts"

/**
 * Why an entry is passed over, and when the policy lifts. The router never waits for a policy to lift: a spend cap or
 * a schedule is a decision not to use a provider, unlike a limit that is waited out.
 */
export type Block = {
  reason: string
  until?: number
  /** A preference, not a rule: the entry is used when nothing else in the chain is available. */
  soft?: boolean
}
export type Gate = (entry: ModelRef) => Block | undefined

/** One gate from several: the first policy that blocks an entry decides, and a hard block outranks a soft one. */
export function composeGates(gates: Array<Gate | undefined>): Gate | undefined {
  const list = gates.filter((g): g is Gate => !!g)
  if (list.length === 0) return undefined
  return (entry) => {
    let soft: Block | undefined
    for (const gate of list) {
      const block = gate(entry)
      if (block && !block.soft) return block
      soft ??= block
    }
    return soft
  }
}

/** Copilot bills AI credits by tokens, at a hundred credits to the dollar of the model's list price. */
export const COPILOT_CREDITS_PER_USD = 100

/**
 * Copilot economy: near the end of the monthly allowance, the models that use credits fastest are passed over on
 * Copilot while another entry in the chain can run. A soft block, so Copilot is still used when it is all there is.
 */
export function economyGate(config: Config, usedPct: number | undefined, models: Map<string, ModelInfo>): Gate | undefined {
  const { economyAtPct, economyOutputPrice } = config.copilot
  if (!(economyAtPct > 0) || usedPct === undefined || usedPct < economyAtPct) return undefined
  return (entry) => {
    if (entry.providerID !== "github-copilot") return undefined
    const price = Math.max(0, ...(models.get(`${entry.providerID}/${entry.id}`)?.cost ?? []).map((t) => t.output))
    return price >= economyOutputPrice ? { reason: `Copilot allowance at ${Math.round(usedPct)}%: what is left is kept for cheaper models`, soft: true } : undefined
  }
}

/** Providers set aside for later, each until a time. Routing passes them over until then. */
export type Saved = Record<string, number>

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
const DAY = 86_400_000

export function saveGate(saved: Saved, now: number): Gate | undefined {
  const active = Object.entries(saved).filter(([, until]) => until > now)
  if (active.length === 0) return undefined
  const by = new Map(active)
  return (entry) => {
    const until = by.get(entry.providerID)
    return until ? { reason: `saved for later until ${until - now > DAY ? new Date(until).toLocaleString() : clock(until)}`, until } : undefined
  }
}

/**
 * When a "save for" ends: `90m`, `2h`, `1d`, or a time of day such as `17:00` (the next time the clock shows it).
 * At most a week ahead.
 */
export function parseUntil(text: string, now: number): number | undefined {
  const t = text.trim().toLowerCase()
  const span = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)[a-z]*$/.exec(t)
  if (span) {
    const ms = Number(span[1]) * (span[2] === "d" ? DAY : span[2].startsWith("h") ? 3_600_000 : 60_000)
    return ms > 0 && ms <= 7 * DAY ? now + ms : undefined
  }
  const time = /^(\d{1,2}):(\d{2})$/.exec(t)
  if (time && Number(time[1]) < 24 && Number(time[2]) < 60) {
    const d = new Date(now)
    d.setHours(Number(time[1]), Number(time[2]), 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return undefined
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
