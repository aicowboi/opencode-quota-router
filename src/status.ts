// The status feed: for each session, the provider it is on and how full that provider's window is. The terminal's
// footer line and the command line's prompt segment both read it.
import type { Core } from "./core.ts"
import type { ModelRef } from "./engine/types.ts"
import type { StatusEntry, StatusFeed } from "./tui-feed.ts"

export function buildStatus(core: Core, now = Date.now()): StatusFeed {
  const pools = (model: ModelRef) => core.poolsFor(model).map((id) => core.pools.get(id))
  const limit = (model: ModelRef) => pools(model).filter((p) => (p.status === "cooling" || p.status === "blocked") && (p.until ?? Infinity) > now)
  const entry = (model: ModelRef): StatusEntry => {
    const used = pools(model).map((p) => p.utilization).filter((u): u is number => typeof u === "number")
    const limited = limit(model)
    return {
      provider: model.providerID,
      ...(used.length ? { pct: Math.max(...used) } : {}),
      ...(limited.length ? { limited: true, until: latest(limited.map((p) => p.until)) } : {}),
    }
  }
  const sessions: Record<string, StatusEntry> = {}
  for (const s of core.sessions.values()) {
    if (!s.current) continue
    const e = entry(s.current)
    if (s.fallback && s.fallback.from.providerID !== s.current.providerID) {
      e.from = s.fallback.from.providerID
      e.fromUntil = latest(limit(s.fallback.from).map((p) => p.until))
    }
    sessions[s.id] = e
  }
  // With no session to go by, show the provider a new one would most likely start on.
  const first = Object.entries(core.config.providers)
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([id]) => id)
    .filter((id) => core.hasProvider(id))
    .map((id) => {
      const own = core.pools.all().filter((p) => p.id === id || p.id.startsWith(`${id}:`))
      const used = own.map((p) => p.utilization).filter((u): u is number => typeof u === "number")
      return { provider: id, ...(used.length ? { pct: Math.max(...used) } : {}), free: !own.some((p) => (p.status === "cooling" || p.status === "blocked") && (p.until ?? Infinity) > now) }
    })
    .find((p) => p.free)
  return {
    now,
    enabled: core.config.enabled && core.config.statusLine,
    paused: core.paused,
    dryRun: core.config.dryRun,
    ...(first ? { top: { provider: first.provider, ...(first.pct === undefined ? {} : { pct: first.pct }) } } : {}),
    sessions,
  }
}

const latest = (times: Array<number | undefined>) => {
  const known = times.filter((t): t is number => typeof t === "number")
  return known.length ? Math.max(...known) : undefined
}
