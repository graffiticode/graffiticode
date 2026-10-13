// SPDX-License-Identifier: MIT
import { createProtectionClient, metadataIdToken } from "@graffiticode/l0000";
import { createApp } from "./app.js";
import { compiler } from "./compile.js";

const port = process.env.PORT || "50000";
const authUrl = process.env.AUTH_URL || "https://auth.graffiticode.org";
// Chain admission (capability plan W4): with POLICY_URL, a stage of an
// admitted plan asks policy for its binding (L0000 has no protected
// functions, so no broker); PREFLIGHT_GATEWAYS names the gateway accounts
// allowed to preflight.
if (process.env.POLICY_URL) {
  compiler.setPolicy(createProtectionClient({ policyUrl: process.env.POLICY_URL, idToken: metadataIdToken }));
}
const preflightGateways = (process.env.PREFLIGHT_GATEWAYS ?? "").split(",").map(s => s.trim()).filter(Boolean);

const app = createApp({ authUrl, preflightGateways });
app.listen(Number(port), () => {
  console.log(`L0000 language server listening on ${port} (authUrl ${authUrl})`);
});

process.on("uncaughtException", (err) => {
  console.log(`ERROR uncaught exception: ${(err as Error).stack}`);
});
