// Library build: publishes @graffiticode/l0014-view (L0014's Form + the shared View) as ESM,
// with bundled types and an extracted style.css. React is external (peer dependency).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import dts from "vite-plugin-dts";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
  plugins: [react(), dts({ rollupTypes: true })],
});
