import { defineConfig } from "vitest/config";

// jsdom, because the behaviour worth testing here is DOM behaviour: which shape the data gets
// (table or tree), paging, and errors as alerts.
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "jsdom" },
});
