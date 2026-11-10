# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-10

### Added

#### Routing

- Provider rules for Gemini, Vertex AI, OpenRouter, Azure OpenAI, Amazon Bedrock, Ollama Cloud, OpenCode Go and OpenCode Zen: their limit errors are recognised and given a reset time where there is one. Where a provider limits each model separately, a limit on one model no longer blocks the others.
- Project rules: `projects` in your settings, or `.opencode/quota-router.json` in a repository, shut providers or kinds of provider out for that project's sessions; your own settings can also give a project its chain.
- Schedules: rules that apply at certain times of the day or week, such as local models first after 18:00, or no pay-per-use providers at the weekend.
- Chains per agent (`agents`): `"agents": { "plan": "sonnet" }` or `/router agent plan sonnet` runs an agent's sessions on a chain of your choice.
- Save for later: `/router save <provider> 2h` (or "Save for 2 hours" on the dashboard) sets a provider aside until a time, so routing passes it over and its allowance is kept for when you want it.
- Pace guard (`pace`): subagents, and agents you list, pass over a plan that is on pace to run out, keeping what is left for the main session. Off by default.
- Spend caps for pay-per-use providers: `spend.dailyUsd`, `spend.monthlyUsd`, and the same per provider. A provider that has reached its cap is passed over until the day or month ends.
- Latency and health: time to first token and the error rate are recorded per provider and shown on the dashboard. A provider that keeps failing without being limited is passed over while another can run, and of two providers given the same priority the faster goes first.
- Chain updates: when a provider offers a newer model of the same line as a chain entry (Opus 5.5 → 5.6), the dashboard suggests replacing it, and an entry whose model is deprecated is flagged there and in the health check.
- Local model health: Ollama and LM Studio are asked whether they are running and what is loaded. A server that is not running is passed over rather than tried, the dashboard shows what is in memory, and the health check warns about a model too large for the machine.
- OpenRouter credit check (`openrouter.usageProbe`, off by default): reads how much of the key's spending limit is left from OpenRouter's key endpoint, shows it on the dashboard, and leaves OpenRouter when it is spent rather than at the first failed request. Free-model requests left today are tracked separately.
- xAI: the size of the weekly pool is estimated from the times it ran out, since xAI publishes no usage figures. The dashboard shows an estimated gauge and the forecast covers it.
- Copilot credits: an estimate of the credits each model has used this month, a forecast of when the allowance runs out, and an economy setting (`copilot.economyAtPct`) that keeps the last of the allowance for cheaper models.
- Copilot credits are estimated from recorded tokens while GitHub's own count lags, and reconciled to that count when it catches up. The estimate drives the cut-over, so a session spending credits quickly is moved off before the allowance runs out rather than minutes later, when the count updates. The dashboard and menu bar show the estimate, how many output, cached and cache-write tokens a credit has bought, and the allowance in tokens at that rate.
- The Claude plan (Pro, Max, Ultra, Team standard and premium seats, Enterprise) is read from Claude Code's login when the usage check is on, and shown on the dashboard and in the health check.
- A wait given in words in an error message ("retry after 26 seconds", "try again in 6m0s") is used when there is no `retry-after` header.

#### Seeing what it does

- Settings page on the dashboard (**⋯ → Settings**): change routing, cut-over points, usage checks, spending caps, notifications, telemetry identity and retention without editing files. Changes are checked, applied at once and kept over `opencode.jsonc`, which is never written; **Reset** goes back to it.
- Status line: the terminal's prompt footer shows the session's provider and how full its window is, the provider it fell back from and when that is back, and whether routing is paused or in a dry run (`statusLine`, on by default).
- Notifications for fallbacks, returns, every provider being limited, spend caps and failing usage checks: on the dashboard, in the menu bar, as toasts in the OpenCode terminal, and optionally through the operating system (`notifications.system`). Rate-limited, and each kind can be turned off.
- Efficiency figures on the dashboard: cache hit rate, tokens per tool call, failed request rate and time lost to limits, for the range shown.
- Forecasts: the dashboard and `/router doctor` say when a Claude, ChatGPT or Copilot window is on pace to run out before it resets.
- Plan advice (`/router advice` and a dashboard section): whether each subscription fits how it was used, from the local record of limits, usage checks and pay-per-use spend.
- `/router doctor` and a Health check section on the dashboard: connected providers, chains with no fallback, models a provider no longer offers, failing usage checks, and what to change. The note left in the session lists only what needs attention (`/router doctor full` for everything), and the Health check and Plan advice sections can be hidden.
- Accessibility: the dashboard can be used from the keyboard and with a screen reader (skip link, menu keys, a summary and data table for each chart, actions announce whether they worked), text meets WCAG AA contrast in both schemes, and numbers and money follow the browser's language. A failed action now says so instead of doing nothing.
- OpenTelemetry export (`telemetry`): tokens, costs, requests, fallbacks, time limited and plan utilisation as OTLP/HTTP JSON metrics, and optionally one log record per limit, switch and recovery. Off by default; identity and project attributes are opt-in; the standard `OTEL_*` variables are honoured. See `docs/telemetry.md`.

#### Other tools

- Command line: `quota-router usage` totals tokens and their value at API prices from Claude Code, Codex and OpenCode logs on this machine; `limits` shows plan windows (Codex from its logs, others from the plugin); `status`, `doctor` and `open` talk to the running plugin; `prompt` prints the status line for a shell prompt. Logs are read incrementally with a private cache.
- LiteLLM callback (`integrations/litellm/quota_router.py`): the plugin's limit classifier in one Python file, for a LiteLLM Router or Proxy. A deployment that hits a limit is set aside until it resets. Tested against the plugin's classifier cases and in a real LiteLLM Router.
- Claude Code Router routing rule (experimental, `integrations/claude-code-router`): a CCR Node.js script rule that starts requests on a provider quota-router knows has room and puts limited ones at the end of CCR's fallback chain.
- The routing engine has its own entry point, `opencode-quota-router/engine`, with no dependency on OpenCode.

#### Running it

- Dry run: `/router dry-run on` records what routing would do, as "Would: …" rows in the routing log, without moving a session or changing a retry.
- Settings can be changed while OpenCode runs. They are stored in the plugin's database on top of `opencode.jsonc`, which is never written to.
- Support matrix (`docs/support.md`) and contract tests against the OpenCode plugin API: the type check fails when a hook, event or context method the plugin uses changes shape. CI also runs on macOS.

### Changed

- Routing counts the cost of a move (`switching`): a session that was just moved stays for three minutes before returning up the chain, a session with a large context waits up to a minute on a throttle before moving, and the routing log says how much context each move sends again.
- Installing from npm is now the recommended way: `"package": "opencode-quota-router"` in `opencode.jsonc`. The menu bar part and the command line ship built in `dist/`.
- Node.js is only needed for the command line and to build from source.

### Fixed

- The terminal part (status line and toasts) loads from the installed npm package, and finds the dashboard when its port was changed in `opencode.jsonc`: the server part notes the address in `dashboard.json`, since the terminal part doesn't receive the plugin's options.
- A second OpenCode with its own data folder keeps its own dashboard, instead of showing the first one's.
- `quota-router usage` values new models such as Fable 5.2: it uses the list prices OpenCode gives the plugin, which the plugin keeps in `prices.json`, before OpenCode's catalogue file, which can be weeks old.
- `quota-router usage` no longer counts OpenCode's Claude subscription requests twice. They run through Claude Code's Agent SDK, which logs them in Claude Code's folder as well; such sessions are now counted once, as OpenCode's.
- The Claude subscription's model aliases (`opus`, `fable`) are valued at the newest model of their family with a list price, not a fixed one; `fable` had still pointed at Fable 5.1.

### Security

- Dashboard writes are refused when the browser says they came from another site, and settings changes need a token only the dashboard page has.
- GitHub Actions are pinned to commit SHAs and no longer keep credentials after checkout.
- Releases are published from GitHub Actions with npm trusted publishing and provenance; no npm token is stored.

## [0.1.0] - 2026-11-09

First public release.

### Added

- Fallback inside OpenCode's retry hook: a request that hits a limit runs again on the next provider in its chain, keeping its effort level.
- Recovery at the start of each turn, once a limit has reset.
- Error classifier for the Claude subscription, ChatGPT plans, GitHub Copilot, xAI, the Anthropic API and the OpenAI API, with exact reset times wherever the provider gives one.
- Pool health shared across sessions and kept across restarts, with backoff and half-open retries.
- Optional usage checks: Claude 5-hour and weekly windows, Copilot monthly credits, and ChatGPT windows from response headers. Routing leaves a plan before usage credits or paid overage are drawn.
- Discovery of every connected provider, labelled subscription, pay-per-use or local, with chain suggestions on the dashboard.
- Local models (Ollama, LM Studio, vLLM) as a free last resort.
- Per-provider chain overrides: `"chains": { "opus": { "xai": "grok-4.6#high" } }`.
- Local dashboard with totals, the route, running sessions, a routing log, usage charts, breakdowns, session search and CSV export.
- macOS menu bar item for OpenCode Desktop.
- SQLite storage with daily rollups and retention, sized for years of history, and a one-time import of earlier OpenCode usage.

[0.2.0]: https://github.com/aicowboi/opencode-quota-router/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/aicowboi/opencode-quota-router/releases/tag/v0.1.0
