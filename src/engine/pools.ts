// Health per pool: the thing that actually runs out (a subscription window, an API key's limits).
// Pure apart from the injected clock and change listener.
import type { Config } from "./config.ts"
import type { PoolState, Signal } from "./types.ts"

export type PoolChange = { pool: PoolState; previous?: PoolState; reason: string }

export class PoolStore {
  private pools = new Map<string, PoolState>()
  private listeners: Array<(change: PoolChange) => void> = []
  private config: Config
  private now: () => number

  constructor(config: Config, now: () => number = Date.now) {
    this.config = config
    this.now = now
  }

  setConfig(config: Config) {
    this.config = config
  }

  onChange(listener: (change: PoolChange) => void) {
    this.listeners.push(listener)
  }

  load(states: PoolState[]) {
    for (const s of states) if (s && typeof s.id === "string") this.pools.set(s.id, s)
  }

  all(): PoolState[] {
    return [...this.pools.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): PoolState {
    return this.pools.get(id) ?? { id, status: "available", since: this.now(), backoff: 0, updated: this.now() }
  }

  /** Usable now, or past its cooldown and so worth one trial request (half-open). */
  usable(id: string): "yes" | "trial" | "no" {
    const p = this.pools.get(id)
    if (!p || p.status === "available" || p.status === "degraded") return "yes"
    return p.until !== undefined && p.until <= this.now() ? "trial" : "no"
  }

  private set(next: PoolState, reason: string) {
    const previous = this.pools.get(next.id)
    this.pools.set(next.id, next)
    for (const l of this.listeners) l({ pool: next, previous, reason })
  }

  private providerOf(pool: string) {
    return pool.split(":")[0]
  }

  /** Record a failure signal against each of its pools. Later deadlines win; repeated failures back off. */
  report(sig: Signal) {
    const now = this.now()
    for (const id of sig.pools) {
      const prev = this.get(id)
      const provider = this.config.providers[this.providerOf(id)]
      const failedAgain = prev.status === "cooling" || prev.status === "blocked"
      const backoff = failedAgain && prev.until !== undefined && prev.until <= now ? prev.backoff + 1 : prev.backoff
      const grow = (base: number, cap: number) => Math.min(base * 2 ** backoff, cap)
      let until: number
      let status: PoolState["status"] = "cooling"
      switch (sig.kind) {
        case "throttle":
          until = now + Math.max(sig.retryAfterMs ?? 0, grow(this.config.throttle.cooldownMs, this.config.throttle.maxCooldownMs))
          break
        case "overload":
          until = now + Math.max(sig.retryAfterMs ?? 0, grow(this.config.overload.cooldownMs, this.config.overload.maxCooldownMs))
          break
        case "window": {
          const fallback = grow(provider?.windowCooldownMs ?? 15 * 60_000, 24 * 3_600_000)
          until = sig.resetAt ?? now + Math.max(sig.retryAfterMs ?? 0, fallback)
          break
        }
        case "billing":
          status = "blocked"
          until = sig.resetAt ?? now + grow(this.config.billing.probeAfterMs, 24 * 3_600_000)
          break
        case "auth":
          status = "blocked"
          until = now + grow(30 * 60_000, 6 * 3_600_000)
          break
      }
      if (sig.resetAt !== undefined) until += this.config.recovery.skewMs
      // Keep a later deadline already known for this pool unless the new evidence is an exact reset time.
      if (failedAgain && prev.until !== undefined && prev.until > until && sig.resetAt === undefined) until = prev.until
      this.set(
        {
          ...prev,
          status,
          kind: sig.kind,
          until,
          since: failedAgain ? prev.since : now,
          evidence: sig.evidence,
          source: "error",
          backoff,
          lastFailure: now,
          updated: now,
        },
        `failure:${sig.kind}`,
      )
    }
  }

  /** A request on the pool succeeded: clear any cooldown. */
  success(ids: string[]) {
    const now = this.now()
    for (const id of ids) {
      const prev = this.get(id)
      if (prev.status === "available" && prev.lastSuccess && now - prev.lastSuccess < 30_000) continue
      // A cutover from a usage probe stands until the probe says otherwise: requests that were already
      // in flight, or that ran on usage credits, still succeed.
      if (prev.source === "probe" && prev.status === "cooling" && prev.until !== undefined && prev.until > now) {
        this.pools.set(id, { ...prev, lastSuccess: now })
        continue
      }
      const status = prev.status === "degraded" ? "degraded" : "available"
      this.set({ ...prev, status, until: undefined, kind: undefined, source: undefined, evidence: status === "degraded" ? prev.evidence : undefined, backoff: 0, lastSuccess: now, updated: now, since: prev.status === status ? prev.since : now }, "success")
    }
  }

  /**
   * Usage reported by a probe or headers. `exhausted` cools the pool until `resetAt`; usage under the
   * cutover threshold clears a window cooldown early (limit reset, purchase).
   */
  usage(id: string, input: { utilization: number; resetAt?: number; exhausted: boolean; warn: boolean; evidence: string }) {
    const now = this.now()
    const prev = this.get(id)
    if (input.exhausted) {
      const until = (input.resetAt ?? now + (this.config.providers[this.providerOf(id)]?.windowCooldownMs ?? 15 * 60_000)) + this.config.recovery.skewMs
      const same = prev.status === "cooling" && prev.until === until && prev.utilization === input.utilization
      if (same) return
      this.set({ ...prev, status: "cooling", kind: "window", source: "probe", until, evidence: input.evidence, utilization: input.utilization, since: prev.status === "cooling" ? prev.since : now, updated: now }, "usage:exhausted")
      return
    }
    const clearing = (prev.status === "cooling" && prev.kind === "window") || prev.status === "available" || prev.status === "degraded"
    if (!clearing) {
      if (prev.utilization !== input.utilization) this.set({ ...prev, utilization: input.utilization, updated: now }, "usage:update")
      return
    }
    const status = input.warn ? "degraded" : "available"
    if (prev.status === status && prev.utilization === input.utilization) return
    this.set(
      { ...prev, status, kind: undefined, source: undefined, until: undefined, backoff: 0, evidence: input.warn ? input.evidence : undefined, utilization: input.utilization, since: prev.status === status ? prev.since : now, updated: now },
      prev.status === "cooling" ? "usage:recovered" : "usage:update",
    )
  }

  /** Clear a pool by hand (`/router reset`), or on fresh credentials. */
  reset(id: string, reason = "manual") {
    const now = this.now()
    const prev = this.get(id)
    this.set({ ...prev, status: "available", kind: undefined, source: undefined, until: undefined, backoff: 0, evidence: undefined, since: now, updated: now }, reason)
  }

  /** The earliest time any of these pools becomes usable again. */
  earliest(ids: string[]): number | undefined {
    let best: number | undefined
    for (const id of ids) {
      const p = this.pools.get(id)
      if (!p || p.until === undefined) continue
      if (best === undefined || p.until < best) best = p.until
    }
    return best
  }
}
