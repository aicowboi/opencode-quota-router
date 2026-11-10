# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - Unreleased

### Added

- Dry run: `/router dry-run on` records what routing would do, as "Would: …" rows in the routing log, without moving a session or changing a retry.
- `/router doctor` and a Health check section on the dashboard: connected providers, chains with no fallback, models a provider no longer offers, failing usage checks, and what to change.
- Settings can be changed while OpenCode runs. They are stored in the plugin's database on top of `opencode.jsonc`, which is never written to.
- The routing engine has its own entry point, `opencode-quota-router/engine`, with no dependency on OpenCode.

### Changed

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
