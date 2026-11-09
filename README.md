# quota-router

**Keep coding when you hit a usage limit.** quota-router is an [OpenCode](https://opencode.ai) plugin. When a provider reaches its rate limit, subscription window or quota, it moves the session to the next provider you've chosen, without losing the request. When the limit resets, it moves you back up. It also gives you a local dashboard and a macOS menu bar view of your usage.

- **Uses subscriptions first.** Claude, ChatGPT, Copilot and Grok subscriptions are used before pay-per-use API keys, and local models (Ollama, LM Studio, vLLM) come last, at no cost.
- **Works with every provider OpenCode connects.** New connections are found automatically, and the dashboard suggests where each fits.
- **Knows when limits reset.** It reads exact reset times from Claude, ChatGPT, Copilot, Anthropic and OpenAI, so it neither retries too early nor waits forever.
- **No surprise charges (optional).** It can leave Claude before your usage credits are drawn, and Copilot before paid credits beyond your allowance.
- **Local only.** No telemetry and no server of its own. Your data stays in a SQLite file on your machine. See [SECURITY.md](SECURITY.md).

> Unofficial. Not affiliated with Anthropic, GitHub, xAI, OpenAI or OpenCode.

---

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Onboarding guide](#onboarding-guide)
- [How routing works](#how-routing-works)
- [Dashboard and menu bar](#dashboard-and-menu-bar)
- [Commands](#commands)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- **OpenCode V2**, 2.2 or later. The menu bar item needs OpenCode Desktop.
- **Node.js 24 or later and npm**, only to install and build.
- **At least two OpenCode providers connected**, for example a Claude subscription and an API key.

## Quick start

```bash
git clone https://github.com/<you>/opencode-quota-router.git
cd opencode-quota-router
npm install --ignore-scripts
npm run build          # builds the menu bar part (dist/gui-experimental.cjs)
```

Add the plugin to your global OpenCode config, `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/opencode-quota-router", "options": {} }
  ]
}
```

OpenCode loads it straight away; there's nothing to restart. Run `/router` in any session to open the dashboard.

## Onboarding guide

### 1. Connect your providers

quota-router only routes between providers that OpenCode can already use. In OpenCode, run `/connect` for each provider you have. Its default chains cover these five:

| Priority | Provider ID | What it is |
|---|---|---|
| 1 | `claude-agent` | Claude Pro, Max, Team or Enterprise, via the Claude Code login |
| 2 | `xai` | SuperGrok or X subscription (signed in), or an xAI API key (pay-per-use) |
| 3 | `github-copilot` | GitHub Copilot |
| 4 | `anthropic` | Anthropic API key (pay-per-use) |
| 5 | `openai` | OpenAI API key (pay-per-use), or a ChatGPT plan when you sign in with ChatGPT |

Providers you haven't connected are skipped, so you don't need all five.

**Every other provider** OpenCode connects (Ollama, LM Studio, OpenRouter, Gemini, Bedrock, Vertex, Azure, Fireworks, Groq and the rest) is found automatically and given a kind from how you connected it:

- **Subscription:** signed in with a plan (for example ChatGPT or Ollama Cloud).
- **Pay-per-use:** an API key.
- **Local:** Ollama, LM Studio, vLLM and similar. These are free, so they cost nothing on the dashboard.

Found providers rank after the ones you configured: subscriptions first, then pay-per-use, then local. They're only routed to once they're in a chain (step 3). Set `"discovery": { "enabled": false }` to rank only the providers you list.

**ChatGPT plans.** If you sign in to OpenAI with ChatGPT (Plus, Pro, Business), it's treated as a subscription and ranked with the others. Its 5-hour and weekly windows appear on the dashboard after its first response, and routing leaves it at 98% so you never hit the wall mid-task. If a limit is hit anyway, the exact reset time from ChatGPT is used. An OpenAI API key is unaffected.

### 2. Choose your order

Lower numbers are tried first. To put Copilot ahead of xAI, for example:

```jsonc
"options": {
  "providers": { "github-copilot": { "priority": 2 }, "xai": { "priority": 3 } }
}
```

Set `"allow": "never"` on a provider to keep it out of routing completely.

### 3. Pick a model that belongs to a chain

A **chain** lists the equivalent models across providers. Selecting any model in a chain puts the session under routing. The defaults use Claude Opus 5.5 at medium effort as the reference model:

| Chain | Claude subscription | xAI | Copilot | Anthropic API | OpenAI API |
|---|---|---|---|---|---|
| `opus` | `opus#medium` | `grok-4.7#high` | `claude-opus-5.5#medium` | `claude-opus-5-5#medium` | `gpt-6.1-sol#high` |
| `sonnet` | `sonnet#medium` | `grok-4.7#medium` | `claude-sonnet-5.5#medium` | `claude-sonnet-5-5#medium` | `gpt-6.1-sol#medium` |
| `fable` | `fable#medium` | `grok-4.7#xhigh` | — | `claude-fable-5-1#medium` | `gpt-6-astra#medium` |
| `haiku` | `haiku#medium` | `grok-build-0.1` | `claude-haiku-5.5#medium` | `claude-haiku-5-5#medium` | `gpt-6-luna#medium` |

- **New sessions:** to route these by default, set your default model to a chain member, for example `"model": "claude-agent/opus"`.
- **Models outside every chain** are never touched.
- **Other providers:** the dashboard's Route section lists suggested entries for every connected provider that's in no chain yet: the same model family where there is one, otherwise the model nearest the chain's price level. **Add** puts it in the chain; **Ignore** hides it. Your choices are stored by the plugin, not in your config.

**Choosing your own models.** Change one provider's entry and keep the rest of the chain:

```jsonc
"chains": {
  "opus": { "xai": "grok-4.6#high", "openai": null, "ollama": "qwen3-coder" }
}
```

A model name sets that provider's entry, `null` removes it, and a provider not yet in the chain is added. To replace a chain completely, or to make your own, give a list: `"chains": { "gpt": ["openai/gpt-6.1-sol#high", "azure/gpt-6.1-sol#high"] }`. `"opus": null` removes a chain.

To make a model other than Opus your first choice, give its provider the lowest priority: routing always tries providers in priority order within the chain.

Effort carries across providers as an offset: Opus at `high`, one step above its `medium` baseline, becomes Grok at `xhigh`. A model is skipped if the conversation wouldn't fit its context window.

### 4. Optional: turn on the usage checks

Without these, quota-router reacts to limit errors. With them, it sees limits coming. Each is **off by default** because it reads a local login and calls an unofficial endpoint (details in [SECURITY.md](SECURITY.md)):

```jsonc
"options": {
  "claude": { "usageProbe": true },
  "copilot": { "usageProbe": true }
}
```

- **Claude:** reads Claude Code's login from the macOS keychain (or `~/.claude/.credentials.json`) and checks your 5-hour and weekly windows, the same figures Claude Code's `/usage` shows. Routing leaves the subscription when a window reaches 98%, or as soon as usage credits start going up. The login is never stored, logged or refreshed.
- **Copilot:** uses OpenCode's stored GitHub login to read your monthly allowance, and stops routing to Copilot before paid credits beyond it are used. Business and Enterprise seats share credits across the organisation, so your seat's share is used (1,900 or 3,900 a month); set `copilot.monthlyCredits` if yours differs.

### 5. Check it's working

1. Run `/router`. The dashboard opens at `http://127.0.0.1:47321`.
2. In **Route**, your connected providers appear in your order, and the one serving your session is marked.
3. Send a message, and it appears under **Running now**, then in the totals.
4. Problems are written to `~/.local/share/opencode-quota-router/router.log`.

## How routing works

- **Within a turn.** A failed request is classified as a throttle, overload, window used up, billing problem or auth failure.
  - Short throttles (a `retry-after` of 20 s or less) retry on the same provider.
  - Anything else switches the session to the next provider inside OpenCode's retry hook. The same request runs again there, with no extra messages and no lost tool calls.
- **At the next turn.** The session moves to the highest-priority provider that's available, so it returns once a limit resets.
- **Health is per pool and shared.** A pool is something that can run out: the Claude subscription, its per-model weekly limits, or an API key. Every session shares that health, and it survives restarts.
- **Reset times** come from the provider wherever possible: Claude's limit message, Copilot's `Retry-After`, Anthropic's monthly spend cap and rate-limit headers. Otherwise a backing-off cooldown applies, and the provider is retried at a turn boundary.
- **When everything is limited,** the request waits for the earliest reset, up to 30 minutes per retry. A failed session is continued once at that reset, if nothing else happened in it.
- **Your choice of model** sets the chain and effort level. Routing still uses the highest-priority provider with capacity; use `/router pin` to keep one session on one provider.

## Dashboard and menu bar

**Dashboard:** `http://127.0.0.1:47321` while OpenCode runs, or `/router`. Local only. It shows:
- totals (tokens, value at API prices, actual spend, savings, model time, fallbacks);
- the route, with each provider's live state and allowances;
- running sessions;
- a routing log grouped by day;
- usage charts, breakdowns by model, project, agent and tool, and searchable sessions;
- CSV export.

**Menu bar** (OpenCode Desktop only): a ring showing Claude's 5-hour window, with short status text. Its menu shows allowances, the route, running sessions, today's totals and quick actions. Turn it off with `"dashboard": { "menubar": false }`.

**Data:** `~/.local/share/opencode-quota-router/router.db` (SQLite) holds daily rollups, cached session totals and retention settings, sized for years of use. On first start, earlier usage is imported read-only from OpenCode's own database.

## Commands

| Command | Effect |
|---|---|
| `/router` | Open the dashboard |
| `/router pin` | Keep this session on its current model |
| `/router unpin` | Route this session again |
| `/router reset <pool or all>` | Clear a provider's limited state |
| `/router pause` | Pause routing for every session |
| `/router resume` | Resume routing for every session |

## Configuration reference

All options go under the plugin's `options` in `opencode.jsonc`. Defaults are in [`src/config.ts`](src/config.ts).

| Option | Default | Meaning |
|---|---|---|
| `providers.<id>.priority` | 1–5 as above | Lower is tried first. Chains are sorted by it. |
| `providers.<id>.allow` | `always` | `never` keeps a provider out of routing |
| `chains.<name>` | see above | A list of `provider/model#variant` replaces the chain; an object of `provider: model` (or `null`) changes single entries; `null` removes the chain |
| `providers.<id>.kind` | detected | `subscription`, `metered` or `local`; set it to override what discovery detects |
| `discovery.enabled` | true | Rank and show every connected provider, not only the ones listed here |
| `chatgpt.cutoverAtPct` / `warnAtPct` | 98 / 85 | Leave a ChatGPT plan before its 5-hour or weekly window is spent |
| `throttle.maxWaitMs` / `inPlaceRetries` | 20000 / 2 | Short throttles retried on the same provider |
| `onExhausted.mode` / `maxWaitMs` | `wait` / 30 min | When everything is limited: wait for the earliest reset, or `fail` |
| `claude.usageProbe` | false | Check Claude subscription usage (see step 4) |
| `claude.avoidUsageCredits` / `cutoverAtPct` | true / 98 | Leave the subscription before usage credits are drawn |
| `copilot.usageProbe` | false | Check Copilot's monthly allowance (see step 4) |
| `copilot.avoidAdditionalCredits` / `reserveFraction` | true / 0.01 | Leave Copilot before paid credits beyond the allowance |
| `copilot.monthlyCredits` | 0 (plan default) | Your included credits on a pooled Business or Enterprise seat |
| `headers.observe` | anthropic, github-copilot | Providers whose rate-limit headers are read. Adding `openai` or `xai` turns off their WebSocket transport. |
| `dashboard.enabled` / `port` / `menubar` | true / 47321 / true | Local dashboard and menu bar item |
| `backfill` | true | Import earlier OpenCode usage on first start |
| `retention.toolsDays` / `executionsDays` / `snapshotsDays` / `poolLogDays` | 400 / 400 / 90 / 730 | Days of raw detail kept; rollups and requests are kept for good |
| `log.level` | `info` | `debug` logs every retry decision |

## Troubleshooting

- **The dashboard doesn't open.** Check `router.log` for `dashboard` lines. If port 47321 is taken, the next free port up to 47325 is used, and `/router` opens the right one.
- **A session isn't routed.** Its model isn't in any chain. Pick a chain model, or add yours to `chains`.
- **A connected provider is never used.** It's in no chain yet. Add one of its suggested entries on the dashboard, or set it in `chains`.
- **"Usage check" messages on the dashboard.** The Claude check needs Claude Code to be logged in (`claude auth login`). An expired login refreshes the next time Claude Code runs.
- **The menu bar item doesn't appear.** It needs OpenCode Desktop and a built `dist/gui-experimental.cjs` (`npm run build`). After first adding it, restart OpenCode once.
- **Routing misbehaves.** Run `/router pause`, or use the dashboard's pause button, and open an issue with the relevant `router.log` lines. Remove anything private from them first.

## Development

```bash
npm install --ignore-scripts
npm test           # unit, harness and storage tests (Node 24, built-in SQLite)
npm run typecheck
npm run build      # menu bar bundle
```

- **Dashboard:** `src/dashboard/page.html`, read on every request.
- **Server code:** changes rebuild the plugin's core when saved, with no restart.
- **`package.json` exports:** changes need an OpenCode restart.

## License

[MIT](LICENSE)
