// Totals for the `usage` command: grouping, ranges, and the value of the tokens at API list prices.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { costOf, priceSources } from "../engine/pricing.ts"
import type { CostTier } from "../engine/types.ts"
import type { Usage } from "./readers.ts"

export type Prices = Map<string, CostTier[]>

/**
 * List prices from the model catalogue OpenCode keeps (`~/.cache/opencode/models.json`, from models.dev). Without it
 * the value column is left out. Prices are per million tokens.
 */
export function loadPrices(file = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode", "models.json")): Prices {
  const out: Prices = new Map()
  let catalogue: any
  try {
    catalogue = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return out
  }
  const tier = (c: any, t?: any): CostTier | undefined =>
    typeof c?.input === "number" && typeof c?.output === "number"
      ? { input: c.input, output: c.output, cache: { read: typeof c.cache_read === "number" ? c.cache_read : 0, write: typeof c.cache_write === "number" ? c.cache_write : 0 }, ...(t ? { tier: t } : {}) }
      : undefined
  for (const [providerID, p] of Object.entries<any>(catalogue ?? {})) {
    for (const [modelID, m] of Object.entries<any>(p?.models ?? {})) {
      const base = tier(m?.cost)
      if (!base) continue
      const tiers = [base, ...(Array.isArray(m.cost.tiers) ? m.cost.tiers.map((t: any) => tier(t, t?.tier)).filter(Boolean) : [])]
      out.set(`${providerID}/${modelID}`, tiers)
    }
  }
  return out
}

/** The tokens' cost at API list price, or what the tool reported when the model has no list price. */
export function valueOf(prices: Prices, u: Usage): number | undefined {
  for (const key of priceSources(u.providerID, u.model)) {
    const tiers = prices.get(key)
    if (tiers?.some((t) => t.input > 0 || t.output > 0)) return costOf(tiers, { input: u.input, output: u.output, reasoning: u.reasoning, cache: { read: u.cacheRead, write: u.cacheWrite } })
  }
  return u.cost
}

export const RANGES: Record<string, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90, all: 0 }
export const GROUPS = ["day", "model", "source", "project"] as const
export type GroupBy = (typeof GROUPS)[number]

export const localDay = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Start of the range in local time: today counts as the first of the days. */
export function rangeStart(range: string, now = Date.now()): number {
  const days = RANGES[range]
  if (!days) return 0
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (days - 1))
  return d.getTime()
}

export type Row = { key: string; requests: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; tokens: number; value: number; priced: boolean }

export function summarise(usage: Usage[], by: GroupBy, prices: Prices, from = 0): { rows: Row[]; total: Row } {
  const rows = new Map<string, Row>()
  const blank = (key: string): Row => ({ key, requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, value: 0, priced: true })
  const total = blank("Total")
  for (const u of usage) {
    if (u.at < from) continue
    const key = by === "day" ? localDay(u.at) : by === "model" ? `${u.providerID}/${u.model}` : by === "source" ? u.source : u.project ? path.basename(u.project) : "(none)"
    const r = rows.get(key) ?? blank(key)
    rows.set(key, r)
    const v = valueOf(prices, u)
    for (const t of [r, total]) {
      t.requests++
      t.input += u.input
      t.output += u.output
      t.reasoning += u.reasoning
      t.cacheRead += u.cacheRead
      t.cacheWrite += u.cacheWrite
      t.tokens += u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
      if (v === undefined) t.priced = false
      else t.value += v
    }
  }
  const list = [...rows.values()].sort((a, b) => (by === "day" ? a.key.localeCompare(b.key) : b.tokens - a.tokens))
  return { rows: list, total }
}
