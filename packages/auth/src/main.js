#!/usr/bin/env node

import { createApp } from "./app.js";

const { app } = createApp();

const port = process.env.PORT || "4100";
app.listen(port, () => {
  console.log(`Listening on ${port}...`);
});

process.on("uncaughtException", (err) => {
  console.log(`ERROR Caught exception: ${err.stack}`);
});
