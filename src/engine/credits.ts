// Copilot AI credits, estimated from recorded tokens and reconciled against GitHub's own count.
//
// GitHub's count runs minutes behind real usage, and a long session can spend the whole allowance in that gap. So the
// estimate adds the credits that recorded tokens account for, at list price, on top of the last count that was keeping
// up. It is never below GitHub's own count: when a newer count arrives and accounts for those tokens, it takes over,
// which is the reconciliation. Until then the estimate is labelled as running ahead of the count.

export type CreditReading = { at: number; used: number }
export type CreditStep = {
  endedAt: number
  /** What the step costs in credits at list price: a credit is one cent. */
  credits: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type TokenSplit = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }

export type CopilotCreditEstimate = {
  /** Best estimate of credits used right now. Never below GitHub's own count. */
  used: number
  /** GitHub's own count, and when it was read. */
  reported: { used: number; at: number }
  /**
   * reported: the count is keeping up with recorded tokens, so it stands.
   * settled: the count has been tracking recorded tokens, and only tokens newer than the last reading are added.
   * stale: recorded tokens are ahead of the count, so the estimate trusts the tokens. The lag is a lower bound.
   */
  basis: "reported" | "settled" | "stale"
  /** How far behind the count is. A lower bound when `lagAtLeast` is set. */
  lagMs: number
  lagAtLeast: boolean
  /** Credits the estimate adds on top of GitHub's count. */
  pending: number
  /** Credits recorded in the last minute: how fast the allowance is being spent right now. */
  burnPerMin: number
  readings: number
  /**
   * What a credit has bought recently, from recorded tokens at list price. `reconciled` means GitHub's count has been
   * shown to agree; until then the rate is list price only, and the pool is an estimate.
   */
  yield?: { perCredit: TokenSplit; credits: number; tokens: TokenSplit; reconciled: boolean; pool: { allowance: number; used: number } }
}

/** Below this, a reading's movement is dust and says nothing about whether the count is keeping up. */
const MIN_CREDITS = 1
/** A reading pair must cover at least this many recorded credits before it says anything about the price ratio. */
const MIN_PAIR = 20
/** How many such pairs it takes before the ratio counts as stable rather than luck. */
const SCALE_PAIRS = 3
/** Stable means the largest ratio is at most this multiple of the smallest. */
const SCALE_SPREAD = 1.5

/** Credits of steps that ended at or before t, from steps sorted by end time. */
function cumulative(steps: CreditStep[]): (t: number) => number {
  const at: number[] = []
  const cum: number[] = []
  let acc = 0
  for (const s of steps) {
    acc += s.credits
    at.push(s.endedAt)
    cum.push(acc)
  }
  return (t) => {
    let lo = 0
    let hi = at.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (at[mid] <= t) lo = mid + 1
      else hi = mid
    }
    return lo === 0 ? 0 : cum[lo - 1]
  }
}

/**
 * Readings since the allowance last reset. The count drops at a reset and otherwise only rises, so the current period
 * is the run after the last drop. A fraction of a credit is rounding, not a reset.
 */
export function currentPeriod(readings: CreditReading[]): CreditReading[] {
  const sorted = readings.filter((r) => Number.isFinite(r.at) && Number.isFinite(r.used) && r.used >= 0).sort((a, b) => a.at - b.at)
  let start = 0
  for (let i = 1; i < sorted.length; i++) if (sorted[i].used < sorted[i - 1].used - 0.5) start = i
  return sorted.slice(start)
}

/**
 * The ratio of credits GitHub billed to credits recorded, when it has been stable across several readings. Undefined
 * until then: a single gap is the count lagging, not a price difference, and the two can only be told apart once the
 * ratio repeats.
 */
function scaleOf(readings: CreditReading[], C: (t: number) => number): number | undefined {
  const ratios: number[] = []
  for (let i = 1; i < readings.length; i++) {
    const recorded = C(readings[i].at) - C(readings[i - 1].at)
    if (recorded < MIN_PAIR) continue
    ratios.push((readings[i].used - readings[i - 1].used) / recorded)
  }
  if (ratios.length < SCALE_PAIRS) return undefined
  const sorted = [...ratios].sort((a, b) => a - b)
  const [lo, hi] = [sorted[0], sorted[sorted.length - 1]]
  if (lo <= 0 || hi > lo * SCALE_SPREAD) return undefined
  const median = sorted[sorted.length >> 1]
  // Outside this range the prices are too far apart for the ratio to be believed; keep estimating from list price.
  return median >= 0.25 && median <= 4 ? median : undefined
}

function yieldOf(steps: CreditStep[], entitlement: number, used: number, reconciled: boolean): CopilotCreditEstimate["yield"] {
  const tokens: TokenSplit = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  let credits = 0
  for (const s of steps) {
    tokens.input += s.input
    tokens.output += s.output + s.reasoning
    tokens.cacheRead += s.cacheRead
    tokens.cacheWrite += s.cacheWrite
    credits += s.credits
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
  if (credits <= MIN_CREDITS || tokens.total <= 0) return undefined
  const perCredit: TokenSplit = {
    input: tokens.input / credits,
    output: tokens.output / credits,
    cacheRead: tokens.cacheRead / credits,
    cacheWrite: tokens.cacheWrite / credits,
    total: tokens.total / credits,
  }
  return { perCredit, credits, tokens, reconciled, pool: { allowance: entitlement * perCredit.total, used: used * perCredit.total } }
}

/**
 * Estimate credits used at `now`. `steps` are Copilot requests priced in credits at list price; `readings` are
 * GitHub's own counts. `entitlement` is the included allowance, used only to express the result in tokens.
 */
export function estimateCopilot(readings: CreditReading[], steps: CreditStep[], now: number, entitlement: number): CopilotCreditEstimate | undefined {
  const period = currentPeriod(readings)
  if (!period.length || !(entitlement > 0)) return undefined
  const recorded = steps.filter((s) => s.endedAt > 0 && s.credits > 0).sort((a, b) => a.endedAt - b.endedAt)
  const C = cumulative(recorded)
  const latest = period[period.length - 1]

  // The reading where the count was furthest ahead of recorded tokens is the last one that had caught up. Later
  // readings that lag score lower, so this reaches back past a stale count. Ties go to the newer reading, so a count
  // that catches up takes over.
  let anchor = period[0]
  for (const r of period) if (r.used - C(r.at) >= anchor.used - C(anchor.at)) anchor = r

  const sinceAnchor = C(latest.at) - C(anchor.at)
  const movement = latest.used - anchor.used
  // The count has caught up when its movement covers what was recorded. Three quarters, not all of it: list price
  // runs a little above what GitHub bills, and a count that close has caught up.
  const caughtUp = anchor === latest || sinceAnchor <= MIN_CREDITS || movement >= 0.75 * sinceAnchor
  const scale = scaleOf(period, C)

  let used: number
  let basis: CopilotCreditEstimate["basis"]
  let lagMs: number
  let lagAtLeast: boolean
  if (scale !== undefined) {
    basis = "settled"
    lagAtLeast = false
    lagMs = Math.max(0, now - latest.at)
    used = latest.used + scale * Math.max(0, C(now) - C(latest.at))
  } else if (caughtUp) {
    basis = sinceAnchor > MIN_CREDITS ? "settled" : "reported"
    lagAtLeast = false
    lagMs = Math.max(0, now - latest.at)
    used = latest.used + Math.max(0, C(now) - C(latest.at))
  } else {
    basis = "stale"
    lagAtLeast = true
    lagMs = Math.max(0, now - anchor.at)
    used = anchor.used + Math.max(0, C(now) - C(anchor.at))
  }
  used = Math.max(used, latest.used)

  const burnPerMin = recorded.reduce((sum, s) => (s.endedAt > now - 60_000 && s.endedAt <= now ? sum + s.credits : sum), 0)
  return {
    used,
    reported: { used: latest.used, at: latest.at },
    basis,
    lagMs,
    lagAtLeast,
    pending: Math.max(0, used - latest.used),
    burnPerMin,
    readings: period.length,
    // The rate is taken over the recent usage: since the count last kept up, which is the anchor.
    yield: yieldOf(recorded.filter((s) => s.endedAt > anchor.at && s.endedAt <= now), entitlement, used, basis === "settled"),
  }
}
