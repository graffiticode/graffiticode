#!/usr/bin/env node

import { createApp } from "./app.js";

const port = process.env.PORT || "3100";
const authUrl = process.env.AUTH_URL || "https://auth.graffiticode.org";

const app = createApp({ authUrl });
app.listen(port, () => {
  console.log(`Listening on ${port}...`);
});

process.on("uncaughtException", (err) => {
  console.log(`ERROR Caught exception: ${err.stack}`);
});
