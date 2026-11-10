// Entry point of the `quota-router` command (built to dist/cli.mjs).
import { main } from "./index.ts"

const code = await main(process.argv.slice(2)).catch((error) => {
  console.error(`quota-router: ${error instanceof Error ? error.message : String(error)}`)
  return 1
})
// Exit once the output is written, rather than waiting for timers such as a dashboard request that lost a race.
process.stdout.write("", () => process.exit(code))
