import { test } from "node:test"
import assert from "node:assert/strict"
import { inflateSync } from "node:zlib"
import { ringIcon } from "../gui/icon.ts"
import { present, type Menubar } from "../gui/present.ts"

const NOW = Date.parse("2026-11-09T15:00:00Z")
const base: Menubar = {
  now: NOW,
  paused: false,
  url: "http://127.0.0.1:47321",
  claude: {
    windows: [
      { pool: "claude-agent", label: "5-hour session", utilization: 53, resetAt: NOW + 40 * 60_000 },
      { pool: "claude-agent", label: "Weekly (all models)", utilization: 6, resetAt: NOW + 6 * 86_400_000 },
    ],
    extra: { enabled: true, used: 0, limit: 50, currency: "USD" },
  },
  copilot: { name: "ai_credits", plan: "business", entitlement: 1900, used: 493, remaining: 1407, overageUsed: 0, resetAt: Date.parse("2026-12-01T00:00:00Z") },
  providers: [
    { id: "claude-agent", priority: 1, kind: "subscription", status: "available", serving: 1 },
    { id: "xai", priority: 2, kind: "subscription", status: "available", serving: 0 },
  ],
  live: [{ title: "Plugin work", startedAt: NOW - 12 * 60_000, model: "claude-agent/opus#medium" }],
  today: { tokens: 147_400_000, equiv: 54.69, actual: 35.21, steps: 400 },
}

test("menu bar: normal state shows Claude's 5-hour window", () => {
  const v = present(base)
  assert.equal(v.title, "53%")
  assert.equal(v.ring, "ok")
  assert.equal(v.dot, "ok")
  assert.equal(v.fraction, 0.53)
  const labels = v.sections.flat().map((i) => i.label)
  assert.ok(labels.includes("Claude 5-hour — 53%"))
  assert.ok(labels.some((l) => l.startsWith("Copilot credits — 493 / 1,900")))
  assert.ok(labels.some((l) => /^Usage credits — .*0\.00 of .*50\.00$/.test(l)))
  assert.ok(labels.includes("Pause Routing"))
})

test("menu bar: limited Claude shows where requests go and when it returns", () => {
  const v = present({
    ...base,
    providers: [
      { id: "claude-agent", priority: 1, kind: "subscription", status: "cooling", until: NOW + 2 * 3_600_000 + 5 * 60_000, evidence: "5-hour limit", serving: 0 },
      { id: "xai", priority: 2, kind: "subscription", status: "available", serving: 1 },
    ],
    live: [{ title: "Plugin work", startedAt: NOW - 60_000, model: "xai/grok-4.7#high", fallback: "claude-agent/opus#medium" }],
  })
  assert.equal(v.title, "xAI · Claude in 2h 05m")
  assert.equal(v.ring, "bad")
  assert.equal(v.dot, "warn")
})

test("menu bar: near the cut-over, paused, and offline", () => {
  const near = present({ ...base, claude: { windows: [{ ...base.claude!.windows[0], utilization: 90 }] } })
  assert.equal(near.ring, "warn")
  const paused = present({ ...base, paused: true })
  assert.equal(paused.title, "Paused")
  assert.ok(paused.sections.flat().some((i) => i.label === "Resume Routing"))
  const off = present(undefined)
  assert.equal(off.title, "")
  assert.equal(off.ring, "idle")
})

test("ring icon is a valid PNG with a partly filled ring", () => {
  const png = ringIcon(36, 0.5, [210, 120, 90], [128, 128, 128], 0.45, [127, 174, 139])
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 36)
  // Decode the pixel rows and check: right side (filled half) is ring-coloured, left side is the faint track.
  const idat = png.subarray(png.indexOf("IDAT") + 4, png.indexOf("IEND") - 8)
  const raw = inflateSync(idat)
  const px = (x: number, y: number) => raw.subarray(y * (36 * 4 + 1) + 1 + x * 4, y * (36 * 4 + 1) + 1 + x * 4 + 4)
  const right = px(32, 18)
  const left = px(3, 18)
  assert.ok(right[0] > 180 && right[3] > 200, `right ${[...right]}`)
  assert.ok(left[3] > 0 && left[3] < 160, `left ${[...left]}`)
  assert.ok(px(18, 18)[1] > 150, "centre dot")
})
