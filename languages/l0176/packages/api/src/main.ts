// SPDX-License-Identifier: MIT
import { createApp } from "./app.js";
import { configureProtection } from "./protection.js";

const port = process.env.PORT || "50176";
const authUrl = process.env.AUTH_URL || "https://auth.graffiticode.org";

const brokered = configureProtection();
// The gateway accounts allowed to preflight (capability plan W4).
const preflightGateways = (process.env.PREFLIGHT_GATEWAYS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const app = createApp({ authUrl, preflightGateways });
app.listen(Number(port), () => {
  console.log(`L0176 language server listening on ${port} (authUrl ${authUrl}, connections ${brokered ? "enabled" : "disabled"})`);
});

process.on("uncaughtException", (err) => {
  console.log(`ERROR uncaught exception: ${(err as Error).stack}`);
});
