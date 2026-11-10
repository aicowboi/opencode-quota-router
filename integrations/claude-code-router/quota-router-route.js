// quota-router for Claude Code Router: a Node.js script routing rule (experimental).
//
// Starts each request on the first model in your chain whose provider has room, according to the quota-router
// plugin running in OpenCode on this machine, and hands CCR the rest of the chain as its fallback targets. Providers
// that quota-router knows are limited (a used-up plan window, a spend cap, a provider saved for later) go to the end
// of the chain rather than being dropped, so CCR's own failover can still reach them.
//
// CCR runs this file as the body of an async function with `input` (the request) and `api` (fetch, fs, env). See
// integrations/claude-code-router/README.md for setup. It only talks to 127.0.0.1 and reads one config file.
// MIT licence, part of https://github.com/aicowboi/opencode-quota-router.

const configPath = api.env("QUOTA_ROUTER_CCR_CONFIG") || "~/.config/quota-router/ccr.json"

if (!(await api.fs.exists(configPath))) return null
const config = await api.fs.readJson(configPath)
if (!config || typeof config !== "object" || !Array.isArray(config.routes)) throw new Error(`quota-router: ${configPath} needs a "routes" list`)

// The first route whose `match` the requested model starts with ("*" matches every request).
const requested = typeof input.model === "string" ? input.model : ""
const route = config.routes.find((r) => r && typeof r.match === "string" && (r.match === "*" || requested.startsWith(r.match)))
if (!route) return null
if (!Array.isArray(route.chain) || route.chain.length === 0) throw new Error(`quota-router: route "${route.match}" needs a non-empty "chain"`)
const chain = route.chain.map((entry, i) => {
  const model = typeof entry === "string" ? entry : entry && entry.model
  if (typeof model !== "string" || !model.includes("/")) throw new Error(`quota-router: chain entry ${i + 1} of route "${route.match}" should be a CCR model such as "Provider/model"`)
  // The quota-router provider ID: given, or the CCR provider name in lower case ("Anthropic/..." is "anthropic").
  const provider = entry && typeof entry.provider === "string" ? entry.provider : model.split("/")[0].toLowerCase()
  return { model, provider, at: i }
})

// What the plugin knows: each provider's state, from its local dashboard. It takes the next free port when its own
// is taken, so the next few are tried when the first refuses.
const port = Number.isInteger(config.port) ? config.port : 47321
let known = null
for (let p = port; p < port + 5 && !known; p++) {
  try {
    const r = await api.fetch(`http://127.0.0.1:${p}/api/menubar`)
    if (!r.ok) continue
    const body = JSON.parse(r.body)
    if (body && Array.isArray(body.providers) && typeof body.now === "number") known = body
  } catch {
    // Nothing listening there: try the next port.
  }
}

// Without the plugin, the chain is used as configured.
const now = known ? known.now : 0
const state = new Map((known ? known.providers : []).map((p) => [p.id, p]))
const limitedUntil = (provider) => {
  if (!known || known.paused) return undefined
  const p = state.get(provider)
  if (!p) return undefined
  if (typeof p.saved === "number" && p.saved > now) return p.saved
  if ((p.status === "cooling" || p.status === "blocked") && typeof p.until === "number" && p.until > now) return p.until
  return undefined
}

// Usable first, in chain order; then the limited ones, the soonest back first.
const marked = chain.map((c) => ({ ...c, until: limitedUntil(c.provider) }))
const usable = marked.filter((c) => c.until === undefined)
const limited = marked.filter((c) => c.until !== undefined).sort((a, b) => a.until - b.until || a.at - b.at)
const ordered = [...usable, ...limited]

return {
  model: ordered[0].model,
  fallback: { mode: "model-chain", models: ordered.slice(1).map((c) => c.model), retryCount: 0 },
}
