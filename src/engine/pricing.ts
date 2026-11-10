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
