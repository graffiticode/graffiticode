import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deployTargets, selectLanguages } from "../lib/upgrade-and-deploy.js";

const repoServices = () => JSON.parse(readFileSync(new URL("../../deploy.json", import.meta.url), "utf8")).services;
const languagesDir = new URL("../../languages/", import.meta.url).pathname;
const quiet = () => {};

test("a language the api routes to its Rust service releases lNNNNr too", () => {
  const services = {
    api: { env: { BASE_URL_L0184: "https://l0184r-abc-uc.a.run.app", BASE_URL_L0177: "https://l0177-abc-uc.a.run.app" } },
    ...Object.fromEntries(["l0184", "l0184r", "l0177", "l0177r", "l0180", "l0180r"].map(n => [n, {}])),
  };
  // l0177 is routed to its TypeScript service, l0180 not routed at all: TypeScript only.
  assert.deepEqual(deployTargets(["l0177", "l0180", "l0184"], services), ["l0177", "l0180", "l0184", "l0184r"]);
});

test("deploy.json: the languages switched today are L0000 and L0184", () => {
  const { services } = JSON.parse(readFileSync(new URL("../../deploy.json", import.meta.url), "utf8"));
  const langs = Object.keys(services).filter(n => /^l\d{4}$/.test(n));
  assert.deepEqual(deployTargets(langs, services).filter(n => n.endsWith("r")), ["l0000r", "l0184r"]);
});

test("a View release deploys L0000, which owns it, without upgrading it, and its consumers with an upgrade", () => {
  const services = repoServices();
  const view = { languagesDir, services, PKG_NAME: "@graffiticode/l0000-view", TARGET_PKG: "packages/view", log: quiet };
  const all = selectLanguages({ ...view, langs: null });
  assert.deepEqual(all.owners, ["l0000"]);
  assert.ok(!all.consumers.includes("l0000"));
  assert.ok(all.consumers.includes("l0184") && all.consumers.includes("l0176"));
  // --lang 0000 alone: L0000's own services, Rust included while the api routes there.
  const only = selectLanguages({ ...view, langs: ["0000"] });
  assert.deepEqual(only, { consumers: [], owners: ["l0000"] });
  assert.deepEqual(deployTargets([...only.owners, ...only.consumers], services), ["l0000", "l0000r"]);
  // The kernel package: the same owner.
  const core = selectLanguages({ languagesDir, services, PKG_NAME: "@graffiticode/l0000", TARGET_PKG: "packages/core", langs: ["0000", "0184"], log: quiet });
  assert.deepEqual(core, { consumers: ["l0184"], owners: ["l0000"] });
});

test("selection skips a language without the package, without a deploy.json entry, or blocked", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "langs-"));
  try {
    const lang = (name, pkg) => {
      mkdirSync(path.join(dir, name, "packages/view"), { recursive: true });
      writeFileSync(path.join(dir, name, "packages/view/package.json"), JSON.stringify(pkg));
    };
    lang("l0001", { name: "@x/pkg" });
    lang("l0002", { name: "l0002-view", dependencies: { "@x/pkg": "^1" } });
    lang("l0003", { name: "l0003-view", dependencies: { "@x/pkg": "^1" } });
    lang("l0004", { name: "l0004-view", dependencies: { "@x/pkg": "^1" } });
    lang("l0005", { name: "l0005-view" });
    const services = { l0001: {}, l0002: {}, l0003: { blocked: "not yet" }, l0005: {} };
    assert.deepEqual(selectLanguages({ languagesDir: dir, langs: null, services, PKG_NAME: "@x/pkg", TARGET_PKG: "packages/view", log: quiet }),
      { consumers: ["l0002"], owners: ["l0001"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
