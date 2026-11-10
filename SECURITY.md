# Security and privacy

quota-router runs entirely on your machine. It has no analytics and no server of its own, and it sends nothing about your usage anywhere unless you turn on the optional OpenTelemetry export and give it an endpoint.

## What it reads

| Data | When | Why |
|---|---|---|
| OpenCode session events (models, token counts, timings, session titles) | Always | Routing decisions and the dashboard |
| OpenCode's own database, read-only | Once, on first start (`backfill`) | Import earlier usage into the dashboard |
| Claude Code's login from the macOS keychain (or `~/.claude/.credentials.json`) | Only with `claude.usageProbe: true` | Read your Claude subscription windows from the endpoint Claude Code's `/usage` uses. The token is never stored, logged or refreshed. |
| OpenCode's stored GitHub Copilot login | Only with `copilot.usageProbe: true` | Read your Copilot monthly allowance |
| Rate-limit response headers from configured providers | `headers.observe` | Headroom before a limit is hit |

## Where it sends data

Only to the providers you already use: `api.anthropic.com` for the Claude usage check, and `api.github.com` for the Copilot usage check. Nothing else leaves your machine by default.

**Optional telemetry export** (`telemetry.enabled`, off by default): token counts, costs, request and fallback counts and plan utilisation are sent to the OpenTelemetry endpoint you configure. Prompts, responses, code, tool arguments, session titles and error messages are never sent. Your email, user or organisation ID, host name and project names are sent only if you set them under `telemetry.identity` or `telemetry.projects`. The endpoint must use HTTPS unless it is on this machine, redirects are refused, header values are never logged or shown, and the endpoint and headers can only be set in `opencode.jsonc` or the environment, never from the dashboard or a command. See [docs/telemetry.md](docs/telemetry.md).

**Optional system notifications** (`notifications.system`, off by default) run `osascript` (macOS) or `notify-send` (Linux) with the notification text passed as arguments only.

## What it stores

`~/.local/share/opencode-quota-router/` (or under `$XDG_DATA_HOME`):
- `router.db`: usage, routing and session history (SQLite);
- `router.log`.

Session titles and project paths are stored there. No prompts, responses, file contents or credentials are stored.

The dashboard listens on `127.0.0.1` only, rejects requests whose `Host` header is not local, and requires a custom header for actions.

## Reporting a vulnerability

Please open a private security advisory on this repository rather than a public issue.
