import { defineConfig } from "vitest/config";

// jsdom, because what is worth testing here is DOM behaviour: every compiled board paints one
// group per node and connector with its compiled lines, and the page tabs select by id.
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "jsdom" },
});
