// Schedules: rules that apply at certain times, such as "after 18:00 use local models first" or
// "at weekends, subscriptions only". Times are in the machine's own time zone.
import type { Config } from "./config.ts"
import type { Gate } from "./policy.ts"
import type { ModelRef, ProviderKind } from "./types.ts"

export type Schedule = {
  name: string
  /** Days of the week it applies on, 0 for Sunday to 6 for Saturday. Absent: every day. */
  days?: number[]
  /** Minutes after midnight. Absent, or both the same: all day. `from` later than `to` runs past midnight. */
  from?: number
  to?: number
  /** Providers never routed to while it applies. */
  deny: string[]
  /** When set, the only providers routed to while it applies. */
  allow?: string[]
  denyKinds: ProviderKind[]
  /** Providers, or kinds of provider, tried before the rest of the chain while it applies. */
  first: string[]
}

export type ActiveSchedule = Schedule & { until?: number }

const KINDS: ProviderKind[] = ["subscription", "metered", "local"]
const KEYS = "name days from to deny allow denyKinds first".split(" ")
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const DAY_SETS: Record<string, number[]> = { weekdays: [1, 2, 3, 4, 5], weekends: [0, 6], weekend: [0, 6], daily: [0, 1, 2, 3, 4, 5, 6] }
const names = (v: unknown): string[] | undefined => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 100))] : undefined)

/** `18:00`, `8:30` or `24:00` as minutes after midnight. */
export function parseClock(v: unknown): number | undefined {
  const m = typeof v === "string" ? /^(\d{1,2}):(\d{2})$/.exec(v.trim()) : null
  if (!m) return undefined
  const minutes = Number(m[1]) * 60 + Number(m[2])
  return Number(m[2]) < 60 && minutes <= 1440 ? minutes % 1440 : undefined
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`

export function parseSchedules(raw: unknown): { schedules: Schedule[]; warnings: string[] } {
  const warnings: string[] = []
  if (raw === undefined) return { schedules: [], warnings }
  if (!Array.isArray(raw)) return { schedules: [], warnings: ["schedules should be a list; ignored"] }
  const schedules: Schedule[] = []
  raw.slice(0, 50).forEach((item, i) => {
    const at = `schedules[${i}]`
    if (!item || typeof item !== "object" || Array.isArray(item)) return void warnings.push(`${at} should be an object; ignored`)
    const o = item as Record<string, unknown>
    for (const key of Object.keys(o)) if (!KEYS.includes(key)) warnings.push(`${at}: unknown key ${key}; ignored`)
    let days: number[] | undefined
    if (o.days !== undefined) {
      const list = typeof o.days === "string" ? [o.days] : names(o.days)
      const found = (list ?? []).flatMap((d) => DAY_SETS[d.toLowerCase()] ?? (DAYS.indexOf(d.toLowerCase().slice(0, 3)) >= 0 && d.length >= 3 ? [DAYS.indexOf(d.toLowerCase().slice(0, 3))] : [-1]))
      if (!list || list.length === 0 || found.includes(-1)) return void warnings.push(`${at}: days should be a list such as ["sat", "sun"], or "weekdays" or "weekends"; schedule ignored`)
      days = [...new Set(found)].sort()
    }
    const from = o.from === undefined ? undefined : parseClock(o.from)
    const to = o.to === undefined ? undefined : parseClock(o.to)
    if ((o.from !== undefined && from === undefined) || (o.to !== undefined && to === undefined)) return void warnings.push(`${at}: from and to should be times such as "18:00"; schedule ignored`)
    if ((from === undefined) !== (to === undefined)) return void warnings.push(`${at}: give both from and to, or neither for the whole day; schedule ignored`)
    for (const key of ["deny", "allow", "denyKinds", "first"]) if (o[key] !== undefined && !names(o[key])) warnings.push(`${at}: ${key} should be a list of names; ignored`)
    for (const k of names(o.denyKinds) ?? []) if (!(KINDS as string[]).includes(k)) warnings.push(`${at}: denyKinds has no kind named ${k}; ignored`)
    const s: Schedule = {
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : describeWhen({ days, from, to }),
      days,
      from,
      to,
      deny: names(o.deny) ?? [],
      allow: names(o.allow),
      denyKinds: (names(o.denyKinds) ?? []).filter((k): k is ProviderKind => (KINDS as string[]).includes(k)),
      first: names(o.first) ?? [],
    }
    if (s.deny.length === 0 && !s.allow && s.denyKinds.length === 0 && s.first.length === 0) return void warnings.push(`${at}: has no deny, allow, denyKinds or first, so it does nothing; ignored`)
    schedules.push(s)
  })
  return { schedules, warnings }
}

/** When a schedule applies, in words: `Sat, Sun 18:00 to 08:00`. */
export function describeWhen(s: { days?: number[]; from?: number; to?: number }): string {
  const allDay = s.from === undefined || s.to === undefined || s.from === s.to
  const days = !s.days || s.days.length === 7 ? "" : s.days.map((d) => DAYS[d][0].toUpperCase() + DAYS[d].slice(1)).join(", ")
  const hours = allDay ? "" : `${clock(s.from!)} to ${clock(s.to!)}`
  return [days, hours].filter(Boolean).join(" ") || "always"
}

/** Whether a schedule applies at a moment, and if so when its current stretch ends. */
function stretch(s: Schedule, now: number): { on: boolean; end?: number } {
  const d = new Date(now)
  const day = d.getDay()
  const minute = d.getHours() * 60 + d.getMinutes()
  const on = (dayOfWeek: number) => !s.days || s.days.includes(dayOfWeek)
  const at = (addDays: number, minutes: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays, 0, minutes).getTime()
  if (s.from === undefined || s.to === undefined || s.from === s.to) return on(day) ? { on: true, end: at(1, 0) } : { on: false }
  if (s.from < s.to) return on(day) && minute >= s.from && minute < s.to ? { on: true, end: at(0, s.to) } : { on: false }
  // Past midnight: the stretch belongs to the day it started on.
  if (minute >= s.from) return on(day) ? { on: true, end: at(1, s.to) } : { on: false }
  if (minute < s.to) return on((day + 6) % 7) ? { on: true, end: at(0, s.to) } : { on: false }
  return { on: false }
}

/** The schedules that apply now, each with the time it stops applying (absent for one that never stops). */
export function activeSchedules(schedules: Schedule[], now: number): ActiveSchedule[] {
  const out: ActiveSchedule[] = []
  for (const s of schedules) {
    let cur = stretch(s, now)
    if (!cur.on) continue
    let until: number | undefined
    // Stretches that run into each other (all day on Saturday, then all day on Sunday) end when the last one does.
    for (let i = 0; i < 8 && cur.on && cur.end !== undefined; i++) {
      until = cur.end
      cur = stretch(s, cur.end)
    }
    out.push({ ...s, until: cur.on ? undefined : until })
  }
  return out
}

const time = (ms: number) => {
  const d = new Date(ms)
  return clock(d.getHours() * 60 + d.getMinutes())
}

/** Providers a schedule shuts out are not routed to while it applies. */
export function scheduleGate(config: Config, active: ActiveSchedule[]): Gate | undefined {
  const rules = active.filter((s) => s.deny.length || s.denyKinds.length || s.allow)
  if (rules.length === 0) return undefined
  return (entry) => {
    const kind = config.providers[entry.providerID]?.kind
    for (const s of rules) {
      const until = s.until ? ` until ${time(s.until)}` : ""
      if (s.deny.includes(entry.providerID)) return { reason: `the ${s.name} schedule shuts ${entry.providerID} out${until}`, until: s.until }
      if (kind && s.denyKinds.includes(kind)) return { reason: `the ${s.name} schedule shuts ${kind} providers out${until}`, until: s.until }
      if (s.allow && !s.allow.includes(entry.providerID)) return { reason: `the ${s.name} schedule allows only ${s.allow.join(", ") || "nothing"}${until}`, until: s.until }
    }
    return undefined
  }
}

/** What a schedule does, in words: `local first; no metered providers`. */
export function describeSchedule(s: Schedule): string {
  return [s.first.length ? `${s.first.join(", ")} first` : "", s.deny.length ? `no ${s.deny.join(", ")}` : "", s.denyKinds.length ? `no ${s.denyKinds.join(" or ")} providers` : "", s.allow ? `only ${s.allow.join(", ") || "nothing"}` : ""].filter(Boolean).join("; ")
}

/** For `route`: the entries a schedule puts ahead of the rest of the chain, named by provider or by kind. */
export function scheduleFirst(config: Config, active: ActiveSchedule[]): ((entry: ModelRef) => string | undefined) | undefined {
  const firsts = active.filter((s) => s.first.length)
  if (firsts.length === 0) return undefined
  return (entry) => {
    const kind = config.providers[entry.providerID]?.kind
    return firsts.find((s) => s.first.includes(entry.providerID) || (kind !== undefined && s.first.includes(kind)))?.name
  }
}
