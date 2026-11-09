// Turns a failed request into a routing signal: what ran out, for which pool, and until when.
// Evidence is checked from most to least specific: provider-specific codes and wording first,
// then OpenCode's own error type, then status codes.
import type { FailureKind, SessionError, Signal } from "./types.ts"
import { nextMonthUtc, parseResetText, parseTimestamp } from "./resets.ts"

/** Deterministic failures. A different model would only hide the real problem. */
const NEVER_ROUTE = new Set([
  "aborted",
  "provider.content-filter",
  "provider.invalid-output",
  "provider.unsupported-operation",
  "provider.no-route",
  "output-limit",
  "permission.rejected",
  "tool.execution",
  "compaction.unavailable",
  "compaction.failed",
])

/** Harmless notices that mention limits without being one (azumag/opencode-rate-limit-fallback#25). */
const IGNORE = [/draw from your extra usage/i, /not your (?:plan|usage) limit/i]

const CONTEXT_OVERFLOW = /prompt is too long|context(?: window|[_ ]length)[_ ]?(?:exceeded)?|maximum context length|too many tokens in request/i

/** The pool(s) a model draws from. Claude subscription weekly limits can be per model family. */
export function modelPools(providerID: string, modelID: string): string[] {
  if (providerID === "claude-agent") {
    const family = /opus|fable|sonnet|haiku/i.exec(modelID)?.[0]?.toLowerCase()
    return family ? [providerID, `${providerID}:${family}`] : [providerID]
  }
  return [providerID]
}

const bodyCode = (error: SessionError): string => {
  const body = error.response?.body ?? ""
  const codes: string[] = []
  try {
    const json = JSON.parse(body)
    const visit = (o: unknown) => {
      if (!o || typeof o !== "object") return
      for (const [k, v] of Object.entries(o)) {
        if ((k === "code" || k === "type" || k === "error_code") && typeof v === "string") codes.push(v)
        else if (typeof v === "object") visit(v)
      }
    }
    visit(json)
  } catch {}
  return codes.join(" ").toLowerCase()
}

const signal = (kind: FailureKind, pools: string[], evidence: string, extra: Partial<Signal> = {}): Signal => ({
  kind,
  pools,
  evidence,
  ...extra,
})

function claudeAgent(error: SessionError, text: string, pools: string[], now: number): Signal | undefined {
  const resetAt = parseResetText(text, now)
  const scope = /\((?:seven[ _]day[ _])?(opus|sonnet|fable)\)|hit your (opus|sonnet|fable) limit|(opus|sonnet|fable) limit reached/i.exec(text)
  const family = (scope?.[1] ?? scope?.[2] ?? scope?.[3])?.toLowerCase()
  const scoped = family ? [`claude-agent:${family}`] : ["claude-agent"]
  if (/credits required|extra[- ]usage|usage credits|monthly spend limit|spend limit reached|billing/i.test(text) && !/limit reached \(/i.test(text))
    return signal("billing", scoped, "Claude usage credits or spend limit", { resetAt })
  if (/subscription limit reached|usage limit|hit your (?:session|weekly|opus|sonnet|fable) limit|limit reached|out of (?:extra )?usage/i.test(text)) {
    const label = /\(([a-z _]+)\)/i.exec(text)?.[1] ?? (/session/i.test(text) ? "session" : /weekly/i.test(text) ? "weekly" : "window")
    return signal("window", scoped, `Claude subscription limit (${label.replaceAll("_", " ")})`, { resetAt })
  }
  if (/overloaded|\b529\b|HTTP 5\d\d|exhausted its retries/i.test(text)) return signal("overload", pools, "Anthropic overloaded")
  if (/rate[- ]?limit|too many requests|temporarily limiting/i.test(text))
    return signal("throttle", pools, "Claude rate limit", { retryAfterMs: error.retryAfterMs })
  return undefined
}

function anthropic(error: SessionError, text: string, codes: string, pools: string[], now: number): Signal | undefined {
  if (codes.includes("enforced_spend_limit_reached") || /regain access on/i.test(text))
    return signal("billing", pools, "Anthropic monthly spend cap", { resetAt: parseResetText(text, now) ?? nextMonthUtc(now) })
  if (/specified (?:workspace )?api usage limits/i.test(text)) return signal("billing", pools, "Anthropic workspace spend limit")
  if (/credit balance is too low/i.test(text) || error.status === 402 || codes.includes("billing_error"))
    return signal("billing", pools, "Anthropic credit balance")
  if (error.status === 529 || codes.includes("overloaded_error")) return signal("overload", pools, "Anthropic overloaded")
  return undefined
}

function xai(error: SessionError, text: string, codes: string, pools: string[]): Signal | undefined {
  if (/used all available credits|spending[- ]limit|personal-team-blocked|need a grok subscription|run out of credits/i.test(text) || codes.includes("spending-limit"))
    return signal("window", pools, "xAI weekly pool or credits used up")
  if (codes.includes("resource-exhausted") && /0\/0/.test(text)) return signal("auth", pools, "xAI token not entitled for this endpoint")
  if (error.status === 429) return signal("throttle", pools, "xAI rate limit", { retryAfterMs: error.retryAfterMs })
  return undefined
}

function copilot(error: SessionError, text: string, codes: string, pools: string[], now: number): Signal | undefined {
  if (error.status === 402 || codes.includes("quota_exceeded") || /exceeded your monthly quota/i.test(text)) {
    const resetAt = error.retryAfterMs !== undefined && error.retryAfterMs > 3_600_000 ? now + error.retryAfterMs : nextMonthUtc(now)
    return signal("billing", pools, "Copilot monthly allowance used", { resetAt })
  }
  if (codes.includes("user_global_rate_limited") || /global rate limit/i.test(text))
    return signal("window", pools, "Copilot global rate limit", { retryAfterMs: error.retryAfterMs })
  return undefined
}

function openai(error: SessionError, text: string, codes: string, pools: string[], now: number): Signal | undefined {
  if (/insufficient_quota|credit_balance_exhausted|organization_usage_limit_exceeded|spend_limit_exceeded/.test(codes) || /exceeded your current quota/i.test(text)) {
    const monthly = /usage_limit|spend_limit/.test(codes)
    return signal("billing", pools, "OpenAI quota or spend limit", monthly ? { resetAt: nextMonthUtc(now) } : {})
  }
  if (error.status === 503 || codes.includes("server_is_overloaded")) return signal("overload", pools, "OpenAI overloaded")
  return undefined
}

export function classify(providerID: string, modelID: string, error: SessionError, now: number): Signal | undefined {
  if (NEVER_ROUTE.has(error.type) || error.type.startsWith("permission.") || error.type.startsWith("tool.")) return undefined
  const text = `${error.message}\n${error.response?.body ?? ""}`
  if (IGNORE.some((re) => re.test(text)) && error.status !== 429) return undefined
  if (error.type === "provider.invalid-request" && CONTEXT_OVERFLOW.test(text)) return undefined
  const codes = bodyCode(error)
  const pools = modelPools(providerID, modelID)

  const specific =
    providerID === "claude-agent"
      ? claudeAgent(error, text, pools, now)
      : providerID === "anthropic"
        ? anthropic(error, text, codes, pools, now)
        : providerID === "xai"
          ? xai(error, text, codes, pools)
          : providerID === "github-copilot"
            ? copilot(error, text, codes, pools, now)
            : providerID === "openai"
              ? openai(error, text, codes, pools, now)
              : undefined
  if (specific) return specific

  // Invalid requests are deterministic unless a provider rule above recognised a spend limit.
  if (error.type === "provider.invalid-request") return undefined
  const resetAt = parseResetText(text, now)
  switch (error.type) {
    case "provider.quota":
    case "provider.chatgpt-limit":
    case "provider.budget-limit":
    case "provider.model-budget-limit":
    case "provider.go-limit":
    case "provider.free-limit":
      return signal("billing", pools, `Quota exhausted (${error.type})`, { resetAt })
    case "provider.rate-limit":
      return signal(resetAt ? "window" : "throttle", pools, "Rate limited", { resetAt, retryAfterMs: error.retryAfterMs })
    case "provider.auth":
      return signal("auth", pools, "Authentication failed")
    case "provider.internal":
    case "provider.transport":
    case "provider.timeout":
      return signal("overload", pools, `Provider unavailable (${error.type})`, { retryAfterMs: error.retryAfterMs })
  }
  if (error.status === 429) return signal(resetAt ? "window" : "throttle", pools, "HTTP 429", { resetAt, retryAfterMs: error.retryAfterMs })
  if (error.status === 402) return signal("billing", pools, "HTTP 402")
  if (error.status !== undefined && error.status >= 500) return signal("overload", pools, `HTTP ${error.status}`)
  if (/usage limit|quota (?:exceeded|exhausted)|limit reached/i.test(text)) return signal("window", pools, "Usage limit", { resetAt })
  return undefined
}

/** Epoch ms from any reset value a probe or header may report. */
export const resetFrom = parseTimestamp
