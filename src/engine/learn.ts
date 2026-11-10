// The size of a plan's pool, for providers that publish no usage figures. It is learned from the times the pool ran
// out, or, before that has happened, estimated from a console reading matched to the usage recorded here.

/** A time the pool ran out, and when it was usable again if that is known. */
export type Exhaustion = { at: number; until?: number }
/** Usage in a period starting at `at`, valued at list prices. */
export type PoolSpend = { at: number; usd: number }

/**
 * A console reading matched to the list-price usage recorded at that moment. `pct` is this meter's share of the
 * window (the API, not chat on the same seat). Consoles round to a whole number, so the estimate keeps a range.
 */
export type UsageReading = { at: number; pct: number; usd: number }

export type LearnedPool = {
  /** Usage, at list prices, that the pool holds. The median of the readings it rests on. */
  capacityUsd: number
  /** The range around `capacityUsd` when the console percent is rounded, or when two readings disagree. */
  capacityLowUsd?: number
  capacityHighUsd?: number
  /** How many separate times the pool ran out, or how many console readings, that this rests on. */
  samples: number
  /** Usage since the window is taken to have started. */
  usedUsd: number
  pct: number
  /** The same usage against the high and low capacity. Set when the size is still a calibration, not a fact. */
  pctLow?: number
  pctHigh?: number
  windowStart: number
  /** Known when the window is anchored on a reset, or while the pool is out. */
  resetAt?: number
  /** The pool is out now. */
  exhausted: boolean
  /** `reading`: calibrated from the console. `exhausted`: learned from running out, which replaces a calibration. */
  basis?: "reading" | "exhausted"
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

/** Half a percentage point: a console that shows whole numbers. */
const ROUND_PP = 0.5

/** The window of `windowMs` that contains `now`, aligned on a known reset. */
function windowContaining(now: number, resetAt: number, windowMs: number): { start: number; end: number } {
  let end = resetAt
  if (now >= end) end += (Math.floor((now - end) / windowMs) + 1) * windowMs
  else if (now < end - windowMs) end -= (Math.floor((end - windowMs - now) / windowMs) + 1) * windowMs
  return { start: end - windowMs, end }
}

/**
 * Estimate the pool from console readings until it has run out. Each reading says the recorded usage at that moment
 * was that share of the pool, so the pool's size is that usage divided by the share. Two readings that do not agree
 * stay as a range; the point in the middle is only a guide. List price is the meter, not raw tokens: a cached token
 * and an output token do not draw the same amount.
 */
type Band = { mid: number; low: number; high: number }

/** One reading, as a pool size, with half a point either way for a console that rounds. */
function bandOf(r: UsageReading): Band {
  const lo = Math.max(ROUND_PP, r.pct - ROUND_PP)
  const hi = Math.min(100 - ROUND_PP, r.pct + ROUND_PP)
  // A higher true percent means a smaller pool for the same usage.
  return { mid: r.usd / (r.pct / 100), low: r.usd / (hi / 100), high: r.usd / (lo / 100) }
}

function fromReadings(input: { readings: UsageReading[]; spend: PoolSpend[]; windowMs: number; now: number; resetAt?: number }): LearnedPool | undefined {
  const readings = input.readings.filter((r) => r.pct > 0 && r.pct < 100 && r.usd > 0 && Number.isFinite(r.at)).sort((a, b) => a.at - b.at)
  if (readings.length === 0) return undefined
  const bands = readings.map(bandOf)
  // A reading in between two that agree, but far from the rate those two imply, is a console that had not caught
  // up. It is not a different pool size. The first and last readings are the rate, so they stay.
  let trusted = bands
  if (bands.length >= 3) {
    const [first, last] = [readings[0], readings[readings.length - 1]]
    const dPct = last.pct - first.pct
    const dUsd = last.usd - first.usd
    if (dPct >= 2 && dUsd > 0) {
      const slope = dUsd / (dPct / 100)
      trusted = bands.filter((b, i) => i === 0 || i === bands.length - 1 || (b.mid < slope * 1.4 && b.mid > slope / 1.4))
    }
  }
  const mids = trusted.map((b) => b.mid).sort((a, b) => a - b)
  const i = mids.length >> 1
  const capacityUsd = mids.length % 2 ? mids[i] : (mids[i - 1] + mids[i]) / 2
  // Where the readings' ranges overlap, that is the pool. Where they do not, the range covers both.
  let capacityLowUsd = Math.max(...trusted.map((b) => b.low))
  let capacityHighUsd = Math.min(...trusted.map((b) => b.high))
  if (!(capacityLowUsd < capacityHighUsd)) {
    capacityLowUsd = Math.min(...trusted.map((b) => b.low))
    capacityHighUsd = Math.max(...trusted.map((b) => b.high))
  }
  const aligned = input.resetAt !== undefined && input.resetAt > 0 ? windowContaining(input.now, input.resetAt, input.windowMs) : undefined
  const windowStart = aligned ? aligned.start : input.now - input.windowMs
  const usedUsd = input.spend.reduce((sum, s) => (s.at >= windowStart && s.at < input.now + 1 ? sum + s.usd : sum), 0)
  const pctOf = (cap: number) => (cap > 0 ? (usedUsd / cap) * 100 : 0)
  return {
    capacityUsd,
    capacityLowUsd,
    capacityHighUsd,
    samples: trusted.length,
    usedUsd,
    pct: pctOf(capacityUsd),
    pctLow: pctOf(capacityHighUsd),
    pctHigh: pctOf(capacityLowUsd),
    windowStart,
    resetAt: aligned?.end,
    exhausted: false,
    basis: "reading",
  }
}

/**
 * The pool's size. Once it has run out with usage on record, that wins: it is what the pool actually held, and a
 * console calibration is only a stand-in until then. Otherwise a console reading is enough to estimate.
 */
export function estimatePool(input: { exhausted: Exhaustion[]; spend: PoolSpend[]; windowMs: number; now: number; readings?: UsageReading[]; resetAt?: number }): LearnedPool | undefined {
  const learned = learnPool(input)
  if (learned) return { ...learned, basis: "exhausted" }
  const readings = input.readings
  return readings?.length ? fromReadings({ ...input, readings }) : undefined
}
