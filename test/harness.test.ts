import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qr-test-"))
process.env.XDG_DATA_HOME = tmp

const { Core } = await import("../src/core.ts")
const { onEvent, onPrompt, onRetry } = await import("../src/controller.ts")
const { startDashboard } = await import("../src/dashboard/server.ts")
const q = await import("../src/dashboard/queries.ts")

const MODELS = [
  ["claude-agent", "opus", [], 1_000_000],
  ["xai", "grok-4.7", [{ input: 2, output: 6 }], 500_000],
  ["github-copilot", "claude-opus-5.5", [{ input: 4, output: 20 }], 1_000_000],
  ["anthropic", "claude-opus-5-5", [{ input: 4, output: 20, cache: { read: 0.2, write: 5 } }], 1_000_000],
  ["openai", "gpt-6.1-sol", [{ input: 2, output: 10 }], 1_050_000],
].map(([providerID, id, cost, context]) => ({ providerID, id, cost, limit: { context }, variants: ["low", "medium", "high", "xhigh", "max"].map((v) => ({ id: v })) }))

let n = 0
const evt = (type: string, data: Record<string, unknown>) => ({ id: `evt_test${++n}`, type, created: Date.now(), data })

function fakeCtx(core: any) {
  const calls = { switches: [] as any[], synthetic: [] as any[] }
  const sessionModels = new Map<string, any>()
  const ctx = {
    options: {},
    model: { list: async () => MODELS },
    session: {
      get: async ({ sessionID }: any) => ({ id: sessionID, model: sessionModels.get(sessionID) }),
      switchModel: async ({ sessionID, model }: any) => {
        calls.switches.push({ sessionID, model })
        const previous = sessionModels.get(sessionID)
        sessionModels.set(sessionID, model)
        // OpenCode publishes session.model.selected straight away.
        queueMicrotask(() => void onEvent(core, evt("session.model.selected", { sessionID, model, previous })))
      },
      synthetic: async (input: any) => calls.synthetic.push(input),
    },
    integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
  }
  return { ctx, calls, sessionModels }
}

let core: any
let harness: ReturnType<typeof fakeCtx>

before(async () => {
  core = await Core.create({ claude: { usageProbe: false }, copilot: { usageProbe: false }, backfill: false, dashboard: { enabled: false } })
  harness = fakeCtx(core)
  core.ctx = harness.ctx
  await core.refreshModels(true)
})
after(() => {
  core.stopTimers()
  core.store.close()
})

const flush = () => new Promise((r) => setTimeout(r, 10))

test("Claude window error fails over in place to xAI", async () => {
  const sid = "ses_a"
  harness.sessionModels.set(sid, { providerID: "claude-agent", id: "opus", variant: "medium" })
  await onEvent(core, evt("session.created", { sessionID: sid, model: { providerID: "claude-agent", id: "opus", variant: "medium" }, location: { directory: "/tmp/proj" }, title: "Build thing" }))
  const e: any = {
    sessionID: sid,
    model: { providerID: "claude-agent", id: "opus", variant: "medium" },
    error: { type: "provider.unknown", message: `Claude Code subscription limit reached (five hour). Resets at ${new Date(Date.now() + 3_600_000).toISOString()}.` },
    attempt: 2,
    decision: { retry: false },
  }
  await onRetry(core, e)
  await flush()
  assert.deepEqual(e.decision, { retry: true, delay: 0 })
  assert.deepEqual(harness.calls.switches.at(-1).model, { providerID: "xai", id: "grok-4.7", variant: "high" })
  assert.equal(core.pools.get("claude-agent").status, "cooling")
  // Our own switch must not be mistaken for a manual change.
  assert.equal(core.sessions.get(sid).preferred.model.providerID, "claude-agent")
  const r = core.store.all("SELECT trigger, from_model, to_model FROM routing WHERE session_id = ?", sid)
  assert.deepEqual(r.map((x: any) => x.trigger), ["failover"])
})

test("short throttle retries in place", async () => {
  const sid = "ses_a"
  const before = harness.calls.switches.length
  const e: any = {
    sessionID: sid,
    model: { providerID: "xai", id: "grok-4.7", variant: "high" },
    error: { type: "provider.rate-limit", status: 429, message: "rate limited", retryAfterMs: 5000 },
    attempt: 2,
    decision: { retry: true, delay: 5000 },
  }
  await onRetry(core, e)
  assert.deepEqual(e.decision, { retry: true, delay: 5000 })
  assert.equal(harness.calls.switches.length, before)
  assert.equal(core.pools.get("xai").status, "available")
})

test("next turn returns to Claude once its window has reset", async () => {
  const sid = "ses_a"
  // Pretend the reset time passed.
  const p = core.pools.get("claude-agent")
  core.pools.load([{ ...p, until: Date.now() - 1000 }])
  // The session was moved moments ago and xAI still works, so it stays: moving back would send the context a third time.
  const moves = harness.calls.switches.length
  await onPrompt(core, { sessionID: sid })
  await flush()
  assert.equal(harness.calls.switches.length, moves)
  core.session(sid).movedAt = Date.now() - core.config.switching.minStayMs - 1
  await onPrompt(core, { sessionID: sid })
  await flush()
  assert.deepEqual(harness.calls.switches.at(-1).model, { providerID: "claude-agent", id: "opus", variant: "medium" })
  const last = core.store.get("SELECT trigger FROM routing WHERE session_id = ? ORDER BY id DESC LIMIT 1", sid)
  assert.equal(last.trigger, "recovery")
})

test("a manual model change becomes the session's preference", async () => {
  const sid = "ses_a"
  await onEvent(core, evt("session.model.selected", { sessionID: sid, model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } }))
  const s = core.sessions.get(sid)
  assert.equal(s.preferred.model.providerID, "anthropic")
  assert.equal(s.preferred.variant, "high")
  // Back to the Claude subscription for the rest of the tests.
  await onEvent(core, evt("session.model.selected", { sessionID: sid, model: { providerID: "claude-agent", id: "opus", variant: "medium" } }))
})

test("every provider limited: wait for the earliest reset", async () => {
  const sid = "ses_b"
  harness.sessionModels.set(sid, { providerID: "claude-agent", id: "opus", variant: "medium" })
  await onEvent(core, evt("session.created", { sessionID: sid, model: { providerID: "claude-agent", id: "opus", variant: "medium" } }))
  for (const p of ["xai", "github-copilot", "anthropic", "openai"]) core.pools.report({ kind: "window", pools: [p], resetAt: Date.now() + (p === "anthropic" ? 600_000 : 7_200_000), evidence: "test" })
  const e: any = {
    sessionID: sid,
    model: { providerID: "claude-agent", id: "opus", variant: "medium" },
    error: { type: "provider.unknown", message: `You've hit your session limit · resets ${new Date(Date.now() + 3 * 3_600_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "")}` },
    attempt: 2,
    decision: { retry: false },
  }
  await onRetry(core, e)
  await flush()
  assert.equal(e.decision.retry, true)
  assert.ok(e.decision.delay > 500_000 && e.decision.delay <= 1_800_000, `delay ${e.decision.delay}`)
  assert.equal(harness.calls.switches.at(-1).model.providerID, "anthropic")
  for (const p of ["claude-agent", "xai", "github-copilot", "anthropic", "openai"]) core.pools.reset(p)
})

test("failed execution continues once on the next provider", async () => {
  const sid = "ses_c"
  harness.sessionModels.set(sid, { providerID: "xai", id: "grok-4.7" })
  await onEvent(core, evt("session.created", { sessionID: sid, model: { providerID: "claude-agent", id: "opus", variant: "medium" } }))
  await onEvent(core, evt("session.step.started", { sessionID: sid, assistantMessageID: "msg_1", model: { providerID: "xai", id: "grok-4.7" }, agent: "build" }))
  const failed = evt("session.execution.failed", { sessionID: sid, error: { type: "provider.auth", status: 403, message: "You have run out of credits or need a Grok subscription", response: { body: '{"code":"personal-team-blocked:spending-limit"}' } } })
  await onEvent(core, failed)
  await onEvent(core, failed)
  await flush()
  const mine = harness.calls.synthetic.filter((s: any) => s.sessionID === sid)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].resume, true)
  assert.equal(mine[0].id, `msg_qr${failed.id.replace(/^evt_/, "")}`)
  // Claude is preferred and available, so the continuation goes back to it.
  assert.equal(harness.calls.switches.at(-1).model.providerID, "claude-agent")
  assert.equal(core.pools.get("xai").status, "cooling")
})

test("deterministic errors are left to OpenCode", async () => {
  const e: any = { sessionID: "ses_a", model: { providerID: "claude-agent", id: "opus" }, error: { type: "provider.content-filter", message: "blocked" }, attempt: 2, decision: { retry: false } }
  await onRetry(core, e)
  assert.deepEqual(e.decision, { retry: false })
})

test("unmanaged models are not routed", async () => {
  const sid = "ses_free"
  harness.sessionModels.set(sid, { providerID: "opencode", id: "iceman-free" })
  const before = harness.calls.switches.length
  await onPrompt(core, { sessionID: sid })
  const e: any = { sessionID: sid, model: { providerID: "opencode", id: "iceman-free" }, error: { type: "provider.rate-limit", status: 429, message: "slow", retryAfterMs: 60_000 }, attempt: 2, decision: { retry: true, delay: 60_000 } }
  await onRetry(core, e)
  assert.equal(harness.calls.switches.length, before)
  assert.deepEqual(e.decision, { retry: true, delay: 60_000 })
})

test("Claude usage probe: cutover before usage credits, early recovery after reset", () => {
  const now = Date.now()
  core.applyClaude({ windows: [{ pool: "claude-agent", label: "5-hour session", utilization: 99, resetAt: now + 3_600_000 }], extra: { enabled: true, used: 0, spendLimitReached: false } }, now)
  assert.equal(core.pools.usable("claude-agent"), "no")
  core.pools.success(["claude-agent"])
  assert.equal(core.pools.usable("claude-agent"), "no", "in-flight success must not undo the cutover")
  core.applyClaude({ windows: [{ pool: "claude-agent", label: "5-hour session", utilization: 2, resetAt: now + 5 * 3_600_000 }], extra: { enabled: true, used: 0, spendLimitReached: false } }, now)
  assert.equal(core.pools.usable("claude-agent"), "yes")
  core.applyClaude({ windows: [{ pool: "claude-agent", label: "5-hour session", utilization: 40, resetAt: now + 3_600_000 }], extra: { enabled: true, used: 1.5, spendLimitReached: false } }, now)
  assert.equal(core.pools.usable("claude-agent"), "no", "credits going up means a window is spent")
  core.pools.reset("claude-agent")
  core.claude.lastExtraUsed = undefined
})

test("Copilot probe: cut over at the included allowance", () => {
  const now = Date.now()
  core.applyCopilot({ name: "premium_interactions", entitlement: 300, remaining: 120, percentRemaining: 40, unlimited: false, overagePermitted: true, overageUsed: 0, resetAt: now + 86_400_000 }, now)
  assert.equal(core.pools.usable("github-copilot"), "yes")
  core.applyCopilot({ name: "premium_interactions", entitlement: 300, remaining: 2, percentRemaining: 0.6, unlimited: false, overagePermitted: true, overageUsed: 0, resetAt: now + 86_400_000 }, now)
  assert.equal(core.pools.usable("github-copilot"), "no")
  core.pools.reset("github-copilot")
})

test("OpenRouter probe: leave when the key's limit is spent; free models have their own allowance", () => {
  const now = Date.now()
  const reset = now + 86_400_000
  core.applyOpenRouter({ limitUsd: 20, remainingUsd: 6, usedUsd: 14, scope: "key", interval: "monthly", resetAt: reset, freeTier: false, free: { used: 1000, limit: 1000, remaining: 0 } }, now)
  assert.equal(core.pools.usable("openrouter"), "yes")
  assert.equal(core.pools.usable("openrouter:free"), "no", "paid models stay usable when the free allowance is gone")
  core.applyOpenRouter({ limitUsd: 20, remainingUsd: 0, usedUsd: 20.01, scope: "key", interval: "monthly", resetAt: reset, freeTier: false, free: { used: 3, limit: 1000, remaining: 997 } }, now)
  assert.equal(core.pools.usable("openrouter"), "no")
  assert.match(core.pools.get("openrouter").evidence ?? "", /key limit spent \(\$0\.00 of \$20\.00 left\)/)
  assert.equal(core.pools.usable("openrouter:free"), "yes")
  // Topped up: the next check clears it.
  core.applyOpenRouter({ limitUsd: 50, remainingUsd: 30, usedUsd: 20, scope: "key", resetAt: reset, freeTier: false }, now)
  assert.equal(core.pools.usable("openrouter"), "yes")
  // No limit on the key: nothing to measure, nothing blocked.
  core.applyOpenRouter({ usedUsd: 3, freeTier: false }, now)
  assert.equal(core.pools.usable("openrouter"), "yes")
  core.pools.reset("openrouter")
  core.pools.reset("openrouter:free")
})

test("xAI: the weekly pool is estimated from the times it ran out", () => {
  const now = Date.now()
  const DAY = 86_400_000
  assert.ok(core.hasProvider("xai"))
  const fresh = () => ((core as any).learnedCache = (core as any).forecastCache = undefined)
  core.store.run("DELETE FROM pool_log WHERE pool = 'xai'")
  fresh()
  assert.equal(core.learned(now).xai, undefined)
  for (let i = 1; i <= 12; i++) core.store.run("INSERT INTO steps (id, session_id, provider_id, model_id, started_at, ended_at, status, cost_equiv) VALUES (?, 'ses_learn', 'xai', 'grok-4.7', ?, ?, 'ok', 3)", `learn${i}`, now - i * DAY, now - i * DAY + 1000)
  core.store.run("INSERT INTO pool_log (at, pool, status, kind, until) VALUES (?, 'xai', 'cooling', 'window', ?)", now - 4.5 * DAY, now - 3.5 * DAY)
  fresh()
  const x = core.learned(now).xai
  assert.ok(x)
  assert.equal(x.capacityUsd, 21, "seven days at $3 before it ran out")
  assert.equal(x.usedUsd, 9, "three days since it came back")
  assert.equal(x.resetAt, now - 3.5 * DAY + 7 * DAY)
  const f = core.forecasts(now).find((w: any) => w.providerID === "xai")
  assert.ok(f, "the estimate feeds the forecast")
  assert.match(f.label, /estimated/)
  core.store.run("DELETE FROM steps WHERE session_id = 'ses_learn'")
  core.store.run("DELETE FROM pool_log WHERE pool = 'xai'")
  fresh()
})

test("recorder: steps, costs and dashboard queries", async () => {
  const sid = "ses_rec"
  await onEvent(core, evt("session.created", { sessionID: sid, model: { providerID: "claude-agent", id: "opus" }, location: { directory: "/home/user/project" }, title: "Recorder" }))
  core.recorder.handle(evt("session.created", { sessionID: sid, model: { providerID: "claude-agent", id: "opus" }, location: { directory: "/home/user/project" }, title: "Recorder" }))
  core.recorder.handle(evt("session.execution.started", { sessionID: sid }))
  core.recorder.handle(evt("session.step.started", { sessionID: sid, assistantMessageID: "msg_r1", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "medium" } }))
  core.recorder.handle(evt("session.tool.input.started", { sessionID: sid, assistantMessageID: "msg_r1", id: "toolu_1", name: "shell" }))
  assert.equal(core.recorder.live.get(sid).tools.length, 1)
  core.recorder.handle(evt("session.tool.success", { sessionID: sid, assistantMessageID: "msg_r1", id: "toolu_1" }))
  core.recorder.handle(evt("session.step.ended", { sessionID: sid, assistantMessageID: "msg_r1", finish: "stop", cost: 0, tokens: { input: 1000, output: 1000, reasoning: 0, cache: { read: 100_000, write: 0 } } }))
  core.recorder.handle(evt("session.execution.succeeded", { sessionID: sid }))
  const row: any = core.store.get("SELECT * FROM steps WHERE session_id = ?", sid)
  assert.equal(row.status, "ok")
  assert.ok(Math.abs(row.cost_equiv - 0.044) < 1e-9)
  assert.ok(Math.abs(row.cost_actual - 0.044) < 1e-9, "Anthropic API is pay-per-use")
  assert.equal(core.recorder.live.has(sid), false)
  core.maintain()
  for (const range of ["today", "7d", "all"]) {
    const r = q.resolveRange(range)
    const sum: any = q.summary(core.store, r)
    assert.ok(sum.tokens >= 102_000, `${range} tokens ${sum.tokens}`)
    assert.ok(sum.efficiency.toolCalls >= 1, `${range} tool calls`)
    assert.ok(sum.efficiency.cacheHitRate > 0 && sum.efficiency.cacheHitRate < 1)
    assert.equal(sum.efficiency.tokensPerToolCall, Math.round(sum.tokens / sum.efficiency.toolCalls))
    assert.ok(q.series(core.store, r).rows.length > 0)
    assert.ok(q.breakdown(core.store, r, "project").rows.some((x: any) => x.key === "/home/user/project"))
    assert.ok(q.tools(core.store, r).rows.some((x: any) => x.name === "shell"))
  }
  const page = q.sessions(core.store, q.resolveRange("7d"))
  const mine: any = page.rows.find((x: any) => x.id === sid)
  assert.ok(mine, "session listed")
  assert.equal(mine.tokens, 102_000)
  assert.ok(mine.busy_ms >= 0)
  assert.match([...q.csv(core.store, "steps", 0)].join(""), /^id,session_id/)
})

test("store: rollups match raw rows, pagination and retention", async () => {
  const { Store, localDay } = await import("../src/db.ts")
  const m = await import("../src/maintenance.ts")
  const store = await Store.open(path.join(tmp, "big.db"))
  assert.equal(store.meta("schema_version"), "6")
  assert.equal(Number((store.get("PRAGMA auto_vacuum") as any).auto_vacuum), 2, "incremental auto-vacuum")
  const now = Date.now()
  const DAY = 86_400_000
  // 40 days x 50 sessions x 10 steps = 20,000 steps across 3 providers.
  store.transaction(() => {
    for (let d = 0; d < 40; d++)
      for (let s = 0; s < 50; s++) {
        const sid = `ses_${d}_${s}`
        const at = now - d * DAY - s * 60_000
        store.run("INSERT INTO sessions (id, title, directory, created_at) VALUES (?, ?, ?, ?)", sid, `Session ${d}/${s}`, `/p/${s % 4}`, at)
        for (let k = 0; k < 10; k++) {
          const t = at + k * 1000
          store.run(
            `INSERT INTO steps (id, session_id, kind, provider_id, model_id, started_at, ended_at, status, input, output, cache_read, cost_equiv, cost_actual, day)
             VALUES (?, ?, 'primary', ?, 'm', ?, ?, ?, 10, 5, 100, 0.01, ?, ?)`,
            `st_${d}_${s}_${k}`, sid, ["claude-agent", "xai", "anthropic"][k % 3], t, t + 500, k === 9 ? "failed" : "ok", k % 3 === 2 ? 0.01 : 0, localDay(t),
          )
        }
        store.run("INSERT INTO tools (id, session_id, name, started_at, ended_at, status, day) VALUES (?, ?, 'shell', ?, ?, 'ok', ?)", `tl_${d}_${s}`, sid, at, at + 200, localDay(at))
        store.run("INSERT INTO routing (at, session_id, trigger, from_model, to_model, evidence) VALUES (?, ?, ?, 'claude-agent/opus', 'xai/grok-4.7', 'limit')", at, sid, s % 5 === 0 ? "recovery" : "failover")
        m.markDirty(store, sid, at)
      }
  })
  while (m.rollupDirty(store) > 0);
  while (m.refreshSessions(store) > 0);

  // Rollups agree with the raw rows for every range.
  for (const range of ["7d", "30d", "all"]) {
    const r = q.resolveRange(range)
    const raw: any = store.get("SELECT COUNT(*) AS steps, SUM(input + output + cache_read) AS tokens FROM steps WHERE day >= ?", r.fromDay)
    const sum: any = q.summary(store, r)
    assert.equal(sum.steps, raw.steps, `${range} steps`)
    assert.equal(sum.tokens, raw.tokens, `${range} tokens`)
  }
  assert.equal(q.series(store, q.resolveRange("1y")).bucket, "week")
  assert.equal(q.breakdown(store, q.resolveRange("all"), "provider").total, 3)

  // Keyset pagination walks every session exactly once.
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let i = 0; i < 200; i++) {
    const page = q.sessions(store, q.resolveRange("all"), { cursor, limit: 100 })
    for (const row of page.rows) seen.add(row.id)
    cursor = page.next
    if (!cursor) break
  }
  assert.equal(seen.size, 2000)
  assert.equal(q.sessions(store, q.resolveRange("all"), { q: "Session 3/1" }).rows.length, 11)

  // Routing groups: one row per day x change, paginated.
  const g1 = q.routingGroups(store, q.resolveRange("all"), { limit: 10 })
  assert.equal(g1.groups.length, 10)
  assert.ok(g1.groups[0].n >= 1 && g1.next)
  const g2 = q.routingGroups(store, q.resolveRange("all"), { limit: 10, before: g1.next })
  assert.ok(g2.groups.every((g: any) => g.last_at < g1.next!))
  assert.equal(q.routingSummary(store, q.resolveRange("all")).all, 2000)
  const first = g1.groups[0]
  const ev = q.routingEvents(store, { day: first.day, trigger: first.trigger, from: first.from_model, to: first.to_model, limit: 5 })
  assert.equal(ev.rows.length, Math.min(5, first.n))

  // Retention drops old raw tool rows but the rollup keeps their totals.
  const toolsBefore: any = q.tools(store, q.resolveRange("all")).rows[0]
  m.prune(store, now, { toolsDays: 10, executionsDays: 10, snapshotsDays: 10, poolLogDays: 10 })
  assert.ok((store.get("SELECT COUNT(*) AS n FROM tools") as any).n < 2000)
  assert.equal((q.tools(store, q.resolveRange("all")).rows[0] as any).calls, toolsBefore.calls)
  m.optimize(store)
  store.close()
})

test("recorder: a retried attempt is recorded as failed with its error", () => {
  const sid = "ses_retry"
  core.recorder.handle(evt("session.execution.started", { sessionID: sid }))
  core.recorder.handle(evt("session.step.started", { sessionID: sid, assistantMessageID: "msg_x", model: { providerID: "claude-agent", id: "opus" } }))
  core.recorder.handle(evt("session.retry.scheduled", { sessionID: sid, assistantMessageID: "msg_x", attempt: 2, at: Date.now(), error: { type: "provider.unknown", message: "limit reached" } }))
  core.recorder.handle(evt("session.step.started", { sessionID: sid, assistantMessageID: "msg_x", model: { providerID: "xai", id: "grok-4.7" } }))
  core.recorder.handle(evt("session.step.ended", { sessionID: sid, assistantMessageID: "msg_x", finish: "stop", cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }))
  core.recorder.handle(evt("session.execution.succeeded", { sessionID: sid }))
  const rows: any[] = core.store.all("SELECT provider_id, status, error_message FROM steps WHERE session_id = ? ORDER BY started_at, rowid", sid)
  assert.deepEqual(rows.map((r) => `${r.provider_id}:${r.status}`), ["claude-agent:failed", "xai:ok"])
  assert.equal(rows[0].error_message, "limit reached")
})

test("dashboard serves the page and state, and rejects foreign hosts", async () => {
  core.config.dashboard.port = 47900 + Math.floor(Math.random() * 90)
  const d = await startDashboard(core)
  assert.ok(d)
  try {
    const page = await fetch(d.url)
    assert.match(await page.text(), /quota-router/)
    const state: any = await (await fetch(`${d.url}/api/state`)).json()
    assert.ok(Array.isArray(state.providers) && state.providers[0].id === "claude-agent")
    assert.deepEqual(Object.keys(await (await fetch(`${d.url}/api/notifications?after=0`)).json()), ["alerts", "last"])
    assert.deepEqual(Object.keys(await (await fetch(`${d.url}/api/status`)).json()).slice(0, 4), ["now", "enabled", "paused", "dryRun"])
    const doctor: any = await (await fetch(`${d.url}/api/doctor`)).json()
    assert.ok(doctor.checks.some((c: any) => c.id === "routing" && c.status === "ok"))
    // fetch cannot override Host, so use a raw request, as a DNS-rebinding page would produce.
    const http = await import("node:http")
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(d.url)
      http.get({ host: u.hostname, port: u.port, path: "/api/state", headers: { host: "evil.example" } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }).on("error", reject)
    })
    assert.equal(status, 403)
    const noHeader = await fetch(`${d.url}/api/action`, { method: "POST", body: '{"action":"pause"}' })
    assert.equal(noHeader.status, 403)
    const ok = await fetch(`${d.url}/api/action`, { method: "POST", headers: { "x-quota-router": "1", "content-type": "application/json" }, body: '{"action":"pause"}' })
    assert.equal(ok.status, 200)
    assert.equal(core.paused, true)
    core.paused = false
  } finally {
    await d.stop()
  }
})

test("settings changed at runtime are stored, applied over the options, and can be cleared", async () => {
  assert.equal(core.config.claude.warnAtPct, 85)
  assert.deepEqual(core.setSetting("claude.warnAtPct", 70), { ok: true })
  assert.equal(core.config.claude.warnAtPct, 70)
  assert.deepEqual(JSON.parse(core.store.meta("settings")), { claude: { warnAtPct: 70 } })
  // Survives the options being re-applied, as happens when a second plugin instance starts.
  core.setOptions({ claude: { usageProbe: false }, copilot: { usageProbe: false }, backfill: false, dashboard: { enabled: false } })
  assert.equal(core.config.claude.warnAtPct, 70)
  assert.equal(core.setSetting("dashboard.port", 1).ok, false)
  assert.deepEqual(core.setSetting("claude.warnAtPct", undefined), { ok: true })
  assert.equal(core.config.claude.warnAtPct, 85)
  assert.equal(core.store.meta("settings"), "{}")
})

test("dry run records what routing would do and changes nothing", async () => {
  const sid = "ses_dry"
  const opus = { providerID: "claude-agent", id: "opus", variant: "medium" }
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  harness.sessionModels.set(sid, opus)
  await onEvent(core, evt("session.created", { sessionID: sid, model: opus }))
  assert.deepEqual(core.setSetting("dryRun", true), { ok: true })
  const switches = harness.calls.switches.length
  const synthetic = harness.calls.synthetic.length
  const e: any = {
    sessionID: sid,
    model: opus,
    error: { type: "provider.unknown", message: `Claude Code subscription limit reached (five hour). Resets at ${new Date(Date.now() + 3_600_000).toISOString()}.` },
    attempt: 2,
    decision: { retry: false },
  }
  await onRetry(core, e)
  // OpenCode's own decision stands, no model was switched, and the limit was still learned.
  assert.deepEqual(e.decision, { retry: false })
  assert.equal(harness.calls.switches.length, switches)
  assert.deepEqual(core.sessions.get(sid).current, opus)
  assert.equal(core.pools.get("claude-agent").status, "cooling")
  // The next turns would move early; the suggestion is recorded once, not on every turn.
  await onPrompt(core, { sessionID: sid })
  await onPrompt(core, { sessionID: sid })
  await onEvent(core, evt("session.execution.failed", { sessionID: sid, error: e.error }))
  await flush()
  assert.equal(harness.calls.switches.length, switches)
  assert.equal(harness.calls.synthetic.length, synthetic)
  const rows: any[] = core.store.all("SELECT trigger, to_model, dry FROM routing WHERE session_id = ? ORDER BY id", sid)
  assert.deepEqual(rows.map((r) => `${r.trigger}:${r.dry}`), ["failover:1", "preempt:1", "resume:1"])
  assert.equal(rows[0].to_model, "xai/grok-4.7#high")

  // Dry rows are their own kind on the dashboard and never count as fallbacks.
  const all = q.resolveRange("all")
  const before = q.routingSummary(core.store, all)
  assert.equal(before.dry >= 3, true)
  assert.equal(q.summary(core.store, all).routing.preempt ?? 0, core.store.get("SELECT COUNT(*) AS n FROM routing WHERE trigger = 'preempt' AND dry = 0").n)
  const groups = q.routingGroups(core.store, all, { filter: "dry" }).groups
  assert.ok(groups.length >= 3 && groups.every((g: any) => g.trigger.startsWith("dry:")))
  assert.ok(q.routingGroups(core.store, all, { filter: "fallback" }).groups.every((g: any) => !g.trigger.startsWith("dry:")))
  const g = groups[0]
  assert.ok(q.routingEvents(core.store, { day: g.day, trigger: g.trigger, from: g.from_model, to: g.to_model }).rows.length >= 1)
  core.maintain()
  assert.equal(core.store.get("SELECT fallbacks FROM sessions WHERE id = ?", sid)?.fallbacks ?? 0, 0)

  core.setSetting("dryRun", undefined)
  assert.equal(core.config.dryRun, false)
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
})

test("doctor reports the setup without touching credentials", async () => {
  const { runDoctor, doctorText } = await import("../src/doctor.ts")
  const by = () => Object.fromEntries(runDoctor(core).map((c: any) => [c.id, c]))
  let c = by()
  assert.equal(c.routing.status, "ok")
  assert.equal(c.config.status, "ok")
  assert.equal(c.providers.title, "5 connected providers")
  assert.equal(c["chain-opus"].status, "ok")
  assert.match(c["chain-opus"].detail, /^claude-agent\/opus#medium → xai\/grok-4\.7#high/)
  // Haiku's models are not connected in this harness: reported, not a problem.
  assert.equal(c["chain-haiku"].status, "info")
  assert.equal(c["probe-claude"].status, "info")
  assert.equal(c.storage.status, "ok")
  assert.ok(!JSON.stringify(c).includes(os.homedir()))

  core.paused = true
  core.pools.report({ kind: "window", pools: ["xai"], resetAt: Date.now() + 3_600_000, evidence: "weekly limit" })
  core.setOptions({ claude: { usageProbe: "yes" }, backfill: false, dashboard: { enabled: false }, providers: { "github-copilot": { allow: "never" }, anthropic: { allow: "never" }, openai: { allow: "never" }, xai: { allow: "never" } } })
  c = by()
  assert.equal(c.routing.title, "Routing is paused")
  assert.match(c["config-0"].detail, /claude\.usageProbe/)
  assert.equal(c["chain-opus"].status, "warn")
  assert.equal(c["pool-xai"].detail, "weekly limit")
  assert.match(doctorText(Object.values(c) as any), /! Chain opus: no fallback/)

  core.paused = false
  core.pools.reset("xai", "test")
  core.setOptions({ claude: { usageProbe: false }, copilot: { usageProbe: false }, backfill: false, dashboard: { enabled: false } })
})

test("spend cap: recorded spend stops failover onto a pay-per-use provider", async () => {
  const sid = "ses_cap"
  const opus = { providerID: "claude-agent", id: "opus", variant: "medium" }
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  const { localDay } = await import("../src/db.ts")
  core.store.run("INSERT INTO steps (id, session_id, provider_id, model_id, started_at, day, status, cost_actual) VALUES ('cap1', 'ses_other', 'anthropic', 'claude-opus-5-5', ?, ?, 'ok', 6.5)", Date.now(), localDay(Date.now()))
  assert.deepEqual(core.setSetting("spend.providers.anthropic.dailyUsd", 5), { ok: true })
  assert.deepEqual(core.setSetting("spend.providers.openai.dailyUsd", 0.01), { ok: true })
  ;(core as any).spendCache = undefined
  const already = core.store.get("SELECT COALESCE(SUM(cost_actual), 0) AS n FROM steps WHERE provider_id = 'anthropic' AND id != 'cap1'").n
  assert.equal(Math.round((core.spend().day.anthropic - already) * 100), 650)
  assert.deepEqual(Object.keys(core.spendBlocks()), ["anthropic"])

  harness.sessionModels.set(sid, opus)
  await onEvent(core, evt("session.created", { sessionID: sid, model: opus }))
  for (const p of ["xai", "github-copilot"]) core.pools.report({ kind: "window", pools: [p], resetAt: Date.now() + 3_600_000, evidence: "limit" })
  const e: any = {
    sessionID: sid,
    model: opus,
    error: { type: "provider.unknown", message: `Claude Code subscription limit reached (five hour). Resets at ${new Date(Date.now() + 3_600_000).toISOString()}.` },
    attempt: 2,
    decision: { retry: false },
  }
  await onRetry(core, e)
  await flush()
  // Anthropic is capped, so the request goes to OpenAI, which has spent nothing yet.
  assert.deepEqual(harness.calls.switches.at(-1).model, { providerID: "openai", id: "gpt-6.1-sol", variant: "high" })
  const state = (await import("../src/dashboard/server.ts")).buildState(core)
  assert.match(state.spend.blocked.anthropic.reason, /daily spend cap reached/)
  const { runDoctor } = await import("../src/doctor.ts")
  assert.ok(runDoctor(core).some((c: any) => c.id === "spend-anthropic" && c.status === "warn"))

  core.setSetting("spend", undefined)
  core.store.run("DELETE FROM steps WHERE id = 'cap1'")
  ;(core as any).spendCache = undefined
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
})

test("notifications: raised once per event, rate-limited, switchable, and read through one feed", async () => {
  const { raise, feed, systemNotify, pruneAlerts } = await import("../src/alerts.ts")
  const { follower } = await import("../src/tui-feed.ts")
  core.store.run("DELETE FROM notifications")
  const sid = "ses_alert"
  const opus = { providerID: "claude-agent", id: "opus", variant: "medium" }
  const grok = { providerID: "xai", id: "grok-4.7", variant: "high" }

  // A terminal that opened before anything happened shows only what comes after.
  const toasts: any[] = []
  const poll = follower(async (after) => core.alerts(after === undefined ? { limit: 1 } : { after }), (t) => toasts.push(t))
  await poll()

  core.recordRouting({ sessionID: sid, trigger: "failover", from: opus, to: grok, evidence: "5-hour limit" })
  core.recordRouting({ sessionID: sid, trigger: "failover", from: opus, to: grok, evidence: "5-hour limit" })
  core.recordRouting({ sessionID: sid, trigger: "recovery", from: grok, to: opus, evidence: "Claude is free again" })
  core.recordRouting({ sessionID: sid, trigger: "manual", from: opus, to: grok })
  let f = core.alerts()
  assert.deepEqual(f.alerts.map((a: any) => `${a.kind}: ${a.title}`), ["fallback: Moved to xai/grok-4.7#high", "return: Back on claude-agent/opus#medium"])
  assert.equal(f.alerts[0].body, "From claude-agent/opus#medium: 5-hour limit")
  assert.equal(f.last, f.alerts[1].id)
  assert.deepEqual(core.alerts({ after: f.alerts[0].id }).alerts.map((a: any) => a.kind), ["return"])

  await poll()
  await poll()
  assert.deepEqual(toasts.map((t) => `${t.variant}: ${t.title}`), ["warning: Moved to xai/grok-4.7#high", "success: Back on claude-agent/opus#medium"])
  assert.equal(toasts[0].sessionID, sid)

  // A kind that is turned off raises nothing, and neither does anything in a dry run.
  core.setSetting("notifications.events.fallback", false)
  core.recordRouting({ sessionID: "ses_other", trigger: "failover", from: opus, to: grok })
  core.setSetting("notifications", undefined)
  core.setSetting("dryRun", true)
  core.recordRouting({ sessionID: "ses_other", trigger: "failover", from: opus, to: grok })
  core.setSetting("dryRun", undefined)
  assert.equal(core.alerts().alerts.length, 2)

  // Conditions found by looking: a spend cap, and a usage check that has failed for a while.
  const { localDay } = await import("../src/db.ts")
  core.store.run("INSERT INTO steps (id, session_id, provider_id, model_id, started_at, day, status, cost_actual) VALUES ('cap2', 'ses_other', 'openai', 'gpt-6.1-sol', ?, ?, 'ok', 2)", Date.now(), localDay(Date.now()))
  core.setSetting("spend.providers.openai.dailyUsd", 1)
  ;(core as any).spendCache = undefined
  core.setOptions({ claude: { usageProbe: true }, copilot: { usageProbe: false }, backfill: false, dashboard: { enabled: false } })
  const now = Date.now()
  core.claude = { at: now, ok: false, message: "Usage endpoint returned HTTP 500" }
  core.checkAlerts(now)
  core.checkAlerts(now + 11 * 60_000)
  core.checkAlerts(now + 12 * 60_000)
  f = core.alerts()
  assert.deepEqual(f.alerts.slice(2).map((a: any) => a.title), ["Spend cap reached for openai", "Claude usage check is failing"])
  assert.match(f.alerts[2].body!, /daily spend cap reached \(\$2\.00 of \$1\.00 on openai\)/)
  const { buildMenubar } = await import("../src/dashboard/server.ts")
  assert.equal(buildMenubar(core).alerts[0].title, "Claude usage check is failing")
  const { present } = await import("../gui/present.ts")
  assert.ok(present(buildMenubar(core) as any).sections.flat().some((i) => i.label === "Notifications — 4"))

  // System notifications are off unless asked for, and their text is only ever an argument.
  const calls: Array<[string, string[]]> = []
  const exec = (file: string, args: string[]) => void calls.push([file, args])
  const evil = 'x" & do shell script "touch /tmp/pwned'
  assert.equal(systemNotify(evil, "$(id)", "darwin", exec), true)
  assert.equal(systemNotify("t", "b", "linux", exec), true)
  assert.equal(systemNotify("t", "b", "win32", exec), false)
  assert.deepEqual(calls[0][1].slice(-3), ["--", evil, "$(id)"])
  assert.ok(!calls[0][1].slice(0, -3).join(" ").includes("pwned"))
  assert.deepEqual(calls[1], ["notify-send", ["--app-name=quota-router", "--", "t", "b"]])
  const sent: string[] = []
  const config = { ...core.config, notifications: { ...core.config.notifications, system: true } }
  assert.ok(raise(core.store, config, { kind: "allLimited", title: "Every provider is limited" }, now, (t) => (sent.push(t), true)))
  assert.deepEqual(sent, ["Every provider is limited"])

  // No more than twenty an hour, and old ones are dropped.
  for (let i = 0; i < 30; i++) raise(core.store, core.config, { kind: "fallback", key: `k${i}`, title: "x" }, now, () => true)
  assert.equal(core.store.get("SELECT COUNT(*) AS n FROM notifications WHERE at > ?", now - 3_600_000).n, 20)
  pruneAlerts(core.store, now + 31 * 86_400_000)
  assert.equal(feed(core.store).alerts.length, 0)

  core.claude = { ok: false }
  core.setSetting("spend", undefined)
  core.store.run("DELETE FROM steps WHERE id = 'cap2'")
  ;(core as any).spendCache = undefined
  core.setOptions({ claude: { usageProbe: false }, copilot: { usageProbe: false }, backfill: false, dashboard: { enabled: false } })
})

test("save for later: routing passes a saved provider over until its time or until it is released", async () => {
  const sid = "ses_save"
  const opus = { providerID: "claude-agent", id: "opus", variant: "medium" }
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  assert.equal(core.findProvider("grok"), "xai")
  assert.equal(core.findProvider("claude"), "claude-agent")
  assert.equal(core.findProvider("nothing-like-this"), undefined)

  core.save("xai", Date.now() + 3_600_000)
  assert.deepEqual(Object.keys(core.saved()), ["xai"])
  harness.sessionModels.set(sid, opus)
  await onEvent(core, evt("session.created", { sessionID: sid, model: opus }))
  await onRetry(core, {
    sessionID: sid,
    model: opus,
    error: { type: "provider.unknown", message: `Claude Code subscription limit reached (five hour). Resets at ${new Date(Date.now() + 3_600_000).toISOString()}.` },
    attempt: 2,
    decision: { retry: false },
  } as any)
  await flush()
  // xAI is next in the chain but set aside, so the request goes one further.
  const to = harness.calls.switches.at(-1)
  assert.equal(to.sessionID, sid)
  assert.notEqual(to.model.providerID, "xai")
  assert.notEqual(to.model.providerID, "claude-agent")

  const { buildState } = await import("../src/dashboard/server.ts")
  assert.ok(buildState(core).saved.xai > Date.now())
  const { runDoctor } = await import("../src/doctor.ts")
  assert.ok(runDoctor(core).some((c: any) => c.id === "saved-xai" && c.status === "info"))

  // Saving the provider a session is on moves that session at its next turn.
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  core.save("xai")
  assert.deepEqual(core.saved(), {})
  const sid2 = "ses_save2"
  harness.sessionModels.set(sid2, opus)
  await onEvent(core, evt("session.created", { sessionID: sid2, model: opus }))
  core.save("claude-agent", Date.now() + 3_600_000)
  await onPrompt(core, { sessionID: sid2 })
  await flush()
  assert.equal(harness.calls.switches.at(-1).sessionID, sid2)
  assert.equal(harness.calls.switches.at(-1).model.providerID, "xai")
  // Released early, the session returns.
  core.save("claude-agent")
  await onPrompt(core, { sessionID: sid2 })
  await flush()
  assert.equal(harness.calls.switches.at(-1).model.providerID, "claude-agent")

  // The dashboard actions take a provider that exists and a span of at most a week.
  core.config.dashboard.port = 47900 + Math.floor(Math.random() * 90)
  const d = await startDashboard(core)
  assert.ok(d)
  try {
    const post = (body: unknown) => fetch(`${d.url}/api/action`, { method: "POST", headers: { "x-quota-router": "1", "content-type": "application/json" }, body: JSON.stringify(body) })
    await post({ action: "save", provider: "xai", minutes: 120 })
    assert.ok(Math.abs(core.saved().xai - Date.now() - 7_200_000) < 5_000)
    await post({ action: "save", provider: "not-a-provider", minutes: 120 })
    await post({ action: "save", provider: "openai", minutes: 999_999 })
    assert.deepEqual(Object.keys(core.saved()), ["xai"])
    await post({ action: "unsave", provider: "xai" })
    assert.deepEqual(core.saved(), {})
  } finally {
    await d.stop()
  }
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
})

test("agent chains: an agent's sessions use its chain until the user picks a model", async () => {
  const opus = { providerID: "claude-agent", id: "opus", variant: "medium" }
  const grok = { providerID: "xai", id: "grok-4.7", variant: "low" }
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  assert.deepEqual(core.setSetting("chains.quick", ["xai/grok-4.7#low", "openai/gpt-6.1-sol#low"]), { ok: true })
  assert.deepEqual(core.setSetting("agents.plan", "quick"), { ok: true })
  assert.equal(core.setSetting("agents.plan", "no-such-chain").ok, false)

  // A session created for the agent moves to its chain straight away, whatever model it was created with.
  const sid = "ses_agent"
  harness.sessionModels.set(sid, opus)
  await onEvent(core, evt("session.created", { sessionID: sid, model: opus, agent: "plan" }))
  await flush()
  const s = core.session(sid)
  assert.equal(s.preferred.chain, "quick")
  assert.equal(s.byAgent, true)
  assert.deepEqual(harness.calls.switches.at(-1), { sessionID: sid, model: grok })
  const row: any = core.store.get("SELECT trigger, evidence FROM routing WHERE session_id = ? ORDER BY rowid DESC LIMIT 1", sid)
  assert.deepEqual({ ...row }, { trigger: "route", evidence: "The plan agent uses the quick chain" })

  // A limit moves it along the agent's chain, not the chain of the model the session started on.
  core.pools.report({ kind: "window", pools: ["xai"], resetAt: Date.now() + 3_600_000, evidence: "limit" })
  await onPrompt(core, { sessionID: sid })
  await flush()
  assert.deepEqual(harness.calls.switches.at(-1), { sessionID: sid, model: { providerID: "openai", id: "gpt-6.1-sol", variant: "low" } })
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")

  // Another agent, and a subagent's session, keep the chain of their model.
  await onEvent(core, evt("session.created", { sessionID: "ses_agent_build", model: opus, agent: "build" }))
  await onEvent(core, evt("session.created", { sessionID: "ses_agent_child", model: opus, agent: "plan", parentID: sid }))
  assert.equal(core.session("ses_agent_build").preferred.chain, "opus")
  assert.equal(core.session("ses_agent_child").preferred.chain, "opus")

  // Picking a model outranks the agent's chain, and is remembered.
  await onEvent(core, evt("session.model.selected", { sessionID: sid, model: opus }))
  assert.equal(s.preferred.chain, "opus")
  assert.equal(s.byAgent, false)
  core.sessions.delete(sid)
  const again = core.session(sid)
  core.setAgent(again, "plan")
  assert.equal(again.picked, true)
  assert.equal(again.preferred.chain, "opus")
  // Selecting the agent again applies its chain once more.
  await onEvent(core, evt("session.agent.selected", { sessionID: sid, agent: "plan", previous: "build" }))
  assert.equal(again.preferred.chain, "quick")

  // Removing the rule returns sessions to the chain of the model they are on.
  again.current = opus
  assert.deepEqual(core.setSetting("agents.plan", undefined), { ok: true })
  assert.equal(again.byAgent, false)
  assert.equal(again.preferred.chain, "opus")
  assert.deepEqual(core.config.agents, {})
  assert.deepEqual(core.setSetting("chains.quick", undefined), { ok: true })
  for (const id of [sid, "ses_agent_build", "ses_agent_child"]) core.sessions.delete(id)
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
})

test("project rules: a project's file shuts a provider out, and your settings give the project its chain", async () => {
  const base = { claude: { usageProbe: false }, copilot: { usageProbe: false }, backfill: false, dashboard: { enabled: false } }
  const opus = { providerID: "claude-agent", id: "opus", variant: "medium" }
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "qr-proj-"))
  fs.mkdirSync(path.join(proj, ".opencode"))
  fs.mkdirSync(path.join(proj, "api"))
  // The file tries to choose a chain too; that part is ignored.
  fs.writeFileSync(path.join(proj, ".opencode", "quota-router.json"), JSON.stringify({ deny: ["xai"], chain: "opus" }))
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  assert.deepEqual(core.setSetting("chains.quick", ["xai/grok-4.7#low", "openai/gpt-6.1-sol#low"]), { ok: true })
  core.setOptions({ ...base, projects: { [proj]: { chain: "quick" } } })
  assert.deepEqual(core.warnings, [])

  // A session in a folder of the project starts on the project's chain, minus the provider the file shuts out.
  const sid = "ses_rules"
  harness.sessionModels.set(sid, opus)
  await onEvent(core, evt("session.created", { sessionID: sid, model: opus, location: { directory: path.join(proj, "api") } }))
  await flush()
  const s = core.session(sid)
  assert.equal(s.preferred.chain, "quick")
  assert.equal(s.byProject, true)
  assert.deepEqual(harness.calls.switches.at(-1), { sessionID: sid, model: { providerID: "openai", id: "gpt-6.1-sol", variant: "low" } })
  const rules = core.rulesFor(s)
  assert.deepEqual(rules.deny, ["xai"])
  assert.equal(rules.chain, "quick")
  assert.equal(core.projectFile(path.join(proj, "api")).warnings.length, 1, "the file's chain is refused, with a warning")
  const row: any = core.store.get("SELECT evidence FROM routing WHERE session_id = ? ORDER BY rowid DESC LIMIT 1", sid)
  assert.match(row.evidence, /xai is not allowed in this project \(\.opencode\/quota-router\.json\)/)

  // A session elsewhere is untouched.
  const other = "ses_rules_other"
  const before = harness.calls.switches.length
  harness.sessionModels.set(other, opus)
  await onEvent(core, evt("session.created", { sessionID: other, model: opus, location: { directory: os.tmpdir() } }))
  await flush()
  assert.equal(core.rulesFor(core.session(other)), undefined)
  assert.equal(core.session(other).preferred.chain, "opus")
  assert.equal(harness.calls.switches.length, before)

  // A file that is not valid JSON shuts nothing out and says so.
  fs.writeFileSync(path.join(proj, ".opencode", "quota-router.json"), "{ not json")
  core.ruleFiles.clear()
  assert.equal(core.projectFile(proj).rules, undefined)
  assert.match(core.projectFile(proj).warnings[0], /not valid JSON/)

  core.setOptions(base)
  assert.deepEqual(core.setSetting("chains.quick", undefined), { ok: true })
  core.ruleFiles.clear()
  for (const id of [sid, other]) core.sessions.delete(id)
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  fs.rmSync(proj, { recursive: true, force: true })
})

test("schedules: a schedule puts a provider first or shuts one out while it applies", async () => {
  const base = { claude: { usageProbe: false }, copilot: { usageProbe: false }, backfill: false, dashboard: { enabled: false } }
  const opus = { providerID: "claude-agent", id: "opus", variant: "medium" }
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  const sid = "ses_sched"
  harness.sessionModels.set(sid, opus)
  await onEvent(core, evt("session.created", { sessionID: sid, model: opus }))
  const s = core.session(sid)

  // No times given: it applies now, whenever the test runs.
  core.setOptions({ ...base, schedules: [{ name: "nights", first: ["xai"] }] })
  assert.deepEqual(core.warnings, [])
  await onPrompt(core, { sessionID: sid })
  await flush()
  assert.deepEqual(harness.calls.switches.at(-1), { sessionID: sid, model: { providerID: "xai", id: "grok-4.7", variant: "high" } })
  const row: any = core.store.get("SELECT trigger, evidence FROM routing WHERE session_id = ? ORDER BY rowid DESC LIMIT 1", sid)
  assert.deepEqual({ ...row }, { trigger: "preempt", evidence: "The nights schedule puts xai first" })
  assert.equal(s.preferred.model.providerID, "claude-agent", "the session's own choice is kept for when the schedule ends")

  // The schedule now shuts xAI out instead: the session leaves it.
  core.setOptions({ ...base, schedules: [{ name: "nights", deny: ["xai"] }] })
  s.movedAt = 0
  await onPrompt(core, { sessionID: sid })
  await flush()
  assert.equal(harness.calls.switches.at(-1).model.providerID, "claude-agent")

  core.setOptions(base)
  assert.deepEqual(core.config.schedules, [])
  core.sessions.delete(sid)
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
})

test("chain updates: replacing an entry with a newer model keeps its place, and can be undone", () => {
  const key = "anthropic/claude-opus-5-5"
  const info = core.models.get(key)
  core.models.set(key, { ...info, family: "claude-opus", released: 10 })
  core.models.set("anthropic/claude-opus-5-6", { ...info, id: "claude-opus-5-6", family: "claude-opus", released: 20 })
  const at = core.config.chains.opus.findIndex((r: any) => r.providerID === "anthropic")
  const variant = core.config.chains.opus[at].variant
  const u = core.updates().find((x: any) => x.chain === "opus" && x.ref.startsWith(key))
  assert.equal(u.to, `anthropic/claude-opus-5-6#${variant}`)
  core.updateChain("replace", "opus", u.ref, u.to)
  assert.equal(core.config.chains.opus[at].id, "claude-opus-5-6")
  assert.equal(core.updates().some((x: any) => x.chain === "opus" && x.ref.startsWith("anthropic/")), false)
  core.updateChain("restore", "opus", key)
  assert.equal(core.config.chains.opus[at].id, "claude-opus-5-5")
  // Passed over: not offered again, and nothing changes.
  core.updateChain("skip", "opus", u.ref, u.to)
  assert.equal(core.updates().some((x: any) => x.chain === "opus" && x.ref.startsWith(key)), false)
  assert.equal(core.config.chains.opus[at].id, "claude-opus-5-5")
  core.store.setMeta("chain_ignored", JSON.stringify(core.ignoredSuggestions().filter((x: string) => !x.includes(">"))))
  core.models.delete("anthropic/claude-opus-5-6")
  core.models.set(key, info)
  core.rebuildConfig()
})

test("pace guard: a subagent leaves a plan that is on pace to run out, and the main session stays", async () => {
  const opus = { providerID: "claude-agent", id: "opus", variant: "medium" }
  const now = Date.now()
  const H = 3_600_000
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  const usage = (pct: number) => ({ windows: [{ pool: "claude-agent", label: "5-hour session", utilization: pct, resetAt: now + 3 * H }] })
  core.store.run("DELETE FROM usage_snapshots")
  for (const [ago, pct] of [[50, 40], [30, 50], [1, 60]]) core.store.run("INSERT INTO usage_snapshots (at, provider, data) VALUES (?, 'claude-agent', ?)", now - ago * 60_000, JSON.stringify(usage(pct)))
  const before = core.claude
  core.claude = { at: now, ok: true, data: usage(60) }
  ;(core as any).forecastCache = undefined
  const [f] = core.forecasts()
  assert.equal(f.label, "Claude 5-hour session")
  assert.equal(f.beforeReset, true)

  await onEvent(core, evt("session.created", { sessionID: "ses_pace_main", model: opus }))
  await onEvent(core, evt("session.created", { sessionID: "ses_pace_sub", model: opus, parentID: "ses_pace_main" }))
  harness.sessionModels.set("ses_pace_main", opus)
  harness.sessionModels.set("ses_pace_sub", opus)
  const count = harness.calls.switches.length
  // Off by default: nothing moves.
  await onPrompt(core, { sessionID: "ses_pace_sub" })
  await flush()
  assert.equal(harness.calls.switches.length, count)

  assert.deepEqual(core.setSetting("pace.enabled", true), { ok: true })
  await onPrompt(core, { sessionID: "ses_pace_main" })
  await onPrompt(core, { sessionID: "ses_pace_sub" })
  await flush()
  assert.equal(harness.calls.switches.length, count + 1)
  assert.equal(harness.calls.switches.at(-1).sessionID, "ses_pace_sub")
  assert.equal(harness.calls.switches.at(-1).model.providerID, "xai")
  const row: any = core.store.get("SELECT trigger, evidence FROM routing WHERE session_id = 'ses_pace_sub' ORDER BY rowid DESC LIMIT 1")
  assert.equal(row.trigger, "preempt")
  assert.match(row.evidence, /5-hour session on pace to run out/)

  // An agent listed as light is treated the same way.
  assert.deepEqual(core.setSetting("pace.lightAgents", ["explore"]), { ok: true })
  const main = core.session("ses_pace_main")
  main.agent = "explore"
  assert.equal(core.isLight(main), true)
  main.agent = undefined

  const state = (await import("../src/dashboard/server.ts")).buildState(core)
  assert.equal(state.forecasts.length, 1)
  assert.equal(state.pace.enabled, true)
  const { runDoctor } = await import("../src/doctor.ts")
  const checks = runDoctor(core)
  assert.ok(checks.some((c: any) => c.id === "pace" && c.status === "warn"))
  assert.ok(checks.some((c: any) => c.id === "pace-claude-5-hour-session" && c.status === "info"))

  core.setSetting("pace", undefined)
  core.claude = before
  core.store.run("DELETE FROM usage_snapshots")
  ;(core as any).forecastCache = undefined
  for (const id of ["ses_pace_main", "ses_pace_sub"]) core.sessions.delete(id)
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
})

test("switching cost: a large context waits longer in place, and a move says what it sends again", async () => {
  const sid = "ses_cache"
  const opus = { providerID: "claude-agent", id: "opus", variant: "medium" }
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  harness.sessionModels.set(sid, opus)
  await onEvent(core, evt("session.created", { sessionID: sid, model: opus }))
  const s = core.session(sid)
  const throttled = (delay: number): any => ({ sessionID: sid, model: opus, error: { type: "provider.rate_limit", status: 429, message: "rate limited", response: { headers: { "retry-after": String(delay / 1000) } } }, attempt: 1, decision: { retry: true, delay } })
  const moves = harness.calls.switches.length

  // 45 seconds is longer than a small session waits, so it moves.
  let e = throttled(45_000)
  await onRetry(core, e)
  await flush()
  assert.equal(harness.calls.switches.length, moves + 1)
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  s.current = opus
  s.lastRetry = undefined

  // With 150k tokens of context, the same wait is cheaper than sending it all to another provider.
  s.lastInputTokens = 150_000
  e = throttled(45_000)
  await onRetry(core, e)
  await flush()
  assert.equal(harness.calls.switches.length, moves + 1)
  assert.deepEqual(e.decision, { retry: true, delay: 45_000 })
  // Past the longer wait it moves, and the routing log says what the move costs.
  e = throttled(90_000)
  await onRetry(core, e)
  await flush()
  assert.equal(harness.calls.switches.at(-1).model.providerID, "xai")
  let row: any = core.store.get("SELECT evidence FROM routing WHERE session_id = ? ORDER BY rowid DESC LIMIT 1", sid)
  assert.match(row.evidence, / · sends 150k tokens of context again$/)
  // A pay-per-use target has a price: 150k input tokens at $2 per million.
  for (const p of ["xai", "github-copilot", "anthropic"]) core.pools.report({ kind: "window", pools: [p], resetAt: Date.now() + 3_600_000, evidence: "limit" })
  await onPrompt(core, { sessionID: sid })
  await flush()
  assert.equal(harness.calls.switches.at(-1).model.providerID, "openai")
  row = core.store.get("SELECT evidence FROM routing WHERE session_id = ? ORDER BY rowid DESC LIMIT 1", sid)
  assert.match(row.evidence, /sends 150k tokens of context again, about \$0\.30$/)

  core.sessions.delete(sid)
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
})

test("plan advice: gathered from the local record of limits, usage checks and spend", async () => {
  const { planAdvice, adviceText } = await import("../src/advisor.ts")
  const now = Date.now()
  const DAY = 86_400_000
  const before = { claude: core.claude, copilot: core.copilot }
  core.store.run("DELETE FROM pool_log")
  core.store.run("DELETE FROM usage_snapshots")
  const { localDay } = await import("../src/db.ts")
  core.store.run("INSERT INTO steps (id, session_id, provider_id, model_id, started_at, day, status, cost_actual) VALUES ('adv1', 'ses_adv', 'anthropic', 'claude-opus-5-5', ?, ?, 'ok', 95)", now - 20 * DAY, localDay(now - 20 * DAY))
  // Five separate limits of two hours each; the usage updates in between are not counted again.
  for (let i = 1; i <= 5; i++) {
    core.store.run("INSERT INTO pool_log (at, pool, status, kind, until) VALUES (?, 'claude-agent', 'blocked', 'window', ?)", now - i * 3 * DAY, now - i * 3 * DAY + 7_200_000)
    core.store.run("INSERT INTO pool_log (at, pool, status, kind, until) VALUES (?, 'claude-agent', 'blocked', 'window', ?)", now - i * 3 * DAY + 60_000, now - i * 3 * DAY + 7_200_000)
    core.store.run("INSERT INTO pool_log (at, pool, status) VALUES (?, 'claude-agent', 'available')", now - i * 3 * DAY + 7_200_000)
  }
  core.store.run("INSERT INTO usage_snapshots (at, provider, data) VALUES (?, 'claude-agent', ?)", now - 5 * DAY, JSON.stringify({ windows: [{ pool: "claude-agent", label: "Weekly (all models)", utilization: 97 }] }))
  core.claude = { ok: true, at: now, plan: { type: "max", tier: "default_claude_max_5x" } }
  const d = new Date(now)
  const elapsed = (now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) / (Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  core.copilot = { ok: true, at: now, data: { plan: "individual_pro", name: "ai_credits", entitlement: 1500, used: 1500 * elapsed * 0.5, remaining: 1, percentRemaining: 50, unlimited: false, overagePermitted: false, overageUsed: 0 } }

  const a = planAdvice(core, now)
  assert.equal(Math.round(a.coveredDays), 20)
  assert.equal(a.plans.claude, "Claude Max (5x)")
  const claude: any = a.advice.find((x: any) => x.provider === "claude")
  assert.equal(claude.title, "Claude: limited 5 times")
  assert.match(claude.detail, /for about 10 h in all, and pay-per-use providers cost \$95(\.\d+)? in that time\. Claude Ultra has 2 times the allowance for \$100 more a month\./)
  const copilot: any = a.advice.find((x: any) => x.provider === "copilot")
  // Early in a month no Copilot projection is made.
  if (elapsed >= 0.2) assert.equal(copilot.title, "Copilot: Copilot Pro fits")
  else assert.equal(copilot, undefined)
  assert.match(adviceText(a.advice), /^- Claude: limited 5 times\n  /)
  assert.match(adviceText([]), /needs a week/)
  const { buildState } = await import("../src/dashboard/server.ts")
  assert.equal(buildState(core).plans.claude, "Claude Max (5x)")
  // The plan can be set by hand when it is not detected.
  core.claude = { ok: false }
  assert.deepEqual(core.setSetting("claude.plan", "pro"), { ok: true })
  assert.equal(planAdvice(core, now).plans.claude, "Claude Pro")

  core.setSetting("claude", undefined)
  core.claude = before.claude
  core.copilot = before.copilot
  core.store.run("DELETE FROM pool_log")
  core.store.run("DELETE FROM usage_snapshots")
  core.store.run("DELETE FROM steps WHERE id = 'adv1'")
  ;(core as any).spendCache = undefined
})

test("recorder: time to first token is the first sign of an answer", () => {
  const sid = "ses_first"
  const t0 = Date.now() - 60_000
  const at = (type: string, data: Record<string, unknown>, ms: number) => ({ ...evt(type, { sessionID: sid, ...data }), created: t0 + ms })
  core.recorder.handle(at("session.execution.started", {}, 0))
  core.recorder.handle(at("session.step.started", { assistantMessageID: "msg_f1", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" } }, 0))
  core.recorder.handle(at("session.reasoning.started", { assistantMessageID: "msg_f1" }, 850))
  core.recorder.handle(at("session.text.started", { assistantMessageID: "msg_f1" }, 2400))
  core.recorder.handle(at("session.step.ended", { assistantMessageID: "msg_f1", finish: "stop", cost: 0, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }, 3000))
  core.recorder.handle(at("session.execution.succeeded", {}, 3000))
  const row: any = core.store.get("SELECT first_ms FROM steps WHERE session_id = ?", sid)
  assert.equal(row.first_ms, 850)
  ;(core as any).healthCache = undefined
  const h = core.health()
  assert.ok(h.anthropic.requests >= 1)
  assert.equal(typeof h.anthropic.firstTokenMs, "number")
  core.store.run("DELETE FROM steps WHERE session_id = ?", sid)
  ;(core as any).healthCache = undefined
})

test("efficiency figures: cache hit rate, tokens per tool call, failed rate and time lost to limits", () => {
  const now = Date.parse("2026-11-09T19:00:00Z")
  const MIN = 60_000
  const e = q.efficiency({ input: 2_000, cache_read: 6_000, cache_write: 2_000, tokens: 12_000, steps: 40, failed: 2 }, 8, [{ at: now - 30 * MIN, until: now - 20 * MIN }, { at: now - 5 * MIN, until: now + 10 * MIN }, { at: now - 60 * MIN, until: null }], now)
  assert.deepEqual(e, { cacheHitRate: 0.6, tokensPerToolCall: 1500, toolCalls: 8, failedRate: 0.05, waitMs: 15 * MIN, waits: 3 })
  assert.deepEqual(q.efficiency({}, 0, [], now), { cacheHitRate: undefined, tokensPerToolCall: undefined, toolCalls: 0, failedRate: undefined, waitMs: 0, waits: 0 })
})

test("status line: the session's provider and window use, the provider it left, and what turns the line off", async () => {
  const { buildStatus } = await import("../src/status.ts")
  const { statusLine, reader } = await import("../src/tui-feed.ts")
  const now = Date.now()
  const HOUR = 3_600_000
  const time = (at: number, from: number) => `in ${Math.round((at - from) / HOUR)}h`
  for (const p of core.pools.all()) core.pools.reset(p.id, "test")
  const sid = "ses_status"
  const opus = { providerID: "claude-agent", id: "opus", variant: "medium" }
  const grok = { providerID: "xai", id: "grok-4.7", variant: "high" }
  const s = core.session(sid)
  s.current = opus
  core.pools.usage("claude-agent", { utilization: 62.4, exhausted: false, warn: false, evidence: "5-hour window at 62%" })

  let feed = buildStatus(core, now)
  assert.deepEqual(feed.sessions[sid], { provider: "claude-agent", pct: 62.4 })
  assert.deepEqual(feed.top, { provider: "claude-agent", pct: 62.4 })
  assert.deepEqual(statusLine(feed, sid, time), { text: "claude-agent 62%", tone: "muted" })
  // A prompt with no routed session shows the provider a new one would start on.
  assert.deepEqual(statusLine(feed, "ses_unknown", time), { text: "claude-agent 62%", tone: "muted" })
  assert.deepEqual(statusLine(feed, undefined, time), { text: "claude-agent 62%", tone: "muted" })

  // Nearly full: a warning. Run out and moved to a fallback: the line says where the session came from and when that is back.
  core.pools.usage("claude-agent", { utilization: 93, exhausted: false, warn: true, evidence: "5-hour window at 93%" })
  assert.deepEqual(statusLine(buildStatus(core, now), sid, time), { text: "claude-agent 93%", tone: "warning" })
  core.pools.usage("claude-agent", { utilization: 100, resetAt: now + 2 * HOUR, exhausted: true, warn: true, evidence: "5-hour window at 100%" })
  s.current = grok
  s.fallback = { from: opus, reason: "5-hour limit", at: now }
  feed = buildStatus(core, now)
  assert.deepEqual(feed.sessions[sid], { provider: "xai", from: "claude-agent", fromUntil: core.pools.get("claude-agent").until })
  assert.deepEqual(statusLine(feed, sid, time), { text: "xai · claude-agent back in 2h", tone: "warning" })
  assert.equal(feed.top?.provider !== "claude-agent", true)

  // Every provider of the session limited: it waits, and the line says until when.
  s.current = opus
  s.fallback = undefined
  assert.deepEqual(statusLine(buildStatus(core, now), sid, time), { text: "claude-agent 100% limited until in 2h", tone: "error" })

  // Paused and dry run are said; turned off, nothing is shown.
  core.pools.reset("claude-agent", "test")
  core.paused = true
  core.setSetting("dryRun", true)
  assert.match(statusLine(buildStatus(core, now), sid, time)!.text, /^claude-agent( \d+%)? · paused · dry run$/)
  core.paused = false
  core.setSetting("dryRun", undefined)
  core.setSetting("statusLine", false)
  assert.equal(buildStatus(core, now).enabled, false)
  assert.equal(statusLine(buildStatus(core, now), sid, time), undefined)
  core.setSetting("statusLine", undefined)
  assert.equal(statusLine(undefined, sid, time), undefined)
  assert.equal(statusLine({ now, enabled: true, paused: false, dryRun: false, sessions: {} }, sid, time), undefined)
  core.sessions.delete(sid)

  // The reader finds the dashboard on a later port, keeps to it, and looks again once it is gone.
  const asked: string[] = []
  let up = true
  const read = reader(47321, (async (url: string) => {
    asked.push(url)
    if (!up || !url.includes(":47323/")) throw new Error("refused")
    return { ok: true, json: async () => ({ sessions: {} }) }
  }) as any)
  const ok = (b: any) => typeof b?.sessions === "object"
  assert.deepEqual(await read("/api/status", ok), { sessions: {} })
  assert.equal(asked.length, 3)
  await read("/api/status", ok)
  assert.equal(asked.length, 4)
  up = false
  assert.equal(await read("/api/status", ok), undefined)
  assert.equal(asked.length, 5)
  assert.equal(await read("/api/status", ok), undefined)
  assert.equal(asked.length, 10)
})

test("dashboard page: accessibility basics stay in place", async () => {
  const fs = await import("node:fs")
  const html = fs.readFileSync(new URL("../src/dashboard/page.html", import.meta.url), "utf8")
  assert.match(html, /<html lang="en">/)
  assert.match(html, /<a class="skip" href="#main">/)
  assert.match(html, /<main[^>]*id="main"/)
  assert.match(html, /id="announce" role="status" aria-live="polite"/)
  assert.match(html, /prefers-reduced-motion/)
  assert.match(html, /:focus-visible \{ outline/)
  // --faint fails contrast for text; it is for lines and marks only.
  assert.deepEqual(html.match(/(?<![-\w])color: var\(--faint\)/g), null)
  // Every icon-only button has a name.
  for (const b of html.matchAll(/<button[^>]*>\s*<svg/g)) assert.match(b[0], /aria-label="/)
})

test("settings page: changes are checked, stored over opencode.jsonc, and only accepted from the page itself", async () => {
  core.config.dashboard.port = 47900 + Math.floor(Math.random() * 90)
  const d = await startDashboard(core)
  assert.ok(d)
  try {
    const html = await (await fetch(d.url)).text()
    const token = html.match(/<meta name="qr-token" content="([^"]+)">/)?.[1]
    assert.ok(token && token !== "__QR_TOKEN__" && token.length >= 32)
    const base = { "content-type": "application/json", "x-quota-router": "1", "x-quota-router-token": token! }
    const post = (body: unknown, headers: Record<string, string> = base) => fetch(`${d.url}/api/settings`, { method: "POST", headers, body: JSON.stringify(body) })
    const field = (s: any, path: string) => s.groups.flatMap((g: any) => g.fields).find((f: any) => f.path === path)

    const before: any = await (await fetch(`${d.url}/api/settings`)).json()
    assert.ok(before.groups.length >= 5 && before.locked.includes("telemetry.endpoint"))
    assert.equal(field(before, "claude.cutoverAtPct").value, core.config.claude.cutoverAtPct)
    assert.equal(field(before, "claude.cutoverAtPct").changed, false)

    // Refused: no token, a wrong one, another site's origin, a cross-site fetch, a form post.
    const { "x-quota-router-token": _, ...noToken } = base
    for (const headers of [noToken, { ...base, "x-quota-router-token": "x".repeat(token!.length) }, { ...base, origin: "http://evil.example" }, { ...base, "sec-fetch-site": "cross-site" }, { ...base, "content-type": "text/plain" }])
      assert.equal((await post({ path: "claude.cutoverAtPct", value: 90 }, headers)).status, 403)
    assert.equal((await fetch(`${d.url}/api/action`, { method: "POST", headers: { ...base, origin: "http://evil.example" }, body: '{"action":"pause"}' })).status, 403)
    assert.equal(core.config.claude.cutoverAtPct, 98)

    // Accepted from the page's own origin; minutes and percent are converted to what the option stores.
    let r = await post({ path: "claude.cutoverAtPct", value: 90 }, { ...base, origin: d.url, "sec-fetch-site": "same-origin" })
    assert.equal(r.status, 200)
    const after: any = (await r.json()).settings
    assert.equal(core.config.claude.cutoverAtPct, 90)
    assert.deepEqual([field(after, "claude.cutoverAtPct").changed, field(after, "claude.cutoverAtPct").configured], [true, undefined])
    assert.equal((await post({ path: "switching.minStayMs", value: 5 })).status, 200)
    assert.equal(core.config.switching.minStayMs, 5 * 60_000)
    assert.equal((await post({ path: "copilot.reserveFraction", value: 2.5 })).status, 200)
    assert.equal(core.config.copilot.reserveFraction, 0.025)

    // Out of range, the wrong type, a locked setting and one the page doesn't offer are refused with a reason.
    for (const [body, msg] of [
      [{ path: "claude.cutoverAtPct", value: 101 }, /between 0 and 100/],
      [{ path: "claude.usageProbe", value: "yes" }, /on or off/],
      [{ path: "telemetry.level", value: "everything" }, /choices/],
      [{ path: "telemetry.identity.userId", value: "a\u0000b" }, /text/],
      [{ path: "dashboard.port", value: 1 }, /can't be changed/],
      [{ path: "telemetry.endpoint", value: "https://elsewhere.example" }, /can't be changed/],
      [{ path: "__proto__.polluted", value: true }, /can't be changed/],
    ] as const) {
      r = await post(body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.match((await r.json()).error, msg)
    }
    assert.equal(({} as any).polluted, undefined)

    // Choosing the configured value again drops the override.
    assert.equal((await post({ path: "dryRun", value: true })).status, 200)
    assert.equal((await post({ path: "dryRun", value: false })).status, 200)
    assert.equal(Object.hasOwn(core.storedSettings(), "dryRun"), false)
    // Reset goes back to the configured value.
    for (const path of ["claude.cutoverAtPct", "switching.minStayMs", "copilot.reserveFraction"]) assert.equal((await post({ path, value: null })).status, 200)
    assert.equal(core.config.claude.cutoverAtPct, 98)
    assert.equal(core.config.switching.minStayMs, 3 * 60_000)
    assert.deepEqual(core.storedSettings(), {})
  } finally {
    await d.stop()
  }
})
