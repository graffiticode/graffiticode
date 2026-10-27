// Embed app build: produces the standalone /form bundle (dist-embed/) that the language
// server serves. index.html lands at dist-embed/index.html so the server can serve it
// directly at GET /form. Also powers `npm run dev`. React is bundled here.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  root: resolve(import.meta.dirname, "embed"),
  build: {
    outDir: resolve(import.meta.dirname, "dist-embed"),
    emptyOutDir: true,
  },
  // Dev: allow importing ../src from the embed root.
  server: {
    fs: { strict: false },
  },
  // One React. The repo root hoists React 19 (pulled in as @graffiticode/l0000-view's peer)
  // while this package pins 18 locally; without dedupe the Form renders on 18 and l0000-view's
  // swr imports 19, whose dispatcher react-dom 18 never sets — every hook in it throws
  // "Cannot read properties of null (reading 'useContext')" and /form renders nothing.
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  plugins: [react()],
});
