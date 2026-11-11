import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { eligibleModels, INTELLIGENT_CHAIN, parseRecommendation, recommendationPrompt } from "../src/engine/intelligent.ts"
import { refLabel } from "../src/engine/config.ts"
import { orderedChain, route } from "../src/engine/router.ts"
import { withAdditions } from "../src/engine/discovery.ts"
import { routeGuidance } from "../src/dashboard/routes.ts"

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "qr-intelligent-"))
const { Core } = await import("../src/core.ts")
const { startDashboard } = await import("../src/dashboard/server.ts")

const models = [
  { providerID: "claude-agent", id: "opus", name: "Claude Opus", type: "chat", capabilities: { tools: true }, variants: ["medium", "high"], limit: { context: 1_000_000 }, cost: [] },
  { providerID: "github-copilot", id: "coder", name: "Copilot Coder", type: "chat", capabilities: { tools: true }, variants: ["medium"], limit: { context: 200_000 }, cost: [] },
  { providerID: "anthropic", id: "api-coder", name: "API Coder", type: "chat", capabilities: { tools: true }, variants: ["medium"], limit: { context: 200_000 }, cost: [{ input: 3, output: 15 }] },
  { providerID: "ollama", id: "local-coder", name: "Local Coder", type: "chat", capabilities: { tools: true }, variants: [], limit: { context: 64_000 }, cost: [] },
]
const entries = [
  { ref: "claude-agent/opus#medium", reason: "Start with the strong coding model in the included plan." },
  { ref: "github-copilot/coder#medium", reason: "Use the other subscription when Claude is limited." },
  { ref: "ollama/local-coder", reason: "A local last resort for smaller contexts, without API charges." },
]
const answer = () => JSON.stringify({ summary: "Use the included plans first, then local capacity. Existing safety rules still apply.", entries })
const input = { analyzer: "claude-agent/opus", goal: "balanced" as const, includeMetered: false, allowMeteredAnalysis: false, setup: false }

async function fixture(t: TestContext, options: unknown = {}, existing?: { providerID: string; modelID: string }) {
  const core = await Core.create(options)
  // Every fixture has its own database even when tests run in the same process.
  for (const key of ["settings", "chain_additions", "chain_replaced", "chain_ignored", "intelligent_candidate", "intelligent_active", "intelligent_onboarded"]) core.store.run("DELETE FROM meta WHERE key = ?", key)
  core.setOptions(options)
  const calls: Array<{ input: any; options: any }> = []
  const fake = {
    answer: answer(),
    generate: async (_input: any, _options: any): Promise<{ text: string }> => ({ text: fake.answer }),
  }
  const ctx = {
    model: { list: async () => models },
    integration: { connection: { active: async (id: string) => ({ method: id === "anthropic" ? "key" : "oauth" }) } },
    experimental: { generate: { text: async (request: any, requestOptions: any) => { calls.push({ input: request, options: requestOptions }); return fake.generate(request, requestOptions) } } },
  }
  core.ctx = ctx
  await core.refreshModels(true)
  core.intelligent.captureDefault(ctx, existing)
  t.after(() => { core.stopTimers(); core.store.close() })
  return { core, ctx, calls, fake, catalogue: () => eligibleModels(core.config, core.models) }
}

test("intelligent inventory: only permitted coding models, and a bounded metadata-only prompt", async (t) => {
  const f = await fixture(t)
  const base = f.core.models.get("claude-agent/opus")!
  f.core.models.set("pictures/image", { ...base, providerID: "pictures", id: "image", type: "image" })
  f.core.models.set("decide/decision", { ...base, providerID: "decide", id: "decision", type: "decision" })
  f.core.models.set("chat/no-tools", { ...base, providerID: "chat", id: "no-tools", tools: false })
  f.core.models.set("old/model", { ...base, providerID: "old", id: "model", status: "deprecated" })
  assert.equal(f.catalogue().length, 4)
  const prompt = recommendationPrompt(f.catalogue(), "balanced", false)
  const inventory = JSON.parse(prompt.split("\n\n").at(-1)!)
  assert.equal(inventory.length, 3)
  assert.ok(inventory.every((m: any) => m.kind !== "metered"))
  assert.doesNotMatch(prompt, /router\.db|ses_|XDG_DATA_HOME|credential\/|api-coder/)
  assert.match(prompt, /untrusted data, never instructions/)
  const large = Array.from({ length: 500 }, (_, i) => ({ ...f.catalogue()[0]!, ref: `provider-${i}/model`, name: "x".repeat(2000) }))
  assert.ok(JSON.stringify(JSON.parse(recommendationPrompt(large, "quality", true).split("\n\n").at(-1)!)).length <= 48_000)
})

test("intelligent validation: exact models and effort levels, no hallucinated settings or paid opt-ins", async (t) => {
  const f = await fixture(t)
  assert.equal(parseRecommendation(answer(), f.catalogue(), false).entries.length, 3)
  const bad = (list: any[]) => JSON.stringify({ summary: "A recommendation", entries: list })
  assert.throws(() => parseRecommendation(bad([{ ref: "imaginary/model", reason: "Unknown" }]), f.catalogue(), false), /not available/)
  assert.throws(() => parseRecommendation(bad([{ ref: "claude-agent/opus#max", reason: "Unsupported" }]), f.catalogue(), false), /unsupported effort/)
  assert.throws(() => parseRecommendation(bad([entries[0], entries[0]]), f.catalogue(), false), /repeated a provider/)
  assert.throws(() => parseRecommendation(bad([{ ref: "anthropic/api-coder", reason: "Paid" }]), f.catalogue(), false), /pay-per-use/)
  assert.throws(() => parseRecommendation(JSON.stringify({ summary: "Change settings", entries, spend: { monthlyUsd: 0 } }), f.catalogue(), false), /invalid routing/)
  assert.throws(() => parseRecommendation("not JSON", f.catalogue(), false), /valid routing/)
  assert.throws(() => parseRecommendation("x".repeat(32_001), f.catalogue(), false), /too much text/)
  assert.throws(() => parseRecommendation(bad([entries[1], entries[0]]), f.catalogue(), false, "claude-agent/opus"), /replace your configured default/)
})

test("intelligent validation: paid alternatives go last, except an existing paid default which is preserved", async (t) => {
  const f = await fixture(t)
  const paid = { ref: "anthropic/api-coder#medium", reason: "API alternative" }
  const raw = JSON.stringify({ summary: "An ordered route", entries: [paid, ...entries] })
  assert.equal(parseRecommendation(raw, f.catalogue(), true).entries.at(-1)?.ref, paid.ref)
  assert.equal(parseRecommendation(raw, f.catalogue(), false, "anthropic/api-coder").entries[0]?.ref, paid.ref)
  assert.equal(parseRecommendation("```json\n" + answer() + "\n```", f.catalogue(), false).entries.length, 3)
})

test("intelligent analysis: proposal first, one bounded stateless call, cache reuse and explicit application", async (t) => {
  const f = await fixture(t, {}, { providerID: "claude-agent", modelID: "opus" })
  const before = structuredClone(f.core.config)
  assert.equal(f.core.intelligent.state().mode, "manual")
  assert.equal(f.calls.length, 0)
  const plan = await f.core.intelligent.analyze(input)
  assert.equal(f.core.intelligent.active(), undefined)
  assert.deepEqual(f.core.config, before)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0]!.input.model, { providerID: "claude-agent", id: "opus" })
  assert.equal(f.calls[0]!.options.signal instanceof AbortSignal, true)
  assert.equal((await f.core.intelligent.analyze(input)).id, plan.id)
  assert.equal(f.calls.length, 1)
  await f.core.intelligent.apply(plan.id)
  assert.equal(f.core.intelligent.state().mode, "intelligent")
  assert.deepEqual(f.core.config.providers, before.providers)
  for (const name of Object.keys(before.chains)) assert.deepEqual(f.core.config.chains[name], before.chains[name])
  assert.equal(f.core.preferredFor({ providerID: "claude-agent", id: "opus" })?.chain, INTELLIGENT_CHAIN)
  assert.equal(f.core.intelligent.defaultFor({ providerID: "claude-agent", modelID: "opus" }), undefined)
})

test("intelligent onboarding: a genuinely unset setup adopts the recommendation, and manual mode restores it", async (t) => {
  const f = await fixture(t)
  const before = structuredClone(f.core.config)
  assert.equal(f.core.intelligent.hasExistingSetup(), false)
  await f.core.intelligent.analyze({ ...input, setup: true })
  assert.equal(f.core.intelligent.state().mode, "intelligent")
  assert.equal(refLabel(f.core.intelligent.defaultFor(undefined)!), entries[0]!.ref)
  const writes: string[] = []
  const editor = { default: { get: () => undefined, set: (p: string, m: string) => writes.push(`${p}/${m}`) }, get: () => ({ enabled: true }) }
  f.core.intelligent.transformDefault(f.ctx, editor)
  assert.deepEqual(writes, ["claude-agent/opus"])
  f.core.intelligent.transformDefault(f.ctx, { ...editor, get: () => ({ enabled: false }) })
  assert.equal(writes.length, 1)
  await f.core.intelligent.manual()
  assert.equal(f.core.intelligent.defaultFor(undefined), undefined)
  assert.deepEqual(f.core.config, before)
  assert.deepEqual(f.core.options, {})
})

test("intelligent onboarding: existing defaults, custom settings and unknown default provenance never auto-apply", async (t) => {
  const f = await fixture(t, {}, { providerID: "claude-agent", modelID: "opus" })
  const pinned = f.core.session("ses_pinned")
  pinned.pinned = true
  pinned.current = { providerID: "claude-agent", id: "opus" }
  f.core.savePrefs(pinned)
  await f.core.intelligent.analyze({ ...input, setup: true })
  assert.equal(f.core.intelligent.active(), undefined)
  await f.core.intelligent.apply(f.core.intelligent.candidate()!.id)
  let overwritten = false
  f.core.intelligent.transformDefault(f.ctx, { default: { get: () => ({ providerID: "claude-agent", modelID: "opus" }), set: () => { overwritten = true } }, get: () => ({ enabled: true }) })
  assert.equal(overwritten, false)
  assert.equal(pinned.pinned, true)
  assert.deepEqual(pinned.current, { providerID: "claude-agent", id: "opus" })
  await f.core.intelligent.manual()
  f.core.store.run("DELETE FROM meta WHERE key = ?", "intelligent_onboarded")
  f.core.intelligent.forgetDefault(f.ctx)
  assert.equal(f.core.intelligent.hasExistingSetup(), true)
  f.core.intelligent.captureDefault(f.ctx, undefined)
  f.core.setOptions({ dryRun: true })
  await f.core.intelligent.analyze({ ...input, setup: true, force: true })
  assert.equal(f.core.intelligent.active(), undefined)
})

test("intelligent route: accepted order is independent of manual ranks, while context and safety gates still win", async (t) => {
  const f = await fixture(t)
  f.fake.answer = JSON.stringify({ summary: "Use Copilot first for this goal", entries: [entries[1], entries[0], entries[2]] })
  const plan = await f.core.intelligent.analyze(input)
  await f.core.intelligent.apply(plan.id)
  assert.equal(orderedChain(f.core.config, INTELLIGENT_CHAIN)[0]?.providerID, "github-copilot")
  assert.equal(orderedChain(f.core.config, "opus")[0]?.providerID, "claude-agent")
  const preferred = f.core.preferredFor({ providerID: "github-copilot", id: "coder" })!
  const request = { config: f.core.config, pools: f.core.pools, models: f.core.models, preferred, mode: "turn" as const }
  assert.equal(route(request).target?.providerID, "github-copilot")
  assert.equal(route({ ...request, speed: (ref) => ref.providerID === "github-copilot" ? 1000 : 1 }).target?.providerID, "github-copilot")
  assert.equal(route({ ...request, lastInputTokens: 300_000 }).target?.providerID, "claude-agent")
  assert.equal(route({ ...request, gate: (ref) => ref.providerID === "github-copilot" ? { reason: "A spending policy excludes it" } : undefined }).target?.providerID, "claude-agent")
  assert.equal(f.calls.length, 1, "normal routing never calls the AI analyzer")
})

test("intelligent analysis: explicit paid-analysis consent and existing policies are enforced", async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.core.intelligent.analyze({ ...input, analyzer: "anthropic/api-coder" }), /Confirm that charge/)
  assert.equal(f.calls.length, 0)
  await f.core.intelligent.analyze({ ...input, analyzer: "anthropic/api-coder", allowMeteredAnalysis: true })
  assert.equal(f.calls.length, 1)
  const gate = f.core.gate
  f.core.gate = () => () => ({ reason: "Daily spending cap reached" })
  await assert.rejects(f.core.intelligent.analyze({ ...input, force: true }), /spending cap/)
  assert.equal(f.calls.length, 1)
  f.core.gate = gate
})

test("intelligent preset: a later configured default takes precedence over an older recommendation", async (t) => {
  const f = await fixture(t)
  const plan = await f.core.intelligent.analyze({ ...input, setup: true })
  assert.equal(f.core.intelligent.active()?.id, plan.id)
  f.core.intelligent.captureDefault(f.ctx, { providerID: "github-copilot", modelID: "coder" })
  await Promise.resolve()
  assert.equal(f.core.intelligent.active(), undefined)
  assert.equal(f.core.config.chains[INTELLIGENT_CHAIN], undefined)
  assert.equal(f.core.intelligent.defaultFor({ providerID: "github-copilot", modelID: "coder" }), undefined)
  assert.equal(f.core.intelligent.state().stale, true)
})

test("intelligent default: root configuration is preserved even when the registry editor reports no default", async (t) => {
  const f = await fixture(t)
  f.core.intelligent.captureConfiguredDefault(f.ctx, { known: true, model: { providerID: "claude-agent", modelID: "opus" } })
  const plan = await f.core.intelligent.analyze({ ...input, setup: true })
  assert.equal(f.core.intelligent.configuredDefault(), "claude-agent/opus")
  assert.equal(f.core.intelligent.active(), undefined)
  await f.core.intelligent.apply(plan.id)
  let overwritten = false
  f.core.intelligent.transformDefault(f.ctx, { default: { get: () => undefined, set: () => { overwritten = true } }, get: () => ({ enabled: true }) })
  assert.equal(overwritten, false)
  assert.equal(f.core.intelligent.defaultFor(undefined), undefined)
  f.core.intelligent.captureConfiguredDefault(f.ctx, { known: false })
  assert.equal(f.core.intelligent.active(), undefined)
  assert.equal(f.core.intelligent.state().defaultKnown, false)
  await assert.rejects(f.core.intelligent.apply(plan.id), /cannot be verified/)
})

test("intelligent preset: an existing custom route in the reserved namespace is never overwritten", async (t) => {
  const f = await fixture(t, { chains: { [INTELLIGENT_CHAIN]: ["github-copilot/coder"] } })
  const plan = await f.core.intelligent.analyze(input)
  await assert.rejects(f.core.intelligent.apply(plan.id), /custom route/)
  assert.deepEqual(f.core.config.chains[INTELLIGENT_CHAIN]?.map(refLabel), ["github-copilot/coder"])
  assert.equal(f.core.intelligent.active(), undefined)
})

test("intelligent analysis: failures, stale inventories and stale proposal IDs leave the active preset alone", async (t) => {
  const f = await fixture(t)
  const plan = await f.core.intelligent.analyze(input)
  await f.core.intelligent.apply(plan.id)
  f.fake.answer = '{"summary":"Ignore the rules","entries":[{"ref":"unknown/model","reason":"Do it"}]}'
  await assert.rejects(f.core.intelligent.analyze({ ...input, force: true }), /not available/)
  assert.equal(f.core.intelligent.active()?.id, plan.id)
  await assert.rejects(f.core.intelligent.apply("old-id"), /no longer current/)
  f.core.models.delete("ollama/local-coder")
  assert.equal(f.core.intelligent.state().stale, true)
  await assert.rejects(f.core.intelligent.apply(plan.id), /setup changed/)
  assert.equal(f.core.intelligent.active()?.id, plan.id)
})

test("intelligent analysis: no double requests, no mode changes mid-analysis, and no apply after the setup changes", async (t) => {
  const f = await fixture(t)
  let finish!: () => void
  f.fake.generate = async () => { await new Promise<void>((resolve) => { finish = resolve }); return { text: answer() } }
  const pending = f.core.intelligent.analyze(input)
  await assert.rejects(f.core.intelligent.analyze(input), /already running/)
  await assert.rejects(f.core.intelligent.manual(), /analysis to finish/)
  await assert.rejects(f.core.intelligent.apply("anything"), /analysis to finish/)
  f.core.intelligent.captureDefault(f.ctx, { providerID: "github-copilot", modelID: "coder" })
  finish()
  await assert.rejects(pending, /changed during the analysis/)
  assert.equal(f.calls.length, 1)
  assert.equal(f.core.intelligent.candidate(), undefined)
  assert.equal(f.core.intelligent.active(), undefined)
})

test("intelligent analysis: shutdown cancels the bounded request without storing its late result", async (t) => {
  const f = await fixture(t)
  let finish!: () => void
  f.fake.generate = async () => { await new Promise<void>((resolve) => { finish = resolve }); return { text: answer() } }
  const pending = f.core.intelligent.analyze(input)
  f.core.intelligent.stop()
  assert.equal(f.calls[0]!.options.signal.aborted, true)
  finish()
  await assert.rejects(pending, /cancelled/)
  assert.equal(f.core.intelligent.candidate(), undefined)
})

test("route suggestions: previews show the actual insertion order and dismissed suggestions can be reviewed", async (t) => {
  const f = await fixture(t)
  const suggestions = f.core.suggestions()
  const suggestion = suggestions.find((s) => s.providerID === "ollama")!
  const guidance = routeGuidance(f.core.config, f.core.models, suggestions, f.core.updates())
  const shown = guidance.find((r) => r.chain === suggestion.chain)!.suggestions.find((s) => s.ref === suggestion.ref)!
  assert.deepEqual(shown.after.map((e) => e.ref), orderedChain(withAdditions(f.core.config, { [suggestion.chain]: [suggestion.ref] }), suggestion.chain).map(refLabel))
  assert.equal(f.core.config.chains[suggestion.chain]!.some((r) => r.providerID === "ollama"), false)
  f.core.changeChain("ignore", suggestion.chain, suggestion.ref)
  assert.equal(f.core.suggestions().some((s) => s.chain === suggestion.chain && s.ref === suggestion.ref), false)
  f.core.reviewSuggestions()
  assert.equal(f.core.suggestions().some((s) => s.chain === suggestion.chain && s.ref === suggestion.ref), true)
})

test("intelligent API: reads never generate; writes need the dashboard token, same origin and explicit consent", async (t) => {
  const f = await fixture(t, {}, { providerID: "claude-agent", modelID: "opus" })
  f.core.config.dashboard.port = 48100 + Math.floor(Math.random() * 90)
  const server = await startDashboard(f.core)
  assert.ok(server)
  try {
    const html = await (await fetch(server.url)).text()
    const token = html.match(/name="qr-token" content="([^"]+)"/)![1]!
    const headers = { "content-type": "application/json", "x-quota-router": "1", "x-quota-router-token": token }
    const body = JSON.stringify({ action: "analyze", ...input })
    assert.equal((await fetch(server.url + "/api/intelligent")).status, 200)
    assert.equal(f.calls.length, 0)
    for (const bad of [{ ...headers, "x-quota-router-token": "wrong" }, { ...headers, origin: "http://elsewhere.invalid" }, { ...headers, "sec-fetch-site": "cross-site" }]) {
      assert.equal((await fetch(server.url + "/api/intelligent", { method: "POST", headers: bad, body })).status, 403)
    }
    assert.equal(f.calls.length, 0)
    const response = await fetch(server.url + "/api/intelligent", { method: "POST", headers, body })
    const result = await response.json() as any
    assert.equal(response.status, 200)
    assert.equal(result.state.mode, "manual")
    assert.equal(result.state.candidate.entries.length, 3)
    assert.equal(f.calls.length, 1)
    assert.equal((await fetch(server.url + "/api/intelligent", { method: "POST", headers, body: '{"action":"apply","id":"not-reviewed"}' })).status, 400)
  } finally { await server.stop() }
})

test("plugin lifecycle: register the default-preserving transform without touching sessions or generating on load", async () => {
  const previousHome = process.env.XDG_DATA_HOME
  const configKeys = ["XDG_CONFIG_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"]
  const previousConfig = Object.fromEntries(configKeys.map((k) => [k, process.env[k]]))
  for (const key of configKeys) delete process.env[key]
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "qr-config-"))
  process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "qr-plugin-default-"))
  const { default: plugin } = await import("../src/index.ts")
  const transforms: Array<(editor: any) => void> = [], defaultWrites: string[] = []
  let configured: { providerID: string; modelID: string } | undefined
  let generations = 0, sessionWrites = 0
  const reload = async () => {
    const editor = { default: { get: () => configured, set: (p: string, m: string) => defaultWrites.push(`${p}/${m}`) }, get: (p: string, m: string) => models.find((x) => x.providerID === p && x.id === m) }
    for (const transform of transforms) transform(editor)
    return { data: models[0] }
  }
  const ctx = {
    options: { claude: { usageProbe: false }, copilot: { usageProbe: false }, local: { healthCheck: false }, backfill: false, dashboard: { enabled: false } },
    location: { directory: "/demo" },
    model: { list: async () => models, transform: async (cb: (editor: any) => void) => { transforms.push(cb) }, default: reload, reload },
    integration: { connection: { active: async () => ({ method: "oauth" }) } },
    session: { hook: async () => ({}), switchModel: async () => { sessionWrites++ } },
    command: { transform: async () => ({}) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })) } },
    experimental: { generate: { text: async () => { generations++; return { text: answer() } } } },
  }
  let cleanup: (() => void) | undefined
  let core: Awaited<ReturnType<typeof Core.create>> | undefined
  const key = Symbol.for("opencode-quota-router")
  try {
    cleanup = await plugin.setup(ctx)
    const shared = (globalThis as any)[key]
    core = await shared.core
    assert.equal(transforms.length, 1)
    assert.equal(defaultWrites.length, 0)
    assert.equal(generations, 0)
    const plan = await core!.intelligent.analyze(input)
    await core!.intelligent.apply(plan.id)
    assert.deepEqual(defaultWrites, ["claude-agent/opus"])
    configured = { providerID: "github-copilot", modelID: "coder" }
    await reload()
    await Promise.resolve()
    assert.equal(defaultWrites.length, 1)
    assert.equal(core!.intelligent.state().mode, "manual")
    assert.equal(sessionWrites, 0)
    assert.equal(generations, 1)
  } finally {
    cleanup?.()
    const shared = (globalThis as any)[key]
    if (shared?.shutdownTimer) clearTimeout(shared.shutdownTimer)
    core?.stopTimers(); core?.store.close()
    delete (globalThis as any)[key]
    process.env.XDG_DATA_HOME = previousHome
    for (const key of configKeys) { if (previousConfig[key] === undefined) delete process.env[key]; else process.env[key] = previousConfig[key] }
  }
})
