# Support matrix

What quota-router 0.2 is built and tested against. "Tested" means the automated tests run there on every change; "works" means it is used there but not tested automatically; "not supported" means a part is turned off there.

## OpenCode

| | Version | Status |
|---|---|---|
| OpenCode | V2, 2.2 or later | Tested by hand on 2.2.7 |
| Plugin API (`@opencode/plugin`) | 2.2.6, pinned exactly | Tested: the contract tests check every hook, event and context method the plugin uses |
| OpenCode V1 | | Not supported: the plugin API is different |
| OpenCode Desktop | 2.2 or later | Works: the menu bar item needs it; everything else runs without it |
| Terminal status line and toasts | 2.2 or later | Tested by hand; needs the dashboard on |

The plugin API version is pinned so an OpenCode update can't change what the plugin is built against without notice. The contract tests (`test/contract.test.ts`) fail to compile when a hook input, an event field or a context method the plugin uses changes shape, and fail at runtime when the plugin listens for an event the API no longer sends. When OpenCode ships a new plugin API, raise the pin, run `npm run typecheck && npm test`, and update this page.

## Runtime

| | Version | Status |
|---|---|---|
| Node.js | 24 or later | Tested: tests, type check and build run on Node 24. Needed only to install, build and test; OpenCode runs the plugin itself |
| Bun (inside OpenCode) | the one OpenCode ships | Works: the store uses `bun:sqlite` there and `node:sqlite` in the tests |

## Operating systems

| System | Status | Notes |
|---|---|---|
| macOS | Tested | Everything, including the menu bar item and system notifications. The Claude usage check reads Claude Code's login from the Keychain |
| Linux | Tested | Everything except the menu bar item. System notifications use `notify-send`. The Claude usage check reads `~/.claude/.credentials.json` |
| Windows | Not tested | Expected to work for routing, the dashboard and the status line, but no test runs there yet. No menu bar item and no system notifications; `/router doctor` says so. Reports are welcome |

## Providers

Each provider's limit errors are recognised from documented responses and checked against invented examples in `test/fixtures/classify.json`. The usage checks call documented endpoints where there are any; where a provider publishes none (xAI), quota-router estimates and says so on the dashboard. See [How it works](how-it-works.md) for what each check reads.
