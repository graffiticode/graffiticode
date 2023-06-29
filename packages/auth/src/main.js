#!/usr/bin/env node

import { createAppWithFirestoreStorage } from "./app.js";

const { app } = createAppWithFirestoreStorage();

const port = process.env.PORT || "4100";
app.listen(port, () => {
  console.log(`Listening on ${port}...`);
});

process.on("uncaughtException", (err) => {
  console.log(`ERROR Caught exception: ${err.stack}`);
});
