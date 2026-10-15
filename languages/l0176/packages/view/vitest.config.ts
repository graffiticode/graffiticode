// Tests run in jsdom against the sources (no build). Kept apart from vite.config.ts so the
// library build's dts plugin doesn't run under vitest.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
