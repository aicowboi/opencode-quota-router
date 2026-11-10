// Turns a failed request into a routing signal: what ran out, for which pool, and until when.
// Evidence is checked from most to least specific: provider-specific codes and wording first,
// then OpenCode's own error type, then status codes.
import type { FailureKind, SessionError, Signal } from "./types.ts"
import { nextMidnightIn, nextMonthUtc, parseDuration, parseResetText, parseRetryText, parseTimestamp } from "./resets.ts"

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

/** Providers whose rate limits and quotas are counted per model (or per deployment), not per account. */
const PER_MODEL = new Set(["google", "google-vertex", "google-vertex-anthropic", "amazon-bedrock", "azure", "azure-cognitive-services", "openrouter"])

/**
 * The pool(s) a model draws from. Claude subscription weekly limits can be per model family; Gemini, Vertex, Bedrock,
 * Azure and OpenRouter limit each model on its own, and OpenRouter's free models share one daily allowance.
 */
export function modelPools(providerID: string, modelID: string): string[] {
  if (providerID === "claude-agent") {
    const family = /opus|fable|sonnet|haiku/i.exec(modelID)?.[0]?.toLowerCase()
    return family ? [providerID, `${providerID}:${family}`] : [providerID]
  }
  if (PER_MODEL.has(providerID)) {
    const pools = [providerID, `${providerID}:${modelID}`]
    if (providerID === "openrouter" && modelID.endsWith(":free")) pools.push("openrouter:free")
    return pools
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

/** A numeric field anywhere in the JSON error body, e.g. ChatGPT's `resets_at`. */
const bodyNumber = (error: SessionError, key: string): number | undefined => {
  let found: number | undefined
  try {
    const visit = (o: unknown) => {
      if (!o || typeof o !== "object" || found !== undefined) return
      for (const [k, v] of Object.entries(o)) {
        if (k === key && (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)))) found = Number(v)
        else if (typeof v === "object") visit(v)
      }
    }
    visit(JSON.parse(error.response?.body ?? ""))
  } catch {}
  return found
}

function openai(error: SessionError, text: string, codes: string, pools: string[], now: number): Signal | undefined {
  // ChatGPT plan (signed in with ChatGPT): a 5-hour or weekly window, with its exact reset in the body.
  if (codes.includes("usage_limit_reached") || error.type === "provider.chatgpt-limit") {
    const after = bodyNumber(error, "resets_in_seconds")
    const resetAt = parseTimestamp(bodyNumber(error, "resets_at"), now) ?? (after !== undefined ? now + after * 1000 : parseResetText(text, now))
    const plan = /"plan_type"\s*:\s*"([a-z_]+)"/i.exec(error.response?.body ?? "")?.[1]
    return signal("window", pools, `ChatGPT${plan ? ` ${plan}` : ""} usage limit`, { resetAt })
  }
  if (codes.includes("usage_not_included")) return signal("billing", pools, "ChatGPT plan does not include this model")
  if (/insufficient_quota|credit_balance_exhausted|organization_usage_limit_exceeded|spend_limit_exceeded/.test(codes) || /exceeded your current quota/i.test(text)) {
    const monthly = /usage_limit|spend_limit/.test(codes)
    return signal("billing", pools, "OpenAI quota or spend limit", monthly ? { resetAt: nextMonthUtc(now) } : {})
  }
  if (error.status === 503 || codes.includes("server_is_overloaded")) return signal("overload", pools, "OpenAI overloaded")
  return undefined
}

/** A string field anywhere in the JSON error body, e.g. OpenRouter's `limit_source`. */
const bodyString = (error: SessionError, key: string): string | undefined => {
  let found: string | undefined
  try {
    const visit = (o: unknown) => {
      if (!o || typeof o !== "object" || found !== undefined) return
      for (const [k, v] of Object.entries(o)) {
        if (k === key && typeof v === "string") found = v
        else if (typeof v === "object") visit(v)
      }
    }
    visit(JSON.parse(error.response?.body ?? ""))
  } catch {}
  return found
}

const wait = (error: SessionError, text: string) => error.retryAfterMs ?? parseRetryText(text)

/** Gemini API (Google AI Studio keys): per-minute limits come with a retry delay, daily ones reset at midnight Pacific. */
function gemini(error: SessionError, text: string, providerID: string, modelID: string, now: number): Signal | undefined {
  const model = [`${providerID}:${modelID}`]
  if (error.status === 402 || /payment_required|billing (?:account|is not enabled|has been disabled)|prepayment credits/i.test(text)) return signal("billing", [providerID], "Gemini billing or credit")
  if (error.status === 429 || /resource_exhausted|quota_exceeded|rate_limit_exceeded|too_many_requests|quota exceeded/i.test(text)) {
    const delay = parseDuration(bodyString(error, "retryDelay")) ?? wait(error, text)
    if (/per_?day|daily|quota_exceeded/i.test(text)) {
      const free = /free[_-]?tier/i.test(text)
      return signal("window", model, `Gemini daily limit${free ? " (free tier)" : ""}`, { resetAt: nextMidnightIn("America/Los_Angeles", now) })
    }
    return signal("throttle", model, "Gemini rate limit", { retryAfterMs: delay })
  }
  if (error.status === 503 || /"UNAVAILABLE"|model is overloaded/i.test(text)) return signal("overload", model, "Gemini overloaded")
  return undefined
}

/** Vertex AI: shared capacity, so "resource exhausted" is a short throttle unless a quota is named. */
function vertex(error: SessionError, text: string, providerID: string, modelID: string): Signal | undefined {
  const model = [`${providerID}:${modelID}`]
  if (error.status === 429 || /resource[_ ]exhausted|quota exceeded/i.test(text)) return signal("throttle", model, "Vertex AI resource exhausted", { retryAfterMs: wait(error, text) })
  if (error.status === 503 || /"UNAVAILABLE"|overloaded/i.test(text)) return signal("overload", model, "Vertex AI unavailable")
  return undefined
}

/** OpenRouter: account credit, a key's own limit, the daily allowance for free models, and upstream rate limits. */
function openrouter(error: SessionError, text: string, modelID: string, now: number): Signal | undefined {
  const model = [`openrouter:${modelID}`]
  const reset = () => parseTimestamp(bodyNumber(error, "resets_at") ?? bodyString(error, "resets_at") ?? bodyNumber(error, "X-RateLimit-Reset"), now)
  const free = /free-models-per-(day|min)/i.exec(text)?.[1]?.toLowerCase()
  if (free === "day") return signal("window", ["openrouter:free"], "OpenRouter daily allowance for free models", { resetAt: reset() })
  if (free === "min") return signal("throttle", ["openrouter:free"], "OpenRouter rate limit for free models", { retryAfterMs: wait(error, text) })
  const source = bodyString(error, "limit_source")
  if (source || /key limit exceeded|limit exceeded for (?:this )?key/i.test(text)) return signal("billing", ["openrouter"], `OpenRouter ${source ? `${source.replaceAll("_", " ")} ` : "key "}limit`, { resetAt: reset() })
  if (error.status === 402 || /insufficient credits|requires more credits|negative credit balance/i.test(text)) return signal("billing", ["openrouter"], "OpenRouter credit used up")
  if (error.status === 429) return signal("throttle", model, "OpenRouter rate limit", { retryAfterMs: wait(error, text) })
  if (error.status === 502 || error.status === 503 || /no (?:available|allowed) (?:model )?providers?/i.test(text)) return signal("overload", model, "OpenRouter has no provider available for this model")
  return undefined
}

/** Azure OpenAI and Azure AI: limits are per deployment, and the wait is in `retry-after-ms` or the message. */
function azure(error: SessionError, text: string, codes: string, providerID: string, modelID: string): Signal | undefined {
  const model = [`${providerID}:${modelID}`]
  if (/insufficient_quota|quota_exceeded|outofquota/.test(codes.replaceAll(" ", "")) || /out of (?:call volume )?quota|exceeded your current quota/i.test(text)) return signal("billing", [providerID], "Azure quota used up")
  if (error.status === 429 || /exceeded (?:token|call|request) rate limit/i.test(text)) return signal("throttle", model, "Azure rate limit", { retryAfterMs: wait(error, text) })
  if (error.status === 503 || /server_?busy|servicebusy|temporarily unable/i.test(text)) return signal("overload", model, "Azure deployment busy", { retryAfterMs: wait(error, text) })
  return undefined
}

/** Amazon Bedrock: recognised by exception name, since the SDK does not always pass an HTTP status on. */
function bedrock(error: SessionError, text: string, modelID: string): Signal | undefined {
  const model = [`amazon-bedrock:${modelID}`]
  if (/too many tokens per day|tokens per day/i.test(text)) return signal("window", model, "Bedrock daily token quota")
  if (/ServiceQuotaExceededException/i.test(text)) return signal("window", model, "Bedrock service quota")
  if (/ThrottlingException|TooManyRequestsException|too many requests/i.test(text) || error.status === 429) return signal("throttle", model, "Bedrock throttled", { retryAfterMs: wait(error, text) })
  if (/ServiceUnavailableException|ModelNotReadyException|ModelTimeoutException|ModelStreamErrorException|InternalServerException/i.test(text)) return signal("overload", model, `Bedrock ${/ModelNotReady/i.test(text) ? "model not ready" : /ModelTimeout/i.test(text) ? "model timed out" : "unavailable"}`)
  if (/ExpiredTokenException|UnrecognizedClientException|InvalidSignatureException|security token .* (?:expired|invalid)/i.test(text)) return signal("auth", ["amazon-bedrock"], "AWS credentials expired or invalid")
  return undefined
}

/** Ollama Cloud, OpenCode Go and OpenCode Zen: plans with windows, where the message names the window that ran out. */
function plan(error: SessionError, text: string, name: string, pools: string[], now: number): Signal | undefined {
  const scope = /\b(hourly|5[- ]hour|five[- ]hour|session|daily|weekly|monthly)\b[^.\n]{0,24}\b(?:limit|usage|allowance|quota)/i.exec(text)?.[1]?.toLowerCase()
  const limited = error.type === "provider.go-limit" || error.type === "provider.free-limit" || scope !== undefined
  if (/insufficient (?:balance|credits?)|out of credits?|add (?:more )?credits?|payment required|billing/i.test(text) && !scope || error.type === "provider.budget-limit" || (error.status === 402 && !limited))
    return signal("billing", pools, `${name} balance or spend limit`, { resetAt: parseResetText(text, now) })
  if (!limited) return undefined
  const resetAt = parseTimestamp(bodyNumber(error, "resets_at") ?? bodyString(error, "resets_at") ?? bodyNumber(error, "resetAt") ?? bodyString(error, "resetAt"), now) ?? parseResetText(text, now) ?? (scope === "monthly" ? nextMonthUtc(now) : scope === "hourly" ? now + 3_600_000 : undefined)
  const what = error.type === "provider.free-limit" ? "free allowance" : `${scope ? `${scope.replace("five", "5")} ` : ""}limit`
  return signal("window", pools, `${name} ${what}`, { resetAt, retryAfterMs: wait(error, text) })
}

export function classify(providerID: string, modelID: string, error: SessionError, now: number): Signal | undefined {
  if (NEVER_ROUTE.has(error.type) || error.type.startsWith("permission.") || error.type.startsWith("tool.")) return undefined
  const text = `${error.message}\n${error.response?.body ?? ""}`
  if (IGNORE.some((re) => re.test(text)) && error.status !== 429) return undefined
  if (error.type === "provider.invalid-request" && CONTEXT_OVERFLOW.test(text)) return undefined
  const codes = bodyCode(error)
  let pools = modelPools(providerID, modelID)

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
              : providerID === "google"
                ? gemini(error, text, providerID, modelID, now)
                : providerID === "google-vertex" || providerID === "google-vertex-anthropic"
                  ? vertex(error, text, providerID, modelID)
                  : providerID === "openrouter"
                    ? openrouter(error, text, modelID, now)
                    : providerID === "azure" || providerID === "azure-cognitive-services"
                      ? azure(error, text, codes, providerID, modelID)
                      : providerID === "amazon-bedrock"
                        ? bedrock(error, text, modelID)
                        : providerID === "ollama-cloud"
                          ? plan(error, text, "Ollama Cloud", pools, now)
                          : providerID === "opencode-go"
                            ? plan(error, text, "OpenCode Go", pools, now)
                            : providerID === "opencode"
                              ? plan(error, text, "OpenCode Zen", pools, now)
                              : undefined
  if (specific) return specific

  // Invalid requests are deterministic unless a provider rule above recognised a spend limit.
  if (error.type === "provider.invalid-request") return undefined
  const resetAt = parseResetText(text, now)
  // Where limits are counted per model, a rate limit or outage on one model says nothing about the others.
  const account = pools
  if (PER_MODEL.has(providerID)) pools = [`${providerID}:${modelID}`]
  switch (error.type) {
    case "provider.quota":
    case "provider.chatgpt-limit":
    case "provider.budget-limit":
    case "provider.model-budget-limit":
    case "provider.go-limit":
    case "provider.free-limit":
      return signal("billing", account, `Quota exhausted (${error.type})`, { resetAt })
    case "provider.rate-limit":
      return signal(resetAt ? "window" : "throttle", pools, "Rate limited", { resetAt, retryAfterMs: wait(error, text) })
    case "provider.auth":
      return signal("auth", account, "Authentication failed")
    case "provider.internal":
    case "provider.transport":
    case "provider.timeout":
      return signal("overload", pools, `Provider unavailable (${error.type})`, { retryAfterMs: error.retryAfterMs })
  }
  if (error.status === 429) return signal(resetAt ? "window" : "throttle", pools, "HTTP 429", { resetAt, retryAfterMs: wait(error, text) })
  if (error.status === 402) return signal("billing", account, "HTTP 402")
  if (error.status !== undefined && error.status >= 500) return signal("overload", pools, `HTTP ${error.status}`)
  if (/usage limit|quota (?:exceeded|exhausted)|limit reached/i.test(text)) return signal("window", pools, "Usage limit", { resetAt })
  return undefined
}

/** Epoch ms from any reset value a probe or header may report. */
export const resetFrom = parseTimestamp
