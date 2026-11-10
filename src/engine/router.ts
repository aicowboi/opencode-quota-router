// Picks the model a session should use. Pure: everything it needs is passed in.
import type { Config } from "./config.ts"
import { refKey } from "./config.ts"
import { modelPools } from "./classify.ts"
import type { Gate } from "./policy.ts"
import type { PoolStore } from "./pools.ts"
import type { ModelInfo, ModelRef } from "./types.ts"

export const EFFORT = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

export type Preferred = { chain: string; index: number; variant?: string }

export type RouteResult =
  | { target: ModelRef; index: number; usable: "yes" | "trial"; skipped: string[] }
  | { target: undefined; earliest?: number; next?: ModelRef; skipped: string[] }

/** Chain entries ordered by provider priority. A stable sort keeps the configured order within a provider. */
export function orderedChain(config: Config, name: string): ModelRef[] {
  const chain = config.chains[name] ?? []
  const rank = (ref: ModelRef) => config.providers[ref.providerID]?.priority ?? 99
  return chain.map((ref, i) => ({ ref, i })).sort((a, b) => rank(a.ref) - rank(b.ref) || a.i - b.i).map((x) => x.ref)
}

/** The chain and position a model belongs to. Variants are ignored when matching. */
export function findInChains(config: Config, model: { providerID: string; id: string }): { chain: string; index: number } | undefined {
  for (const name of Object.keys(config.chains)) {
    const index = orderedChain(config, name).findIndex((r) => r.providerID === model.providerID && r.id === model.id)
    if (index !== -1) return { chain: name, index }
  }
  return undefined
}

/**
 * Effort carries across providers as an offset from each chain entry's configured effort.
 * Opus at `high` (one above its `medium` baseline) maps to Grok at `xhigh` (one above `high`).
 */
export function mapVariant(entry: ModelRef, baseline: ModelRef | undefined, wanted: string | undefined, supported: string[]): string | undefined {
  if (supported.length === 0) return undefined
  let target = entry.variant
  if (wanted && wanted !== "default" && baseline?.variant) {
    const delta = EFFORT.indexOf(wanted) - EFFORT.indexOf(baseline.variant)
    const base = EFFORT.indexOf(entry.variant ?? baseline.variant)
    if (EFFORT.includes(wanted) && base !== -1) target = EFFORT[Math.max(0, Math.min(EFFORT.length - 1, base + delta))]
  }
  if (!target) return undefined
  if (supported.includes(target)) return target
  const want = EFFORT.indexOf(target)
  if (want === -1) return undefined
  // Nearest supported effort, preferring the higher one on ties.
  let best: string | undefined
  let bestDistance = Infinity
  for (const v of supported) {
    const i = EFFORT.indexOf(v)
    if (i === -1) continue
    const d = Math.abs(i - want) - (i > want ? 0.1 : 0)
    if (d < bestDistance) {
      best = v
      bestDistance = d
    }
  }
  return best
}

export function route(input: {
  config: Config
  pools: PoolStore
  models: Map<string, ModelInfo>
  preferred: Preferred
  lastInputTokens?: number
  mode: "turn" | "failover"
  /** Pools that just failed this request; never pick a model drawing from them. */
  exclude?: Set<string>
  /** Policies that pass over an entry for reasons other than pool health (spend caps, schedules, project rules). */
  gate?: Gate
}): RouteResult {
  const { config, pools, models, preferred } = input
  const chain = orderedChain(config, preferred.chain)
  // The model the user picked sets the chain and the effort level; priority order always decides the provider.
  const baseline = chain[preferred.index]
  const order = [...chain.keys()]
  const skipped: string[] = []
  let trial: { target: ModelRef; index: number } | undefined
  let next: { target: ModelRef; at: number } | undefined

  for (const index of order) {
    const entry = chain[index]
    const label = refKey(entry)
    const provider = config.providers[entry.providerID]
    if (provider?.allow === "never") {
      skipped.push(`${label}: disabled`)
      continue
    }
    const info = models.get(label)
    if (!info) {
      skipped.push(`${label}: not connected`)
      continue
    }
    const entryPools = modelPools(entry.providerID, entry.id)
    if (entryPools.some((p) => input.exclude?.has(p))) {
      skipped.push(`${label}: just failed`)
      continue
    }
    if (input.lastInputTokens && info.context && info.context < input.lastInputTokens * config.contextFit.safetyFactor) {
      skipped.push(`${label}: context ${info.context} too small`)
      continue
    }
    const variant = mapVariant(entry, baseline, preferred.variant, info.variants)
    const target: ModelRef = { providerID: entry.providerID, id: entry.id, ...(variant ? { variant } : {}) }
    const block = input.gate?.(entry)
    if (block) {
      skipped.push(`${label}: ${block.reason}`)
      if (block.until && (!next || block.until < next.at)) next = { target, at: block.until }
      continue
    }
    const states = entryPools.map((p) => pools.usable(p))
    const usable = states.includes("no") ? "no" : states.includes("trial") ? "trial" : "yes"
    if (usable === "no") {
      skipped.push(`${label}: ${entryPools.map((p) => pools.get(p).evidence).filter(Boolean).join(", ") || "cooling"}`)
      // An entry is usable once all of its pools are, so its own deadline is the latest of them.
      const at = Math.max(...entryPools.map((p) => pools.get(p).until ?? 0))
      if (at > 0 && (!next || at < next.at)) next = { target, at }
      continue
    }
    if (usable === "yes" || input.mode === "turn") return { target, index, usable, skipped }
    trial ??= { target, index }
  }
  if (trial) return { ...trial, usable: "trial", skipped }
  return { target: undefined, earliest: next?.at, next: next?.target, skipped }
}
