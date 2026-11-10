import { test } from "node:test"
import assert from "node:assert/strict"
import { currentPeriod, estimateCopilot, type CreditReading, type CreditStep } from "../src/engine/credits.ts"

const minute = (m: number) => m * 60_000
const step = (atMin: number, credits: number, tokens: Partial<CreditStep> = {}): CreditStep => ({
  endedAt: minute(atMin),
  credits,
  input: tokens.input ?? 0,
  output: tokens.output ?? 0,
  reasoning: tokens.reasoning ?? 0,
  cacheRead: tokens.cacheRead ?? 0,
  cacheWrite: tokens.cacheWrite ?? 0,
})

test("a stale count is topped up with recorded tokens, and never trusted below GitHub's figure", () => {
  // The count sits at 493 while a burst records 442 credits, then ticks to 540. GitHub is behind.
  const readings: CreditReading[] = [
    { at: minute(0), used: 493 },
    { at: minute(14), used: 540 },
  ]
  const steps = [step(11, 400, { output: 28_000, cacheRead: 6_200_000 }), step(16, 42, { output: 1_000 })]
  const e = estimateCopilot(readings, steps, minute(18), 1900)!

  assert.equal(e.basis, "stale")
  assert.equal(e.lagAtLeast, true)
  // Anchored at the reading that had caught up (493), plus everything recorded since.
  assert.ok(Math.abs(e.used - (493 + 442)) < 1e-6)
  assert.ok(e.used > e.reported.used)
  assert.equal(e.reported.used, 540)
  assert.equal(e.pending, e.used - 540)
  assert.equal(e.lagMs, minute(18))
})

test("a count that catches up replaces the estimate", () => {
  const readings: CreditReading[] = [
    { at: minute(0), used: 493 },
    { at: minute(14), used: 540 },
    { at: minute(40), used: 493 + 442 },
  ]
  const steps = [step(11, 400), step(16, 42)]
  const e = estimateCopilot(readings, steps, minute(40), 1900)!

  // The count now accounts for every recorded token, so it stands and nothing is added on top.
  assert.equal(e.used, 493 + 442)
  assert.equal(e.pending, 0)
  assert.equal(e.lagAtLeast, false)
  assert.notEqual(e.basis, "stale")
})

test("tokens recorded after the last reading are added even when the count is current", () => {
  const readings: CreditReading[] = [{ at: minute(0), used: 100 }]
  const steps = [step(5, 30)]
  const e = estimateCopilot(readings, steps, minute(6), 1900)!
  assert.equal(e.basis, "reported")
  assert.equal(e.used, 130)
  assert.equal(e.pending, 30)
})

test("the burn rate counts only the last minute", () => {
  const readings: CreditReading[] = [{ at: minute(0), used: 100 }]
  const steps = [step(1, 50), step(9.5, 7)]
  const e = estimateCopilot(readings, steps, minute(10), 1900)!
  assert.ok(Math.abs(e.burnPerMin - 7) < 1e-6)
})

test("a new allowance period starts where the count drops", () => {
  const readings: CreditReading[] = [
    { at: minute(0), used: 1800 },
    { at: minute(10), used: 12 },
    { at: minute(20), used: 40 },
  ]
  assert.deepEqual(currentPeriod(readings).map((r) => r.used), [12, 40])
  // The 1,800 from last month must not pull the estimate up.
  const e = estimateCopilot(readings, [step(15, 5)], minute(20), 1900)!
  assert.equal(e.used, 40)
})

test("what a credit buys, and the allowance that implies", () => {
  const readings: CreditReading[] = [{ at: minute(0), used: 0 }]
  const steps = [step(5, 100, { input: 200, output: 5_000, reasoning: 1_400, cacheRead: 1_400_000, cacheWrite: 120_000 })]
  const e = estimateCopilot(readings, steps, minute(6), 1900)!
  const y = e.yield!
  assert.equal(y.reconciled, false)
  assert.ok(Math.abs(y.perCredit.output - 64) < 1e-6)
  assert.ok(Math.abs(y.perCredit.cacheRead - 14_000) < 1e-6)
  assert.ok(Math.abs(y.perCredit.cacheWrite - 1_200) < 1e-6)
  assert.ok(Math.abs(y.perCredit.input - 2) < 1e-6)
  // 1,900 credits at 15,266 tokens each.
  assert.ok(Math.abs(y.pool.allowance - 1900 * y.perCredit.total) < 1e-6)
  assert.ok(y.pool.used < y.pool.allowance)
})

test("a stable gap between the count and recorded tokens is a price difference, not lag", () => {
  // GitHub bills half of list price, consistently, across four readings.
  const readings: CreditReading[] = [0, 1, 2, 3].map((i) => ({ at: minute(i * 10), used: i * 50 }))
  const steps = [1, 2, 3].map((i) => step(i * 10 - 1, 100, { output: 6_000 }))
  const e = estimateCopilot(readings, steps, minute(30), 1900)!
  assert.equal(e.basis, "settled")
  // 150 billed, plus half of nothing new since the last reading.
  assert.equal(e.used, 150)
  assert.equal(e.yield?.reconciled, true)
})

test("one gap is not treated as a price difference", () => {
  const readings: CreditReading[] = [
    { at: minute(0), used: 0 },
    { at: minute(10), used: 10 },
  ]
  const e = estimateCopilot(readings, [step(5, 100)], minute(10), 1900)!
  assert.equal(e.basis, "stale")
  // The tokens stand: 100 recorded against a count that only reached 10.
  assert.ok(Math.abs(e.used - 100) < 1e-6)
  assert.ok(e.used > e.reported.used)
})

test("nothing to estimate without a reading", () => {
  assert.equal(estimateCopilot([], [step(5, 100)], minute(10), 1900), undefined)
})
