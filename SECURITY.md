# Security and privacy

quota-router runs entirely on your machine. It has no analytics and no server of its own, and it sends nothing about your usage anywhere unless you turn on the optional OpenTelemetry export and give it an endpoint.

## What it reads

| Data | When | Why |
|---|---|---|
| OpenCode session events (models, token counts, timings, session titles) | Always | Routing decisions and the dashboard |
| OpenCode's own database, read-only | Once, on first start (`backfill`) | Import earlier usage into the dashboard |
| Claude Code's login from the macOS keychain (or `~/.claude/.credentials.json`) | Only with `claude.usageProbe: true` | Read your Claude subscription windows from the endpoint Claude Code's `/usage` uses. The token is never stored, logged or refreshed. |
| OpenCode's stored GitHub Copilot login | Only with `copilot.usageProbe: true` | Read your Copilot monthly allowance |
| OpenCode's stored OpenRouter key, or `OPENROUTER_API_KEY` | Only with `openrouter.usageProbe: true` | Read how much of the key's spending limit is left. The key is sent only to `openrouter.ai`, and is never stored or logged; the key's label is discarded. |
| `.opencode/quota-router.json` in the session's directory or the nearest parent that has one | When a session runs there | Project rules. The file is treated as untrusted: at most 32 KB, parsed as JSON, and only able to shut providers out of routing. It cannot choose a chain, change a setting, or make quota-router contact anything. |
| The list of installed and loaded models from Ollama or LM Studio on this machine | When one of them is connected (`local.healthCheck`, on by default) | Pass a server over while it is not running, and show what is loaded. The address is `127.0.0.1` unless you set another in `opencode.jsonc`; it cannot be changed from the dashboard. |
| Rate-limit response headers from configured providers | `headers.observe` | Headroom before a limit is hit |
| Claude Code's logs (`~/.claude/projects`), Codex's logs (`~/.codex/sessions`) and OpenCode's database, read-only | Only when you run `quota-router usage` or `limits` | Token counts, model names, times and project folders for the totals. Prompts and replies in those logs are skipped, not kept. What was read is cached in `~/.cache/quota-router`, created readable only by you |

The optional Claude Code Router rule reads only its own config file (`~/.config/quota-router/ccr.json`) and asks the dashboard on `127.0.0.1` for provider states. The LiteLLM callback reads nothing and keeps everything in memory; it never stores API keys, only a short hash to tell accounts apart.

## Where it sends data

Only to the providers you already use: `api.anthropic.com` for the Claude usage check, `api.github.com` for the Copilot usage check, and `openrouter.ai` for the OpenRouter credit check. Nothing else leaves your machine by default.

**Optional telemetry export** (`telemetry.enabled`, off by default): token counts, costs, request and fallback counts and plan utilisation are sent to the OpenTelemetry endpoint you configure. Prompts, responses, code, tool arguments, session titles and error messages are never sent. Your email, user or organisation ID, host name and project names are sent only if you set them under `telemetry.identity` or `telemetry.projects`. The endpoint must use HTTPS unless it is on this machine, redirects are refused, header values are never logged or shown, and the endpoint and headers can only be set in `opencode.jsonc` or the environment, never from the dashboard or a command. See [docs/telemetry.md](docs/telemetry.md).

**Optional system notifications** (`notifications.system`, off by default) run `osascript` (macOS) or `notify-send` (Linux) with the notification text passed as arguments only.

## What it stores

`~/.local/share/opencode-quota-router/` (or under `$XDG_DATA_HOME`):
- `router.db`: usage, routing and session history (SQLite);
- `router.log`.

Session titles and project paths are stored there. No prompts, responses, file contents or credentials are stored.

The dashboard listens on `127.0.0.1` only and rejects requests whose `Host` header is not local, which stops DNS rebinding. Every write (actions and settings) must be a JSON `POST` with a custom header, and is refused when the browser says it came from another site (`Origin`, `Sec-Fetch-Site`); a page elsewhere can't send a JSON body without a preflight, which the dashboard never answers. Settings changes also need a random token that is generated when the plugin starts and is only in the dashboard page itself. The settings page can change only the settings it lists, each checked for type and range; where the dashboard listens, where telemetry is sent and with which headers, the local server addresses and `explicitProviders` can only be changed in `opencode.jsonc`.

## Reporting a vulnerability

Please open a private security advisory on this repository rather than a public issue.
