// Marks each workspace package's bin targets executable after `tsc -b`, which
// writes files without the execute bit. npm only fixes bin modes when it
// installs, so without this a rebuilt dist/main.js behind `npx
// @graffiticode/auth` fails with "permission denied" (TS migration phase 2b).

import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const name of readdirSync(path.join(ROOT, "packages"))) {
  const manifest = path.join(ROOT, "packages", name, "package.json");
  if (!existsSync(manifest)) continue;
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  const targets = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
  for (const target of targets) {
    const file = path.join(ROOT, "packages", name, target);
    if (target.replace(/^\.\//, "").startsWith("dist/") && existsSync(file)) chmodSync(file, 0o755);
  }
}
