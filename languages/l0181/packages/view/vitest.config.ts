import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // An empty inline PostCSS config stops Vite loading postcss.config.js under test. Without
  // it Tailwind runs over every imported stylesheet — including KaTeX's — and warns that its
  // content globs match nothing, on every run.
  css: { postcss: {} },
  test: {
    environment: "jsdom",
    // Testing Library unmounts between tests only if a global `afterEach` exists, and without
    // that every render stacks up in the same document — so `screen` finds three Reveal
    // buttons and every query throws.
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
