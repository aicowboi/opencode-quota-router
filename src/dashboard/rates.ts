// One comparable figure per provider and per routed model: dollars per million tokens.
// Pay-per-use uses what was charged, when enough of it was recorded. Everything else uses the API list price of one
// shared mix, so a cache-heavy session is not compared on sticker output prices. A subscription is never billed that
// amount; the figure is there so the route can be compared.
import type { Config } from "../engine/config.ts"
import { listedPrice, longContextRate, MODEL_RATE_TOKENS, perMillionAt, RECORDED_MIX_TOKENS, TYPICAL_MIX, type TokenMix } from "../engine/pricing.ts"
import type { ModelInfo, ProviderKind } from "../engine/types.ts"
import type { ModelSpend } from "./queries.ts"

export type TokenRate = {
  /** Dollars per million tokens. The low end, when `high` is set. */
  perMillion: number
  /** Set only for an estimate that spans several models, so the ladder can show a range. */
  high?: number
  /** actual: charged. api: list price, or the API model a subscription model stands in for. free: local. */
  basis: "actual" | "api" | "free"
  /** True when this model has not been used enough, so the figure is the list price of the shared mix. */
  estimate: boolean
  note: string
}

export type RateMap = { models: Record<string, TokenRate>; providers: Record<string, TokenRate> }

type Window = "30d" | "all" | "typical"

const money = (n: number) => {
  const digits = n >= 0.1 ? 2 : 3
  return `$${n.toFixed(digits)}`
}
const thousands = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const period = (window: Window) => (window === "30d" ? "the last 30 days" : "all recorded use")

function mixOf(rows: ModelSpend[]): TokenMix | undefined {
  const totals = rows.reduce(
    (s, r) => ({ input: s.input + r.input, output: s.output + r.output, reasoning: s.reasoning + r.reasoning, cacheRead: s.cacheRead + r.cacheRead, cacheWrite: s.cacheWrite + r.cacheWrite }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  )
  const total = totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite
  if (total < RECORDED_MIX_TOKENS) return undefined
  return {
    input: totals.input / total,
    output: totals.output / total,
    reasoning: totals.reasoning / total,
    cacheRead: totals.cacheRead / total,
    cacheWrite: totals.cacheWrite / total,
  }
}

/** Charged amount when it covers the requests; otherwise the API-price value of the same tokens. */
function realized(kind: ProviderKind, rows: ModelSpend[]): { perMillion: number; basis: "actual" | "api" } | undefined {
  const tokens = rows.reduce((s, r) => s + r.tokens, 0)
  if (tokens < MODEL_RATE_TOKENS) return undefined
  const actual = rows.reduce((s, r) => s + r.actual, 0)
  const equiv = rows.reduce((s, r) => s + r.equiv, 0)
  // A few requests reporting a cost, and the rest reporting none, would make the provider look cheaper than it is.
  if (kind === "metered" && actual > 0 && (equiv <= 0 || actual >= equiv * 0.5)) return { perMillion: (actual / tokens) * 1e6, basis: "actual" }
  if (equiv > 0) return { perMillion: (equiv / tokens) * 1e6, basis: "api" }
  return undefined
}

function sourcePhrase(models: Map<string, ModelInfo>, source: string): string {
  const providerID = source.slice(0, source.indexOf("/"))
  const name = models.get(source)?.name ?? source.slice(source.indexOf("/") + 1)
  const where = providerID === "anthropic" ? "the Anthropic API" : providerID === "openai" ? "the OpenAI API" : providerID === "xai" ? "the xAI API" : providerID === "google" ? "the Gemini API" : providerID
  return `${name} (${where})`
}

function note(opts: { kind: ProviderKind; basis: TokenRate["basis"]; estimate: boolean; window: Window; source?: string; models: Map<string, ModelInfo>; above?: { tokens: number; perMillion: number }; split?: string; grouped?: boolean }): string {
  if (opts.basis === "free") return "Runs on this machine, at no cost per token."
  const parts: string[] = []
  if (opts.basis === "actual") parts.push(`What this provider charged for the tokens recorded here over ${period(opts.window)}.`)
  else if (!opts.estimate) parts.push(`API price of the tokens recorded here over ${period(opts.window)}.`)
  else if (opts.window === "typical") parts.push("API price of a typical cached session. Nothing recorded yet to take the mix from, so this is an estimate.")
  else if (opts.grouped) parts.push(`API price of your recorded mix, across the models routed here. Not enough use over ${period(opts.window)} for a recorded rate, so this is an estimate.`)
  else parts.push(`API price of your recorded mix. Not enough use of this model over ${period(opts.window)}, so this is an estimate.`)
  if (opts.kind === "subscription") parts.push("The subscription is not billed per token.")
  if (opts.source) parts.push(`Priced as ${sourcePhrase(opts.models, opts.source)}.`)
  if (opts.above) parts.push(`Above ${thousands(opts.above.tokens)} tokens of context, about ${money(opts.above.perMillion)} / 1M at this mix.`)
  if (opts.split) parts.push(opts.split)
  return parts.join(" ")
}

function modelName(models: Map<string, ModelInfo>, providerID: string, modelID: string): string {
  return models.get(`${providerID}/${modelID}`)?.name ?? modelID
}

/**
 * Rates for the models a route can send to, and one per provider for the ladder. `recent` is the last 30 days;
 * `all` is everything recorded. The last 30 days win once there is enough of them to be a mix.
 */
export function buildRates(input: { config: Config; models: Map<string, ModelInfo>; recent: ModelSpend[]; all: ModelSpend[]; refs: Array<{ providerID: string; id: string }>; providerIDs: string[] }): RateMap {
  const recentTokens = input.recent.reduce((s, r) => s + r.tokens, 0)
  const rows = recentTokens >= RECORDED_MIX_TOKENS ? input.recent : input.all
  const window: Window = recentTokens >= RECORDED_MIX_TOKENS ? "30d" : rows.reduce((s, r) => s + r.tokens, 0) >= RECORDED_MIX_TOKENS ? "all" : "typical"
  const mix = mixOf(rows) ?? TYPICAL_MIX
  const kindOf = (id: string): ProviderKind => input.config.providers[id]?.kind ?? "metered"
  const of = (providerID: string, modelID: string) => rows.filter((r) => r.provider === providerID && r.model === modelID)

  const quote = (providerID: string, modelID: string, kind: ProviderKind): TokenRate | undefined => {
    if (kind === "local") return { perMillion: 0, basis: "free", estimate: false, note: note({ kind, basis: "free", estimate: false, window, models: input.models }) }
    const listed = listedPrice(input.models, providerID, modelID)
    const perMillion = listed ? perMillionAt(listed.tiers, mix) : undefined
    if (!listed || !(perMillion && perMillion > 0)) return undefined
    const above = longContextRate(listed.tiers, mix)
    return { perMillion, basis: "api", estimate: true, note: note({ kind, basis: "api", estimate: true, window, source: listed.source, models: input.models, above }) }
  }

  const forModel = (providerID: string, modelID: string): TokenRate | undefined => {
    const kind = kindOf(providerID)
    if (kind === "local") return quote(providerID, modelID, kind)
    const spent = realized(kind, of(providerID, modelID))
    if (spent) {
      const listed = listedPrice(input.models, providerID, modelID)
      // Recorded use already includes whatever long prompts cost. The higher-tier warning is only for an estimate.
      return { perMillion: spent.perMillion, basis: spent.basis, estimate: false, note: note({ kind, basis: spent.basis, estimate: false, window, source: spent.basis === "api" ? listed?.source : undefined, models: input.models }) }
    }
    return quote(providerID, modelID, kind)
  }

  const models: Record<string, TokenRate> = {}
  const seen = new Set<string>()
  for (const ref of input.refs) {
    const key = `${ref.providerID}/${ref.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const rate = forModel(ref.providerID, ref.id)
    if (rate) models[key] = rate
  }

  const providers: Record<string, TokenRate> = {}
  for (const id of input.providerIDs) {
    const kind = kindOf(id)
    if (kind === "local") {
      providers[id] = { perMillion: 0, basis: "free", estimate: false, note: note({ kind, basis: "free", estimate: false, window, models: input.models }) }
      continue
    }
    const own = rows.filter((r) => r.provider === id)
    const spent = realized(kind, own)
    const routed = input.refs.filter((r) => r.providerID === id)
    const parts = [...new Set(spent ? own.filter((r) => r.tokens >= MODEL_RATE_TOKENS).map((r) => r.model) : routed.map((r) => r.id))].flatMap((modelID) => {
      const rate = forModel(id, modelID)
      return rate && rate.basis !== "free" ? [{ name: modelName(input.models, id, modelID), perMillion: rate.perMillion }] : []
    })
    const split = parts.length > 1 && Math.max(...parts.map((p) => p.perMillion)) > Math.min(...parts.map((p) => p.perMillion)) * 1.15 ? `By model: ${parts.sort((a, b) => b.perMillion - a.perMillion).slice(0, 4).map((p) => `${p.name} ${money(p.perMillion)}`).join(", ")}.` : undefined
    if (spent) {
      providers[id] = { perMillion: spent.perMillion, basis: spent.basis, estimate: false, note: note({ kind, basis: spent.basis, estimate: false, window, models: input.models, split }) }
      continue
    }
    const estimates = routed.flatMap((r) => {
      const rate = models[`${r.providerID}/${r.id}`]
      return rate && rate.estimate ? [rate] : []
    })
    if (estimates.length === 0) continue
    const low = Math.min(...estimates.map((r) => r.perMillion))
    const high = Math.max(...estimates.map((r) => r.perMillion))
    const sample = estimates.find((r) => r.perMillion === low) ?? estimates[0]!
    providers[id] = { perMillion: low, ...(high > low * 1.15 ? { high } : {}), basis: "api", estimate: true, note: split ? note({ kind, basis: "api", estimate: true, window, models: input.models, split, grouped: true }) : sample.note }
  }
  return { models, providers }
}
