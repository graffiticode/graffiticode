// SPDX-License-Identifier: MIT
// ISOLATE-01: first, so every outbound request goes through the egress proxy when
// HTTPS_PROXY is set (on the compiler network); without it, nothing changes.
import "@graffiticode/l0000/egress";
import { createApp, systemPreviewDirect } from "./app.js";
import { configureProtection } from "./protection.js";

const port = process.env.PORT || "50176";
const authUrl = process.env.AUTH_URL || "https://auth.graffiticode.org";

const brokered = configureProtection();
// The gateway accounts allowed to preflight (capability plan W4).
const preflightGateways = (process.env.PREFLIGHT_GATEWAYS ?? "").split(",").map(s => s.trim()).filter(Boolean);
// Gateway-only system preview signing, unless SYSTEM_PREVIEW_DIRECT=1 (the
// rollout window only; plan system-preview-rate-limit).
const direct = systemPreviewDirect();
const app = createApp({ authUrl, preflightGateways, systemPreviewDirect: direct });
app.listen(Number(port), () => {
  console.log(`L0176 language server listening on ${port} (authUrl ${authUrl}, connections ${brokered ? "enabled" : "disabled"}, system previews ${direct ? "direct" : "gateway-only"})`);
});

process.on("uncaughtException", (err) => {
  console.log(`ERROR uncaught exception: ${(err as Error).stack}`);
});
