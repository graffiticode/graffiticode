// SPDX-License-Identifier: MIT
import { createApp } from "./app.js";

const port = process.env.PORT || "50175";
const authUrl = process.env.AUTH_URL || "https://auth.graffiticode.org";

const app = createApp({ authUrl });
app.listen(Number(port), () => {
  console.log(`L0175 language server listening on ${port} (authUrl ${authUrl})`);
});

process.on("uncaughtException", (err) => {
  console.log(`ERROR uncaught exception: ${(err as Error).stack}`);
});
