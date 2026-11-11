// Cost estimates. `equivalent` is what the tokens would cost at API list price, so subscription use can be
// compared with pay-per-use. `actual` is real marginal spend: only metered providers cost money per token.
import type { Config } from "./config.ts"
import type { CostTier, ModelInfo, Tokens } from "./types.ts"

/** Where Claude Code's model aliases pointed when this was written; used when the model list has no release dates. */
const CLAUDE_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-2",
}

const priced = (m: ModelInfo) => m.cost?.some((t) => t.input > 0 || t.output > 0) ?? false

/**
 * The Anthropic model a Claude Code alias (`opus`, `fable`) stands for: the newest of that family with a list price,
 * by release date. Variants such as `-fast` are never picked, since the alias doesn't mean them.
 */
export function aliasTarget(alias: string, models?: Map<string, ModelInfo>): string | undefined {
  if (!Object.hasOwn(CLAUDE_ALIASES, alias)) return undefined
  const line = new RegExp(`^claude-${alias}-\\d+(?:-\\d+)*$`)
  let best: ModelInfo | undefined
  for (const m of models?.values() ?? []) {
    if (m.providerID !== "anthropic" || m.released === undefined || !line.test(m.id) || !priced(m)) continue
    // Of two with the same date (claude-opus-4-5 and claude-opus-4-5-20251101), the shorter name.
    if (!best || m.released > best.released! || (m.released === best.released && m.id.length < best.id.length)) best = m
  }
  return best?.id ?? CLAUDE_ALIASES[alias]
}

/** API models whose price stands in for a subscription model that has none in the catalogue. */
export function priceSources(providerID: string, modelID: string, models?: Map<string, ModelInfo>): string[] {
  const own = `${providerID}/${modelID}`
  if (providerID === "claude-agent") return [own, `anthropic/${aliasTarget(modelID, models) ?? modelID}`]
  if (providerID === "github-copilot") {
    if (modelID.startsWith("claude-")) return [`anthropic/${modelID.replaceAll(".", "-")}`, own]
    if (modelID.startsWith("grok-")) return [`xai/${modelID}`, own]
    if (modelID.startsWith("gemini-")) return [`google/${modelID}`, own]
    return [`openai/${modelID}`, own]
  }
  return [own]
}

/** Shares of a million tokens. They sum to 1. Output and reasoning are both charged as output. */
export type TokenMix = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

/**
 * A cached coding session, used only when nothing has been recorded yet. Cache is most of it, so a provider with an
 * expensive cache read does not look cheap just because its output price is low.
 */
export const TYPICAL_MIX: TokenMix = { input: 0.02, output: 0.015, reasoning: 0.005, cacheRead: 0.93, cacheWrite: 0.03 }

/** Below this, one odd request would decide the rate. The list price of the shared mix is used instead. */
export const MODEL_RATE_TOKENS = 50_000

/** Below this, recorded use is too thin to be "your mix", and the typical mix stands in. */
export const RECORDED_MIX_TOKENS = 100_000

/** A small sample, so a context-sized price tier (100k and up) is not applied to the rate itself. */
const RATE_SAMPLE = 1_000

/** Dollars per million tokens at this mix, on the base tier. Undefined when the model has no positive price. */
export function perMillionAt(tiers: CostTier[] | undefined, mix: TokenMix): number | undefined {
  if (!tiers?.some((t) => t.input > 0 || t.output > 0)) return undefined
  const cost = costOf(tiers, {
    input: mix.input * RATE_SAMPLE,
    output: mix.output * RATE_SAMPLE,
    reasoning: mix.reasoning * RATE_SAMPLE,
    cache: { read: mix.cacheRead * RATE_SAMPLE, write: mix.cacheWrite * RATE_SAMPLE },
  })
  return (cost * 1_000_000) / RATE_SAMPLE
}

/** The provider's own list price, or the API model a subscription model stands in for. */
export function listedPrice(models: Map<string, ModelInfo>, providerID: string, modelID: string): { tiers: CostTier[]; source?: string } | undefined {
  for (const key of priceSources(providerID, modelID, models)) {
    const tiers = models.get(key)?.cost
    if (tiers?.some((t) => t.input > 0 || t.output > 0)) return { tiers, source: key === `${providerID}/${modelID}` ? undefined : key }
  }
  return undefined
}

/**
 * The first long-context tier, when a prompt past it costs at least a quarter more at this mix. The headline rate
 * stays on the base tier, so providers are compared on the same footing; the caller says when a long prompt costs more.
 */
export function longContextRate(tiers: CostTier[], mix: TokenMix): { tokens: number; perMillion: number } | undefined {
  const base = perMillionAt(tiers, mix)
  const tier = tiers.filter((t) => t.tier?.type === "context" && t.tier.size > 0).sort((a, b) => a.tier!.size - b.tier!.size)[0]
  if (!base || !tier) return undefined
  const higher = perMillionAt([tier], mix)
  if (higher === undefined || higher < base * 1.25) return undefined
  return { tokens: tier.tier!.size, perMillion: higher }
}

export function costOf(tiers: CostTier[] | undefined, tokens: Tokens): number {
  if (!tiers || tiers.length === 0) return 0
  const context = tokens.input + tokens.cache.read + tokens.cache.write
  const tier =
    tiers
      .filter((t) => t.tier?.type === "context" && context > t.tier.size)
      .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ?? tiers.find((t) => !t.tier) ?? tiers[0]
  return (
    (tokens.input * tier.input +
      (tokens.output + tokens.reasoning) * tier.output +
      tokens.cache.read * (tier.cache?.read ?? 0) +
      tokens.cache.write * (tier.cache?.write ?? 0)) /
    1e6
  )
}

export function estimate(config: Config, models: Map<string, ModelInfo>, providerID: string, modelID: string, tokens: Tokens, reported: number) {
  let equivalent = 0
  for (const key of priceSources(providerID, modelID, models)) {
    const tiers = models.get(key)?.cost
    if (tiers && tiers.length > 0 && tiers.some((t) => t.input > 0 || t.output > 0)) {
      equivalent = costOf(tiers, tokens)
      break
    }
  }
  if (equivalent === 0 && reported > 0) equivalent = reported
  const metered = (config.providers[providerID]?.kind ?? "metered") === "metered" && !["claude-agent", "github-copilot"].includes(providerID)
  return { equivalent, actual: metered ? (reported > 0 ? reported : equivalent) : 0 }
}
