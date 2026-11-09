import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Builds the OpenCode Desktop part (menu bar item) into dist/gui-experimental.cjs.
// `public/` holds files for the public repository, not build assets.
export default defineConfig({ publicDir: false, plugins: [gui({ entry: "gui/index.ts" })] })
