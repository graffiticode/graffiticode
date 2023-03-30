import { fileURLToPath } from "url";
import { createAppWithFirestoreStorage } from "./app.js";

const run = async () => {
  const { app } = createAppWithFirestoreStorage();

  const port = process.env.PORT || "4100";
  app.listen(port, () => {
    console.log(`Listening on ${port}...`);
  });

  process.on("uncaughtException", (err) => {
    console.log(`ERROR Caught exception: ${err.stack}`);
  });
};

const __filename = fileURLToPath(import.meta.url);
const entryFile = process.argv?.[1];
if (entryFile === __filename) {
  run().catch(console.error);
}
