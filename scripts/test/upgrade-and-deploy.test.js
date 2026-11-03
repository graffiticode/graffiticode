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
    api: { env: { BASE_URL_L0184: "https://l0184r-abc-uc.a.run.app", BASE_URL_L0177: "https://l0177-abc-uc.a.run.app", BASE_URL_L0186: "https://l0186.graffiticode.org" } },
    ...Object.fromEntries(["l0184", "l0184r", "l0177", "l0177r", "l0180", "l0180r", "l0186", "l0186r"].map(n => [n, {}])),
  };
  // l0177 is routed to its TypeScript service, l0180 not routed at all: TypeScript only.
  // l0186 is routed to its own domain, which serves l0186r once switched.
  assert.deepEqual(deployTargets(["l0177", "l0180", "l0184", "l0186"], services), ["l0177", "l0180", "l0184", "l0184r", "l0186", "l0186r"]);
});

test("a language whose TypeScript service is blocked (A6) releases only its lNNNNr", () => {
  const services = {
    api: { env: { BASE_URL_L0184: "https://l0184.graffiticode.org" } },
    l0184: { blocked: "A6" },
    l0184r: {},
  };
  assert.deepEqual(deployTargets(["l0184"], services), ["l0184r"]);
});

test("a language whose TypeScript service is retired (A7) releases only its lNNNNr", () => {
  const services = {
    api: { env: { BASE_URL_L0184: "https://l0184.graffiticode.org", BASE_URL_L0183: "https://l0183.graffiticode.org" } },
    l0184r: {},
  };
  assert.deepEqual(deployTargets(["l0184"], services), ["l0184r"]);
  // Not routed: nothing to release, and no lNNNN to fall back to.
  delete services.api.env.BASE_URL_L0184;
  assert.deepEqual(deployTargets(["l0184"], services), []);
});

test("deploy.json: the switched languages: L0000, L0003, L0010, L0013, L0014, L0174, L0175, L0177–L0186", () => {
  const { services } = JSON.parse(readFileSync(new URL("../../deploy.json", import.meta.url), "utf8"));
  // A retired TypeScript service (A7, L0184) leaves only the lNNNNr entry.
  const langs = [...new Set(Object.keys(services).filter(n => /^l\d{4}r?$/.test(n)).map(n => n.slice(0, 5)))];
  assert.deepEqual(deployTargets(langs, services).filter(n => n.endsWith("r")).sort(), ["l0000r", "l0003r", "l0010r", "l0013r", "l0014r", "l0174r", "l0175r", "l0177r", "l0178r", "l0179r", "l0180r", "l0181r", "l0182r", "l0183r", "l0184r", "l0185r", "l0186r"]);
});

test("a View release deploys L0000, which owns it, without upgrading it, and its consumers with an upgrade", () => {
  const services = repoServices();
  const view = { languagesDir, services, PKG_NAME: "@graffiticode/l0000-view", TARGET_PKG: "packages/view", log: quiet };
  const all = selectLanguages({ ...view, langs: null });
  assert.deepEqual(all.owners, ["l0000"]);
  assert.ok(!all.consumers.includes("l0000"));
  // L0184's TypeScript service is retired (A7): it's selected through l0184r.
  assert.ok(all.consumers.includes("l0184") && all.consumers.includes("l0176"));
  assert.deepEqual(deployTargets(["l0184"], services), ["l0184r"]);
  // --lang 0000 alone: L0000's own services, Rust included while the api routes there.
  const only = selectLanguages({ ...view, langs: ["0000"] });
  assert.deepEqual(only, { consumers: [], owners: ["l0000"] });
  assert.deepEqual(deployTargets([...only.owners, ...only.consumers], services), ["l0000", "l0000r"]);
  // The kernel package: the same owner.
  // L0184's TypeScript is gone (A6), so it no longer consumes the kernel package; L0183 still does.
  const core = selectLanguages({ languagesDir, services, PKG_NAME: "@graffiticode/l0000", TARGET_PKG: "packages/core", langs: ["0000", "0183", "0184"], log: quiet });
  assert.deepEqual(core, { consumers: ["l0183"], owners: ["l0000"] });
});

test("selection skips a language without the package, without a deploy.json entry, blocked, or with nothing to release", () => {
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
    // l0006: TypeScript service retired (A7), routed to l0006r; l0007: only an unrouted l0007r.
    lang("l0006", { name: "l0006-view", dependencies: { "@x/pkg": "^1" } });
    lang("l0007", { name: "l0007-view", dependencies: { "@x/pkg": "^1" } });
    const services = { l0001: {}, l0002: {}, l0003: { blocked: "not yet" }, l0005: {}, l0006r: {}, l0007r: {} };
    services.api = { env: { BASE_URL_L0006: "https://l0006.graffiticode.org" } };
    assert.deepEqual(selectLanguages({ languagesDir: dir, langs: null, services, PKG_NAME: "@x/pkg", TARGET_PKG: "packages/view", log: quiet }),
      { consumers: ["l0002", "l0006"], owners: ["l0001"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
