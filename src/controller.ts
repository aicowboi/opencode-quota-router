// Routing decisions wired to OpenCode hooks and events.
import { classify } from "./engine/classify.ts"
import { refKey, refLabel } from "./engine/config.ts"
import type { Core, SessionState } from "./core.ts"
import { orderedChain, route } from "./engine/router.ts"
import type { CodexWindow } from "./engine/headers.ts"
import type { ModelRef, SessionError } from "./engine/types.ts"

const same = (a?: ModelRef, b?: ModelRef, variant = true) =>
  !!a && !!b && a.providerID === b.providerID && a.id === b.id && (!variant || (a.variant ?? "default") === (b.variant ?? "default"))

type RetryEvent = {
  sessionID: string
  model: ModelRef
  error: SessionError
  attempt: number
  decision: { retry: false } | { retry: true; delay: number }
}

/**
 * Retry hook. Runs after OpenCode classifies a failed request, before it schedules a retry. Short throttles retry
 * in place; anything longer moves the request to the next provider, and OpenCode re-runs it on the new model.
 */
export async function onRetry(core: Core, e: RetryEvent) {
  const decision = e.decision
  await decideRetry(core, e)
  // Dry run: the decision is recorded, and OpenCode's own retry is left as it was.
  if (core.config.dryRun) e.decision = decision
}

async function decideRetry(core: Core, e: RetryEvent) {
  if (!core.config.enabled || core.paused) return
  const now = Date.now()
  const s = core.session(e.sessionID)
  const fromKey = refLabel(e.model)
  // Two plugin instances can each register this hook; act once per attempt.
  if (s.lastRetry && s.lastRetry.attempt === e.attempt && s.lastRetry.from === fromKey && now - s.lastRetry.at < 10_000) return
  const signal = classify(e.model.providerID, e.model.id, e.error, now)
  core.log.debug("retry", { sessionID: e.sessionID, model: fromKey, error: e.error.type, status: e.error.status, attempt: e.attempt, kind: signal?.kind })
  if (!signal) return

  if (signal.kind === "throttle" || signal.kind === "overload") {
    const wait = signal.retryAfterMs ?? (e.decision.retry ? e.decision.delay : 0)
    const allowed = signal.kind === "throttle" ? core.config.throttle.inPlaceRetries : core.config.overload.inPlaceRetries
    // A large context costs more to send again elsewhere than a longer wait costs here.
    const large = (s.lastInputTokens ?? 0) >= core.config.switching.largeContextTokens
    const patience = large ? Math.max(core.config.throttle.maxWaitMs, core.config.switching.largeContextMaxWaitMs) : core.config.throttle.maxWaitMs
    if (e.decision.retry && wait <= patience && e.attempt <= allowed + 1) return
  }

  s.lastRetry = { attempt: e.attempt, from: fromKey, at: now }
  s.dryLast = undefined
  core.pools.report(signal)
  if (!s.preferred && !s.pinned) await core.initSession(s)
  s.current ??= e.model
  if (!s.preferred || s.pinned) {
    // Not ours to route. Still stop OpenCode waiting up to 15 minutes per attempt on a window that will not reset soon.
    if (e.decision.retry && (signal.kind === "window" || signal.kind === "billing")) e.decision = { retry: false }
    return
  }
  await core.refreshModels()
  const r = route({ config: core.config, pools: core.pools, models: core.models, preferred: s.preferred, lastInputTokens: s.lastInputTokens, gate: core.gate(s), mode: "failover", exclude: new Set(signal.pools) })
  if (r.target) {
    try {
      await core.switchTo(s, r.target, "failover", signal)
      e.decision = { retry: true, delay: 0 }
    } catch (error) {
      core.log.error("switch failed", { sessionID: s.id, error: String(error) })
    }
    return
  }
  if (core.config.onExhausted.mode === "wait" && r.earliest) {
    const delay = Math.max(1_000, Math.min(r.earliest - now, core.config.onExhausted.maxWaitMs))
    if (r.next && !same(r.next, s.current)) await core.switchTo(s, r.next, "wait", signal, `Every provider is limited; waiting for ${refLabel(r.next)}`).catch(() => {})
    e.decision = { retry: true, delay }
    core.recordRouting({ sessionID: s.id, trigger: "wait", signal, until: now + delay, evidence: `All providers limited; retrying in ${Math.round(delay / 60_000)} min` })
    return
  }
  e.decision = { retry: false }
  core.recordRouting({ sessionID: s.id, trigger: "exhausted", signal, evidence: `All providers limited: ${r.skipped.join("; ")}` })
}

/**
 * Prompt hook. Runs when a user turn is admitted, before OpenCode resolves the model. Moves the session to the
 * best provider available right now: back up the chain when a window has reset, or off a provider that a usage
 * check says is spent.
 */
export async function onPrompt(core: Core, e: { sessionID: string; metadata?: Record<string, unknown> }) {
  core.lastActivity = Date.now()
  if (!core.config.enabled || core.paused || e.metadata?.quotaRouter) return
  const s = core.session(e.sessionID)
  if (!s.preferred && !s.current) await core.initSession(s)
  if (!s.preferred || s.pinned) return
  await core.refreshModels()
  const providers = [...new Set(orderedChain(core.config, s.preferred.chain).map((r) => r.providerID))]
  await core.freshUsage(providers)
  const r = route({ config: core.config, pools: core.pools, models: core.models, preferred: s.preferred, lastInputTokens: s.lastInputTokens, gate: core.gate(s), mode: "turn" })
  if (!r.target || same(r.target, s.current)) return
  const chain = orderedChain(core.config, s.preferred.chain)
  const currentIndex = s.current ? chain.findIndex((c) => c.providerID === s.current!.providerID && c.id === s.current!.id) : -1
  const trigger = currentIndex !== -1 && r.index < currentIndex ? "recovery" : currentIndex === -1 ? "route" : "preempt"
  // Each move sends the whole context again, so a session that has just been moved stays put for a few minutes.
  if (trigger === "recovery" && s.movedAt && Date.now() - s.movedAt < core.config.switching.minStayMs && core.canStay(s)) return
  const evidence =
    trigger === "recovery"
      ? r.usable === "trial"
        ? `Trying ${refLabel(r.target)} again after its cooldown`
        : `${refLabel(r.target)} is available again`
      : r.skipped.length
        ? r.skipped.join("; ")
        : s.byAgent && trigger === "route"
          ? `The ${s.agent} agent uses the ${s.preferred.chain} chain`
          : undefined
  if (core.config.dryRun) {
    const key = `${trigger} ${refLabel(r.target)}`
    if (s.dryLast === key) return
    s.dryLast = key
  }
  await core.switchTo(s, r.target, trigger, undefined, evidence).catch((error) => core.log.error("switch failed", { sessionID: s.id, error: String(error) }))
}

/** Event stream: track models, successes, manual switches, and recover failed executions. */
export async function onEvent(core: Core, ev: { id: string; type: string; created: number; data: Record<string, any> }) {
  const d = ev.data ?? {}
  const sid: string | undefined = d.sessionID
  switch (ev.type) {
    case "session.created": {
      const s = core.session(sid!)
      s.parentID = d.parentID
      if (d.model?.providerID && !s.current) {
        s.current = d.model
        s.preferred ??= core.preferredFor(d.model)
      }
      core.setAgent(s, d.agent)
      // An agent with its own chain starts on that chain, not on the model the session was created with.
      if (s.byAgent) void onPrompt(core, { sessionID: s.id })
      return
    }
    case "session.agent.selected": {
      core.setAgent(core.session(sid!), d.agent, true)
      return
    }
    case "session.model.selected": {
      const s = core.session(sid!)
      const mine = s.pending.findIndex((p) => same(p.model, d.model, false))
      if (mine !== -1) {
        s.pending.splice(mine, 1)
        s.current = d.model
        return
      }
      // A change we did not make is the user's choice: it sets the session's chain and effort level.
      s.current = d.model
      s.fallback = undefined
      s.movedAt = undefined
      s.picked = true
      s.byAgent = false
      s.preferred = core.preferredFor(d.model)
      core.savePrefs(s)
      core.recordRouting({ sessionID: sid, trigger: "manual", to: d.model, from: d.previous, evidence: s.preferred ? `Routing follows the ${s.preferred.chain} chain (use /router pin to stay on this provider)` : "Model is in no chain; routing paused for this session" })
      return
    }
    case "session.step.started": {
      core.lastActivity = Date.now()
      const s = core.session(sid!)
      s.stepModel = d.model
      s.current = d.model
      if (!s.preferred && !s.pinned && d.model?.providerID && !core.store.get("SELECT 1 FROM session_prefs WHERE id = ?", sid)) s.preferred = core.preferredFor(d.model)
      core.setAgent(s, d.agent)
      return
    }
    case "session.step.ended": {
      const s = core.session(sid!)
      const t = d.tokens
      if (t) s.lastInputTokens = Number(t.input ?? 0) + Number(t.cache?.read ?? 0) + Number(t.cache?.write ?? 0)
      if (s.stepModel) core.pools.success(core.poolsFor(s.stepModel))
      // Keep the Copilot credit count live while Copilot is in use (rate-limited inside the probe).
      if (s.stepModel?.providerID === "github-copilot") void core.probeCopilot()
      return
    }
    case "session.execution.failed":
      return resumeAfterFailure(core, ev)
    case "credential.switched":
      // Another account or plan on the same provider: its limits are not the old one's.
      if (typeof d.integrationID === "string") core.resetProvider(d.integrationID, "credential switched")
    // falls through
    case "credential.updated":
    case "integration.updated":
      for (const p of core.pools.all()) if (p.kind === "auth") core.pools.reset(p.id, "credential updated")
      await core.refreshModels(true)
      return
    case "model.updated":
    case "provider.updated":
      await core.refreshModels(true)
      return
  }
}

/**
 * Safety net for failures the retry hook could not move (attempts exhausted, or no provider was free at the time).
 * Re-checks the session, switches model and continues once, with a fixed message ID so it can never run twice.
 */
async function resumeAfterFailure(core: Core, ev: { id: string; data: Record<string, any> }) {
  const sid: string = ev.data.sessionID
  const error = ev.data.error as SessionError | undefined
  const s = core.session(sid)
  if (!error || !s.preferred || s.pinned || core.paused || !core.config.enabled || s.resumed.has(ev.id)) return
  const model = s.stepModel ?? s.current
  if (!model) return
  const signal = classify(model.providerID, model.id, error, Date.now())
  if (!signal) return
  s.resumed.add(ev.id)
  core.pools.report(signal)
  s.resumes = s.resumes.filter((t) => Date.now() - t < 3_600_000)
  if (s.resumes.length >= 3) {
    core.recordRouting({ sessionID: sid, trigger: "gave-up", signal, evidence: "Three automatic continuations in the last hour; leaving the session for you" })
    return
  }
  const r = route({ config: core.config, pools: core.pools, models: core.models, preferred: s.preferred, lastInputTokens: s.lastInputTokens, gate: core.gate(s), mode: "failover", exclude: new Set(signal.pools) })
  if (r.target) return continueOn(core, s, r.target, ev.id, signal.evidence)
  if (core.config.onExhausted.mode !== "wait" || !r.earliest || !r.next) {
    core.recordRouting({ sessionID: sid, trigger: "exhausted", signal, evidence: `All providers limited: ${r.skipped.join("; ")}` })
    return
  }
  // Nothing free now: continue when the first provider resets, if the session is still where we left it.
  const at = r.earliest
  const next = r.next
  s.deferred = { at, executionEventID: ev.id }
  core.recordRouting({ sessionID: sid, trigger: "deferred", signal, until: at, to: next, evidence: `All providers limited; continuing on ${refLabel(next)} at ${new Date(at).toLocaleTimeString()}` })
  const timer = setTimeout(async () => {
    if (s.deferred?.executionEventID !== ev.id) return
    s.deferred = undefined
    const latest = core.store.get<{ id: string }>("SELECT id FROM executions WHERE session_id = ? ORDER BY started_at DESC LIMIT 1", sid)
    const deleted = core.store.get<{ deleted_at: number | null }>("SELECT deleted_at FROM sessions WHERE id = ?", sid)?.deleted_at
    // Only if nothing happened in the session since the failure.
    if (deleted || core.recorder.live.has(sid) || (latest && core.store.get<{ outcome: string }>("SELECT outcome FROM executions WHERE id = ?", latest.id)?.outcome !== "failed")) return
    await continueOn(core, s, next, ev.id, "Provider window reset")
  }, Math.max(1_000, at - Date.now()))
  ;(timer as { unref?: () => void }).unref?.()
}

async function continueOn(core: Core, s: SessionState, target: ModelRef, eventID: string, reason: string) {
  try {
    if (!same(target, s.current)) await core.switchTo(s, target, "resume", undefined, reason)
    if (core.config.dryRun) return
    s.resumes.push(Date.now())
    await core.ctx.session.synthetic({
      sessionID: s.id,
      id: `msg_qr${eventID.replace(/^evt_/, "")}`,
      text: `[quota-router] The previous provider stopped (${reason}). Now on ${refLabel(target)}. Continue the task from where it stopped; do not repeat completed work.`,
      metadata: { quotaRouter: true },
      resume: true,
    })
  } catch (error) {
    core.log.error("resume failed", { sessionID: s.id, error: String(error) })
  }
}

/** ChatGPT plan windows from `x-codex-*` headers, on any response that carries them. */
export function onCodexResponse(core: Core, e: { model: ModelRef; response: Response }, read: (h: Headers, now: number) => CodexWindow[]) {
  if (e.model.providerID !== "openai" || !core.chatgptActive()) return
  const now = Date.now()
  core.applyChatgpt(read(e.response.headers, now), now)
}

/** Headroom from rate-limit headers on successful responses, for providers listed in `headers.observe`. */
export function onHttpResponse(core: Core, e: { model: ModelRef; response: Response }, read: (h: Headers, now: number) => { remainingPct: number; resetAt?: number } | undefined) {
  if (e.response.status >= 400) return
  const now = Date.now()
  const h = read(e.response.headers, now)
  if (!h) return
  const exhausted = h.remainingPct <= 0
  core.pools.usage(e.model.providerID, {
    utilization: Math.round(100 - h.remainingPct),
    resetAt: h.resetAt,
    exhausted,
    warn: h.remainingPct <= core.config.headers.warnRemainingPct,
    evidence: exhausted ? `${refKey(e.model)} rate limit used up` : `${Math.round(h.remainingPct)}% of rate limit left`,
  })
}
