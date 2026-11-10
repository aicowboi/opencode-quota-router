// Rate-limit headroom from successful responses, so a pool can be marked before it fails.
import { parseDuration, parseTimestamp } from "./resets.ts"

export type Headroom = { remainingPct: number; resetAt?: number; detail: Record<string, { remaining: number; limit: number }> }

/**
 * Anthropic: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` (RFC 3339).
 * OpenAI and Copilot: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` (reset as a duration such as `6m0s`).
 * Returns the tightest bucket, or undefined when the response has no rate-limit headers.
 */
export function headroom(headers: Headers, now: number): Headroom | undefined {
  const buckets = new Map<string, { limit?: number; remaining?: number; reset?: number }>()
  const bucket = (name: string) => {
    let b = buckets.get(name)
    if (!b) buckets.set(name, (b = {}))
    return b
  }
  headers.forEach((value, rawKey) => {
    const key = rawKey.toLowerCase()
    const a = /^anthropic-ratelimit-(requests|tokens|input-tokens|output-tokens)-(limit|remaining|reset)$/.exec(key)
    if (a) {
      const b = bucket(a[1])
      if (a[2] === "reset") b.reset = parseTimestamp(value, now)
      else b[a[2] as "limit" | "remaining"] = Number(value)
      return
    }
    const o = /^x-ratelimit-(limit|remaining|reset)-(requests|tokens)$/.exec(key)
    if (o) {
      const b = bucket(o[2])
      if (o[1] === "reset") {
        const ms = parseDuration(value)
        b.reset = ms === undefined ? undefined : now + ms
      } else b[o[1] as "limit" | "remaining"] = Number(value)
    }
  })
  let tightest: Headroom | undefined
  const detail: Headroom["detail"] = {}
  for (const [name, b] of buckets) {
    if (!Number.isFinite(b.limit) || !Number.isFinite(b.remaining) || !b.limit) continue
    detail[name] = { remaining: b.remaining!, limit: b.limit! }
    const pct = (b.remaining! / b.limit!) * 100
    if (!tightest || pct < tightest.remainingPct) tightest = { remainingPct: pct, resetAt: b.reset, detail }
  }
  return tightest
}

export type CodexWindow = { label: string; usedPct: number; windowMinutes?: number; resetAt?: number }

const windowLabel = (minutes: number | undefined, fallback: string) =>
  minutes === 300
    ? "5-hour"
    : minutes === 10_080
      ? "weekly"
      : !minutes
        ? fallback
        : minutes % 1440 === 0
          ? `${minutes / 1440}-day`
          : minutes % 60 === 0
            ? `${minutes / 60}-hour`
            : `${minutes}-minute`

/**
 * ChatGPT plans (OpenAI signed in with ChatGPT) report their windows on every response:
 * `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at,reset-after-seconds}`.
 * Primary is usually the 5-hour window and secondary the weekly one.
 */
export function codexWindows(headers: Headers, now: number): CodexWindow[] {
  const out: CodexWindow[] = []
  for (const which of ["primary", "secondary"]) {
    const raw = headers.get(`x-codex-${which}-used-percent`)
    const usedPct = Number(raw)
    if (raw === null || raw.trim() === "" || !Number.isFinite(usedPct)) continue
    const minutes = Number(headers.get(`x-codex-${which}-window-minutes`)) || undefined
    const after = Number(headers.get(`x-codex-${which}-reset-after-seconds`) ?? NaN)
    const resetAt = parseTimestamp(headers.get(`x-codex-${which}-reset-at`) ?? undefined, now) ?? (Number.isFinite(after) ? now + after * 1000 : undefined)
    out.push({ label: windowLabel(minutes, which), usedPct: Math.max(0, Math.min(100, usedPct)), windowMinutes: minutes, resetAt })
  }
  return out
}
