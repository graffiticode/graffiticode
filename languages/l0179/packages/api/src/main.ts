// SPDX-License-Identifier: MIT
// ISOLATE-01: first, so every outbound request goes through the egress proxy when
// HTTPS_PROXY is set (on the compiler network); without it, nothing changes.
import "@graffiticode/l0000/egress";
import { createApp } from "./app.js";

const port = process.env.PORT || "50179";
const authUrl = process.env.AUTH_URL || "https://auth.graffiticode.org";

const app = createApp({ authUrl });
app.listen(Number(port), () => {
  console.log(`L0179 language server listening on ${port} (authUrl ${authUrl})`);
});

process.on("uncaughtException", (err) => {
  console.log(`ERROR uncaught exception: ${(err as Error).stack}`);
});
