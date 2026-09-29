// Library build: publishes @graffiticode/l0181-view (L0181's Form + the re-exported View) as ESM,
// with bundled types and an extracted style.css. React is external (peer dependency).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import dts from "vite-plugin-dts";

// dist/style.css is ~1.4 MB because it carries KaTeX's fonts inline: Vite IGNORES
// `assetsInlineLimit` in library mode and always inlines, so there is no knob for it here.
// That cost lands only on npm consumers who bundle this package. The /form bundle — what a
// learner actually loads — is built by vite.embed.config.ts, which emits the fonts as files
// the browser fetches only when a card contains math.
export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
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
  // bundleTypes emits a single dist/index.d.ts (needs @microsoft/api-extractor).
  plugins: [react(), dts({ bundleTypes: true })],
});
