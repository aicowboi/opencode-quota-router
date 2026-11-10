import { test } from "node:test"
import fs from "node:fs"
import assert from "node:assert/strict"
import { classify, modelPools } from "../src/engine/classify.ts"
import { checkSetting, loadConfig, overlay, parseRef, withSetting } from "../src/engine/config.ts"
import { composeGates, downGate, economyGate, parseUntil, saveGate, spendBlocks, spendGate } from "../src/engine/policy.ts"
import { forecast, paceGate, type WindowForecast } from "../src/engine/forecast.ts"
import { advise, claudePlan, copilotPlan, PLANS } from "../src/engine/plans.ts"
import { nextMidnightIn, parseDuration, parseResetText, parseRetryAfter, parseRetryText, nextMonthUtc } from "../src/engine/resets.ts"
import { PoolStore } from "../src/engine/pools.ts"
import { fasterFirst, findInChains, mapVariant, orderedChain, route } from "../src/engine/router.ts"
import { costOf, estimate } from "../src/engine/pricing.ts"
import { healthGate, speedOf, summariseHealth, unreliable } from "../src/engine/health.ts"
import { combineRules, matchProject, parseRules, ruledOut, rulesGate } from "../src/engine/rules.ts"
import { learnPool } from "../src/engine/learn.ts"
import type { ModelInfo } from "../src/engine/types.ts"

// Monday 2026-11-09 11:00 local
const NOW = new Date(2026, 10, 9, 11, 0, 0).getTime()

test("parseRef handles variants and gateway IDs", () => {
  assert.deepEqual(parseRef("claude-agent/opus#medium"), { providerID: "claude-agent", id: "opus", variant: "medium" })
  assert.deepEqual(parseRef("openrouter/anthropic/claude"), { providerID: "openrouter", id: "anthropic/claude" })
  assert.throws(() => parseRef("nope"))
})

test("reset text: ISO, local times, weekdays, epoch, regain", () => {
  assert.equal(parseResetText("Claude Code subscription limit reached (five hour). Resets at 2026-11-09T16:00:00.000Z.", NOW), Date.parse("2026-11-09T16:00:00.000Z"))
  assert.equal(parseResetText("You've hit your session limit · resets 3:45pm", NOW), new Date(2026, 10, 9, 15, 45).getTime())
  assert.equal(parseResetText("resets 9am (Europe/London)", NOW), new Date(2026, 10, 10, 9, 0).getTime())
  assert.equal(parseResetText("You've hit your weekly limit · resets Mon 12:00am", NOW), new Date(2026, 10, 16, 0, 0).getTime())
  assert.equal(parseResetText("Claude AI usage limit reached|1794250000", NOW), 1794250000 * 1000)
  assert.equal(parseResetText("You will regain access on 2026-12-01 at 00:00 UTC.", NOW), Date.parse("2026-12-01T00:00:00Z"))
  assert.equal(parseResetText("rate limited, try again", NOW), undefined)
})

test("retry-after and durations", () => {
  assert.equal(parseRetryAfter("30", NOW), 30_000)
  assert.equal(parseRetryAfter("Tue, 01 Dec 2026 00:00:00 GMT", NOW), Date.parse("2026-12-01T00:00:00Z") - NOW)
  assert.equal(parseDuration("6m0s"), 360_000)
  assert.equal(parseDuration("250ms"), 250)
  assert.equal(parseDuration("1h2m3.5s"), 3_723_500)
  assert.equal(nextMonthUtc(Date.parse("2026-11-09T12:00:00Z")), Date.parse("2026-12-01T00:00:00Z"))
})

test("classify: Claude subscription window with exact reset", () => {
  const s = classify("claude-agent", "opus", { type: "provider.unknown", message: "Claude Code subscription limit reached (five hour). Resets at 2026-11-09T16:00:00.000Z." }, NOW)
  assert.equal(s?.kind, "window")
  assert.deepEqual(s?.pools, ["claude-agent"])
  assert.equal(s?.resetAt, Date.parse("2026-11-09T16:00:00.000Z"))
})

test("classify: Claude per-model weekly limit only blocks that family", () => {
  const s = classify("claude-agent", "opus", { type: "provider.unknown", message: "Claude Code subscription limit reached (seven day opus). Resets at 2026-11-16T09:00:00Z." }, NOW)
  assert.deepEqual(s?.pools, ["claude-agent:opus"])
  const t = classify("claude-agent", "opus", { type: "provider.unknown", message: "You've hit your Opus limit · resets Mon 12:00am" }, NOW)
  assert.deepEqual(t?.pools, ["claude-agent:opus"])
  assert.equal(t?.kind, "window")
})

test("classify: Claude overload and harmless notices", () => {
  assert.equal(classify("claude-agent", "opus", { type: "provider.unknown", message: "Anthropic is overloaded (529). Claude Code exhausted its retries. Try again shortly." }, NOW)?.kind, "overload")
  assert.equal(classify("anthropic", "x", { type: "provider.unknown", message: "Third-party apps now draw from your extra usage" }, NOW), undefined)
})

test("classify: deterministic errors never route", () => {
  assert.equal(classify("anthropic", "x", { type: "provider.content-filter", message: "blocked" }, NOW), undefined)
  assert.equal(classify("anthropic", "x", { type: "provider.invalid-request", message: "prompt is too long: 1200000 tokens" }, NOW), undefined)
  assert.equal(classify("anthropic", "x", { type: "aborted", message: "Aborted" }, NOW), undefined)
})

test("classify: Anthropic API spend cap lasts until the 1st", () => {
  const s = classify("anthropic", "claude-opus-5-5", { type: "provider.rate-limit", status: 429, message: "You have reached your monthly spend limit. You will regain access on 2026-12-01 at 00:00 UTC.", response: { body: '{"type":"error","error":{"type":"rate_limit_error","details":{"error_code":"enforced_spend_limit_reached"}}}' } }, NOW)
  assert.equal(s?.kind, "billing")
  assert.equal(s?.resetAt, Date.parse("2026-12-01T00:00:00Z"))
  assert.equal(classify("anthropic", "x", { type: "provider.invalid-request", status: 400, message: "You have reached your specified API usage limits." }, NOW)?.kind, "billing")
  assert.equal(classify("anthropic", "x", { type: "provider.internal", status: 529, message: "Overloaded" }, NOW)?.kind, "overload")
})

test("classify: throttles keep retry-after", () => {
  const s = classify("openai", "gpt-6.1-sol", { type: "provider.rate-limit", status: 429, message: "Rate limit reached for requests", retryAfterMs: 30_000, response: { body: '{"error":{"code":"rate_limit_exceeded"}}' } }, NOW)
  assert.equal(s?.kind, "throttle")
  assert.equal(s?.retryAfterMs, 30_000)
})

test("classify: xAI, Copilot and OpenAI billing shapes", () => {
  assert.equal(classify("xai", "grok-4.7", { type: "provider.auth", status: 403, message: "You have run out of credits or need a Grok subscription", response: { body: '{"code":"personal-team-blocked:spending-limit"}' } }, NOW)?.kind, "window")
  const c = classify("github-copilot", "claude-opus-5.5", { type: "provider.quota", status: 402, message: "You have exceeded your monthly quota", retryAfterMs: Date.parse("2026-12-01T00:00:00Z") - NOW, response: { body: '{"error":{"code":"quota_exceeded"}}' } }, NOW)
  assert.equal(c?.kind, "billing")
  assert.equal(c?.resetAt, Date.parse("2026-12-01T00:00:00Z"))
  assert.equal(classify("github-copilot", "x", { type: "provider.rate-limit", status: 429, message: "You've hit your global rate limit", response: { body: '{"error":{"code":"user_global_rate_limited:pro"}}' } }, NOW)?.kind, "window")
  assert.equal(classify("openai", "x", { type: "provider.quota", status: 429, message: "You exceeded your current quota", response: { body: '{"error":{"type":"insufficient_quota","code":"credit_balance_exhausted"}}' } }, NOW)?.kind, "billing")
})

test("classify: generic fallbacks", () => {
  assert.equal(classify("mock", "m", { type: "provider.rate-limit", status: 429, message: "slow down" }, NOW)?.kind, "throttle")
  assert.equal(classify("mock", "m", { type: "provider.quota", message: "quota" }, NOW)?.kind, "billing")
  assert.equal(classify("mock", "m", { type: "provider.internal", status: 503, message: "down" }, NOW)?.kind, "overload")
  assert.equal(classify("mock", "m", { type: "provider.unknown", message: "Claude Code subscription limit reached (five hour). Resets at 2026-11-09T16:00:00.000Z." }, NOW)?.kind, "window")
  assert.equal(classify("mock", "m", { type: "provider.unknown", message: "something odd" }, NOW), undefined)
})

test("modelPools splits Claude families", () => {
  assert.deepEqual(modelPools("claude-agent", "opus"), ["claude-agent", "claude-agent:opus"])
  assert.deepEqual(modelPools("claude-agent", "claude-sonnet-5"), ["claude-agent", "claude-agent:sonnet"])
  assert.deepEqual(modelPools("xai", "grok-4.7"), ["xai"])
})

const cfg = (options: unknown = {}) => loadConfig(options).config

test("config: defaults, overrides and warnings", () => {
  const { config, warnings } = loadConfig({ throttle: { maxWaitMs: 5000 }, bogus: 1, chains: { opus: ["a/b", "bad"] }, providers: { xai: { priority: 9 } } })
  assert.equal(config.throttle.maxWaitMs, 5000)
  assert.equal(config.throttle.inPlaceRetries, 2)
  assert.equal(config.chains.opus.length, 1)
  assert.equal(config.providers.xai.priority, 9)
  assert.equal(config.providers.xai.kind, "subscription")
  assert.ok(warnings.some((w) => w.includes("bogus")))
  assert.ok(warnings.some((w) => w.includes("bad")))
})

test("pools: window until reset, half-open after, success clears", () => {
  let now = NOW
  const pools = new PoolStore(cfg(), () => now)
  pools.report({ kind: "window", pools: ["claude-agent"], resetAt: NOW + 3_600_000, evidence: "5h" })
  assert.equal(pools.usable("claude-agent"), "no")
  now = NOW + 3_600_000 + 61_000
  assert.equal(pools.usable("claude-agent"), "trial")
  pools.success(["claude-agent"])
  assert.equal(pools.usable("claude-agent"), "yes")
})

test("pools: throttle backs off, probe cutover survives in-flight success", () => {
  let now = NOW
  const pools = new PoolStore(cfg(), () => now)
  pools.report({ kind: "throttle", pools: ["xai"], evidence: "429" })
  assert.equal(pools.get("xai").until, NOW + 60_000)
  now += 61_000
  pools.report({ kind: "throttle", pools: ["xai"], evidence: "429" })
  assert.equal(pools.get("xai").until, now + 120_000)

  pools.usage("claude-agent", { utilization: 99, resetAt: now + 1000_000, exhausted: true, warn: true, evidence: "99%" })
  pools.success(["claude-agent"])
  assert.equal(pools.usable("claude-agent"), "no")
  pools.usage("claude-agent", { utilization: 3, exhausted: false, warn: false, evidence: "3%" })
  assert.equal(pools.usable("claude-agent"), "yes")
})

test("pools: billing blocks until the month boundary", () => {
  const pools = new PoolStore(cfg(), () => NOW)
  pools.report({ kind: "billing", pools: ["github-copilot"], resetAt: Date.parse("2026-12-01T00:00:00Z"), evidence: "402" })
  assert.equal(pools.get("github-copilot").status, "blocked")
  assert.equal(pools.get("github-copilot").until, Date.parse("2026-12-01T00:00:00Z") + 60_000)
})

const MODELS = new Map<string, ModelInfo>(
  [
    ["claude-agent", "opus", ["low", "medium", "high", "xhigh", "max"], 1_000_000],
    ["xai", "grok-4.7", ["low", "medium", "high", "xhigh"], 500_000],
    ["github-copilot", "claude-opus-5.5", ["low", "medium", "high", "xhigh", "max"], 1_000_000],
    ["anthropic", "claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"], 1_000_000],
    ["openai", "gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"], 1_050_000],
  ].map(([p, id, variants, context]) => [`${p}/${id}`, { providerID: p as string, id: id as string, variants: variants as string[], context: context as number }]),
)

test("router: priority order, failover, context fit and recovery", () => {
  let now = NOW
  const config = cfg()
  const pools = new PoolStore(config, () => now)
  const preferred = { ...findInChains(config, { providerID: "claude-agent", id: "opus" })!, variant: "medium" }
  assert.equal(orderedChain(config, "opus")[0].providerID, "claude-agent")

  let r = route({ config, pools, models: MODELS, preferred, mode: "turn" })
  assert.deepEqual(r.target, { providerID: "claude-agent", id: "opus", variant: "medium" })

  pools.report({ kind: "window", pools: ["claude-agent"], resetAt: NOW + 3_600_000, evidence: "5h" })
  r = route({ config, pools, models: MODELS, preferred, mode: "failover", exclude: new Set(["claude-agent"]) })
  assert.deepEqual(r.target, { providerID: "xai", id: "grok-4.7", variant: "high" })

  // 600K tokens of context rule out Grok's 500K window.
  r = route({ config, pools, models: MODELS, preferred, mode: "failover", lastInputTokens: 600_000 })
  assert.equal(r.target?.providerID, "github-copilot")

  pools.report({ kind: "window", pools: ["xai"], evidence: "weekly" })
  pools.report({ kind: "billing", pools: ["github-copilot"], evidence: "credits" })
  r = route({ config, pools, models: MODELS, preferred, mode: "turn" })
  assert.equal(r.target?.providerID, "anthropic")

  now = NOW + 3_600_000 + 61_000
  r = route({ config, pools, models: MODELS, preferred, mode: "turn" })
  assert.equal(r.target?.providerID, "claude-agent")
  assert.equal(r.target && "usable" in r ? r.usable : undefined, "trial")
})

test("router: nothing usable reports the earliest reset", () => {
  const config = cfg()
  const pools = new PoolStore(config, () => NOW)
  for (const p of ["claude-agent", "xai", "github-copilot", "anthropic", "openai"]) pools.report({ kind: "window", pools: [p], resetAt: NOW + (p === "xai" ? 600_000 : 3_600_000), evidence: "x" })
  const r = route({ config, pools, models: MODELS, preferred: { chain: "opus", index: 0 }, mode: "failover" })
  assert.equal(r.target, undefined)
  assert.equal(!r.target ? r.earliest : 0, NOW + 600_000 + 60_000)
})

test("router: a manually picked lower-priority model still routes by priority, keeping its effort", () => {
  const config = cfg()
  const pools = new PoolStore(config, () => NOW)
  const r = route({ config, pools, models: MODELS, preferred: { chain: "opus", index: 3, variant: "high" }, mode: "turn" })
  assert.deepEqual(r.target, { providerID: "claude-agent", id: "opus", variant: "high" })
})

test("mapVariant carries effort offsets and clamps to supported", () => {
  const opus = parseRef("claude-agent/opus#medium")
  assert.equal(mapVariant(parseRef("xai/grok-4.7#high"), opus, "medium", ["low", "medium", "high", "xhigh"]), "high")
  assert.equal(mapVariant(parseRef("xai/grok-4.7#high"), opus, "high", ["low", "medium", "high", "xhigh"]), "xhigh")
  assert.equal(mapVariant(parseRef("xai/grok-4.7#high"), opus, "max", ["low", "medium", "high", "xhigh"]), "xhigh")
  assert.equal(mapVariant(parseRef("x/y#medium"), opus, "default", []), undefined)
})

test("pricing: equivalent cost for subscriptions, actual only for metered", () => {
  const config = cfg()
  const models = new Map<string, ModelInfo>([
    ["anthropic/claude-opus-5-5", { providerID: "anthropic", id: "claude-opus-5-5", variants: [], cost: [{ input: 4, output: 20, cache: { read: 0.2, write: 5 } }] }],
  ])
  const tokens = { input: 1000, output: 1000, reasoning: 0, cache: { read: 100_000, write: 0 } }
  assert.equal(costOf(models.get("anthropic/claude-opus-5-5")!.cost, tokens), (4000 + 20000 + 20000) / 1e6)
  const sub = estimate(config, models, "claude-agent", "opus", tokens, 0)
  assert.ok(sub.equivalent > 0)
  assert.equal(sub.actual, 0)
  const api = estimate(config, models, "anthropic", "claude-opus-5-5", tokens, 0.05)
  assert.equal(api.actual, 0.05)
})

test("router: a policy gate passes over an entry and reports when to look again", () => {
  const config = cfg()
  const pools = new PoolStore(config, () => NOW)
  const preferred = { chain: "opus", index: 0, variant: "medium" }
  const gate = composeGates([undefined, (e) => (e.providerID === "claude-agent" ? { reason: "daily cap reached", until: NOW + 1000 } : undefined), () => undefined])
  const r = route({ config, pools, models: MODELS, preferred, mode: "turn", gate })
  assert.equal(r.target?.providerID, "xai")
  assert.deepEqual(r.skipped, ["claude-agent/opus: daily cap reached"])
  // A policy is never waited out: with everything passed over there is nothing to retry on.
  const all = route({ config, pools, models: MODELS, preferred, mode: "turn", gate: () => ({ reason: "blocked", until: NOW + 5 }) })
  assert.equal(all.target, undefined)
  assert.equal(!all.target ? all.earliest : 0, undefined)
  assert.equal(composeGates([undefined]), undefined)
})

test("stored settings: overlay, paths and validation", () => {
  assert.deepEqual(overlay({ claude: { usageProbe: true, warnAtPct: 80 } }, { claude: { warnAtPct: 90 }, dryRun: true }), { claude: { usageProbe: true, warnAtPct: 90 }, dryRun: true })
  assert.deepEqual(withSetting({}, "claude.warnAtPct", 90), { claude: { warnAtPct: 90 } })
  assert.deepEqual(withSetting({ claude: { warnAtPct: 90 } }, "claude.warnAtPct", undefined), {})

  const options = { claude: { usageProbe: true } }
  const ok = checkSetting(options, {}, "claude.cutoverAtPct", 95)
  assert.ok(ok.ok)
  assert.equal(loadConfig(overlay(options, ok.ok ? ok.stored : {})).config.claude.cutoverAtPct, 95)
  // The configured value stays underneath and comes back when the setting is cleared.
  assert.equal(loadConfig(overlay(options, ok.ok ? ok.stored : {})).config.claude.usageProbe, true)

  const refused = (path: string, value: unknown) => {
    const r = checkSetting(options, {}, path, value)
    assert.equal(r.ok, false, path)
    return r.ok ? "" : r.error
  }
  assert.match(refused("claude.cutoverAtPct", "high"), /should be number/)
  assert.match(refused("nope.thing", 1), /Unknown option/)
  assert.match(refused("dashboard.host", "0.0.0.0"), /opencode\.jsonc/)
  assert.match(refused("dashboard", { host: "0.0.0.0" }), /opencode\.jsonc/)
  assert.match(refused("claude.cutoverAtPct", -1), /zero or more/)
  assert.match(refused("__proto__.polluted", true), /not a setting/)
  assert.match(refused("chains.opus", ["nope"]), /Invalid model reference/)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  // A problem that was already in the configuration does not block an unrelated change.
  assert.ok(checkSetting({ typo: 1 }, {}, "claude.warnAtPct", 70).ok)
})

test("spend caps: pay-per-use providers are passed over once a cap is reached", () => {
  const anthropic = parseRef("anthropic/claude-opus-5-5")
  const openai = parseRef("openai/gpt-6.1-sol")
  const claude = parseRef("claude-agent/opus")
  const spent = { day: { anthropic: 4, openai: 1 }, month: { anthropic: 40, openai: 12 } }
  assert.equal(spendGate(cfg(), spent, NOW), undefined)

  // A provider's own cap blocks only that provider, until the next local day.
  let config = cfg({ spend: { providers: { anthropic: { dailyUsd: 4 } } } })
  let gate = spendGate(config, spent, NOW)!
  assert.match(gate(anthropic)!.reason, /daily spend cap reached \(\$4\.00 of \$4\.00 on anthropic\)/)
  assert.equal(gate(anthropic)!.until, new Date(2026, 10, 10).getTime())
  assert.equal(gate(openai), undefined)

  // A cap across providers blocks every pay-per-use provider and never a subscription.
  config = cfg({ spend: { monthlyUsd: 50 } })
  gate = spendGate(config, spent, NOW)!
  assert.match(gate(openai)!.reason, /monthly spend cap reached \(\$52\.00 of \$50\.00 across/)
  assert.equal(gate(openai)!.until, new Date(2026, 11, 1).getTime())
  assert.equal(gate(claude), undefined)
  assert.deepEqual(Object.keys(spendBlocks(config, spent, NOW)), ["*"])

  // With the subscriptions limited and the APIs capped, there is nothing to fail over to.
  const pools = new PoolStore(config, () => NOW)
  for (const p of ["claude-agent", "xai", "github-copilot"]) pools.report({ kind: "window", pools: [p], resetAt: NOW + 3_600_000, evidence: "x" })
  const r = route({ config, pools, models: MODELS, preferred: { chain: "opus", index: 0 }, mode: "failover", gate })
  assert.equal(r.target, undefined)
  assert.ok(r.skipped.some((x) => x.startsWith("anthropic/claude-opus-5-5: monthly spend cap reached")))

  const bad = loadConfig({ spend: { dailyUsd: "5", providers: { anthropic: { weeklyUsd: 1 } } } })
  assert.deepEqual(bad.warnings, ["Option spend.dailyUsd should be number; default kept", "Unknown option spend.providers.anthropic.weeklyUsd ignored"])
})

test("save for later: a saved provider is gated until its time, and spans parse", () => {
  assert.equal(saveGate({}, NOW), undefined)
  assert.equal(saveGate({ xai: NOW - 1 }, NOW), undefined)
  const gate = saveGate({ xai: NOW + 3_600_000 }, NOW)!
  assert.deepEqual(gate({ providerID: "xai", id: "grok-4.7" }), { reason: `saved for later until ${new Date(NOW + 3_600_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, until: NOW + 3_600_000 })
  assert.equal(gate({ providerID: "openai", id: "gpt-6.1-sol" }), undefined)

  assert.equal(parseUntil("90m", NOW), NOW + 90 * 60_000)
  assert.equal(parseUntil("2h", NOW), NOW + 7_200_000)
  assert.equal(parseUntil("1.5 hours", NOW), NOW + 5_400_000)
  assert.equal(parseUntil("1d", NOW), NOW + 86_400_000)
  assert.equal(parseUntil("7d", NOW), NOW + 7 * 86_400_000)
  // NOW is 11:00 local: a later time is today, an earlier one tomorrow.
  assert.equal(parseUntil("17:00", NOW), new Date(2026, 10, 9, 17, 0, 0).getTime())
  assert.equal(parseUntil("9:30", NOW), new Date(2026, 10, 10, 9, 30, 0).getTime())
  for (const bad of ["", "0h", "8d", "-2h", "25:00", "12:75", "soon", "2w"]) assert.equal(parseUntil(bad, NOW), undefined, bad)
})

test("agent chains: an agent maps to a chain that exists", () => {
  assert.deepEqual(cfg().agents, {})
  const chain = Object.keys(cfg().chains)[0]
  const { config, warnings } = loadConfig({ agents: { plan: chain, build: "no-such-chain", review: 3, off: null, __proto__: chain } })
  assert.deepEqual(config.agents, { plan: chain })
  assert.deepEqual(warnings, ["agents.build: there is no chain named no-such-chain; ignored", "agents.review should be the name of a chain; ignored"])
  assert.deepEqual(loadConfig({ agents: ["plan"] }).warnings, ["agents should be an object of agent: chain; ignored"])
  // A stored setting is checked the same way.
  assert.equal(checkSetting({}, {}, "agents.plan", chain).ok, true)
  assert.deepEqual(checkSetting({}, {}, "agents.plan", "no-such-chain"), { ok: false, error: "agents.plan: there is no chain named no-such-chain; ignored" })
})

test("forecast: pace over the recent part of a window, restarted by a reset", () => {
  const H = 3_600_000
  const five = { resetAt: NOW + 3 * H, windowMs: 5 * H, limitPct: 98, now: NOW }
  // 20 points in the last hour, at 60% now: 38 points to go takes 1.9 hours, which is before the reset.
  let f = forecast([{ at: NOW - H, pct: 40 }, { at: NOW - H / 2, pct: 50 }, { at: NOW - 60_000, pct: 60 }], five)!
  assert.equal(Math.round(f.ratePerHour), 20)
  assert.equal(f.runsOutAt, NOW + 1.9 * H)
  assert.equal(f.beforeReset, true)
  // The same pace with the reset an hour away is fine.
  f = forecast([{ at: NOW - H, pct: 40 }, { at: NOW - 60_000, pct: 60 }], { ...five, resetAt: NOW + H })!
  assert.equal(f.beforeReset, false)
  // Time with no new usage slows the pace: the last figure still stands now.
  f = forecast([{ at: NOW - H, pct: 40 }, { at: NOW - H + 600_000, pct: 60 }], five)!
  assert.equal(Math.round(f.ratePerHour), 20)
  // Older than the lookback (an hour for a 5-hour window) is not counted, and nor is anything before a drop.
  f = forecast([{ at: NOW - 3 * H, pct: 0 }, { at: NOW - H / 2, pct: 58 }, { at: NOW - 60_000, pct: 60 }], five)!
  assert.equal(Math.round(f.ratePerHour), 4)
  f = forecast([{ at: NOW - H / 2, pct: 90 }, { at: NOW - H / 3, pct: 2 }, { at: NOW - 60_000, pct: 6 }], five)!
  assert.equal(Math.round(f.ratePerHour), 12)
  // Already at the limit.
  assert.equal(forecast([{ at: NOW - H / 2, pct: 90 }, { at: NOW - 60_000, pct: 99 }], five)!.runsOutAt, NOW)
  // A weekly window looks back about a day and a half.
  f = forecast([{ at: NOW - 30 * H, pct: 10 }, { at: NOW - H, pct: 40 }], { resetAt: NOW + 48 * H, windowMs: 168 * H, limitPct: 100, now: NOW })!
  assert.equal(Math.round(f.ratePerHour), 1)
  assert.equal(f.beforeReset, false)
  // Too little to go on: flat usage, under five minutes of history, one figure, or a window that has already reset.
  assert.equal(forecast([{ at: NOW - H, pct: 40 }, { at: NOW - 60_000, pct: 40 }], five), undefined)
  assert.equal(forecast([{ at: NOW - 240_000, pct: 40 }, { at: NOW - 60_000, pct: 45 }], five), undefined)
  assert.equal(forecast([{ at: NOW - H / 2, pct: 40 }], five), undefined)
  assert.equal(forecast([], five), undefined)
  assert.equal(forecast([{ at: NOW - H, pct: 40 }, { at: NOW - 60_000, pct: 60 }], { ...five, resetAt: NOW - 1 }), undefined)
})

test("pace guard: light work prefers another provider, and still uses the plan when nothing else can run", () => {
  const config = cfg({ pace: { enabled: true } })
  const pools = new PoolStore(config, () => NOW)
  const preferred = { chain: "opus", index: 0 }
  const short: WindowForecast = { providerID: "claude-agent", pool: "claude-agent", label: "Claude 5-hour session", pct: 60, limitPct: 98, resetAt: NOW + 3 * 3_600_000, ratePerHour: 20, runsOutAt: NOW + 1.9 * 3_600_000, beforeReset: true }
  assert.equal(paceGate(cfg(), [short], true, NOW), undefined)
  assert.equal(paceGate(config, [short], false, NOW), undefined)
  assert.equal(paceGate(config, [{ ...short, beforeReset: false }], true, NOW), undefined)
  const gate = paceGate(config, [short], true, NOW)!
  assert.equal(gate({ providerID: "claude-agent", id: "opus" })?.soft, true)
  assert.equal(gate({ providerID: "xai", id: "grok-4.7" }), undefined)
  // A forecast for one model's weekly limit only concerns that model.
  const fable = paceGate(config, [{ ...short, pool: "claude-agent:fable" }], true, NOW)!
  assert.equal(fable({ providerID: "claude-agent", id: "opus" }), undefined)
  assert.equal(fable({ providerID: "claude-agent", id: "fable" })?.soft, true)

  let r = route({ config, pools, models: MODELS, preferred, mode: "turn", gate })
  assert.equal(r.target?.providerID, "xai")
  assert.match(r.skipped[0], /on pace to run out at .*kept for the main session/)
  // Everything after Claude is limited: the plan is used after all, rather than waiting.
  for (const p of ["xai", "github-copilot", "anthropic", "openai"]) pools.report({ kind: "window", pools: [p], resetAt: NOW + 3_600_000, evidence: "limit" })
  r = route({ config, pools, models: MODELS, preferred, mode: "failover", gate })
  assert.equal(r.target?.providerID, "claude-agent")
  assert.ok(!r.skipped.some((line) => line.includes("on pace")))
  // A hard block from another policy outranks the soft one.
  const both = composeGates([gate, saveGate({ "claude-agent": NOW + 1000 }, NOW)])!
  assert.equal(both({ providerID: "claude-agent", id: "opus" })?.soft, undefined)
  assert.equal(route({ config, pools, models: MODELS, preferred, mode: "failover", gate: both }).target, undefined)
})

test("Copilot economy: near the end of the allowance, expensive models go elsewhere when they can", () => {
  const config = cfg({ copilot: { economyAtPct: 90 } })
  assert.equal(economyGate(cfg(), 99, MODELS), undefined)
  assert.equal(economyGate(config, 89, MODELS), undefined)
  assert.equal(economyGate(config, undefined, MODELS), undefined)
  const priced = new Map(MODELS).set("github-copilot/claude-opus-5.5", { ...MODELS.get("github-copilot/claude-opus-5.5")!, cost: [{ input: 4, output: 20 }] })
  const gate = economyGate(config, 92, priced)!
  assert.deepEqual(gate({ providerID: "github-copilot", id: "claude-opus-5.5" }), { reason: "Copilot allowance at 92%: what is left is kept for cheaper models", soft: true })
  assert.equal(gate({ providerID: "anthropic", id: "claude-opus-5-5" }), undefined)
  assert.equal(gate({ providerID: "github-copilot", id: "not-priced" }), undefined)
  assert.equal(economyGate(cfg({ copilot: { economyAtPct: 90, economyOutputPrice: 50 } }), 92, priced)!({ providerID: "github-copilot", id: "claude-opus-5.5" }), undefined)
})

test("plans: Claude and Copilot plans are recognised from what the providers report", () => {
  assert.deepEqual(claudePlan("pro", "default_claude_ai"), { id: "claude.pro", name: "Claude Pro", multiplier: 1 })
  assert.deepEqual(claudePlan("max", "default_claude_max_5x"), { id: "claude.max", name: "Claude Max (5x)", multiplier: 5 })
  assert.deepEqual(claudePlan("max", "default_claude_max_20x"), { id: "claude.max", name: "Claude Max (20x)", multiplier: 20 })
  assert.deepEqual(claudePlan("team", "default_claude_max_5x"), { id: "claude.team-premium", name: "Claude Team (premium seat, 5x)", multiplier: 5 })
  assert.equal(claudePlan("team", undefined)?.id, "claude.team-standard")
  assert.equal(claudePlan("enterprise", undefined)?.id, "claude.enterprise")
  assert.equal(claudePlan("ultra", undefined)?.multiplier, 10)
  assert.equal(claudePlan("something-new", undefined)?.id, undefined)
  assert.equal(claudePlan(undefined, undefined), undefined)
  assert.equal(copilotPlan("business"), "copilot.business")
  assert.equal(copilotPlan("individual_pro"), "copilot.pro")
  assert.equal(copilotPlan("pro_plus"), "copilot.pro-plus")
  assert.equal(copilotPlan("free"), undefined)
  assert.equal(new Set(PLANS.map((p) => p.id)).size, PLANS.length)
})

test("plan advice: a larger plan when limits cost more than the difference, a smaller one when most of it went unused", () => {
  const base = { days: 30, coveredDays: 30, fallbackUsd: 0 }
  // Too little record to say anything.
  assert.deepEqual(advise({ ...base, coveredDays: 3, claude: { planID: "claude.pro", hits: 20, limitedMs: 3_600_000 } }), [])

  // Limited often, and the pay-per-use spend is more than the next plan costs.
  let [a] = advise({ ...base, fallbackUsd: 96, claude: { planID: "claude.pro", hits: 14, limitedMs: 40 * 3_600_000, peakWeeklyPct: 100 } })
  assert.equal(a.verdict, "move-up")
  assert.equal(a.title, "Claude: limited 14 times")
  assert.equal(a.detail, "Claude Pro was limited 14 times in the last 30 days, for about 40 h in all, and pay-per-use providers cost $96 in that time. Claude Max has 5 times the allowance for $80 more a month. The pay-per-use spend alone was more than the difference.")
  // Limited a few times with little spent: worth watching, not worth paying for.
  ;[a] = advise({ ...base, fallbackUsd: 4, claude: { planID: "claude.pro", hits: 4, limitedMs: 5 * 3_600_000 } })
  assert.equal(a.verdict, "watch")
  assert.match(a.detail, /pays off only if the waiting costs you more/)
  // A corrected price is used.
  ;[a] = advise({ ...base, fallbackUsd: 60, prices: { "claude.max": 70 }, claude: { planID: "claude.pro", hits: 4, limitedMs: 3_600_000 } })
  assert.match(a.detail, /for \$50 more a month/)
  assert.equal(a.verdict, "move-up")
  // A seat an organisation assigns has no price to compare.
  ;[a] = advise({ ...base, claude: { planID: "claude.team-standard", planName: "Claude Team (standard seat)", hits: 12, limitedMs: 3_600_000 } })
  assert.match(a.detail, /Claude Team \(premium seat\) has 5 times the allowance\.$/)
  assert.equal(a.verdict, "move-up")
  ;[a] = advise({ ...base, claude: { planID: "claude.ultra", hits: 5, limitedMs: 3_600_000 } })
  assert.match(a.detail, /This is the largest plan/)

  // Never limited, and the busiest week would fit in the plan below.
  ;[a] = advise({ ...base, claude: { planID: "claude.max", hits: 0, limitedMs: 0, peakWeeklyPct: 12 } })
  assert.equal(a.verdict, "move-down")
  assert.equal(a.title, "Claude: Claude Pro would have covered it")
  assert.match(a.detail, /costs \$80 less a month and has 20% of the allowance, so that week would have used about 60% of it/)
  // The same peak is too much for the plan below; and two weeks of record are needed before saying so.
  assert.equal(advise({ ...base, claude: { planID: "claude.max", hits: 0, limitedMs: 0, peakWeeklyPct: 30 } })[0].verdict, "keep")
  assert.equal(advise({ ...base, coveredDays: 9, claude: { planID: "claude.max", hits: 0, limitedMs: 0, peakWeeklyPct: 12 } })[0].verdict, "keep")
  // No usage figures and no limits: nothing to say.
  assert.deepEqual(advise({ ...base, claude: { planID: "claude.max", hits: 0, limitedMs: 0 } }), [])

  // Copilot: by credits.
  ;[a] = advise({ ...base, copilot: { planID: "copilot.pro", entitlement: 1500, projected: 5200, overage: 0 } })
  assert.equal(a.verdict, "move-up")
  assert.match(a.detail, /On pace for about 5,200 credits this month against 1,500 included \(347%\)\. Copilot Pro\+ includes 7,000 for \$29 more a month\./)
  ;[a] = advise({ ...base, copilot: { planID: "copilot.pro-plus", entitlement: 7000, projected: 900, overage: 0 } })
  assert.equal(a.verdict, "move-down")
  ;[a] = advise({ ...base, copilot: { planID: "copilot.business", entitlement: 1900, projected: 2400, overage: 0 } })
  assert.equal(a.verdict, "watch")
  assert.match(a.detail, /set by your organisation/)
  assert.equal(advise({ ...base, copilot: { planID: "copilot.pro", entitlement: 1500, projected: 1300, overage: 0 } })[0].verdict, "keep")

  // ChatGPT, where the plan is not known unless set.
  ;[a] = advise({ ...base, chatgpt: { hits: 6, limitedMs: 3_600_000 } })
  assert.equal(a.verdict, "watch")
  assert.match(a.detail, /ChatGPT Pro has a much larger allowance than Plus/)
})

test("classifier fixtures: Gemini, Vertex, OpenRouter, Azure, Bedrock, Ollama Cloud, OpenCode Go and Zen", () => {
  const file = JSON.parse(fs.readFileSync(new URL("./fixtures/classify.json", import.meta.url), "utf8"))
  const now = Date.parse(file.now)
  assert.ok(file.cases.length >= 25)
  for (const c of file.cases) {
    const s = classify(c.provider, c.model, c.error, now)
    if (c.expect === null) {
      assert.equal(s, undefined, c.name)
      continue
    }
    assert.ok(s, c.name)
    assert.equal(s.kind, c.expect.kind, c.name)
    assert.deepEqual(s.pools, c.expect.pools, c.name)
    if (c.expect.evidence) assert.equal(s.evidence, c.expect.evidence, c.name)
    if ("resetAt" in c.expect) assert.equal(s.resetAt && new Date(s.resetAt).toISOString(), new Date(c.expect.resetAt).toISOString(), c.name)
    if ("retryAfterMs" in c.expect) assert.equal(s.retryAfterMs, c.expect.retryAfterMs, c.name)
  }
})

test("resets: midnight in a provider's time zone, and waits given in words", () => {
  const LA = "America/Los_Angeles"
  const next = (iso: string) => new Date(nextMidnightIn(LA, Date.parse(iso))).toISOString()
  assert.equal(next("2026-11-09T19:00:00Z"), "2026-11-10T08:00:00.000Z")
  assert.equal(next("2026-07-01T06:59:59Z"), "2026-07-01T07:00:00.000Z")
  assert.equal(next("2026-07-01T07:00:00Z"), "2026-07-02T07:00:00.000Z")
  // Across the clock changes: 8 March 2026 is 23 hours long in Los Angeles, 1 November 25.
  assert.equal(next("2026-03-08T08:30:00Z"), "2026-03-09T07:00:00.000Z")
  assert.equal(next("2026-11-01T07:30:00Z"), "2026-11-02T08:00:00.000Z")
  assert.equal(parseRetryText("Please retry after 26 seconds."), 26_000)
  assert.equal(parseRetryText("Please retry in 34.07s"), 34_070)
  assert.equal(parseRetryText("try again in 6m0s"), 360_000)
  assert.equal(parseRetryText("Try again in 250ms"), 250)
  assert.equal(parseRetryText("wait for 2 minutes"), 120_000)
  assert.equal(parseRetryText("try again later"), undefined)
  // Per-model providers keep a pool for each model; OpenRouter's free models share one more.
  assert.deepEqual(modelPools("google", "gemini-3-pro"), ["google", "google:gemini-3-pro"])
  assert.deepEqual(modelPools("openrouter", "meta/llama-5:free"), ["openrouter", "openrouter:meta/llama-5:free", "openrouter:free"])
  assert.deepEqual(modelPools("ollama-cloud", "qwen4-coder"), ["ollama-cloud"])
})

test("learned pool: the size of a pool from the times it ran out", () => {
  const DAY = 86_400_000
  const HOUR = 3_600_000
  const now = Date.parse("2026-11-09T19:00:00Z")
  const WEEK = 7 * DAY
  // $2 of usage every day for five weeks.
  const spend = Array.from({ length: 35 }, (_, i) => ({ at: now - (35 - i) * DAY, usd: 2 }))
  assert.equal(learnPool({ exhausted: [], spend, windowMs: WEEK, now }), undefined, "nothing to learn from until it has run out")
  assert.equal(learnPool({ exhausted: [{ at: now - 3 * DAY }], spend: [], windowMs: WEEK, now }), undefined, "no usage on record")

  // Ran out 20 days ago after a full week of use: the week before holds $14.
  const once = learnPool({ exhausted: [{ at: now - 20 * DAY + HOUR, until: now - 19 * DAY }], spend, windowMs: WEEK, now })
  assert.ok(once)
  assert.equal(once.capacityUsd, 14)
  assert.equal(once.samples, 1)
  assert.equal(once.usedUsd, 14, "a rolling week when it last came back longer ago than that")
  assert.equal(once.pct, 100)
  assert.equal(once.resetAt, undefined)

  // Repeated errors in one outage are one episode; a second outage starts its window where the first ended.
  const twice = learnPool({
    exhausted: [{ at: now - 20 * DAY + HOUR, until: now - 19 * DAY }, { at: now - 20 * DAY + 2 * HOUR, until: now - 19 * DAY }, { at: now - 3 * DAY + HOUR, until: now - 2 * DAY }],
    spend, windowMs: WEEK, now,
  })
  assert.ok(twice)
  assert.equal(twice.samples, 2)
  assert.equal(twice.capacityUsd, 14)
  assert.equal(twice.windowStart, now - 2 * DAY, "the window is anchored on when it came back")
  assert.equal(twice.usedUsd, 4)
  assert.ok(Math.abs(twice.pct - (4 / 14) * 100) < 1e-9)
  assert.equal(twice.resetAt, now + 5 * DAY)
  assert.equal(twice.exhausted, false)

  // Out right now: full, and back when the limit says.
  const out = learnPool({ exhausted: [{ at: now - HOUR, until: now + 6 * HOUR }], spend, windowMs: WEEK, now })
  assert.equal(out?.exhausted, true)
  assert.equal(out?.pct, 100)
  assert.equal(out?.resetAt, now + 6 * HOUR)
})

test("a local server that is not running is passed over", () => {
  assert.equal(downGate({}), undefined)
  const gate = downGate({ ollama: "Ollama is not running" })
  assert.deepEqual(gate?.({ providerID: "ollama", id: "qwen4-coder:32b" }), { reason: "Ollama is not running" })
  assert.equal(gate?.({ providerID: "anthropic", id: "claude-opus-5-5" }), undefined)
  assert.equal(checkSetting({}, {}, "local.ollamaUrl", "http://203.0.113.5:11434").ok, false, "where health checks go is set in opencode.jsonc only")
  assert.equal(checkSetting({}, {}, "local.healthCheck", false).ok, true)
})

test("health: time to first token, error rate, and what routing does with them", () => {
  const MIN = 60_000
  const config = cfg()
  const req = (providerID: string, minsAgo: number, ok: boolean, firstMs?: number, errorType?: string) => ({ providerID, at: NOW - minsAgo * MIN, ok, firstMs, errorType })
  const samples = [
    req("claude-agent", 50, true, 900), req("claude-agent", 40, true, 1100), req("claude-agent", 2, true, 1000),
    // Six requests in the window, four failed with server errors; a rate limit and a bad request are not health.
    req("xai", 12, true, 400), req("xai", 10, false, undefined, "provider.internal"), req("xai", 8, false, undefined, "provider.unknown"),
    req("xai", 6, false, undefined, "provider.internal"), req("xai", 4, true, 420), req("xai", 3, false, undefined, "provider.internal"),
    req("xai", 2, false, undefined, "provider.rate-limit"), req("xai", 1, false, undefined, "provider.invalid-request"),
    // Older than the window: counts towards speed, not towards the error rate.
    req("xai", 40, true, 380),
  ]
  const health = summariseHealth(samples, NOW, config.health.windowMs)
  assert.deepEqual(health["claude-agent"], { requests: 1, failed: 0, firstTokenMs: 1000, timed: 3 })
  assert.deepEqual(health.xai, { requests: 6, failed: 4, firstTokenMs: 400, timed: 3 })
  assert.equal(unreliable(config, health.xai), true)
  assert.equal(unreliable(config, health["claude-agent"]), false)
  assert.equal(unreliable(config, { requests: 4, failed: 4, timed: 0 }), false, "too few requests to judge")

  const gate = healthGate(config, health)
  assert.deepEqual(gate?.({ providerID: "xai", id: "grok-4.7" }), { reason: "unreliable right now (4 of the last 6 requests failed)", soft: true })
  assert.equal(gate?.({ providerID: "claude-agent", id: "opus" }), undefined)
  assert.equal(healthGate(cfg({ health: { enabled: false } }), health), undefined)

  // A failing provider is passed over while another can run, and still used when nothing else can.
  const pools = new PoolStore(config, () => NOW)
  const first = cfg({ providers: { xai: { priority: 0 } } })
  const preferred = { ...findInChains(first, { providerID: "xai", id: "grok-4.7" })!, variant: "high" }
  assert.equal(route({ config: first, pools, models: MODELS, preferred, mode: "turn" }).target?.providerID, "xai")
  assert.equal(route({ config: first, pools, models: MODELS, preferred, mode: "turn", gate }).target?.providerID, "claude-agent")
  const only = new Map([...MODELS].filter(([k]) => k.startsWith("xai/")))
  assert.equal(route({ config: first, pools, models: only, preferred, mode: "turn", gate }).target?.providerID, "xai")

  // Same priority: the provider that starts answering clearly sooner goes first; otherwise the configured order stands.
  const tied = cfg({ providers: { "claude-agent": { priority: 1 }, xai: { priority: 1 } } })
  const chain = orderedChain(tied, "opus")
  const ids = (order: number[]) => order.map((i) => chain[i].providerID)
  assert.deepEqual(ids(fasterFirst(tied, chain)).slice(0, 2), ["claude-agent", "xai"])
  assert.deepEqual(ids(fasterFirst(tied, chain, speedOf(health))).slice(0, 2), ["xai", "claude-agent"])
  assert.deepEqual(ids(fasterFirst(tied, chain, speedOf({ ...health, xai: { ...health.xai, firstTokenMs: 900 } }))).slice(0, 2), ["claude-agent", "xai"], "within a fifth is not clearly faster")
  assert.deepEqual(ids(fasterFirst(tied, chain, speedOf({ ...health, xai: { ...health.xai, timed: 2 } }))).slice(0, 2), ["claude-agent", "xai"], "too few timings to trust")
  assert.deepEqual(ids(fasterFirst(config, orderedChain(config, "opus"), speedOf(health))), ids(fasterFirst(config, orderedChain(config, "opus"))), "different priorities are never reordered")
  const p1 = { ...findInChains(tied, { providerID: "claude-agent", id: "opus" })!, variant: "medium" }
  assert.equal(route({ config: tied, pools, models: MODELS, preferred: p1, mode: "turn", speed: speedOf(health) }).target?.providerID, "xai")
})

test("project rules: a project can shut providers out; only your own settings can choose its chain", () => {
  const config = cfg({ projects: { "/work/client-x": { deny: ["xai"], denyKinds: ["local"], chain: "sonnet" }, "/work": { allow: ["claude-agent", "anthropic", "xai"] }, "/bad": { chain: "nope", deny: "xai", extra: 1 } } })
  assert.equal(config.projects["/work/client-x"].chain, "sonnet")
  assert.deepEqual(config.projects["/bad"], { deny: [], allow: undefined, denyKinds: [], source: "your settings" })
  const { warnings } = loadConfig({ projects: { "/bad": { chain: "nope", deny: "xai", extra: 1 } } })
  assert.equal(warnings.length, 3)

  // The longest matching directory wins; a sibling with the same prefix does not match.
  assert.equal(matchProject(config.projects, "/work/client-x/api")?.[0], "/work/client-x")
  assert.equal(matchProject(config.projects, "/work/client-xyz")?.[0], "/work")
  assert.equal(matchProject(config.projects, "/elsewhere"), undefined)
  assert.equal(matchProject(config.projects, undefined), undefined)

  // A file that comes with the project may shut providers out, but not choose a chain.
  const file = parseRules({ deny: ["github-copilot"], chain: "opus", denyKinds: ["metered", "free"] }, ".opencode/quota-router.json", false, ["opus"])
  assert.equal(file.rules?.chain, undefined)
  assert.deepEqual(file.rules?.denyKinds, ["metered"])
  assert.equal(file.warnings.length, 2)
  assert.equal(parseRules([], "x", false).rules, undefined)

  // Together: everything either shuts out stays out, and an allow list narrows, never widens.
  const both = combineRules([config.projects["/work/client-x"], file.rules])!
  assert.deepEqual(both.deny, ["xai", "github-copilot"])
  assert.deepEqual(both.denyKinds, ["local", "metered"])
  assert.equal(both.chain, "sonnet")
  assert.deepEqual(combineRules([{ deny: [], allow: ["a", "b"], denyKinds: [], source: "1" }, { deny: [], allow: ["b", "c"], denyKinds: [], source: "2" }])?.allow, ["b"])
  assert.equal(combineRules([undefined, undefined]), undefined)

  assert.match(ruledOut(config, both, "xai") ?? "", /xai is not allowed in this project/)
  assert.match(ruledOut(config, both, "anthropic") ?? "", /metered providers are not allowed/)
  assert.equal(ruledOut(config, both, "claude-agent"), undefined)
  assert.match(ruledOut(config, config.projects["/work"], "openai") ?? "", /only claude-agent, anthropic, xai is allowed/)
  assert.equal(rulesGate(config, { deny: [], denyKinds: [], source: "x" }), undefined)

  // Routing never goes to a provider the rules shut out, even when it is the only one left.
  const pools = new PoolStore(config, () => NOW)
  const preferred = { ...findInChains(config, { providerID: "claude-agent", id: "opus" })!, variant: "medium" }
  pools.report({ kind: "window", pools: ["claude-agent"], evidence: "limit", resetAt: NOW + 3_600_000 })
  assert.equal(route({ config, pools, models: MODELS, preferred, mode: "turn" }).target?.providerID, "xai")
  const r = route({ config, pools, models: MODELS, preferred, mode: "turn", gate: rulesGate(config, both) })
  assert.equal(r.target, undefined)
  assert.ok(r.skipped.some((line) => /xai\/grok-4.7: xai is not allowed in this project/.test(line)))
})
