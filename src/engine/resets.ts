// Reset-time parsing for the formats providers and Claude Code use.

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const MAX_AHEAD = 8 * 24 * 3_600_000

const plausible = (at: number, now: number) => Number.isFinite(at) && at > now - 60_000 && at < now + 40 * 24 * 3_600_000

/** First day of the next month, 00:00 UTC. Monthly allowances and spend caps reset then. */
export function nextMonthUtc(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/**
 * The next midnight in a time zone, for limits that reset on a provider's own calendar day (Gemini's daily quotas
 * reset at midnight Pacific time).
 */
export function nextMidnightIn(timeZone: string, now: number): number {
  const clock = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(at)
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
    return (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000
  }
  let at = Math.floor(now / 1000) * 1000 + 86_400_000 - clock(now)
  // A day with a clock change is 23 or 25 hours long: land on the midnight nearest to the estimate.
  const off = clock(at)
  if (off !== 0) at += off > 43_200_000 ? 86_400_000 - off : -off
  return at
}

/** A wait given in words in an error message: `retry after 26 seconds`, `Please retry in 34.07s`, `try again in 6m0s`. */
export function parseRetryText(text: string): number | undefined {
  const m = /(?:retry|try again|wait)\s+(?:after|in|for)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|h)(\d+(?:\.\d+)?(?:ms|s|m))?\b/i.exec(text)
  if (!m) return undefined
  const unit = m[2].toLowerCase()
  const short = unit.startsWith("mil") || unit === "ms" ? "ms" : unit.startsWith("s") ? "s" : unit.startsWith("m") ? "m" : "h"
  return parseDuration(`${m[1]}${short}${m[3] ?? ""}`)
}

/** `retry-after` style values: milliseconds header, seconds, or an HTTP date. */
export function parseRetryAfter(value: string | undefined | null, now: number): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.ceil(Number(trimmed) * 1000))
  const date = Date.parse(trimmed)
  if (!Number.isNaN(date)) return Math.max(0, date - now)
  return undefined
}

/** Go-style durations used by OpenAI rate-limit headers: `1s`, `6m0s`, `250ms`, `1h2m3.5s`. */
export function parseDuration(value: string | undefined | null): number | undefined {
  if (!value) return undefined
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g
  let total = 0
  let matched = false
  for (const m of value.matchAll(re)) {
    matched = true
    const n = Number(m[1])
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n
  }
  return matched ? Math.ceil(total) : undefined
}

/** Epoch seconds, epoch ms, or an ISO/RFC 3339 date. */
export function parseTimestamp(value: unknown, now: number): number | undefined {
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value
    return plausible(ms, now) ? ms : undefined
  }
  if (typeof value !== "string" || !value.trim()) return undefined
  const trimmed = value.trim()
  if (/^\d{9,13}$/.test(trimmed)) return parseTimestamp(Number(trimmed), now)
  const ms = Date.parse(trimmed)
  return plausible(ms, now) ? ms : undefined
}

/**
 * Reset time from free text such as:
 * - `Resets at 2026-11-09T16:00:00.000Z.` (OpenCode's Claude Agent provider)
 * - `resets 3:45pm`, `resets 3pm (Europe/London)`, `resets Mon 12:00am` (Claude Code, local time)
 * - `Claude AI usage limit reached|1794240000` (legacy epoch seconds)
 * - `You will regain access on 2026-12-01 at 00:00 UTC` (Anthropic spend cap)
 * Returns the next future occurrence, or undefined.
 */
export function parseResetText(text: string, now: number): number | undefined {
  const iso = /resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text)
  if (iso) {
    const at = parseTimestamp(iso[1], now)
    if (at !== undefined) return at
  }
  const pipe = /\|(\d{10,13})\b/.exec(text)
  if (pipe) {
    const at = parseTimestamp(Number(pipe[1]), now)
    if (at !== undefined) return at
  }
  const regain = /regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{1,2}):(\d{2}) UTC)?/i.exec(text)
  if (regain) {
    const at = Date.parse(`${regain[1]}T${(regain[2] ?? "0").padStart(2, "0")}:${regain[3] ?? "00"}:00Z`)
    if (plausible(at, now)) return at
  }
  const local = /resets?\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text)
  if (local && (local[4] || local[3])) {
    let hour = Number(local[2])
    const minute = Number(local[3] ?? 0)
    const meridiem = local[4]?.toLowerCase()
    if (meridiem === "pm" && hour < 12) hour += 12
    if (meridiem === "am" && hour === 12) hour = 0
    if (hour > 23 || minute > 59) return undefined
    const base = new Date(now)
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0)
    if (local[1]) {
      const target = WEEKDAYS.indexOf(local[1].toLowerCase().slice(0, 3))
      let days = (target - candidate.getDay() + 7) % 7
      if (days === 0 && candidate.getTime() <= now) days = 7
      candidate.setDate(candidate.getDate() + days)
    } else if (candidate.getTime() <= now) {
      candidate.setDate(candidate.getDate() + 1)
    }
    const at = candidate.getTime()
    return at - now <= MAX_AHEAD ? at : undefined
  }
  return undefined
}

/** The start of the next local day, and of the next local month. Spend caps count in local time, like the dashboard's days. */
export function nextLocalDay(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

export function nextLocalMonth(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
}
