// Library build: publishes @graffiticode/l0000-view (the shared View + base Form) as ESM,
// with bundled types and an extracted style.css. React is external (peer dependency).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import dts from "vite-plugin-dts";

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
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
  // bundleTypes emits a single dist/index.d.ts (needs @microsoft/api-extractor).
  plugins: [react(), dts({ bundleTypes: true })],
});
