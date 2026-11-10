import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qr-otel-"))
process.env.XDG_DATA_HOME = tmp

const { loadConfig, checkSetting } = await import("../src/engine/config.ts")
const { resolveTelemetry, parsePairs, checkEndpoint, metricsPayload, logsPayload, describeUrl } = await import("../src/telemetry/otlp.ts")
const { Telemetry } = await import("../src/telemetry/exporter.ts")
const { Core } = await import("../src/core.ts")
const { localDay } = await import("../src/db.ts")

const cfg = (telemetry: unknown = {}) => loadConfig({ telemetry }).config
const BASE = { claude: { usageProbe: false }, copilot: { usageProbe: false }, backfill: false, dashboard: { enabled: false } }

test("telemetry settings: environment fills in what the settings leave out, and never turns the export on", () => {
  assert.equal(cfg().telemetry.enabled, false)
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com:4318/",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20abc,x-team=core",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=dev,team=platform",
    OTEL_METRIC_EXPORT_INTERVAL: "30000",
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "Cumulative",
  }
  let r = resolveTelemetry(cfg(), env, "9.9.9")
  assert.deepEqual(r.problems, [])
  assert.equal(r.metricsUrl, "https://otel.example.com:4318/v1/metrics")
  assert.equal(r.logsUrl, "https://otel.example.com:4318/v1/logs")
  assert.deepEqual(r.headers, { authorization: "Bearer abc", "x-team": "core" })
  assert.deepEqual(r.resource, { "deployment.environment": "dev", team: "platform", "service.name": "quota-router", "service.version": "9.9.9" })
  assert.equal(r.intervalMs, 30_000)
  assert.equal(r.temporality, "cumulative")

  // Settings win, per-signal variables are used as they are, and identity appears only when asked for.
  r = resolveTelemetry(
    cfg({ endpoint: "http://localhost:4318", headers: { "x-team": "mine" }, attributes: { team: "infra" }, intervalMs: 120_000, temporality: "delta", identity: { userId: "u1", organizationId: "o1" } }),
    { ...env, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://logs.example.com/custom", OTEL_SERVICE_NAME: "router" },
    "1.0.0",
    { email: "dev@example.com", hostName: "laptop" },
  )
  assert.equal(r.metricsUrl, "http://localhost:4318/v1/metrics")
  assert.equal(r.logsUrl, "http://localhost:4318/v1/logs")
  assert.equal(r.headers["x-team"], "mine")
  assert.deepEqual(r.resource, { "deployment.environment": "dev", team: "infra", "service.name": "router", "service.version": "1.0.0", "user.email": "dev@example.com", "user.id": "u1", "organization.id": "o1", "host.name": "laptop" })
  assert.equal(r.temporality, "delta")
  assert.equal(resolveTelemetry(cfg(), { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://m.example.com/in" }, "1").metricsUrl, "https://m.example.com/in")

  assert.deepEqual(parsePairs("a=1, b = two%2Cthree ,bad,=x,__proto__=y"), { a: "1", b: "two,three" })
})

test("telemetry settings: unsafe or unsupported setups are refused with a reason", () => {
  const problems = (telemetry: unknown, env: Record<string, string> = {}) => resolveTelemetry(cfg(telemetry), env, "1").problems.join(" | ")
  assert.match(problems({}), /no endpoint/)
  assert.match(problems({ endpoint: "http://collector.internal:4318" }), /must use https/)
  const withLogin = ["https://user:secret", "otel.example.com"].join("@")
  assert.match(problems({ endpoint: withLogin }), /must not contain a user name or password/)
  assert.ok(!problems({ endpoint: withLogin }).includes("secret"))
  assert.match(problems({ endpoint: "nope" }), /not a valid URL/)
  assert.match(problems({ endpoint: "https://otel.example.com", protocol: "grpc" }), /http\/json only, and telemetry\.protocol asks for grpc/)
  assert.match(problems({ endpoint: "https://otel.example.com" }, { OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" }), /OTEL_EXPORTER_OTLP_PROTOCOL asks for http\/protobuf/)
  // Saying http/json in the settings is how a managed protobuf setup is used anyway.
  assert.equal(problems({ endpoint: "https://otel.example.com", protocol: "http/json" }, { OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" }), "")
  assert.match(problems({ endpoint: "https://otel.example.com" }, { OTEL_SDK_DISABLED: "true" }), /OTEL_SDK_DISABLED/)
  assert.match(problems({ endpoint: "https://otel.example.com", headers: { "bad name": "x" } }), /header name is not valid/)
  assert.equal(checkEndpoint("http://127.0.0.1:4318/v1/metrics").problem, undefined)
  assert.equal(checkEndpoint("http://[::1]:4318").problem, undefined)
  assert.equal(describeUrl("https://otel.example.com/v1/metrics?api_key=secret"), "https://otel.example.com/v1/metrics")

  const w = loadConfig({ telemetry: { level: "everything", projects: "yes", protocol: "carrier-pigeon", headers: { a: 1 }, attributes: "x" } }).warnings
  assert.deepEqual(w, ["telemetry.headers.a should be a string; ignored", "telemetry.attributes should be an object of name: value; ignored", "telemetry.level should be one of totals, events; default kept", "telemetry.projects should be one of off, hashed, names; default kept", "telemetry.protocol should be http/json; default kept"])

  // Where the data goes can only be set in opencode.jsonc, never at runtime.
  for (const p of ["telemetry.endpoint", "telemetry.headers", "telemetry.headers.authorization", "telemetry"]) assert.equal(checkSetting({}, {}, p, p === "telemetry" ? { endpoint: "https://evil.example.com" } : "x").ok, false, p)
  assert.ok(checkSetting({}, {}, "telemetry.enabled", true).ok)
  assert.ok(checkSetting({}, {}, "telemetry.level", "events").ok)
})

test("OTLP JSON: metrics and logs are encoded to the specification", () => {
  const o = { resource: { "service.name": "quota-router", n: 2, f: 1.5, b: true, skip: undefined }, version: "1.2.3", start: 1_700_000_000_000, end: 1_700_000_060_000 }
  const m = metricsPayload(
    [
      { name: "quota_router.tokens", description: "d", unit: "{token}", type: "sum", integer: true, points: [{ attrs: { provider: "p", type: "input", empty: "" }, value: 1234 }] },
      { name: "quota_router.plan.utilization", description: "d", unit: "%", type: "gauge", points: [{ attrs: { provider: "p", window: "5h" }, value: 41.5 }] },
      { name: "quota_router.requests", description: "d", unit: "{request}", type: "sum", points: [] },
    ],
    { ...o, temporality: "delta" },
  )
  const rm = m.resourceMetrics[0]
  assert.deepEqual(rm.resource.attributes, [
    { key: "service.name", value: { stringValue: "quota-router" } },
    { key: "n", value: { intValue: "2" } },
    { key: "f", value: { doubleValue: 1.5 } },
    { key: "b", value: { boolValue: true } },
  ])
  assert.deepEqual(rm.scopeMetrics[0].scope, { name: "quota-router", version: "1.2.3" })
  assert.deepEqual(rm.scopeMetrics[0].metrics, [
    {
      name: "quota_router.tokens", description: "d", unit: "{token}",
      sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ attributes: [{ key: "provider", value: { stringValue: "p" } }, { key: "type", value: { stringValue: "input" } }], startTimeUnixNano: "1700000000000000000", timeUnixNano: "1700000060000000000", asInt: "1234" }] },
    },
    { name: "quota_router.plan.utilization", description: "d", unit: "%", gauge: { dataPoints: [{ attributes: [{ key: "provider", value: { stringValue: "p" } }, { key: "window", value: { stringValue: "5h" } }], timeUnixNano: "1700000060000000000", asDouble: 41.5 }] } },
  ])
  assert.equal((metricsPayload([{ name: "x", description: "", unit: "1", type: "sum", points: [{ attrs: {}, value: 1 }] }], { ...o, temporality: "cumulative" }).resourceMetrics[0].scopeMetrics[0].metrics[0] as any).sum.aggregationTemporality, 2)

  const l = logsPayload([{ at: 1_700_000_001_000, name: "quota_router.switch", attrs: { from: "a/b", to: "c/d" } }], { resource: o.resource, version: "1.2.3", observed: 1_700_000_060_000 })
  assert.deepEqual(l.resourceLogs[0].scopeLogs[0].logRecords[0], {
    timeUnixNano: "1700000001000000000", observedTimeUnixNano: "1700000060000000000", severityNumber: 9, severityText: "INFO", eventName: "quota_router.switch",
    body: { stringValue: "quota_router.switch" },
    attributes: [{ key: "event.name", value: { stringValue: "quota_router.switch" } }, { key: "from", value: { stringValue: "a/b" } }, { key: "to", value: { stringValue: "c/d" } }],
  })
})

// ---------- end to end, against a collector on this machine ----------

let core: any
let server: http.Server
let url = ""
const received: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }> = []
let respond: Array<{ status: number; retryAfter?: string }> = []

before(async () => {
  core = await Core.create(BASE)
  server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const r = respond.shift() ?? { status: 200 }
      if (r.status === 200) received.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(raw) })
      res.writeHead(r.status, { "content-type": "application/json", ...(r.retryAfter ? { "retry-after": r.retryAfter } : {}) })
      res.end("{}")
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  url = `http://127.0.0.1:${(server.address() as any).port}`
})
after(async () => {
  server.close()
  core.store.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const step = (id: string, at: number, o: Record<string, unknown> = {}) => {
  const s = { session: "ses_t", provider: "anthropic", model: "claude-opus-5-5", status: "ok", input: 1000, output: 200, cacheRead: 5000, equiv: 0.5, actual: 0.5, fallback: 0, ...o } as any
  core.store.run(
    "INSERT INTO steps (id, session_id, kind, provider_id, model_id, started_at, ended_at, status, input, output, cache_read, cost_equiv, cost_actual, day, on_fallback) VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, s.session, s.provider, s.model, at - 1000, at, s.status, s.input, s.output, s.cacheRead, s.equiv, s.actual, localDay(at), s.fallback,
  )
}
const metric = (body: any, name: string) => body.resourceMetrics[0].scopeMetrics[0].metrics.find((m: any) => m.name === name)
const points = (body: any, name: string) =>
  (metric(body, name)?.sum ?? metric(body, name)?.gauge)?.dataPoints.map((p: any) => [Object.fromEntries(p.attributes.map((a: any) => [a.key, Object.values(a.value)[0]])), Number(p.asInt ?? p.asDouble)]) ?? []

test("export: totals since the last export, sent once, with nothing that identifies a person or a project", async () => {
  const t0 = Date.now()
  core.store.run("INSERT INTO sessions (id, directory, title) VALUES ('ses_t', '/work/secret-project', 'Fix the secret thing')")
  step("old", t0 - 60_000)
  core.setOptions({ ...BASE, telemetry: { enabled: true, endpoint: url, headers: { authorization: "Bearer test-key" } } })
  const tm = new Telemetry(core, { env: {} })

  // Turning it on exports nothing from before.
  await tm.tick(t0)
  assert.equal(received.length, 0)

  step("s1", t0 + 10_000)
  step("s2", t0 + 20_000, { status: "failed", input: 0, output: 0, cacheRead: 0, equiv: 0, actual: 0 })
  step("s3", t0 + 30_000, { provider: "xai", model: "grok-4.7", equiv: 0.4, actual: 0, fallback: 1 })
  core.store.run("INSERT INTO routing (at, session_id, trigger, kind, from_model, to_model, until, dry) VALUES (?, 'ses_t', 'failover', 'window', 'claude-agent/opus#medium', 'xai/grok-4.7#high', ?, 0)", t0 + 25_000, t0 + 3_600_000)
  core.store.run("INSERT INTO routing (at, session_id, trigger, kind, from_model, to_model, dry) VALUES (?, 'ses_t', 'failover', 'window', 'claude-agent/opus#medium', 'xai/grok-4.7#high', 1)", t0 + 26_000)
  core.pools.report({ kind: "window", pools: ["claude-agent"], resetAt: Date.now() + 3_600_000, evidence: "5h" })
  core.copilot = { at: Date.now(), ok: true, data: { plan: "pro", name: "ai_credits", entitlement: 1500, used: 300, remaining: 1200, percentRemaining: 80, unlimited: false, overagePermitted: false, overageUsed: 0 } }

  await tm.tick(t0 + 30_000) // not due yet
  assert.equal(received.length, 0)
  await tm.tick(t0 + 61_000)
  assert.equal(received.length, 1)
  const { path: p, headers, body } = received[0]
  assert.equal(p, "/v1/metrics")
  assert.equal(headers["content-type"], "application/json")
  assert.equal(headers.authorization, "Bearer test-key")
  assert.deepEqual(points(body, "quota_router.tokens"), [
    [{ provider: "anthropic", model: "claude-opus-5-5", type: "input" }, 1000],
    [{ provider: "anthropic", model: "claude-opus-5-5", type: "output" }, 200],
    [{ provider: "anthropic", model: "claude-opus-5-5", type: "cache_read" }, 5000],
    [{ provider: "xai", model: "grok-4.7", type: "input" }, 1000],
    [{ provider: "xai", model: "grok-4.7", type: "output" }, 200],
    [{ provider: "xai", model: "grok-4.7", type: "cache_read" }, 5000],
  ])
  assert.deepEqual(points(body, "quota_router.requests"), [[{ provider: "anthropic", model: "claude-opus-5-5", kind: "primary" }, 2], [{ provider: "xai", model: "grok-4.7", kind: "primary" }, 1]])
  assert.deepEqual(points(body, "quota_router.requests.failed"), [[{ provider: "anthropic", model: "claude-opus-5-5", kind: "primary" }, 1]])
  assert.deepEqual(points(body, "quota_router.cost.actual_usd"), [[{ provider: "anthropic", model: "claude-opus-5-5" }, 0.5]])
  assert.deepEqual(points(body, "quota_router.overage.avoided_usd"), [[{ provider: "xai", model: "grok-4.7" }, 0.4]])
  // The dry-run row is not a fallback.
  assert.deepEqual(points(body, "quota_router.fallbacks"), [[{ from_provider: "claude-agent", to_provider: "xai", reason_kind: "window" }, 1]])
  assert.deepEqual(points(body, "quota_router.plan.utilization"), [[{ provider: "github-copilot", window: "monthly", plan: "pro" }, 20]])
  assert.deepEqual(points(body, "quota_router.plan.allowance.total"), [[{ provider: "github-copilot", plan: "pro", allowance: "ai_credits", unit: "credits" }, 1500]])
  assert.equal(points(body, "quota_router.limited.duration")[0][0].provider, "claude-agent")
  const sum = metric(body, "quota_router.tokens").sum
  assert.equal(sum.aggregationTemporality, 1)
  assert.equal(sum.dataPoints[0].startTimeUnixNano, `${t0}000000`)
  assert.equal(sum.dataPoints[0].timeUnixNano, `${t0 + 61_000}000000`)

  const text = JSON.stringify(body)
  for (const secret of ["secret", "ses_t", os.hostname(), os.userInfo().username, "user.email", "host.name"]) assert.ok(!text.includes(secret), secret)
  assert.deepEqual(body.resourceMetrics[0].resource.attributes.map((a: any) => a.key), ["service.name", "service.version"])

  // Nothing new: only the gauges go out, and the counters are not repeated.
  await tm.tick(t0 + 122_000)
  assert.equal(received.length, 2)
  assert.equal(metric(received[1].body, "quota_router.tokens"), undefined)
  assert.ok(metric(received[1].body, "quota_router.plan.utilization"))
  const s = tm.status()
  assert.equal(s.queued, 0)
  assert.equal(s.sent, 2)
  assert.deepEqual(s.headerNames, ["authorization"])
  assert.ok(!JSON.stringify(s).includes("test-key"))
  assert.ok(!fs.readFileSync(path.join(tmp, "opencode-quota-router", "router.log"), "utf8").includes("test-key"))
})

test("export: events, hashed projects, identity and cumulative totals when asked for", async () => {
  received.length = 0
  const t0 = Date.now() + 1_000_000
  core.setOptions({ ...BASE, telemetry: { enabled: true, endpoint: url, level: "events", projects: "hashed", temporality: "cumulative", identity: { email: "git", hostName: true, organizationId: "org-1" } } })
  core.store.setMeta("telemetry_state", "{}")
  const tm = new Telemetry(core, { env: {}, gitEmail: async () => "dev@example.com", hostName: () => "laptop" })
  await tm.tick(t0)
  step("c1", t0 + 5_000)
  core.store.run("INSERT INTO routing (at, session_id, trigger, kind, from_model, to_model, until, dry) VALUES (?, 'ses_t', 'failover', 'window', 'claude-agent/opus', 'xai/grok-4.7', ?, 0)", t0 + 6_000, t0 + 600_000)
  core.store.run("INSERT INTO routing (at, session_id, trigger, from_model, to_model, dry) VALUES (?, 'ses_t', 'recovery', 'xai/grok-4.7', 'claude-agent/opus', 0)", t0 + 7_000)
  core.store.run("INSERT INTO routing (at, session_id, trigger, kind, until, evidence, dry) VALUES (?, 'ses_t', 'exhausted', 'window', ?, 'All providers limited: secret detail', 0)", t0 + 8_000, t0 + 68_000)
  await tm.tick(t0 + 60_000)
  step("c2", t0 + 70_000)
  await tm.tick(t0 + 120_000)

  const metrics = received.filter((r) => r.path === "/v1/metrics")
  const logs = received.filter((r) => r.path === "/v1/logs")
  assert.equal(metrics.length, 2)
  const input = (b: any) => points(b, "quota_router.tokens").find((p: any) => p[0].type === "input")
  assert.equal(input(metrics[0].body)[1], 1000)
  assert.equal(input(metrics[1].body)[1], 2000)
  assert.equal(metric(metrics[1].body, "quota_router.tokens").sum.aggregationTemporality, 2)
  assert.equal(metric(metrics[1].body, "quota_router.tokens").sum.dataPoints[0].startTimeUnixNano, `${t0}000000`)
  assert.match(input(metrics[0].body)[0].project, /^[0-9a-f]{12}$/)
  const resource = Object.fromEntries(metrics[0].body.resourceMetrics[0].resource.attributes.map((a: any) => [a.key, a.value.stringValue]))
  assert.equal(resource["user.email"], "dev@example.com")
  assert.equal(resource["host.name"], "laptop")
  assert.equal(resource["organization.id"], "org-1")

  assert.equal(logs.length, 1)
  const records = logs[0].body.resourceLogs[0].scopeLogs[0].logRecords
  assert.deepEqual(records.map((r: any) => r.eventName), ["quota_router.limit_hit", "quota_router.switch", "quota_router.recovered", "quota_router.limit_hit", "quota_router.exhausted"])
  const attrs = (r: any) => Object.fromEntries(r.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]))
  assert.deepEqual(attrs(records[1]), { "event.name": "quota_router.switch", from: "claude-agent/opus", to: "xai/grok-4.7", trigger: "failover", "session.id": "ses_t" })
  assert.equal(attrs(records[4]).wait_seconds, "60")
  assert.ok(!JSON.stringify(logs[0].body).includes("secret"))
})

test("export: a collector that is away is retried in order; a refused request is dropped; turning it off clears the queue", async () => {
  received.length = 0
  const t0 = Date.now() + 5_000_000
  core.setOptions({ ...BASE, telemetry: { enabled: true, endpoint: url } })
  core.store.setMeta("telemetry_state", "{}")
  const tm = new Telemetry(core, { env: {} })
  await tm.tick(t0)

  step("r1", t0 + 1_000)
  respond = [{ status: 503, retryAfter: "120" }]
  await tm.tick(t0 + 60_000)
  assert.equal(received.length, 0)
  assert.equal(tm.status().queued, 1)
  assert.match(tm.status().lastError!, /^HTTP 503 from http:\/\/127\.0\.0\.1:\d+\/v1\/metrics; will retry$/)

  // Before Retry-After has passed nothing is sent, and the next interval queues behind the first.
  step("r2", t0 + 61_000, { input: 7 })
  await tm.tick(t0 + 120_000)
  assert.equal(received.length, 0)
  assert.equal(tm.status().queued, 2)
  await tm.tick(t0 + 181_000)
  assert.deepEqual(received.map((r) => points(r.body, "quota_router.tokens")[0]?.[1]), [1000, 7, undefined])
  assert.equal(tm.status().queued, 0)
  assert.equal(tm.status().lastError, undefined)

  // A request the collector refuses outright is not sent again.
  step("r3", t0 + 190_000)
  respond = [{ status: 400 }]
  await tm.tick(t0 + 242_000)
  assert.equal(tm.status().queued, 0)
  assert.match(tm.status().lastError!, /HTTP 400 .* dropped/)

  // Unreachable: kept and retried.
  step("r4", t0 + 250_000)
  const down = new Telemetry(core, { env: {}, fetch: async () => { throw new TypeError("fetch failed") } })
  await down.tick(t0 + 303_000)
  assert.equal(down.status().queued, 1)
  assert.match(down.status().lastError!, /Could not reach .* will retry/)

  // The queue is bounded.
  for (let i = 0; i < 600; i++) core.store.run("INSERT INTO telemetry_queue (at, signal, body, next_at) VALUES (?, 'metrics', '{}', ?)", t0 + 303_000, t0 * 2)
  await down.tick(t0 + 304_000)
  assert.equal(down.status().queued, 500)

  // Off: the queue is emptied, and what happens meanwhile is never sent.
  core.setOptions(BASE)
  await down.tick(t0 + 305_000)
  assert.equal(down.status().queued, 0)
  step("off", t0 + 306_000, { input: 99 })
  core.setOptions({ ...BASE, telemetry: { enabled: true, endpoint: url } })
  received.length = 0
  await down.tick(t0 + 400_000)
  step("on", t0 + 401_000, { input: 55 })
  await down.tick(t0 + 461_000)
  assert.equal(received.length, 0) // `down` cannot reach the collector; what it queued is what would be sent
  const queued = core.store.all("SELECT body FROM telemetry_queue").map((r: any) => points(JSON.parse(r.body), "quota_router.tokens")[0][1])
  assert.deepEqual(queued, [55])

  // A setup that cannot run sends nothing and says why.
  core.setOptions({ ...BASE, telemetry: { enabled: true, endpoint: "http://collector.example.com:4318" } })
  const { runDoctor } = await import("../src/doctor.ts")
  const check = runDoctor(core).find((c: any) => c.id === "telemetry-0")
  assert.equal(check?.status, "fail")
  assert.match(check!.detail!, /must use https/)
  core.setOptions(BASE)
  assert.equal(runDoctor(core).find((c: any) => c.id === "telemetry")?.title, "Telemetry export is off")
})
