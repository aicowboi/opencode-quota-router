// Subscription plans: what each one is called, how its allowance compares with its neighbours, and advice on whether
// the plan in use fits the way it was used. Prices are monthly list prices in US dollars and go out of date; they can
// be corrected with `advisor.prices`, and every figure the advice gives says where it came from.
export type Plan = {
  id: string
  provider: "claude" | "copilot" | "chatgpt"
  name: string
  /** Plans a person can move between share a group. A seat an organisation assigns is in a group of its own. */
  group: string
  /** Allowance relative to the smallest plan in the group (Claude, ChatGPT), or included credits a month (Copilot). */
  size: number
  monthlyUsd?: number
}

export const PLANS: Plan[] = [
  { id: "claude.pro", provider: "claude", name: "Claude Pro", group: "claude", size: 1, monthlyUsd: 20 },
  { id: "claude.max", provider: "claude", name: "Claude Max", group: "claude", size: 5, monthlyUsd: 100 },
  { id: "claude.ultra", provider: "claude", name: "Claude Ultra", group: "claude", size: 10, monthlyUsd: 200 },
  { id: "claude.team-standard", provider: "claude", name: "Claude Team (standard seat)", group: "claude-team", size: 1 },
  { id: "claude.team-premium", provider: "claude", name: "Claude Team (premium seat)", group: "claude-team", size: 5 },
  { id: "claude.enterprise", provider: "claude", name: "Claude Enterprise", group: "claude-enterprise", size: 1 },
  { id: "copilot.pro", provider: "copilot", name: "Copilot Pro", group: "copilot", size: 1500, monthlyUsd: 10 },
  { id: "copilot.pro-plus", provider: "copilot", name: "Copilot Pro+", group: "copilot", size: 7000, monthlyUsd: 39 },
  { id: "copilot.max", provider: "copilot", name: "Copilot Max", group: "copilot", size: 20000 },
  { id: "copilot.business", provider: "copilot", name: "Copilot Business", group: "copilot-business", size: 1900, monthlyUsd: 19 },
  { id: "copilot.enterprise", provider: "copilot", name: "Copilot Enterprise", group: "copilot-enterprise", size: 3900, monthlyUsd: 39 },
  { id: "chatgpt.plus", provider: "chatgpt", name: "ChatGPT Plus", group: "chatgpt", size: 1, monthlyUsd: 20 },
  { id: "chatgpt.pro", provider: "chatgpt", name: "ChatGPT Pro", group: "chatgpt", size: 10, monthlyUsd: 200 },
]

const plan = (id: string | undefined) => PLANS.find((p) => p.id === id)

/**
 * The Claude plan behind a Claude Code login, from the two fields it stores: the subscription type (`pro`, `max`,
 * `team`, `enterprise`) and the rate-limit tier (such as `default_claude_max_5x`).
 */
export function claudePlan(type: string | undefined, tier: string | undefined): { id?: string; name: string; multiplier?: number } | undefined {
  const t = (type ?? "").toLowerCase()
  const times = Number(/(\d+)x/.exec(tier ?? "")?.[1]) || undefined
  if (!t && !times) return undefined
  if (t === "team") return times && times > 1 ? { id: "claude.team-premium", name: `Claude Team (premium seat, ${times}x)`, multiplier: times } : { id: "claude.team-standard", name: "Claude Team (standard seat)", multiplier: 1 }
  if (t === "enterprise") return { id: "claude.enterprise", name: "Claude Enterprise", multiplier: times }
  if (t === "ultra") return { id: "claude.ultra", name: "Claude Ultra", multiplier: times ?? 10 }
  if (t === "max") return { id: "claude.max", name: `Claude Max${times ? ` (${times}x)` : ""}`, multiplier: times ?? 5 }
  if (t === "pro") return { id: "claude.pro", name: "Claude Pro", multiplier: 1 }
  return { name: `Claude ${t || "plan"}${times ? ` (${times}x)` : ""}`, multiplier: times }
}

/** The Copilot plan a quota check reports (`individual_pro`, `pro_plus`, `business`, ...), as an ID from the list. */
export function copilotPlan(reported: string | undefined): string | undefined {
  const t = (reported ?? "").toLowerCase().replace(/[^a-z+]/g, "")
  if (!t) return undefined
  if (t.includes("enterprise")) return "copilot.enterprise"
  if (t.includes("business")) return "copilot.business"
  if (t.includes("max")) return "copilot.max"
  if (t.includes("proplus") || t.includes("pro+")) return "copilot.pro-plus"
  if (t.includes("pro")) return "copilot.pro"
  return undefined
}

export type Verdict = "move-up" | "move-down" | "keep" | "watch"
export type Advice = { provider: Plan["provider"]; verdict: Verdict; title: string; detail: string }

export type AdviceInput = {
  /** The period looked at, and how many of those days there is a record for. */
  days: number
  coveredDays: number
  /** Pay-per-use spend in the period, in US dollars. */
  fallbackUsd: number
  /** Corrections to the list prices, by plan ID. */
  prices?: Record<string, number>
  claude?: { planID?: string; planName?: string; hits: number; limitedMs: number; peakWeeklyPct?: number }
  chatgpt?: { planID?: string; hits: number; limitedMs: number; peakWeeklyPct?: number }
  copilot?: { planID?: string; entitlement: number; projected: number; overage: number }
}

const usd = (n: number) => `$${n >= 100 ? Math.round(n) : n.toFixed(2).replace(/\.00$/, "")}`
const hours = (ms: number) => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`)
const times = (n: number) => `${n} ${n === 1 ? "time" : "times"}`

/** Whether each plan fits how it was used. One entry per provider with something to say; needs a week of record. */
export function advise(input: AdviceInput): Advice[] {
  const out: Advice[] = []
  if (input.coveredDays < 7) return out
  const price = (p: Plan | undefined) => (p ? input.prices?.[p.id] ?? p.monthlyUsd : undefined)
  const neighbours = (p: Plan) => {
    const group = PLANS.filter((x) => x.group === p.group).sort((a, b) => a.size - b.size)
    const i = group.findIndex((x) => x.id === p.id)
    return { down: group[i - 1], up: group[i + 1] }
  }
  const period = `the last ${Math.round(Math.min(input.days, input.coveredDays))} days`
  const more = (current: Plan, to: Plan) => {
    const a = price(current)
    const b = price(to)
    return a !== undefined && b !== undefined ? b - a : undefined
  }

  for (const provider of ["claude", "chatgpt"] as const) {
    const u = input[provider]
    if (!u) continue
    const label = provider === "claude" ? "Claude" : "ChatGPT"
    const current = plan(u.planID)
    const name = (provider === "claude" && input.claude?.planName) || current?.name || `your ${label} plan`
    const { up, down } = current ? neighbours(current) : { up: undefined, down: undefined }
    if (u.hits >= 3) {
      let detail = `${name} was limited ${times(u.hits)} in ${period}, for about ${hours(u.limitedMs)} in all${input.fallbackUsd >= 0.01 ? `, and pay-per-use providers cost ${usd(input.fallbackUsd)} in that time` : ""}.`
      let verdict: Verdict = "watch"
      if (current && up) {
        const diff = more(current, up)
        detail += ` ${up.name} has ${Math.round((up.size / current.size) * 10) / 10} times the allowance${diff !== undefined ? ` for ${usd(diff)} more a month` : ""}.`
        if (diff !== undefined && input.fallbackUsd >= diff) {
          detail += " The pay-per-use spend alone was more than the difference."
          verdict = "move-up"
        } else if (u.hits >= 10) verdict = "move-up"
        else if (diff !== undefined) detail += " That is more than the pay-per-use spend, so it pays off only if the waiting costs you more."
      } else if (current && current.group !== provider) detail += " The seat type is set by your organisation; a larger seat or a second provider in the chain would cover it."
      else if (current) detail += " This is the largest plan; another provider in the chain is what covers the gaps."
      else if (provider === "chatgpt") detail += " ChatGPT Pro has a much larger allowance than Plus."
      out.push({ provider, verdict, title: `${label}: limited ${times(u.hits)}`, detail })
      continue
    }
    if (u.peakWeeklyPct === undefined) continue
    const peak = Math.round(u.peakWeeklyPct)
    if (current && down && u.hits === 0 && input.coveredDays >= 14) {
      const there = u.peakWeeklyPct * (current.size / down.size)
      if (there < 80) {
        const diff = more(down, current)
        out.push({ provider, verdict: "move-down", title: `${label}: ${down.name} would have covered it`, detail: `The busiest week in ${period} used ${peak}% of ${name}, and it was never limited. ${down.name}${diff !== undefined ? ` costs ${usd(diff)} less a month and` : ""} has ${Math.round((down.size / current.size) * 100)}% of the allowance, so that week would have used about ${Math.round(there)}% of it. Its 5-hour limit is smaller too, so short bursts may be limited more often.` })
        continue
      }
    }
    out.push({ provider, verdict: "keep", title: `${label}: ${current?.name ?? "the plan"} fits`, detail: `${u.hits ? `Limited ${times(u.hits)}` : "Never limited"} in ${period}; the busiest week used ${peak}% of the weekly allowance.` })
  }

  const c = input.copilot
  if (c && c.entitlement > 0) {
    const current = plan(c.planID)
    const projected = Math.round(c.projected)
    const pct = Math.round((c.projected / c.entitlement) * 100)
    const { up, down } = current ? neighbours(current) : { up: undefined, down: undefined }
    const base = `On pace for about ${projected.toLocaleString("en-US")} credits this month against ${c.entitlement.toLocaleString("en-US")} included (${pct}%).`
    if (c.projected > c.entitlement || c.overage > 0) {
      const fits = current ? PLANS.filter((x) => x.group === current.group && x.size >= c.projected).sort((a, b) => a.size - b.size)[0] ?? up : undefined
      const diff = current && fits ? more(current, fits) : undefined
      out.push({
        provider: "copilot",
        verdict: fits ? "move-up" : "watch",
        title: "Copilot: on pace to use more than the allowance",
        detail: `${base}${fits ? ` ${fits.name} includes ${fits.size.toLocaleString("en-US")}${diff !== undefined ? ` for ${usd(diff)} more a month` : ""}.` : current && current.group !== "copilot" ? " The seat is set by your organisation; past the allowance, credits are billed or blocked by its policy." : ""} Credits beyond the allowance cost about $0.01 each.`,
      })
    } else if (current && down && c.projected < down.size * 0.8) {
      const diff = more(down, current)
      out.push({ provider: "copilot", verdict: "move-down", title: `Copilot: ${down.name} would cover it`, detail: `${base} ${down.name} includes ${down.size.toLocaleString("en-US")}${diff !== undefined ? ` and costs ${usd(diff)} less a month` : ""}.` })
    } else out.push({ provider: "copilot", verdict: "keep", title: `Copilot: ${current?.name ?? "the plan"} fits`, detail: base })
  }
  return out
}
