// SPDX-License-Identifier: MIT
/**
 * Shared build for L0179's Learnosity custom question type.
 *
 * Learnosity fetches `question.js` and `scorer.js` by URL and expects each to call
 * `LearnosityAmd.define` as it loads, so both are self-executing IIFE bundles with React and
 * the renderer bundled in — nothing is external. IIFE takes a single entry, which is why
 * there are two configs (question / scorer) rather than one multi-entry build, mirroring
 * packages/view's vite.config.ts / vite.embed.config.ts split.
 *
 * Output lands in dist/, which the root `assemble` step copies into packages/api/static/ so
 * the language server serves it at the URLs L0176's buildCustom synthesizes:
 *   https://l0179.graffiticode.org/{question.js,scorer.js,question.css}
 */
import { defineConfig, type UserConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { resolve } from "path";

const require = createRequire(import.meta.url);

/**
 * Emit the Question Editor layout — the postMessage bridge that opens the Graffiticode editor
 * in a popup and writes the authored item back. It ships from @graffiticode/learnosity-cqt
 * with a __GC_LANG__ placeholder, since the file is identical across languages apart from the
 * four-digit id.
 */
const authoringLayout = (): Plugin => ({
  name: "l0179-authoring-layout",
  generateBundle() {
    const src = require.resolve("@graffiticode/learnosity-cqt/authoring-layout.html");
    this.emitFile({
      type: "asset",
      fileName: "authoring_custom_layout.html",
      source: readFileSync(src, "utf8").replace(/__GC_LANG__/g, "0179"),
    });
  },
});

export const cqtConfig = (entry: "question" | "scorer"): UserConfig => ({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, `src/${entry}.ts`),
      formats: ["iife"],
      // The entry calls LearnosityAmd.define for its effect and exports nothing, so the
      // global this name would create is never read.
      name: `l0179Cqt_${entry}`,
      fileName: () => `${entry}.js`,
    },
    // Both builds write into the same dist/, so only the first may clear it.
    emptyOutDir: entry === "question",
    cssCodeSplit: false,
    sourcemap: false,
    // Terser, not the esbuild default: these bundles are fetched by Learnosity on every
    // question render, and terser gets them ~30% smaller.
    minify: "terser",
    rolldownOptions: {
      output: {
        // Vite would name the extracted stylesheet style.css. It has to be question.css --
        // that is the URL L0176's buildCustom points Learnosity at.
        assetFileNames: (info) =>
          info.name?.endsWith(".css") ? "question.css" : "[name][extname]",
      },
    },
  },
  // Vite's lib mode deliberately preserves `process.env.NODE_ENV` so a library's consumer can
  // decide. These are not libraries -- they are standalone bundles Learnosity loads directly,
  // with no build step downstream to substitute it. Left alone, React's dev build ships
  // alongside the production one and, with `process.env` undefined in the browser, is the one
  // that RUNS: dev-mode React, warnings and all, on every question render.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [react(), ...(entry === "question" ? [authoringLayout()] : [])],
});

export default defineConfig(cqtConfig("question"));
