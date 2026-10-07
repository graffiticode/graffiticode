// Library build: publishes @graffiticode/l0186-view as ESM, with bundled types and an extracted
// style.css. React is external (peer dependency).
//
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import dts from "vite-plugin-dts";

export default defineConfig({
  build: {
    lib: {
      entry: { index: resolve(import.meta.dirname, "src/index.ts") },
      formats: ["es"],
      // Keep the extracted stylesheet at dist/style.css (the "./style.css" export); since
      // Vite 6 library mode otherwise names it after the package.
      cssFileName: "style",
    },
    rolldownOptions: {
      // @graffiticode/l0000-view is a dependency, so it stays external too. Bundled into this
      // library (Vite 8 / rolldown), its own `swr` import drags in SWR's CommonJS
      // use-sync-external-store shim, which rolldown turns into a runtime `require("react")`
      // that throws in the browser -- breaking every consumer of this package (the MCP server's
      // widgets). Consumers resolve it, and SWR with it, from node_modules.
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "@graffiticode/l0000-view",
      ],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
  // bundleTypes emits the bundled .d.ts per entry (needs @microsoft/api-extractor).
  plugins: [react(), dts({ bundleTypes: true })],
});
