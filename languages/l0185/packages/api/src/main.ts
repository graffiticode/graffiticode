// SPDX-License-Identifier: MIT
// ISOLATE-01: first, so every outbound request goes through the egress proxy when
// HTTPS_PROXY is set (on the compiler network); without it, nothing changes.
import "@graffiticode/l0000/egress";
import { setFetcher } from "@graffiticode/l0185";
import { createApp } from "./app.js";
import { makeGuardedFetcher } from "./fetch.js";

// The only fetcher L0185 ever gets in production: public https, checked at connect time.
setFetcher(makeGuardedFetcher());

const port = process.env.PORT || "50185";
const authUrl = process.env.AUTH_URL || "https://auth.graffiticode.org";

const app = createApp({ authUrl });
app.listen(Number(port), () => {
  console.log(`L0185 language server listening on ${port} (authUrl ${authUrl})`);
});

process.on("uncaughtException", (err) => {
  console.log(`ERROR uncaught exception: ${(err as Error).stack}`);
});
