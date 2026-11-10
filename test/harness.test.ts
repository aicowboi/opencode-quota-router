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
  assert.equal(store.meta("schema_version"), "3")
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
