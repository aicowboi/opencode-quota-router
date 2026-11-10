// The Claude Code Router script rule, run the way CCR runs it: as an async function body with `input` and `api`.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const SOURCE = fs.readFileSync(new URL("../integrations/claude-code-router/quota-router-route.js", import.meta.url), "utf8")
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
export const runRule = (input: unknown, api: unknown) => new AsyncFunction("input", "api", SOURCE)(input, api)

const NOW = Date.parse("2026-11-09T19:00:00Z")
const HOUR = 3_600_000
const CONFIG = {
  routes: [
    {
      match: "claude-opus",
      chain: [{ model: "Claude/claude-opus-5-5", provider: "claude-agent" }, "Copilot/claude-opus-5.5", { model: "Grok/grok-4.7", provider: "xai" }, "Anthropic/claude-opus-5-5"],
    },
    { match: "*", chain: ["Copilot/gpt-5.6"] },
  ],
}

/** A fake `api`: one config file, and a dashboard that answers on `port` with `providers`. */
function fakeApi(opts: { config?: unknown; port?: number; providers?: unknown[]; paused?: boolean; down?: boolean; env?: Record<string, string> }) {
  const asked: string[] = []
  const file = opts.env?.QUOTA_ROUTER_CCR_CONFIG ?? "~/.config/quota-router/ccr.json"
  return {
    asked,
    api: {
      env: (name: string) => opts.env?.[name],
      fs: {
        exists: async (p: string) => p === file && opts.config !== undefined,
        readJson: async (p: string) => (p === file ? structuredClone(opts.config) : undefined),
      },
      fetch: async (url: string) => {
        asked.push(url)
        if (opts.down || !url.startsWith(`http://127.0.0.1:${opts.port ?? 47321}/`)) throw new Error("connect ECONNREFUSED")
        return { ok: true, status: 200, body: JSON.stringify({ now: NOW, paused: opts.paused ?? false, providers: opts.providers ?? [] }) }
      },
    },
  }
}

const opus = { model: "claude-opus-5-5", body: { model: "claude-opus-5-5" } }

test("CCR rule: starts on the first provider with room and passes the rest as fallback targets", async () => {
  const { api } = fakeApi({ config: CONFIG, providers: [{ id: "claude-agent", status: "available" }, { id: "github-copilot", status: "available" }] })
  assert.deepEqual(await runRule(opus, api), {
    model: "Claude/claude-opus-5-5",
    fallback: { mode: "model-chain", models: ["Copilot/claude-opus-5.5", "Grok/grok-4.7", "Anthropic/claude-opus-5-5"], retryCount: 0 },
  })
})

test("CCR rule: limited and saved providers go last, the soonest back first", async () => {
  const { api, asked } = fakeApi({
    config: CONFIG,
    port: 47322,
    providers: [
      { id: "claude-agent", status: "cooling", until: NOW + 2 * HOUR },
      { id: "copilot", status: "blocked", until: NOW + 5 * HOUR },
      { id: "xai", status: "available", saved: NOW + HOUR },
      { id: "anthropic", status: "degraded" },
    ],
  })
  const r = await runRule(opus, api)
  assert.equal(r.model, "Anthropic/claude-opus-5-5")
  assert.deepEqual(r.fallback.models, ["Grok/grok-4.7", "Claude/claude-opus-5-5", "Copilot/claude-opus-5.5"])
  // The dashboard was on the next port: the first refused, the second answered.
  assert.deepEqual(asked, ["http://127.0.0.1:47321/api/menubar", "http://127.0.0.1:47322/api/menubar"])
})

test("CCR rule: without the plugin, or while routing is paused, the chain is used as configured", async () => {
  for (const opts of [{ down: true }, { paused: true, providers: [{ id: "claude-agent", status: "cooling", until: NOW + HOUR }] }]) {
    const { api } = fakeApi({ config: CONFIG, ...opts })
    const r = await runRule(opus, api)
    assert.equal(r.model, "Claude/claude-opus-5-5")
    assert.deepEqual(r.fallback.models, ["Copilot/claude-opus-5.5", "Grok/grok-4.7", "Anthropic/claude-opus-5-5"])
  }
  // A limit that has already passed counts as room.
  const { api } = fakeApi({ config: CONFIG, providers: [{ id: "claude-agent", status: "cooling", until: NOW - 1 }] })
  assert.equal((await runRule(opus, api)).model, "Claude/claude-opus-5-5")
})

test("CCR rule: routes match by model prefix, and no config or no matching route leaves the request to later rules", async () => {
  assert.equal((await runRule({ model: "gpt-5.6", body: {} }, fakeApi({ config: CONFIG }).api)).model, "Copilot/gpt-5.6")
  assert.equal(await runRule(opus, fakeApi({}).api), null)
  assert.equal(await runRule(opus, fakeApi({ config: { routes: [{ match: "gemini", chain: ["G/gemini-3-pro"] }] } }).api), null)
  // The config file can be put elsewhere.
  const env = { QUOTA_ROUTER_CCR_CONFIG: "/etc/ccr/quota.json" }
  assert.equal((await runRule(opus, fakeApi({ config: CONFIG, env }).api)).model, "Claude/claude-opus-5-5")
})

test("CCR rule: a broken config is an error CCR records, not a silent misroute", async () => {
  await assert.rejects(runRule(opus, fakeApi({ config: { chains: [] } }).api), /needs a "routes" list/)
  await assert.rejects(runRule(opus, fakeApi({ config: { routes: [{ match: "*", chain: [] }] } }).api), /non-empty "chain"/)
  await assert.rejects(runRule(opus, fakeApi({ config: { routes: [{ match: "*", chain: ["no-slash"] }] } }).api), /should be a CCR model/)
})
