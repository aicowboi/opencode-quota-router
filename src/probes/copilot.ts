// GitHub Copilot monthly allowance, from the endpoint Copilot's own editors use. Undocumented.
import { parseTimestamp } from "../resets.ts"

export type CopilotQuota = {
  plan?: string
  name: string
  entitlement: number
  /** Credits (or premium requests) used this month. */
  used: number
  remaining: number
  percentRemaining: number
  unlimited: boolean
  overagePermitted: boolean
  overageUsed: number
  resetAt?: number
}

const GITHUB_TOKEN = /^(gho_|ghu_|ghp_|github_pat_)/

/** The GitHub OAuth token inside OpenCode's stored Copilot credential, whatever its exact shape. */
export function findGithubToken(credential: unknown): string | undefined {
  const strings: Array<[string, string]> = []
  const visit = (o: unknown, key: string, depth: number) => {
    if (depth > 4 || o === null || o === undefined) return
    if (typeof o === "string") strings.push([key, o])
    else if (typeof o === "object") for (const [k, v] of Object.entries(o)) visit(v, k, depth + 1)
  }
  visit(credential, "", 0)
  return strings.find(([, v]) => GITHUB_TOKEN.test(v))?.[1] ?? strings.find(([k]) => k === "refresh")?.[1]
}

export async function fetchCopilotUser(token: string): Promise<{ status: number; json?: unknown }> {
  const response = await fetch("https://api.github.com/copilot_internal/user", {
    headers: {
      authorization: `token ${token}`,
      accept: "application/json",
      "editor-version": "vscode/1.99.0",
      "editor-plugin-version": "copilot-chat/0.26.0",
      "user-agent": "GitHubCopilotChat/0.26.0",
      "x-github-api-version": "2025-04-01",
    },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) return { status: response.status }
  return { status: response.status, json: await response.json() }
}

/** Included AI credits per seat per month under token-based billing (docs.github.com, June 2026). */
const PLAN_CREDITS: Record<string, number> = { business: 1900, enterprise: 3900 }

type Snapshot = {
  token_based_billing?: boolean
  credits_used?: number
  entitlement?: number
  remaining?: number
  quota_remaining?: number
  percent_remaining?: number
  unlimited?: boolean
  overage_permitted?: boolean
  overage_count?: number
  has_quota?: boolean
}

/**
 * The metered allowance, ignoring unlimited buckets. Business and Enterprise seats on token-based billing report
 * an unlimited bucket because their included credits are pooled across the organisation; for those the seat's own
 * share (`monthlyCredits`, or the plan default) is measured against `credits_used`.
 */
export function interpretCopilot(json: unknown, now: number, monthlyCredits?: number): CopilotQuota | undefined {
  const data = (json ?? {}) as Record<string, unknown>
  const snapshots = (data.quota_snapshots ?? {}) as Record<string, Snapshot>
  const entries = Object.entries(snapshots).filter(([, s]) => s && typeof s === "object")
  const resetRaw0 = (data.quota_reset_date_utc ?? data.quota_reset_date) as string | undefined
  const resetAt0 = typeof resetRaw0 === "string" ? parseTimestamp(/^\d{4}-\d{2}-\d{2}$/.test(resetRaw0) ? `${resetRaw0}T00:00:00Z` : resetRaw0, now) : undefined
  const plan = typeof data.copilot_plan === "string" ? data.copilot_plan : undefined
  const billed = entries.filter(([, s]) => s.token_based_billing && typeof s.credits_used === "number")
  const pooled = billed.find(([k]) => k === "premium_interactions") ?? billed.sort((a, b) => (b[1].credits_used ?? 0) - (a[1].credits_used ?? 0))[0]
  const share = monthlyCredits && monthlyCredits > 0 ? monthlyCredits : plan ? PLAN_CREDITS[plan] : undefined
  if (pooled && pooled[1].unlimited && share) {
    const used = pooled[1].credits_used ?? 0
    return {
      plan,
      name: "ai_credits",
      entitlement: share,
      used,
      remaining: Math.max(0, share - used),
      percentRemaining: Math.max(0, ((share - used) / share) * 100),
      unlimited: false,
      overagePermitted: pooled[1].overage_permitted === true,
      overageUsed: Math.max(0, used - share),
      resetAt: resetAt0,
    }
  }
  const metered = (s: Snapshot) => !s.unlimited && s.has_quota !== false && (s.entitlement ?? 0) > 0
  const pick =
    entries.find(([k, s]) => k === "premium_interactions" && metered(s)) ??
    entries.find(([k, s]) => /premium|credit/i.test(k) && metered(s)) ??
    entries.find(([, s]) => metered(s))
  if (!pick) return undefined
  const [name, s] = pick
  const entitlement = s.entitlement ?? 0
  const remaining = s.remaining ?? s.quota_remaining ?? 0
  const resetRaw = (data.quota_reset_date_utc ?? data.quota_reset_date) as string | undefined
  const resetAt = typeof resetRaw === "string" ? parseTimestamp(/^\d{4}-\d{2}-\d{2}$/.test(resetRaw) ? `${resetRaw}T00:00:00Z` : resetRaw, now) : undefined
  return {
    plan: typeof data.copilot_plan === "string" ? data.copilot_plan : undefined,
    name,
    entitlement,
    used: Math.max(0, entitlement - remaining) + (s.overage_count ?? 0),
    remaining,
    percentRemaining: typeof s.percent_remaining === "number" ? s.percent_remaining : entitlement > 0 ? (remaining / entitlement) * 100 : 0,
    unlimited: s.unlimited === true,
    overagePermitted: s.overage_permitted === true,
    overageUsed: s.overage_count ?? 0,
    resetAt,
  }
}
