// The size of a plan's pool, learned from the times it ran out, for providers that publish no usage figures.

/** A time the pool ran out, and when it was usable again if that is known. */
export type Exhaustion = { at: number; until?: number }
/** Usage in a period starting at `at`, valued at list prices. */
export type PoolSpend = { at: number; usd: number }

export type LearnedPool = {
  /** Usage, at list prices, that the pool has held before running out: the median of the times it did. */
  capacityUsd: number
  /** How many separate times the pool ran out that this rests on. */
  samples: number
  /** Usage since the window is taken to have started. */
  usedUsd: number
  pct: number
  windowStart: number
  /** Known only while the pool is out, or when the window is anchored on the last time it came back. */
  resetAt?: number
  /** The pool is out now. */
  exhausted: boolean
}

const DAY = 86_400_000

/** Rows that belong to one episode of running out: within a day of each other, or before the earlier one ended. */
function episodes(exhausted: Exhaustion[]): Array<{ at: number; end: number }> {
  const out: Array<{ at: number; end: number }> = []
  for (const e of [...exhausted].sort((a, b) => a.at - b.at)) {
    const last = out.at(-1)
    const end = e.until !== undefined && e.until > e.at ? e.until : e.at
    if (last && (e.at - last.at < DAY || e.at <= last.end)) last.end = Math.max(last.end, end)
    else out.push({ at: e.at, end })
  }
  return out
}

/**
 * Each time the pool ran out, the usage in the window before it is one reading of its size. A window starts when the
 * pool last came back, or one window length earlier, whichever is later. Returns nothing until it has run out once
 * with usage on record.
 */
export function learnPool(input: { exhausted: Exhaustion[]; spend: PoolSpend[]; windowMs: number; now: number }): LearnedPool | undefined {
  const { spend, windowMs, now } = input
  const eps = episodes(input.exhausted.filter((e) => e.at <= now))
  const between = (from: number, to: number) => spend.reduce((sum, s) => (s.at >= from && s.at < to ? sum + s.usd : sum), 0)
  const readings: number[] = []
  eps.forEach((e, i) => {
    const from = Math.max(e.at - windowMs, i > 0 ? eps[i - 1].end : 0)
    const usd = between(from, e.at + 1)
    if (usd > 0) readings.push(usd)
  })
  if (readings.length === 0) return undefined
  const recent = readings.slice(-5).sort((a, b) => a - b)
  const mid = recent.length >> 1
  const capacityUsd = recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2
  const last = eps.at(-1)
  if (last && last.end > now) return { capacityUsd, samples: readings.length, usedUsd: capacityUsd, pct: 100, windowStart: Math.max(last.at - windowMs, 0), resetAt: last.end, exhausted: true }
  const anchored = last !== undefined && last.end > now - windowMs
  const windowStart = anchored ? last.end : now - windowMs
  const usedUsd = between(windowStart, now + 1)
  return { capacityUsd, samples: readings.length, usedUsd, pct: Math.min(100, (usedUsd / capacityUsd) * 100), windowStart, resetAt: anchored ? windowStart + windowMs : undefined, exhausted: false }
}
