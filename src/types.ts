export type ModelRef = { providerID: string; id: string; variant?: string }

/** The structured error OpenCode passes to the retry hook and records on failed steps. */
export type SessionError = {
  type: string
  message: string
  status?: number
  response?: { body: string }
  retryAfterMs?: number
}

/**
 * throttle: short rate limit, seconds to minutes.
 * overload: provider-side capacity problem, not ours.
 * window: a plan window (5-hour, weekly, monthly pool) is used up.
 * billing: credits or spend caps exhausted; lasts until a month boundary or a top-up.
 * auth: credentials rejected.
 */
export type FailureKind = "throttle" | "overload" | "window" | "billing" | "auth"

export type Signal = {
  kind: FailureKind
  /** Pools the signal applies to, e.g. ["claude-agent"] or ["claude-agent:opus"]. */
  pools: string[]
  resetAt?: number
  retryAfterMs?: number
  /** Short human-readable reason, shown in logs and the dashboard. */
  evidence: string
}

export type PoolStatus = "available" | "degraded" | "cooling" | "blocked"

export type PoolState = {
  id: string
  status: PoolStatus
  kind?: FailureKind
  /** Epoch ms when the pool may be tried again. Past values mean the pool is half-open. */
  until?: number
  since: number
  evidence?: string
  /** What set the current cooldown: a failed request or a usage probe. */
  source?: "error" | "probe"
  backoff: number
  /** Highest known utilisation of the pool's windows, 0-100. */
  utilization?: number
  lastSuccess?: number
  lastFailure?: number
  updated: number
}

/** subscription: flat-rate plan; metered: pay per token; local: runs on this machine, free. */
export type ProviderKind = "subscription" | "metered" | "local"

export type ModelInfo = {
  providerID: string
  id: string
  name?: string
  variants: string[]
  context?: number
  cost?: CostTier[]
  family?: string
  released?: number
  tools?: boolean
  status?: string
}

export type CostTier = {
  tier?: { type: string; size: number }
  input: number
  output: number
  cache?: { read?: number; write?: number }
}

export type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}
