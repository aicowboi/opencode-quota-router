# Security and privacy

quota-router's routing and storage run on your machine. It has no analytics or hosted backend. Usage data leaves only through the optional OpenTelemetry export; the optional intelligent setup sends bounded model-catalogue metadata to a connected AI provider only when you request an analysis.

## What it reads

**Installer:** the optional installer reads the chosen OpenCode config only to add or update quota-router's plugin reference. It downloads the pinned npm release, or uses an explicitly selected/local sibling tarball, verifies the archive integrity, and installs with npm lifecycle scripts disabled. Builds are kept in a new version-and-content-addressed user directory; an existing loaded build is never overwritten. Config edits preserve comments and unrelated settings, use a private backup and an atomic replacement, preserve symlinks, and refuse malformed/ambiguous configs or concurrent changes. The installer does not run OpenCode, restart its service, alter your selected model or sign into providers. Review `install.sh`/`install.mjs` before using the one-line bootstrap.

| Data | When | Why |
|---|---|---|
| OpenCode session events (models, token counts, timings, session titles) | Always | Routing decisions and the dashboard |
| Connected coding models, capabilities, context sizes, list prices and the configured default | When you request intelligent routing setup | Recommend a default and alternative models. No credentials, session content or project paths are included. |
| The root `model` field in local OpenCode configuration documents | On plugin setup and configuration changes | Preserve configured defaults even when the model-transform API reports none. Raw configuration and other fields are never sent to the analyzer; ambiguous sources disable activation. |
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

**Optional intelligent setup:** a deliberate dashboard action sends a bounded selection of provider/model names, coding capabilities, context sizes, list prices, the configured default's model reference and the selected routing goal to the analysis model you choose, through OpenCode's stateless generation API. No tools, browsing, conversation history, code, project paths, credentials or provider URLs are sent. A paid analyzer needs explicit charge confirmation; no fallback analyzer is called automatically. Requests are limited to one at a time with a one-minute cancellation signal. The answer is untrusted data: only known connected models, supported effort levels and explicitly allowed paid alternatives can be applied; arbitrary settings and unknown references are refused. Existing defaults are not overwritten, and normal routing does not make AI requests.

**Optional telemetry export** (`telemetry.enabled`, off by default): token counts, costs, request and fallback counts and plan utilisation are sent to the OpenTelemetry endpoint you configure. Prompts, responses, code, tool arguments, session titles and error messages are never sent. Your email, user or organisation ID, host name and project names are sent only if you set them under `telemetry.identity` or `telemetry.projects`. The endpoint must use HTTPS unless it is on this machine, redirects are refused, header values are never logged or shown, and the endpoint and headers can only be set in `opencode.jsonc` or the environment, never from the dashboard or a command. See [docs/telemetry.md](docs/telemetry.md).

**Optional system notifications** (`notifications.system`, off by default) run `osascript` (macOS) or `notify-send` (Linux) with the notification text passed as arguments only.

## What it stores

`~/.local/share/opencode-quota-router/` (or under `$XDG_DATA_HOME`):
- `router.db`: usage, routing and session history (SQLite);
- `router.log`;
- `prices.json`: the list prices OpenCode gives for the models it offers, for the `quota-router` command;
- `dashboard.json`: the dashboard's local address and the process ID, so the terminal part and the command line can find it (readable only by you, removed when the plugin is removed).

Session titles and project paths are stored there. No conversation prompts or responses, file contents or credentials are stored. If intelligent setup is used, the proposed and accepted routing presets (model references, analyzer, goal, time and AI-written routing explanations) are also kept locally. Browser-only notification hiding keeps IDs and times, not notification text, in local storage.

The dashboard listens on `127.0.0.1` only and rejects requests whose `Host` header is not local, which stops DNS rebinding. Every write (actions and settings) must be a JSON `POST` with a custom header, and is refused when the browser says it came from another site (`Origin`, `Sec-Fetch-Site`); a page elsewhere can't send a JSON body without a preflight, which the dashboard never answers. Settings and intelligent-setup actions also need a random token that is generated when the plugin starts and is only in the dashboard page itself. The settings page can change only the settings it lists, each checked for type and range; where the dashboard listens, where telemetry is sent and with which headers, the local server addresses and `explicitProviders` can only be changed in `opencode.jsonc`.

## Dependencies

The plugin itself has no runtime dependencies. The terminal part needs OpenTUI and Solid (`@opentui/core`, `@opentui/solid`, `solid-js`), which npm installs as peer dependencies, as OpenCode's plugin guide asks. At the time of writing, `npm audit` reports moderate advisories in `glob` and `minimatch`, which `@opentui/solid` pulls in for its compile-time Babel tooling. quota-router never runs that code, and there is no fix upstream yet.

## Reporting a vulnerability

Please open a private security advisory on this repository rather than a public issue.
