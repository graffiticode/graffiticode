// SPDX-License-Identifier: MIT
//
// Builds L0179's real /form View bundle (languages/l0179/packages/view, `build:embed`) twice,
// for the capture crate's L0179 test (crates/capture/tests/l0179.rs):
//
//   target/capture-test-views/released   with @graffiticode/l0000-view 0.5.0, pinned
//   target/capture-test-views/fixed      with this checkout's languages/l0000/packages/view
//
// The released build is the regression control: under a render grant its first update
// posts a compile, which the test's stand-in api refuses as production's does. It is
// pinned to 0.5.0, the View the r381d64 captures ran, fetched from the registry and
// checked against its published integrity, not taken from whatever l0179 has installed:
// once l0179 upgrades to the fixed View, the control still reproduces the bug. Run the test
// with L0179_VIEW_DIR set to one of them:
//
//   node languages/l0013/tools/build-capture-test-views.mjs
//   L0179_VIEW_DIR=$PWD/languages/l0013/target/capture-test-views/fixed \
//     cargo test -p l0013-capture --test l0179
//
// Needs `npm ci` in languages/l0179 and languages/l0000 (it runs them when node_modules is
// missing). l0179's node_modules is restored afterwards.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const languages = join(here, "..", "..");
const l0000 = join(languages, "l0000");
const l0179 = join(languages, "l0179");
const out = join(here, "..", "target", "capture-test-views");
const run = (cwd, ...args) => execFileSync("npm", args, { cwd, stdio: "inherit" });

// The historical control: the View before the display-only capture context.
const CONTROL = "@graffiticode/l0000-view@0.5.0";
const CONTROL_INTEGRITY = "sha512-4027mTJqcnHosW0HOW1lDL+uW+Ya1BZTVrtgYw2g10XGM4fpEDjywh8mY+nL7khHagscR0T0cxAjFfQVAfrYTA==";
const controlDist = scratch => {
  const [packed] = JSON.parse(execFileSync("npm", ["pack", CONTROL, "--json", "--pack-destination", scratch], { encoding: "utf8" }));
  if (packed.integrity !== CONTROL_INTEGRITY) throw new Error(`${CONTROL}: integrity ${packed.integrity}, expected ${CONTROL_INTEGRITY}`);
  execFileSync("tar", ["-xzf", join(scratch, packed.filename), "-C", scratch]);
  const { version } = JSON.parse(readFileSync(join(scratch, "package", "package.json"), "utf8"));
  if (version !== "0.5.0") throw new Error(`${CONTROL}: unpacked version ${version}`);
  return join(scratch, "package", "dist");
};

for (const dir of [l0000, l0179]) if (!existsSync(join(dir, "node_modules"))) run(dir, "ci");
run(l0000, "run", "-w", "packages/view", "build");

const embed = name => {
  run(l0179, "run", "-w", "packages/view", "build:embed");
  rmSync(join(out, name), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(l0179, "packages/view/dist-embed"), join(out, name), { recursive: true });
  console.log(`build-capture-test-views: wrote ${join(out, name)}`);
};

// Each build swaps its View's dist into l0179's installed package, then restores it.
const installed = join(l0179, "node_modules/@graffiticode/l0000-view/dist");
const saved = `${installed}.installed`;
const scratch = mkdtempSync(join(tmpdir(), "capture-test-views-"));
renameSync(installed, saved);
try {
  for (const [name, dist] of [["released", controlDist(scratch)], ["fixed", join(l0000, "packages/view/dist")]]) {
    rmSync(installed, { recursive: true, force: true });
    cpSync(dist, installed, { recursive: true });
    embed(name);
  }
} finally {
  rmSync(installed, { recursive: true, force: true });
  renameSync(saved, installed);
  rmSync(scratch, { recursive: true, force: true });
}
