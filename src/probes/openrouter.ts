// OpenRouter key limits, from its documented `GET /api/v1/key` endpoint.
import { nextMonthUtc, parseTimestamp } from "../engine/resets.ts"

export type OpenRouterCredit = {
  /** The spending limit that applies to this key: its own, or a budget set above it. Absent when there is none. */
  limitUsd?: number
  remainingUsd?: number
  /** Spent against that limit, or by the key in total when there is no limit. */
  usedUsd: number
  /** What sets the limit: `key`, or the budget's scope (`workspace`, `guardrail`, …). */
  scope?: string
  /** `daily`, `weekly` or `monthly`; absent for a limit that never resets. */
  interval?: string
  resetAt?: number
  usedTodayUsd?: number
  usedMonthUsd?: number
  freeTier: boolean
  /** Requests to `:free` models today. */
  free?: { used: number; limit: number; remaining: number }
}

const KEY = /^sk-or-[\w-]{8,}$/

/** The OpenRouter key inside OpenCode's stored credential, whatever its exact shape. */
export function findOpenRouterKey(credential: unknown): string | undefined {
  let found: string | undefined
  const visit = (o: unknown, depth: number) => {
    if (found || depth > 4 || o === null || o === undefined) return
    if (typeof o === "string") {
      if (KEY.test(o)) found = o
    } else if (typeof o === "object") for (const v of Object.values(o)) visit(v, depth + 1)
  }
  visit(credential, 0)
  return found
}

export async function fetchOpenRouterKey(key: string): Promise<{ status: number; json?: unknown }> {
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) return { status: response.status }
  return { status: response.status, json: await response.json() }
}

/** OpenRouter's limits reset at 00:00 UTC: each day, each Monday, or on the 1st. */
export function nextOpenRouterReset(interval: string | undefined, now: number): number | undefined {
  const d = new Date(now)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  if (interval === "daily") return midnight
  if (interval === "weekly") return midnight + ((8 - new Date(midnight).getUTCDay()) % 7) * 86_400_000
  if (interval === "monthly") return nextMonthUtc(now)
  return undefined
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)

export function interpretOpenRouter(json: unknown, now: number): OpenRouterCredit | undefined {
  const data = (json as { data?: Record<string, unknown> } | null)?.data
  if (!data || typeof data !== "object") return undefined
  const out: OpenRouterCredit = {
    usedUsd: num(data.usage) ?? 0,
    usedTodayUsd: num(data.usage_daily),
    usedMonthUsd: num(data.usage_monthly),
    freeTier: data.is_free_tier === true,
  }
  const budget = data.effective_budget as Record<string, unknown> | null | undefined
  const budgetLimit = budget && typeof budget === "object" ? num(budget.limit_usd) : undefined
  const keyLimit = num(data.limit)
  if (budget && budgetLimit !== undefined) {
    const spent = num(budget.spend_usd)
    out.limitUsd = budgetLimit
    out.remainingUsd = num(budget.remaining_usd) ?? budgetLimit - (spent ?? 0)
    out.usedUsd = spent ?? budgetLimit - out.remainingUsd
    out.scope = str(budget.scope)
    out.interval = str(budget.reset_interval)
    out.resetAt = parseTimestamp(num(budget.resets_at) ?? str(budget.resets_at), now) ?? nextOpenRouterReset(out.interval, now)
  } else if (keyLimit !== undefined) {
    out.limitUsd = keyLimit
    out.remainingUsd = num(data.limit_remaining) ?? keyLimit - out.usedUsd
    out.usedUsd = keyLimit - out.remainingUsd
    out.scope = "key"
    out.interval = str(data.limit_reset)
    out.resetAt = nextOpenRouterReset(out.interval, now)
  }
  const free = data.free_model_daily_requests as Record<string, unknown> | null | undefined
  const freeLimit = free && typeof free === "object" ? num(free.limit) : undefined
  if (free && freeLimit !== undefined && freeLimit > 0) {
    const used = num(free.used) ?? 0
    out.free = { used, limit: freeLimit, remaining: num(free.remaining) ?? Math.max(0, freeLimit - used) }
  }
  return out
}
