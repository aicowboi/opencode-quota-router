import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Builds the OpenCode Desktop part (menu bar item) into dist/gui-experimental.cjs.
export default defineConfig({ plugins: [gui({ entry: "gui/index.ts" })] })
