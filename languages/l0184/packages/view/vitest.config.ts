import { defineConfig } from "vitest/config";

// jsdom, because the behaviour worth testing here is DOM behaviour: the tab strip's roles, keys
// and focus, and when a chart instance is created, resized, replaced and disposed. ECharts itself
// is mocked in those tests — jsdom has no canvas — so they assert what the view asks of it.
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "jsdom" },
});
