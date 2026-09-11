// Embed app build: produces the standalone /form bundle (dist-embed/) that the language
// server serves. index.html lands at dist-embed/index.html so the server can serve it
// directly at GET /form. Also powers `npm run dev`. React is bundled here.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  root: resolve(__dirname, "embed"),
  build: {
    outDir: resolve(__dirname, "dist-embed"),
    emptyOutDir: true,
  },
  // Dev: allow importing ../src from the embed root.
  server: {
    fs: { strict: false },
  },
  plugins: [react()],
});
