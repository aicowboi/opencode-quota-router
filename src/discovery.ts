// Every connected provider, classified and ranked, plus suggested chain entries for providers not yet in a chain.
// Pure: the caller supplies the connections and model catalogue.
import { parseRef, refKey, refLabel, type Config, type ProviderConfig } from "./config.ts"
import { priceSources } from "./pricing.ts"
import { orderedChain } from "./router.ts"
import type { ModelInfo, ModelRef, ProviderKind } from "./types.ts"

/** How a provider is connected: OpenCode's credential method, or `env` for a key from the environment. */
export type ConnectionMethod = "key" | "oauth" | "external" | "env"

/** Runs on this machine: free and never rate-limited by anyone else. */
const LOCAL = new Set(["ollama", "lmstudio", "vllm", "llama.cpp", "llamacpp", "localai", "jan"])
/** Flat-rate plans whatever the sign-in method. */
const SUBSCRIPTION = new Set(["claude-agent", "github-copilot", "ollama-cloud", "opencode-go"])
const KIND_ORDER: ProviderKind[] = ["subscription", "metered", "local"]

export function kindOf(providerID: string, method?: ConnectionMethod): ProviderKind {
  if (LOCAL.has(providerID)) return "local"
  if (SUBSCRIPTION.has(providerID)) return "subscription"
  // Signing in rather than pasting a key means a plan: ChatGPT for openai, SuperGrok for xai.
  if (method === "oauth") return "subscription"
  return "metered"
}

/**
 * Apply what the connections say. Providers the user configured keep their settings (and their kind, if they set
 * one). The rest take the kind their connection implies, and any whose kind changed or that only discovery knows
 * about are ranked by kind: after the configured subscriptions, then after the metered ones, local last.
 */
export function applyDiscovery(config: Config, connected: Map<string, ConnectionMethod | undefined>): Config {
  const explicit = new Set(config.explicitProviders)
  const fixed: Record<string, ProviderConfig> = {}
  const auto: Array<[string, ProviderConfig]> = []
  for (const [id, p] of Object.entries(config.providers)) {
    // Only reclassify when the sign-in method is known.
    const method = connected.get(id)
    const kind = method !== undefined && !p.kindFromUser ? kindOf(id, method) : p.kind
    if (kind === p.kind || explicit.has(id)) fixed[id] = { ...p, kind }
    else auto.push([id, { ...p, kind, discovered: true }])
  }
  if (config.discovery.enabled)
    for (const [id, method] of connected)
      if (!config.providers[id]) auto.push([id, { priority: 0, kind: kindOf(id, method), allow: "always", windowCooldownMs: 15 * 60_000, discovered: true }])

  const providers = { ...fixed }
  let floor = 0
  for (const kind of KIND_ORDER) {
    for (const p of Object.values(fixed)) if (KIND_ORDER.indexOf(p.kind) <= KIND_ORDER.indexOf(kind)) floor = Math.max(floor, p.priority)
    if (kind === "local") floor = Math.max(floor, ...Object.values(providers).map((p) => p.priority))
    const mine = auto.filter(([, p]) => p.kind === kind).sort((a, b) => a[0].localeCompare(b[0]))
    mine.forEach(([id, p], i) => (providers[id] = { ...p, priority: Math.round((floor + (i + 1) / 100) * 100) / 100 }))
    if (mine.length) floor = providers[mine[mine.length - 1][0]].priority
  }
  return { ...config, providers }
}

/** Accepted suggestions, appended to their chains. Chains the user removed stay removed. */
export function withAdditions(config: Config, additions: Record<string, string[]>): Config {
  const chains = { ...config.chains }
  for (const [name, refs] of Object.entries(additions)) {
    const chain = chains[name]
    if (!chain) continue
    const next = [...chain]
    for (const text of refs) {
      let ref: ModelRef
      try {
        ref = parseRef(text)
      } catch {
        continue
      }
      if (!next.some((r) => r.providerID === ref.providerID && r.id === ref.id)) next.push(ref)
    }
    chains[name] = next
  }
  return { ...config, chains }
}

export type Suggestion = { chain: string; ref: string; providerID: string; kind: ProviderKind; name?: string; reason: string }

/** List price per million output tokens, falling back to the API model a subscription model stands in for. */
function outputPrice(models: Map<string, ModelInfo>, m: ModelInfo | undefined): number | undefined {
  if (!m) return undefined
  for (const key of priceSources(m.providerID, m.id)) {
    const tiers = models.get(key)?.cost
    const tier = tiers?.find((t) => !t.tier) ?? tiers?.[0]
    if (tier && tier.output > 0) return tier.output
  }
  return undefined
}

/** A model's family, or that of the API model it stands in for (Claude subscription aliases carry none). */
function familyOf(models: Map<string, ModelInfo>, m: ModelInfo): string | undefined {
  for (const key of [refKey(m), ...priceSources(m.providerID, m.id)]) if (models.get(key)?.family) return models.get(key)!.family
  return undefined
}

/**
 * For each chain, the closest model on every connected provider that has no entry in it yet: the newest model of a
 * family already in the chain, else the one nearest the chain's price level, else the newest tool-capable model.
 */
export function suggest(config: Config, models: Map<string, ModelInfo>, ignored: Set<string> = new Set()): Suggestion[] {
  const byProvider = new Map<string, ModelInfo[]>()
  for (const m of models.values()) {
    if (m.tools === false || m.status === "deprecated") continue
    if (config.providers[m.providerID]?.allow === "never") continue
    byProvider.set(m.providerID, [...(byProvider.get(m.providerID) ?? []), m])
  }
  const newest = (a: ModelInfo, b: ModelInfo) => (b.released ?? 0) - (a.released ?? 0) || (b.context ?? 0) - (a.context ?? 0) || a.id.localeCompare(b.id)
  const out: Suggestion[] = []
  for (const chain of Object.keys(config.chains)) {
    const entries = orderedChain(config, chain)
    const present = new Set(entries.map((e) => e.providerID))
    const infos = entries.map((e) => models.get(refKey(e))).filter((m): m is ModelInfo => !!m)
    // Earlier entries are closer to the chain's reference model, so their families rank first.
    const families = [...new Set(infos.map((m) => familyOf(models, m)).filter((f): f is string => !!f))]
    const reference = infos.find((m) => outputPrice(models, m) !== undefined)
    const target = outputPrice(models, reference)
    const effort = entries.find((e) => e.variant)?.variant
    for (const [providerID, list] of byProvider) {
      if (present.has(providerID)) continue
      const rank = (m: ModelInfo) => (m.family ? families.indexOf(m.family) : -1)
      let pick = list.filter((m) => rank(m) !== -1).sort((a, b) => rank(a) - rank(b) || newest(a, b))[0]
      let reason = pick ? `Same model family (${pick.family})` : ""
      if (!pick && target) {
        const priced = list.map((m) => ({ m, p: outputPrice(models, m) })).filter((x): x is { m: ModelInfo; p: number } => x.p !== undefined)
        const best = priced.sort((a, b) => Math.abs(Math.log(a.p / target)) - Math.abs(Math.log(b.p / target)) || newest(a.m, b.m))[0]
        if (best) {
          pick = best.m
          reason = `Closest price to ${reference!.name ?? reference!.id} ($${best.p} vs $${target} per million output tokens)`
        }
      }
      if (!pick) {
        pick = [...list].sort(newest)[0]
        reason = "Newest model with tool use; no price to compare"
      }
      if (!pick) continue
      const variant = effort && pick.variants.includes(effort) ? effort : pick.variants.includes("medium") ? "medium" : undefined
      const ref = refLabel({ providerID, id: pick.id, ...(variant ? { variant } : {}) })
      if (ignored.has(`${chain} ${refKey(pick)}`)) continue
      out.push({ chain, ref, providerID, kind: config.providers[providerID]?.kind ?? kindOf(providerID), name: pick.name, reason })
    }
  }
  return out
}
