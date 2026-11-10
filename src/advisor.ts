// Plan advice: gathers how each subscription was used over the period from the local record, and asks the engine
// whether the plan fits. Nothing leaves the machine.
import type { Core } from "./core.ts"
import { advise, claudePlan, copilotPlan, type Advice } from "./engine/plans.ts"

const DAY = 86_400_000

/** How often and for how long a provider's plan window was the reason routing left it. */
function limits(core: Core, pool: string, from: number, now: number) {
  const rows = core.store.all<{ at: number; status: string; kind: string | null; until: number | null }>("SELECT at, status, kind, until FROM pool_log WHERE pool = ? AND at >= ? ORDER BY at", pool, from)
  let hits = 0
  let limitedMs = 0
  let since: number | undefined
  for (const r of rows) {
    const limited = r.status !== "available" && r.kind === "window"
    if (limited && since === undefined) {
      hits++
      since = r.at
    } else if (!limited && since !== undefined) {
      limitedMs += r.at - since
      since = undefined
    }
  }
  if (since !== undefined) limitedMs += now - since
  return { hits, limitedMs }
}

export function planAdvice(core: Core, now = Date.now()): { at: number; days: number; coveredDays: number; advice: Advice[]; plans: { claude?: string; copilot?: string } } {
  const days = core.config.advisor.days
  const from = now - days * DAY
  const first = core.store.get<{ at: number | null }>("SELECT MIN(started_at) AS at FROM steps WHERE started_at >= ? AND source = 'live'", from)?.at
  const coveredDays = first ? Math.min(days, (now - first) / DAY) : 0
  const fallbackUsd = core.store.get<{ n: number }>("SELECT COALESCE(SUM(cost_actual), 0) AS n FROM steps WHERE started_at >= ?", from)?.n ?? 0

  // The busiest week: the highest weekly figure any usage check recorded.
  const peak = (provider: string, read: (data: any) => number | undefined) => {
    let max: number | undefined
    for (const r of core.store.all<{ data: string }>("SELECT data FROM usage_snapshots WHERE provider = ? AND at >= ?", provider, from)) {
      try {
        const pct = read(JSON.parse(r.data))
        if (typeof pct === "number" && (max === undefined || pct > max)) max = pct
      } catch {}
    }
    return max
  }

  const claude = core.hasProvider("claude-agent") ? claudePlan(core.config.claude.plan || core.claude.plan?.type, core.claude.plan?.tier) : undefined
  const q = core.copilot.data
  const copilotID = copilotPlan(core.config.copilot.plan || q?.plan)
  let copilot: { planID?: string; entitlement: number; projected: number; overage: number } | undefined
  if (q && q.entitlement > 0 && !q.unlimited) {
    const d = new Date(now)
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    const end = q.resetAt && q.resetAt > now ? q.resetAt : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    const elapsed = (now - start) / (end - start)
    // Early in the month a projection from a few days swings wildly, so it is only made after the first week.
    if (elapsed >= 0.2) copilot = { planID: copilotID, entitlement: q.entitlement, projected: q.used / elapsed, overage: q.overageUsed }
  }
  const advice = advise({
    days,
    coveredDays,
    fallbackUsd,
    prices: core.config.advisor.prices,
    claude: core.hasProvider("claude-agent")
      ? { planID: claude?.id, planName: claude?.name, ...limits(core, "claude-agent", from, now), peakWeeklyPct: peak("claude-agent", (d) => d?.windows?.find((w: any) => /Weekly \(all/.test(w?.label))?.utilization) }
      : undefined,
    chatgpt: core.chatgptActive()
      ? { planID: core.config.chatgpt.plan ? `chatgpt.${core.config.chatgpt.plan}` : undefined, ...limits(core, "openai", from, now), peakWeeklyPct: peak("openai", (d) => d?.windows?.find((w: any) => w?.label === "weekly")?.usedPct) }
      : undefined,
    copilot,
  })
  return { at: now, days, coveredDays, advice, plans: { claude: claude?.name, copilot: copilotID } }
}

export function adviceText(advice: Advice[]): string {
  if (advice.length === 0) return "No plan advice yet: it needs a week of recorded use and a usage check or two."
  return advice.map((a) => `- ${a.title}\n  ${a.detail}`).join("\n")
}
