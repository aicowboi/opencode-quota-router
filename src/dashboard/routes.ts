// Previews use the same ordering as the router, rather than guessing in the browser where a new entry will land.
import { refKey, refLabel, type Config } from "../engine/config.ts"
import { withAdditions, withReplacements, type ChainUpdate, type Suggestion } from "../engine/discovery.ts"
import { INTELLIGENT_CHAIN } from "../engine/intelligent.ts"
import { orderedChain } from "../engine/router.ts"
import type { ModelInfo, ModelRef } from "../engine/types.ts"

export function routeGuidance(config: Config, models: Map<string, ModelInfo>, suggestions: Suggestion[], updates: ChainUpdate[]) {
  const describe = (ref: ModelRef) => ({
    ref: refLabel(ref), providerID: ref.providerID, name: models.get(refKey(ref))?.name ?? ref.id,
    kind: config.providers[ref.providerID]?.kind ?? "metered", connected: models.has(refKey(ref)),
  })
  const preview = (c: Config, chain: string) => orderedChain(c, chain).map(describe)
  return Object.keys(config.chains).map((chain) => ({
    chain, intelligent: chain === INTELLIGENT_CHAIN, entries: preview(config, chain),
    suggestions: suggestions.filter((s) => s.chain === chain).map((s) => ({ ...s, after: preview(withAdditions(config, { [chain]: [s.ref] }), chain) })),
    updates: updates.filter((u) => u.chain === chain).map((u) => ({ ...u, after: u.to ? preview(withReplacements(config, { [chain]: { [u.ref.replace(/#.*$/, "")]: u.to } }), chain) : undefined })),
  }))
}
