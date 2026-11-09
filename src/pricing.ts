// Cost estimates. `equivalent` is what the tokens would cost at API list price, so subscription use can be
// compared with pay-per-use. `actual` is real marginal spend: only metered providers cost money per token.
import type { Config } from "./config.ts"
import type { CostTier, ModelInfo, Tokens } from "./types.ts"

const CLAUDE_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-1",
}

/** API models whose price stands in for a subscription model that has none in the catalogue. */
export function priceSources(providerID: string, modelID: string): string[] {
  const own = `${providerID}/${modelID}`
  if (providerID === "claude-agent") return [own, `anthropic/${CLAUDE_ALIASES[modelID] ?? modelID}`]
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
  for (const key of priceSources(providerID, modelID)) {
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
