import { defineConfig } from "vitest/config";

// No DOM environment: the logic worth testing here — scoring, layout geometry, the tray and the
// reducer — is pure, and keeping it that way is what lets it be tested without pulling jsdom and
// a rendering library into a published component's dev tree.
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
