// AI-assisted onboarding. Uses OpenCode's stateless generation API: no sessions, tools, credentials or user content.
// A proposal is stored separately from the active preset, and applying it never edits opencode.jsonc.
import { createHash, randomUUID } from "node:crypto"
import type { Core } from "./core.ts"
import { loadConfig, overlay, parseRef, refKey, type Config } from "./engine/config.ts"
import { eligibleModels, GOALS, INTELLIGENT_CHAIN, parseRecommendation, recommendationPrompt, withIntelligentRoute, type Recommendation, type RoutingGoal } from "./engine/intelligent.ts"
import { modelPools } from "./engine/classify.ts"
import type { ModelRef } from "./engine/types.ts"
import type { DefaultInspection } from "./default-model.ts"

type DefaultModel = { providerID: string; modelID: string }
type DefaultEditor = { default: { get(): DefaultModel | undefined; set(providerID: string, modelID: string): void }; get(providerID: string, modelID: string): { enabled?: boolean } | undefined }
type AnalyzeInput = { analyzer: string; goal: RoutingGoal; includeMetered: boolean; allowMeteredAnalysis: boolean; setup: boolean; force?: boolean }

export class IntelligentRouting {
  private core: Core
  private defaults = new Map<unknown, string | undefined>()
  private registryDefaults = new Map<unknown, DefaultModel | undefined>()
  private documentDefaults = new Map<unknown, DefaultInspection>()
  readonly reloaders = new Set<() => Promise<void>>()
  private controller?: AbortController
  private stopped = false
  analyzing = false
  error?: string

  constructor(core: Core) { this.core = core }

  captureDefault(ctx: unknown, model: DefaultModel | undefined) {
    this.registryDefaults.set(ctx, model)
    model = this.documentDefaults.get(ctx)?.model ?? model
    const ref = model ? `${model.providerID}/${model.modelID}` : undefined
    const changed = !this.defaults.has(ctx) || this.defaults.get(ctx) !== ref
    this.defaults.set(ctx, ref)
    if (changed) {
      this.core.notify("intelligent")
      // A user changing the configured default outranks an older preset. Leave the synchronous model transform
      // before rebuilding the plugin's routing view, so registry reads cannot recurse through this callback.
      queueMicrotask(() => { if (!this.stopped) this.core.rebuildConfig() })
    }
  }

  captureConfiguredDefault(ctx: unknown, inspection: DefaultInspection) {
    this.documentDefaults.set(ctx, inspection)
    this.captureDefault(ctx, this.registryDefaults.get(ctx))
  }

  forgetDefault(ctx: unknown) { this.defaults.delete(ctx); this.registryDefaults.delete(ctx); this.documentDefaults.delete(ctx) }
  private defaultKnown() { return [...this.documentDefaults.values()].every((d) => d.known) }

  transformDefault(ctx: unknown, editor: DefaultEditor) {
    const registry = editor.default.get()
    this.captureDefault(ctx, registry)
    const existing = this.documentDefaults.get(ctx)?.model ?? registry
    const recommended = this.defaultFor(existing)
    const model = recommended && editor.get(recommended.providerID, recommended.id)
    if (recommended && model && model.enabled !== false) editor.default.set(recommended.providerID, recommended.id)
  }

  configuredDefault() {
    return this.defaults.get(this.core.ctx) ?? [...this.defaults.values()].find((ref) => ref !== undefined)
  }

  /** Fail closed: an unknown default or any deliberate routing setup is never silently replaced during onboarding. */
  hasExistingSetup() {
    const hasOptions = (value: unknown) => !!value && typeof value === "object" && Object.keys(value).length > 0
    return this.defaults.size === 0 || !this.defaultKnown() || !!this.configuredDefault() || hasOptions(this.core.options) || hasOptions(this.core.storedSettings()) ||
      Object.keys(this.core.chainAdditions()).length > 0 || Object.keys(this.core.chainReplacements()).length > 0 || !!this.core.store.meta("intelligent_onboarded")
  }

  private readPlan(key: string): Recommendation | undefined {
    const raw = this.core.metaJSON<any>(key, null)
    if (!raw || typeof raw.id !== "string" || !Number.isFinite(raw.at) || typeof raw.analyzer !== "string" || !GOALS.includes(raw.goal) || typeof raw.includeMetered !== "boolean" || typeof raw.fingerprint !== "string" || typeof raw.summary !== "string" || !Array.isArray(raw.entries) || raw.entries.length < 1 || raw.entries.length > 8) return undefined
    try {
      if (raw.entries.some((e: any) => !e || typeof e.ref !== "string" || typeof e.reason !== "string" || !parseRef(e.ref))) return undefined
      return raw as Recommendation
    } catch { return undefined }
  }

  candidate() { return this.readPlan("intelligent_candidate") }
  private chainConflict() { return Object.hasOwn(loadConfig(overlay(this.core.options, this.core.storedSettings())).config.chains, INTELLIGENT_CHAIN) }
  active() {
    const plan = this.readPlan("intelligent_active"), current = this.configuredDefault()
    if (!this.defaultKnown() || this.chainConflict() || (plan && current && refKey(parseRef(plan.entries[0]!.ref)) !== current)) return undefined
    return plan
  }
  applyToConfig(config: Config) { return withIntelligentRoute(config, this.active()) }

  fingerprint() {
    return createHash("sha256").update(JSON.stringify({ catalogue: eligibleModels(this.core.config, this.core.models), existingDefault: this.configuredDefault(), defaultKnown: this.defaultKnown() })).digest("hex")
  }

  /** Only fills a genuinely unset OpenCode default. A configured default, including another plugin's, always wins. */
  defaultFor(existing: DefaultModel | undefined): ModelRef | undefined {
    if (existing || this.configuredDefault() || !this.defaultKnown() || !this.core.config.enabled || this.core.config.dryRun || this.core.paused) return undefined
    for (const entry of this.active()?.entries ?? []) {
      const ref = parseRef(entry.ref)
      if (this.core.models.has(refKey(ref)) && this.core.config.providers[ref.providerID]?.allow !== "never") return ref
    }
    return undefined
  }

  private blocked(ref: ModelRef): string | undefined {
    if (modelPools(ref.providerID, ref.id).some((id) => this.core.pools.usable(id) === "no")) return "This provider is currently limited. Choose another analysis model."
    return this.core.gate()?.(ref)?.reason
  }

  state() {
    const catalogue = eligibleModels(this.core.config, this.core.models)
    const candidate = this.candidate(), active = this.active()
    const fingerprint = this.fingerprint()
    const kindRank = { subscription: 0, local: 1, metered: 2 }
    const analyzers = catalogue.map((m) => ({ ...m, blocked: this.blocked(parseRef(m.ref)) }))
      .sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || Number(!!a.blocked) - Number(!!b.blocked) || (a.outputUsdPerMillion ?? Infinity) - (b.outputUsdPerMillion ?? Infinity) || a.ref.localeCompare(b.ref))
    const current = this.configuredDefault()
    const preferred = analyzers.find((m) => m.ref === current && m.kind !== "metered" && !m.blocked) ?? analyzers.find((m) => !m.blocked)
    return {
      available: typeof this.core.ctx?.experimental?.generate?.text === "function",
      mode: active ? "intelligent" : "manual",
      onboarded: !!this.core.store.meta("intelligent_onboarded"), existingSetup: this.hasExistingSetup(), configuredDefault: current,
      defaultKnown: this.defaultKnown(),
      analyzing: this.analyzing, error: this.error, analyzers, suggestedAnalyzer: preferred?.ref,
      providers: new Set(catalogue.map((m) => parseRef(m.ref).providerID)).size, models: catalogue.length,
      candidate, active, stale: !!candidate && candidate.fingerprint !== fingerprint,
    }
  }

  async analyze(input: AnalyzeInput): Promise<Recommendation> {
    if (this.stopped) throw new Error("The plugin is reloading. Try again once it is ready.")
    if (this.analyzing) throw new Error("An analysis is already running. Please wait for it to finish.")
    if (typeof input.analyzer !== "string" || !GOALS.includes(input.goal) || typeof input.includeMetered !== "boolean" || typeof input.allowMeteredAnalysis !== "boolean" || typeof input.setup !== "boolean" || (input.force !== undefined && typeof input.force !== "boolean")) throw new Error("Choose a connected analysis model and a routing goal.")
    const generate = this.core.ctx?.experimental?.generate?.text
    if (typeof generate !== "function") throw new Error("This OpenCode version does not provide stateless AI analysis. Manual routes still work.")
    let analyzer: ModelRef
    try { analyzer = parseRef(input.analyzer) } catch { throw new Error("Choose an available analysis model.") }
    const catalogue = eligibleModels(this.core.config, this.core.models)
    const model = catalogue.find((m) => m.ref === refKey(analyzer))
    if (!model || (analyzer.variant && !model.variants.includes(analyzer.variant))) throw new Error("That analysis model is not available. Refresh and choose another.")
    if (model.kind === "metered" && !input.allowMeteredAnalysis) throw new Error("This analysis uses a pay-per-use API. Confirm that charge before running it, or choose an included model.")
    const block = this.blocked(analyzer)
    if (block) throw new Error(block)
    if (!catalogue.some((m) => input.includeMetered || m.kind !== "metered" || m.ref === this.configuredDefault())) throw new Error("No included or local model is available for the route. Allow pay-per-use alternatives or connect a subscription first.")
    const fingerprint = this.fingerprint()
    const cached = this.candidate()
    if (!input.force && cached?.fingerprint === fingerprint && cached.analyzer === input.analyzer && cached.goal === input.goal && cached.includeMetered === input.includeMetered) {
      if (input.setup && !this.hasExistingSetup()) await this.activate(cached)
      return cached
    }
    const canOnboard = input.setup && !this.hasExistingSetup()
    this.analyzing = true; this.error = undefined
    this.controller = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(60_000)])
    this.core.notify("intelligent")
    try {
      let response: { text?: unknown }
      try {
        response = await generate({ model: analyzer, prompt: recommendationPrompt(catalogue, input.goal, input.includeMetered, this.configuredDefault()) }, { signal })
      } catch {
        throw new Error(signal.aborted ? "The analysis was cancelled or took longer than a minute. Nothing was changed." : "The selected provider could not finish the analysis. Nothing was changed; check its connection or choose another model.")
      }
      if (this.stopped || signal.aborted) throw new Error("The analysis was cancelled. Nothing was changed.")
      if (fingerprint !== this.fingerprint()) throw new Error("Your providers, models or default changed during the analysis. Nothing was changed; run it again with the new setup.")
      const parsed = parseRecommendation(typeof response?.text === "string" ? response.text : "", catalogue, input.includeMetered, this.configuredDefault())
      const plan: Recommendation = { ...parsed, id: randomUUID(), at: Date.now(), analyzer: input.analyzer, goal: input.goal, includeMetered: input.includeMetered, fingerprint }
      this.core.store.setMeta("intelligent_candidate", JSON.stringify(plan))
      this.core.log.info("routing analysis", { analyzer: input.analyzer, goal: input.goal, entries: plan.entries.length })
      // Only the deliberate onboarding button, on a still-untouched setup, may adopt a new default automatically.
      if (canOnboard && !this.hasExistingSetup()) await this.activate(plan)
      return plan
    } catch (error) {
      this.error = error instanceof Error ? error.message : "The analysis could not finish. Nothing was changed."
      throw new Error(this.error)
    } finally {
      this.analyzing = false; this.controller = undefined
      if (!this.stopped) this.core.notify("intelligent")
    }
  }

  async apply(id: unknown) {
    if (this.analyzing) throw new Error("Wait for the analysis to finish before applying it.")
    const plan = this.candidate()
    if (!plan || id !== plan.id) throw new Error("That recommendation is no longer current. Review the latest one first.")
    await this.activate(plan)
  }

  private async activate(plan: Recommendation) {
    if (!this.defaultKnown()) throw new Error("The existing default cannot be verified from your configuration sources. Nothing was changed; keep manual routing until it can be verified.")
    if (this.chainConflict()) throw new Error(`You already have a custom route named ${INTELLIGENT_CHAIN}. It was not replaced; rename it before applying this preset.`)
    if (plan.fingerprint !== this.fingerprint()) throw new Error("Your setup changed since this recommendation. Analyze it again before applying.")
    // Check saved data again against the current inventory and policy; no raw model response becomes configuration.
    parseRecommendation(JSON.stringify({ summary: plan.summary, entries: plan.entries }), eligibleModels(this.core.config, this.core.models), plan.includeMetered, this.configuredDefault())
    this.core.store.transaction(() => {
      this.core.store.setMeta("intelligent_active", JSON.stringify(plan))
      this.core.store.setMeta("intelligent_onboarded", "1")
    })
    this.error = undefined
    this.core.rebuildConfig()
    await this.reloadDefaults()
    this.core.notify("intelligent")
  }

  async manual() {
    if (this.analyzing) throw new Error("Wait for the analysis to finish before changing routing mode.")
    this.core.store.transaction(() => {
      this.core.store.setMeta("intelligent_active", "null")
      this.core.store.setMeta("intelligent_onboarded", "1")
    })
    this.error = undefined
    this.core.rebuildConfig()
    await this.reloadDefaults()
    this.core.notify("intelligent")
  }

  async reloadDefaults() { await Promise.all([...this.reloaders].map((reload) => reload().catch(() => this.core.log.warn("could not refresh the recommended default")))) }
  stop() { this.stopped = true; this.controller?.abort(); this.reloaders.clear() }
}
