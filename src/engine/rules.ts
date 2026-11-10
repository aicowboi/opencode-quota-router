// Project rules: which providers a project's sessions may be routed to, and which chain they use.
import type { Config } from "./config.ts"
import type { Gate } from "./policy.ts"
import type { ProviderKind } from "./types.ts"

export type Rules = {
  /** Providers never routed to. */
  deny: string[]
  /** When set, the only providers routed to. */
  allow?: string[]
  /** Kinds of provider never routed to: `subscription`, `metered` or `local`. */
  denyKinds: ProviderKind[]
  /** The chain the project's sessions use. Only honoured from the user's own settings, never from a file in the project. */
  chain?: string
  /** Where the rules came from, for messages. */
  source: string
}

const KINDS: ProviderKind[] = ["subscription", "metered", "local"]
const ids = (v: unknown): string[] | undefined => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 100))] : undefined)

/**
 * Read rules from parsed JSON. A file inside a project is not trusted: it may shut providers out, which can only
 * narrow where sessions go, but it may not choose a chain.
 */
export function parseRules(raw: unknown, source: string, trusted: boolean, chains: string[] = []): { rules?: Rules; warnings: string[] } {
  const warnings: string[] = []
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { warnings: [`${source}: should be an object; ignored`] }
  const o = raw as Record<string, unknown>
  for (const key of Object.keys(o)) if (!["deny", "allow", "denyKinds", "chain", "$schema"].includes(key)) warnings.push(`${source}: unknown key ${key}; ignored`)
  for (const key of ["deny", "allow", "denyKinds"]) if (o[key] !== undefined && !ids(o[key])) warnings.push(`${source}: ${key} should be a list of names; ignored`)
  const rules: Rules = { deny: ids(o.deny) ?? [], allow: ids(o.allow), denyKinds: (ids(o.denyKinds) ?? []).filter((k): k is ProviderKind => (KINDS as string[]).includes(k)), source }
  for (const k of ids(o.denyKinds) ?? []) if (!(KINDS as string[]).includes(k)) warnings.push(`${source}: denyKinds has no kind named ${k}; ignored`)
  if (o.chain !== undefined) {
    if (!trusted) warnings.push(`${source}: a file in a project cannot choose a chain; set it under "projects" in your own settings`)
    else if (typeof o.chain !== "string" || !chains.includes(o.chain)) warnings.push(`${source}: there is no chain named ${String(o.chain)}; ignored`)
    else rules.chain = o.chain
  }
  return { rules, warnings }
}

/** Several sets of rules as one: everything any of them shuts out stays out. */
export function combineRules(list: Array<Rules | undefined>): Rules | undefined {
  const all = list.filter((r): r is Rules => !!r)
  if (all.length === 0) return undefined
  const allows = all.filter((r) => r.allow).map((r) => r.allow!)
  return {
    deny: [...new Set(all.flatMap((r) => r.deny))],
    allow: allows.length ? allows.reduce((a, b) => a.filter((x) => b.includes(x))) : undefined,
    denyKinds: [...new Set(all.flatMap((r) => r.denyKinds))],
    chain: all.find((r) => r.chain)?.chain,
    // Named in the reason a provider is shut out, so only the sets that shut something out are named.
    source: (all.filter((r) => r.deny.length || r.denyKinds.length || r.allow).length ? all.filter((r) => r.deny.length || r.denyKinds.length || r.allow) : all).map((r) => r.source).join(" and "),
  }
}

/** Why a provider is shut out by the rules, if it is. */
export function ruledOut(config: Config, rules: Rules | undefined, providerID: string): string | undefined {
  if (!rules) return undefined
  const kind = config.providers[providerID]?.kind
  if (rules.deny.includes(providerID)) return `${providerID} is not allowed in this project (${rules.source})`
  if (kind && rules.denyKinds.includes(kind)) return `${kind} providers are not allowed in this project (${rules.source})`
  if (rules.allow && !rules.allow.includes(providerID)) return `only ${rules.allow.join(", ") || "nothing"} is allowed in this project (${rules.source})`
  return undefined
}

export function rulesGate(config: Config, rules: Rules | undefined): Gate | undefined {
  if (!rules || (rules.deny.length === 0 && rules.denyKinds.length === 0 && !rules.allow)) return undefined
  return (entry) => {
    const reason = ruledOut(config, rules, entry.providerID)
    return reason ? { reason } : undefined
  }
}

/** The entry of `projects` that covers a directory: the longest path that is the directory or one of its parents. */
export function matchProject<T>(projects: Record<string, T>, directory: string | undefined): [string, T] | undefined {
  if (!directory) return undefined
  const norm = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p)
  const dir = norm(directory)
  let best: [string, T] | undefined
  for (const [path, value] of Object.entries(projects)) {
    const p = norm(path)
    if ((dir === p || dir.startsWith(`${p}/`) || dir.startsWith(`${p}\\`)) && (!best || p.length > norm(best[0]).length)) best = [path, value]
  }
  return best
}
