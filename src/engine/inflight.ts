// The part of an Anthropic API request that is still running. OpenCode sends a live usage snapshot while the request
// streams. That snapshot is either the session's running total or the current step's own tokens; the two are told
// apart by whether it has grown past the usage already settled. The finished request replaces it.
import type { Tokens } from "./types.ts"

export type UsageSnapshot = { cost: number; tokens: Tokens }

export type Inflight = {
  tokens: Tokens
  /** List price of the in-flight tokens. */
  estimate: number
  /** Dollar figure from the usage event, for the in-flight part only, when it sent one. */
  reported: number
  /** What spend counts: the reported cost when it is present, otherwise the list-price estimate. */
  usd: number
  basis: "reported" | "estimated"
}

const empty = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

const grown = (event: Tokens, base: Tokens) =>
  event.input >= base.input && event.output >= base.output && event.reasoning >= base.reasoning && event.cache.read >= base.cache.read && event.cache.write >= base.cache.write

const minus = (event: Tokens, base: Tokens): Tokens => ({
  input: Math.max(0, event.input - base.input),
  output: Math.max(0, event.output - base.output),
  reasoning: Math.max(0, event.reasoning - base.reasoning),
  cache: { read: Math.max(0, event.cache.read - base.cache.read), write: Math.max(0, event.cache.write - base.cache.write) },
})

/**
 * Usage still in flight on the current step. `baseline` is the session's usage at the start of the step, when the
 * snapshot is a running total; a snapshot smaller than that is the step's own tokens.
 */
export function inflightOf(event: UsageSnapshot, baseline: UsageSnapshot, estimateOf: (tokens: Tokens) => number): Inflight {
  const cumulative = event.cost + 1e-9 >= baseline.cost && grown(event.tokens, baseline.tokens)
  const tokens = cumulative ? minus(event.tokens, baseline.tokens) : event.tokens
  const reported = Math.max(0, cumulative ? event.cost - baseline.cost : event.cost)
  const estimate = Math.max(0, estimateOf(tokens))
  const usd = reported > 0 ? reported : estimate
  return { tokens, estimate, reported, usd, basis: reported > 0 ? "reported" : "estimated" }
}

export const ZERO_USAGE: UsageSnapshot = { cost: 0, tokens: empty() }
