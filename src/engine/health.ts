// How each provider is doing right now: how fast it starts answering, and how often its requests fail.
import type { Config } from "./config.ts"
import type { Gate } from "./policy.ts"
import type { ModelRef } from "./types.ts"

/** One finished request. */
export type RequestSample = { providerID: string; at: number; ok: boolean; firstMs?: number; errorType?: string }

export type ProviderHealth = {
  /** Requests and failures inside the window the error rate is judged over. */
  requests: number
  failed: number
  /** Median time to the first token, over everything passed in. */
  firstTokenMs?: number
  /** How many requests that median rests on. */
  timed: number
}

/** Failures that say nothing about the provider's health: limits are handled as limits, and a bad request is the request's fault. */
const NOT_HEALTH = /rate-limit|quota|limit|auth|invalid-request|aborted|cancel/i

export function summariseHealth(samples: RequestSample[], now: number, windowMs: number): Record<string, ProviderHealth> {
  const out: Record<string, ProviderHealth> = {}
  const times: Record<string, number[]> = {}
  for (const s of samples) {
    if (s.at > now) continue
    const h = (out[s.providerID] ??= { requests: 0, failed: 0, timed: 0 })
    const counted = s.ok || !NOT_HEALTH.test(s.errorType ?? "")
    if (counted && s.at >= now - windowMs) {
      h.requests++
      if (!s.ok) h.failed++
    }
    if (s.ok && s.firstMs !== undefined && s.firstMs >= 0) (times[s.providerID] ??= []).push(s.firstMs)
  }
  for (const [id, list] of Object.entries(times)) {
    list.sort((a, b) => a - b)
    const mid = list.length >> 1
    out[id].firstTokenMs = Math.round(list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2)
    out[id].timed = list.length
  }
  return out
}

/** Whether enough of a provider's recent requests failed to call it unreliable. */
export function unreliable(config: Config, h: ProviderHealth | undefined): boolean {
  return !!h && h.requests >= config.health.minRequests && h.failed / h.requests >= config.health.maxErrorRate
}

/**
 * A provider that is failing without being limited is passed over while another entry can run. The block is soft:
 * with nothing else available it is still used, and it lapses by itself as the failures age out of the window.
 */
export function healthGate(config: Config, health: Record<string, ProviderHealth>): Gate | undefined {
  if (!config.health.enabled) return undefined
  const bad = Object.entries(health).filter(([, h]) => unreliable(config, h))
  if (bad.length === 0) return undefined
  const reasons = new Map(bad.map(([id, h]) => [id, `unreliable right now (${h.failed} of the last ${h.requests} requests failed)`]))
  return (entry) => (reasons.has(entry.providerID) ? { reason: reasons.get(entry.providerID)!, soft: true } : undefined)
}

/**
 * For two providers given the same priority: how long this one takes to start answering, when that is known from
 * enough requests to mean something.
 */
export function speedOf(health: Record<string, ProviderHealth>): (entry: ModelRef) => number | undefined {
  return (entry) => {
    const h = health[entry.providerID]
    return h && h.timed >= 3 ? h.firstTokenMs : undefined
  }
}
