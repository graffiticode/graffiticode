import { defineConfig } from "vitest/config";

// No DOM environment: the corpus summary is pure, and the Form is checked with
// react-dom/server's static markup — neither needs jsdom in a published component's dev tree.
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
