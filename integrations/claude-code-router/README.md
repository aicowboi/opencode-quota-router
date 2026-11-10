# quota-router for Claude Code Router (experimental)

A [Claude Code Router](https://github.com/musistudio/claude-code-router) routing rule that starts each request on a provider with room. It asks the quota-router plugin running in OpenCode on the same machine which providers are limited: a used-up plan window, a spend cap, or a provider you saved for later. It then puts those at the end of your chain. CCR tries the chain in order and moves to the next model when one fails, so a limited provider is skipped rather than tried first and waited on.

It's a CCR **Node.js script rule**, a documented CCR feature, so nothing is installed into CCR itself. Tested with CCR 3.1.

## What it can and can't know

quota-router learns about limits from your OpenCode sessions and from its usage checks (Claude, Copilot, ChatGPT, OpenRouter). CCR doesn't pass failures back to scripts, so a limit hit through CCR is handled by CCR's own failover for that request, but quota-router won't learn about it. The rule is most useful when OpenCode and CCR share the same subscriptions and keys, and when the usage checks are on.

Without OpenCode running, or while routing is paused there, the rule hands CCR your chain unchanged.

## Set up

1. Copy `quota-router-route.js` somewhere stable, for example `~/.config/quota-router/`.
2. Write your chains to `~/.config/quota-router/ccr.json` (or set `QUOTA_ROUTER_CCR_CONFIG` in the environment CCR starts with). See `ccr.example.json`:
   - `routes`: checked in order. The first whose `match` the requested model starts with is used; `"*"` matches every request.
   - `chain`: CCR models in the order you prefer, written as CCR shows them (`Provider/model`). Add `"provider"` when the CCR provider name isn't the quota-router provider ID: `claude-agent` (Claude subscription), `github-copilot`, `openai`, `anthropic`, `xai`, `openrouter`, and so on, as shown on the quota-router dashboard.
   - `port`: the dashboard's port, if you changed it (default 47321).
3. In CCR, open **Routing**, add a rule, set **Rule type** to **Node.js script**, select `quota-router-route.js`, keep the 2000 ms timeout, and save. Move it above rules that should only apply when it doesn't match.
4. Send a request and check CCR's request log: **resolved provider** shows where it started, and `x-ccr-fallback-*` headers show any failover.

The rule reads its config file before each request, so edits apply straight away. A broken config is reported in CCR's routing diagnostics and the request goes on to the next rule.

## Security

The rule only reads its config file and asks `127.0.0.1` for the plugin's state. It doesn't see or forward your keys, and it changes nothing in the request except the model and the fallback list. CCR runs script rules with the permissions of the CCR process, so keep the file somewhere only you can write to.

## Tests

`test/ccr.test.ts` runs the script the way CCR does (an async function body with `input` and `api`), and the dashboard test runs it against a real quota-router dashboard.
