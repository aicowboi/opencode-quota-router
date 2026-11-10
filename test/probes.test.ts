import { test } from "node:test"
import assert from "node:assert/strict"
import { interpretClaudeUsage } from "../src/probes/claude.ts"
import { findGithubToken, interpretCopilot } from "../src/probes/copilot.ts"
import { headroom } from "../src/engine/headers.ts"

const NOW = Date.parse("2026-11-09T12:00:00Z")

// Shape of Claude Code's usage endpoint response (illustrative figures).
const CLAUDE = {
  five_hour: { utilization: 15.0, resets_at: "2026-11-09T15:39:59.831478+00:00" },
  seven_day: { utilization: 2.0, resets_at: "2026-11-16T08:59:59.831499+00:00" },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 0.0, currency: "USD", decimal_places: 2, spend_limit_reached: false },
  limits: [
    { kind: "session", group: "session", percent: 15, resets_at: "2026-11-09T15:39:59.831478+00:00", scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 2, resets_at: "2026-11-16T08:59:59.831499+00:00", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: "2026-11-16T09:00:00+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ],
}

test("Claude usage: limits list maps to pools", () => {
  const u = interpretClaudeUsage(CLAUDE, NOW)
  assert.deepEqual(
    u.windows.map((w) => [w.pool, w.label, w.utilization]),
    [
      ["claude-agent", "5-hour session", 15],
      ["claude-agent", "Weekly (all models)", 2],
      ["claude-agent:fable", "Weekly (Fable)", 0],
    ],
  )
  assert.equal(u.windows[0].resetAt, Date.parse("2026-11-09T15:39:59.831Z"))
  assert.deepEqual(u.extra, { enabled: true, used: 0, limit: 50, currency: "USD", spendLimitReached: false })
})

test("Claude usage: falls back to the older fields", () => {
  const { limits, ...legacy } = CLAUDE
  const u = interpretClaudeUsage({ ...legacy, seven_day_opus: { utilization: 99, resets_at: "2026-11-12T00:00:00Z" } }, NOW)
  assert.deepEqual(u.windows.map((w) => w.pool), ["claude-agent", "claude-agent", "claude-agent:opus"])
})

const COPILOT = {
  copilot_plan: "individual_pro",
  quota_reset_date: "2026-12-01",
  quota_snapshots: {
    chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true, overage_count: 0, overage_permitted: false },
    completions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
    premium_interactions: { entitlement: 300, remaining: 42, percent_remaining: 14, unlimited: false, overage_count: 0, overage_permitted: true },
  },
}

test("Copilot quota: premium allowance and reset date", () => {
  const q = interpretCopilot(COPILOT, NOW)!
  assert.equal(q.name, "premium_interactions")
  assert.equal(q.remaining, 42)
  assert.equal(q.entitlement, 300)
  assert.equal(q.resetAt, Date.parse("2026-12-01T00:00:00Z"))
  assert.equal(interpretCopilot({ quota_snapshots: { chat: { unlimited: true } } }, NOW), undefined)
})

test("Copilot Business seat on token-based billing measures credits used against the seat's share", () => {
  const business = {
    copilot_plan: "business",
    quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
    quota_snapshots: {
      chat: { unlimited: true, token_based_billing: true, credits_used: 0, entitlement: 0, remaining: 0 },
      premium_interactions: { unlimited: true, overage_permitted: true, token_based_billing: true, credits_used: 281, entitlement: 0, remaining: 0, percent_remaining: 100 },
    },
  }
  const q = interpretCopilot(business, NOW)!
  assert.equal(q.name, "ai_credits")
  assert.equal(q.entitlement, 1900)
  assert.equal(q.remaining, 1619)
  assert.equal(q.resetAt, Date.parse("2026-12-01T00:00:00Z"))
  assert.equal(interpretCopilot(business, NOW, 500)!.remaining, 219)
  const over = interpretCopilot({ ...business, quota_snapshots: { premium_interactions: { ...business.quota_snapshots.premium_interactions, credits_used: 1950 } } }, NOW)!
  assert.equal(over.remaining, 0)
  assert.equal(over.overageUsed, 50)
})

test("Copilot token found in any credential shape", () => {
  assert.equal(findGithubToken({ type: "oauth", refresh: "gho_abc", access: "tid=xyz" }), "gho_abc")
  assert.equal(findGithubToken({ value: { metadata: { token: "ghu_1" } } }), "ghu_1")
  assert.equal(findGithubToken(undefined), undefined)
})

test("headers: Anthropic and OpenAI headroom", () => {
  const a = headroom(
    new Headers({
      "anthropic-ratelimit-requests-limit": "4000",
      "anthropic-ratelimit-requests-remaining": "3999",
      "anthropic-ratelimit-input-tokens-limit": "2000000",
      "anthropic-ratelimit-input-tokens-remaining": "100000",
      "anthropic-ratelimit-input-tokens-reset": "2026-11-09T12:00:30Z",
    }),
    NOW,
  )
  assert.equal(a?.remainingPct, 5)
  assert.equal(a?.resetAt, Date.parse("2026-11-09T12:00:30Z"))
  const o = headroom(new Headers({ "x-ratelimit-limit-tokens": "1000", "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "6m0s" }), NOW)
  assert.equal(o?.remainingPct, 0)
  assert.equal(o?.resetAt, NOW + 360_000)
  assert.equal(headroom(new Headers({ "content-type": "text/plain" }), NOW), undefined)
})
