import { defineConfig } from "vite"

// Builds the command line into one file, dist/cli.mjs, so it runs from node_modules (where Node won't strip types).
export default defineConfig({
  publicDir: false,
  build: {
    ssr: "src/cli/bin.ts",
    outDir: "dist",
    emptyOutDir: false,
    target: "node24",
    minify: false,
    rollupOptions: { output: { entryFileNames: "cli.mjs", banner: "#!/usr/bin/env node" } },
  },
  ssr: { noExternal: true },
})
