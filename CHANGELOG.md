# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - Unreleased

### Added

- Provider rules for Gemini, Vertex AI, OpenRouter, Azure OpenAI, Amazon Bedrock, Ollama Cloud, OpenCode Go and OpenCode Zen: their limit errors are recognised and given a reset time where there is one. Where a provider limits each model separately, a limit on one model no longer blocks the others.
- OpenRouter credit check (`openrouter.usageProbe`, off by default): reads how much of the key's spending limit is left from OpenRouter's key endpoint, shows it on the dashboard, and leaves OpenRouter when it is spent rather than at the first failed request. Free-model requests left today are tracked separately.
- A wait given in words in an error message ("retry after 26 seconds", "try again in 6m0s") is used when there is no `retry-after` header.
- Forecasts: the dashboard and `/router doctor` say when a Claude, ChatGPT or Copilot window is on pace to run out before it resets.
- Pace guard (`pace`): subagents, and agents you list, pass over a plan that is on pace to run out, keeping what is left for the main session. Off by default.
- Plan advice (`/router advice` and a dashboard section): whether each subscription fits how it was used, from the local record of limits, usage checks and pay-per-use spend.
- The Claude plan (Pro, Max, Ultra, Team standard and premium seats, Enterprise) is read from Claude Code's login when the usage check is on, and shown on the dashboard and in the health check.
- Copilot credits: an estimate of the credits each model has used this month, a forecast of when the allowance runs out, and an economy setting (`copilot.economyAtPct`) that keeps the last of the allowance for cheaper models.
- Chains per agent (`agents`): `"agents": { "plan": "sonnet" }` or `/router agent plan sonnet` runs an agent's sessions on a chain of your choice.
- Save for later: `/router save <provider> 2h` (or "Save for 2 hours" on the dashboard) sets a provider aside until a time, so routing passes it over and its allowance is kept for when you want it.
- Dry run: `/router dry-run on` records what routing would do, as "Would: …" rows in the routing log, without moving a session or changing a retry.
- OpenTelemetry export (`telemetry`): tokens, costs, requests, fallbacks, time limited and plan utilisation as OTLP/HTTP JSON metrics, and optionally one log record per limit, switch and recovery. Off by default; identity and project attributes are opt-in; the standard `OTEL_*` variables are honoured. See `docs/telemetry.md`.
- Notifications for fallbacks, returns, every provider being limited, spend caps and failing usage checks: on the dashboard, in the menu bar, as toasts in the OpenCode terminal, and optionally through the operating system (`notifications.system`). Rate-limited, and each kind can be turned off.
- Spend caps for pay-per-use providers: `spend.dailyUsd`, `spend.monthlyUsd`, and the same per provider. A provider that has reached its cap is passed over until the day or month ends.
- `/router doctor` and a Health check section on the dashboard: connected providers, chains with no fallback, models a provider no longer offers, failing usage checks, and what to change.
- Settings can be changed while OpenCode runs. They are stored in the plugin's database on top of `opencode.jsonc`, which is never written to.
- The routing engine has its own entry point, `opencode-quota-router/engine`, with no dependency on OpenCode.

### Changed

- Routing counts the cost of a move (`switching`): a session that was just moved stays for three minutes before returning up the chain, a session with a large context waits up to a minute on a throttle before moving, and the routing log says how much context each move sends again.
- GitHub Actions are pinned to commit SHAs and no longer keep credentials after checkout.

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

[0.1.0]: https://github.com/aicowboi/opencode-quota-router/releases/tag/v0.1.0
