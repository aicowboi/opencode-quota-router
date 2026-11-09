# Contributing

Thanks for helping. Bug reports, provider error samples and pull requests are all welcome.

## Reporting a bug

Open an issue with:

- your OpenCode version, and which providers you have connected;
- what you expected and what happened;
- the relevant lines from `~/.local/share/opencode-quota-router/router.log`.

**Remove anything private first**: session titles, project paths, account names and any token-like strings.

## A provider error isn't recognised

This is the most useful kind of report. Include the error message and, if you have it, the response body, with anything identifying removed. Real samples become test cases in `test/core.test.ts`.

## Pull requests

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run build
```

- Keep changes focused, and add or update a test for any behaviour change.
- Match the surrounding code: small pure functions where possible, comments only where the reason isn't obvious.
- Personal settings belong in each user's `opencode.jsonc`, never in the defaults.
