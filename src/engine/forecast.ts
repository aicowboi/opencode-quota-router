// When a plan window will run out at the pace it is being used, from the usage figures recorded over time.
import { modelPools } from "./classify.ts"
import type { Config } from "./config.ts"
import type { Gate } from "./policy.ts"

/** Utilisation of one window at one moment, in percent. */
export type Sample = { at: number; pct: number }

export type Forecast = {
  /** Percentage points used per hour over the period looked at. */
  ratePerHour: number
  /** When utilisation reaches the limit at this pace. */
  runsOutAt: number
  /** True when that is before the window resets. */
  beforeReset: boolean
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const clock = (at: number, now: number) => (at - now > DAY ? new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))

/**
 * Project a window's utilisation forward. The pace is measured over the recent part of the window: a fifth of its
 * length, at least half an hour and at most three days, and never from before the window started or from before a
 * drop in utilisation (a reset the provider did not announce). Nothing is forecast from less than five minutes of
 * history, or when usage is not rising.
 */
export function forecast(samples: Sample[], input: { resetAt?: number; windowMs: number; limitPct: number; now: number }): Forecast | undefined {
  const { resetAt, windowMs, limitPct, now } = input
  if (resetAt !== undefined && resetAt <= now) return undefined
  const lookback = Math.min(3 * DAY, Math.max(30 * MINUTE, windowMs / 5))
  const from = Math.max(now - lookback, resetAt !== undefined ? resetAt - windowMs : 0)
  let recent = samples.filter((s) => s.at >= from && s.at <= now && Number.isFinite(s.pct))
  for (let i = recent.length - 1; i > 0; i--) {
    if (recent[i].pct < recent[i - 1].pct) {
      recent = recent.slice(i)
      break
    }
  }
  const first = recent[0]
  const last = recent.at(-1)
  if (!first || !last || now - first.at < 5 * MINUTE || last.pct <= first.pct) return undefined
  const ratePerHour = ((last.pct - first.pct) / (now - first.at)) * HOUR
  const runsOutAt = last.pct >= limitPct ? now : Math.round(now + ((limitPct - last.pct) / ratePerHour) * HOUR)
  return { ratePerHour, runsOutAt, beforeReset: resetAt !== undefined && runsOutAt < resetAt }
}

/** A forecast for one window of a provider's plan. */
export type WindowForecast = Forecast & { providerID: string; pool: string; label: string; pct: number; limitPct: number; resetAt?: number }

/**
 * Pace guard: light work (subagents, and the agents listed in `pace.lightAgents`) passes over a plan that is on pace
 * to run out before it resets, so what is left of it goes to the main session. The block is soft: when nothing else
 * in the chain is available, the plan is still used.
 */
export function paceGate(config: Config, forecasts: WindowForecast[], light: boolean, now: number): Gate | undefined {
  if (!config.pace.enabled || !light) return undefined
  const short = forecasts.filter((f) => f.beforeReset)
  if (short.length === 0) return undefined
  return (entry) => {
    const pools = modelPools(entry.providerID, entry.id)
    const f = short.find((x) => pools.includes(x.pool))
    return f ? { reason: `${f.label} on pace to run out at ${clock(f.runsOutAt, now)}, before it resets; kept for the main session`, until: f.resetAt, soft: true } : undefined
  }
}
