import { test } from "node:test"
import assert from "node:assert/strict"
import { classify, modelPools } from "../src/engine/classify.ts"
import { checkSetting, loadConfig, overlay, parseRef, withSetting } from "../src/engine/config.ts"
import { composeGates, parseUntil, saveGate, spendBlocks, spendGate } from "../src/engine/policy.ts"
import { forecast, paceGate, type WindowForecast } from "../src/engine/forecast.ts"
import { parseDuration, parseResetText, parseRetryAfter, nextMonthUtc } from "../src/engine/resets.ts"
import { PoolStore } from "../src/engine/pools.ts"
import { findInChains, mapVariant, orderedChain, route } from "../src/engine/router.ts"
import { costOf, estimate } from "../src/engine/pricing.ts"
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
