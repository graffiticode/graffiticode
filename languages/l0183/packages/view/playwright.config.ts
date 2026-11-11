// Real-browser tests for what a DOM-free unit test cannot see: who owns a touch (a drag or the
// browser's scroll), and whether placing answers moves anything. Runs the dev fixture page
// (embed/dev.html) on the installed Chrome, so no browser download is needed.
import { defineConfig } from "@playwright/test";

const PORT = 5184;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: "chrome",
    viewport: { width: 375, height: 667 },
    hasTouch: true,
    isMobile: true,
  },
  webServer: {
    command: `vite --config vite.embed.config.ts --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/dev.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
