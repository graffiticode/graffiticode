// Builds packages/<name>/.compiled-test/: the package's tsc output (dist/)
// with its specs copied in at the same relative paths, so the existing specs
// run against the compiled code that production will run (TS migration phase
// 2a). The mirror sits at the same depth as src/, so relative paths such as
// api's ../config/config.json resolve exactly as they will from dist/.
// Run after `npm run build`; scripts/test-targets.json's "compiled" group
// runs jest in each mirror.
//
//   node scripts/prepare-compiled-specs.js [package ...]

import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["common", "auth", "auth-client", "policy", "broker", "api"];

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : PACKAGES) {
  const pkg = path.join(ROOT, "packages", name);
  const dist = path.join(pkg, "dist");
  const mirror = path.join(pkg, ".compiled-test");
  if (!existsSync(dist)) throw new Error(`${name}: no dist/; run npm run build first`);
  rmSync(mirror, { recursive: true, force: true });
  cpSync(dist, mirror, { recursive: true, filter: src => !/\.(d\.ts|tsbuildinfo)$/.test(src) });
  let specs = 0;
  for (const file of readdirSync(path.join(pkg, "src"), { recursive: true })) {
    if (!/\.spec\.js$/.test(file)) continue;
    cpSync(path.join(pkg, "src", file), path.join(mirror, file));
    specs++;
  }
  // A config in the mirror pins jest's rootDir to it; without one, jest walks
  // up to the package.json and also runs the source specs. It re-exports the
  // package's own settings, imported from their real location so any paths
  // they resolve relative to themselves still work.
  const own = path.join(pkg, "jest.config.js");
  writeFileSync(path.join(mirror, "jest.config.js"), existsSync(own)
    ? `export { default } from ${JSON.stringify(pathToFileURL(own).href)};\n`
    : "export default { transform: {} };\n");
  console.log(`${name}: ${specs} spec(s) against dist/ in ${path.relative(ROOT, mirror)}`);
}
