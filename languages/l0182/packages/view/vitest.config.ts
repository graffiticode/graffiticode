import { defineConfig } from "vitest/config";

// No DOM environment: the logic worth testing here — the item registry's state machine and
// the language reducer — is pure, and keeping it that way is what lets it be tested without
// pulling jsdom and a rendering library into a published component's dev tree.
export default defineConfig({
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
