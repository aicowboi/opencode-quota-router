import { test } from "node:test"
import assert from "node:assert/strict"
import { classify } from "../src/engine/classify.ts"
import { loadConfig } from "../src/engine/config.ts"
import { applyDiscovery, kindOf, suggest, withAdditions, type ConnectionMethod } from "../src/engine/discovery.ts"
import { codexWindows } from "../src/engine/headers.ts"
import { estimate } from "../src/engine/pricing.ts"
import { orderedChain } from "../src/engine/router.ts"
import type { ModelInfo } from "../src/engine/types.ts"

const NOW = new Date(2026, 10, 9, 11, 0, 0).getTime()

const model = (providerID: string, id: string, extra: Partial<ModelInfo> = {}): [string, ModelInfo] => [
  `${providerID}/${id}`,
  { providerID, id, variants: ["low", "medium", "high"], tools: true, ...extra },
]
const price = (output: number) => [{ input: output / 5, output }]

test("kindOf: local, subscription by provider or sign-in, metered otherwise", () => {
  assert.equal(kindOf("ollama"), "local")
  assert.equal(kindOf("lmstudio", "key"), "local")
  assert.equal(kindOf("ollama-cloud", "key"), "subscription")
  assert.equal(kindOf("openai", "oauth"), "subscription")
  assert.equal(kindOf("openai", "key"), "metered")
  assert.equal(kindOf("fireworks-ai", "env"), "metered")
})

test("discovery: connected providers are ranked by kind, configured ones keep their place", () => {
  const { config } = loadConfig({ providers: { "github-copilot": { priority: 2 }, xai: { priority: 3 } } })
  const connected = new Map<string, ConnectionMethod | undefined>([
    ["claude-agent", "external"],
    ["github-copilot", "oauth"],
    ["xai", "oauth"],
    ["anthropic", "key"],
    ["openai", "oauth"],
    ["ollama", "key"],
    ["fireworks-ai", "key"],
    ["ollama-cloud", "key"],
  ])
  const c = applyDiscovery(config, connected)
  const order = Object.entries(c.providers).sort((a, b) => a[1].priority - b[1].priority).map(([id]) => id)
  assert.deepEqual(order, ["claude-agent", "github-copilot", "xai", "ollama-cloud", "openai", "anthropic", "fireworks-ai", "ollama"])
  assert.equal(c.providers.openai.kind, "subscription", "ChatGPT sign-in")
  assert.equal(c.providers.openai.discovered, true)
  assert.equal(c.providers.ollama.kind, "local")
  assert.equal(c.providers.anthropic.discovered, undefined)

  // An API key keeps OpenAI where it was; switching discovery off adds nothing new.
  const key = applyDiscovery(config, new Map([["openai", "key"], ["ollama", "key"]]))
  assert.equal(key.providers.openai.priority, 5)
  assert.equal(key.providers.openai.kind, "metered")
  const off = applyDiscovery(loadConfig({ discovery: { enabled: false } }).config, new Map([["ollama", "key"]]))
  assert.equal(off.providers.ollama, undefined)
})

test("discovery: a kind set by the user is never overridden", () => {
  const { config } = loadConfig({ providers: { openai: { kind: "metered" } } })
  assert.equal(applyDiscovery(config, new Map([["openai", "oauth"]])).providers.openai.kind, "metered")
})

test("local and ChatGPT use costs nothing; metered use is spent", () => {
  const { config } = loadConfig({})
  const c = applyDiscovery(config, new Map<string, ConnectionMethod>([["ollama", "key"], ["openai", "oauth"], ["fireworks-ai", "key"]]))
  const models = new Map([model("openai", "gpt-6.1-sol", { cost: price(10) }), model("ollama", "qwen3-coder"), model("fireworks-ai", "kimi-k3", { cost: price(3) })])
  const tokens = { input: 1_000_000, output: 100_000, reasoning: 0, cache: { read: 0, write: 0 } }
  assert.equal(estimate(c, models, "ollama", "qwen3-coder", tokens, 0).actual, 0)
  assert.equal(estimate(c, models, "openai", "gpt-6.1-sol", tokens, 0).actual, 0)
  assert.ok(estimate(c, models, "openai", "gpt-6.1-sol", tokens, 0).equivalent > 0)
  assert.ok(estimate(c, models, "fireworks-ai", "kimi-k3", tokens, 0).actual > 0)
})

test("suggestions: same family first, else nearest price, else newest; ignored ones hidden", () => {
  const { config } = loadConfig({ chains: { opus: ["anthropic/claude-opus-5-5#medium", "openai/gpt-6.1-sol#high"] } })
  const models = new Map([
    model("anthropic", "claude-opus-5-5", { family: "claude-opus", cost: price(25) }),
    model("openai", "gpt-6.1-sol", { family: "gpt-sol", cost: price(30) }),
    model("bedrock", "anthropic.claude-opus-5-5", { family: "claude-opus", released: 2 }),
    model("bedrock", "anthropic.claude-opus-5", { family: "claude-opus", released: 1 }),
    model("bedrock", "openai.gpt-6.1-sol", { family: "gpt-sol", released: 9 }),
    model("fireworks-ai", "cheap", { cost: price(1) }),
    model("fireworks-ai", "close", { cost: price(20), variants: [] }),
    model("fireworks-ai", "no-tools", { cost: price(25), tools: false }),
    model("ollama", "old", { released: 1 }),
    model("ollama", "new", { released: 5 }),
    model("ollama", "gone", { released: 9, status: "deprecated" }),
  ])
  const c = applyDiscovery(config, new Map([["bedrock", "key"], ["fireworks-ai", "key"], ["ollama", "key"], ["anthropic", "key"], ["openai", "key"]]))
  const s = suggest(c, models).filter((x) => x.chain === "opus")
  const byProvider = Object.fromEntries(s.map((x) => [x.providerID, x]))
  assert.equal(byProvider.bedrock.ref, "bedrock/anthropic.claude-opus-5-5#medium")
  assert.match(byProvider.bedrock.reason, /family/)
  assert.equal(byProvider["fireworks-ai"].ref, "fireworks-ai/close")
  assert.equal(byProvider.ollama.ref, "ollama/new#medium")
  assert.equal(byProvider.ollama.kind, "local")
  assert.equal(byProvider.anthropic, undefined, "already in the chain")
  assert.equal(suggest(c, models, new Set(["opus fireworks-ai/close"])).some((x) => x.chain === "opus" && x.providerID === "fireworks-ai"), false)
})

test("accepted suggestions join their chain and are ordered by provider rank", () => {
  const { config } = loadConfig({})
  const c = withAdditions(applyDiscovery(config, new Map<string, ConnectionMethod>([["ollama", "key"], ["claude-agent", "external"]])), {
    opus: ["ollama/qwen3-coder#medium", "claude-agent/opus#medium"],
    gone: ["ollama/x"],
  })
  const chain = orderedChain(c, "opus").map((r) => r.providerID)
  assert.equal(chain.at(-1), "ollama", "local is last")
  assert.equal(chain.filter((p) => p === "claude-agent").length, 1, "no duplicates")
  assert.equal(c.chains.gone, undefined)
})

test("config: one provider's entry in a chain can be changed or removed without rewriting it", () => {
  const { config, warnings } = loadConfig({
    chains: { opus: { xai: "grok-4.6#high", openai: null, ollama: "qwen3-coder", "github-copilot": "xai/grok-4.7" }, mine: ["openai/gpt-6.1-sol#high"] },
  })
  const opus = config.chains.opus.map((r) => `${r.providerID}/${r.id}${r.variant ? `#${r.variant}` : ""}`)
  assert.ok(opus.includes("xai/grok-4.6#high"))
  assert.ok(!opus.some((r) => r.startsWith("openai/")))
  assert.equal(opus.at(-1), "ollama/qwen3-coder")
  assert.ok(opus.includes("github-copilot/claude-opus-5.5#medium"), "a mismatched provider is rejected, the default kept")
  assert.match(warnings.join(" "), /not a github-copilot model/)
  assert.equal(config.chains.mine.length, 1)
})

test("ChatGPT: usage_limit_reached is a window with its exact reset", () => {
  const resetsAt = Math.floor(NOW / 1000) + 3600
  const body = JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_at: resetsAt } })
  const s = classify("openai", "gpt-6.1-sol", { type: "provider.chatgpt-limit", message: "limit", status: 429, response: { body } }, NOW)
  assert.equal(s?.kind, "window")
  assert.equal(s?.resetAt, resetsAt * 1000)
  assert.match(s?.evidence ?? "", /ChatGPT plus/)
  const rel = classify("openai", "gpt-6.1-sol", { type: "provider.rate-limit", message: "", status: 429, response: { body: JSON.stringify({ error: { code: "usage_limit_reached", resets_in_seconds: 600 } }) } }, NOW)
  assert.equal(rel?.resetAt, NOW + 600_000)
})

test("ChatGPT: x-codex headers give both windows", () => {
  const h = new Headers({
    "x-codex-primary-used-percent": "42.5",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-after-seconds": "1200",
    "x-codex-secondary-used-percent": "91",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(Math.floor(NOW / 1000) + 86400),
  })
  const w = codexWindows(h, NOW)
  assert.deepEqual(w.map((x) => [x.label, x.usedPct]), [["5-hour", 42.5], ["weekly", 91]])
  assert.equal(w[0].resetAt, NOW + 1_200_000)
  assert.equal(w[1].resetAt, NOW + 86_400_000)
  assert.deepEqual(codexWindows(new Headers({ "x-ratelimit-remaining-requests": "5" }), NOW), [])
})
