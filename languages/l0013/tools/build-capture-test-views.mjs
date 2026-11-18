// SPDX-License-Identifier: MIT
//
// Builds L0179's real /form View bundle (languages/l0179/packages/view, `build:embed`) twice,
// for the capture crate's L0179 test (crates/capture/tests/l0179.rs):
//
//   target/capture-test-views/released   with the @graffiticode/l0000-view l0179 installs
//   target/capture-test-views/fixed      with this checkout's languages/l0000/packages/view
//
// The released build is the regression control: under a render grant its first update
// posts a compile, which the test's stand-in api refuses as production's does. Run the test
// with L0179_VIEW_DIR set to one of them:
//
//   node languages/l0013/tools/build-capture-test-views.mjs
//   L0179_VIEW_DIR=$PWD/languages/l0013/target/capture-test-views/fixed \
//     cargo test -p l0013-capture --test l0179
//
// Needs `npm ci` in languages/l0179 and languages/l0000 (it runs them when node_modules is
// missing). l0179's node_modules is restored afterwards.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const languages = join(here, "..", "..");
const l0000 = join(languages, "l0000");
const l0179 = join(languages, "l0179");
const out = join(here, "..", "target", "capture-test-views");
const run = (cwd, ...args) => execFileSync("npm", args, { cwd, stdio: "inherit" });

for (const dir of [l0000, l0179]) if (!existsSync(join(dir, "node_modules"))) run(dir, "ci");
run(l0000, "run", "-w", "packages/view", "build");

const embed = name => {
  run(l0179, "run", "-w", "packages/view", "build:embed");
  rmSync(join(out, name), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(l0179, "packages/view/dist-embed"), join(out, name), { recursive: true });
  console.log(`build-capture-test-views: wrote ${join(out, name)}`);
};

embed("released");
const installed = join(l0179, "node_modules/@graffiticode/l0000-view/dist");
const saved = `${installed}.released`;
renameSync(installed, saved);
try {
  cpSync(join(l0000, "packages/view/dist"), installed, { recursive: true });
  embed("fixed");
} finally {
  rmSync(installed, { recursive: true, force: true });
  renameSync(saved, installed);
}
