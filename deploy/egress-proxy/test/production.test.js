// ISOLATE-01 rollout step 1: the production inputs (classes.json and production/network.json)
// build a complete plan, and deploy.json never puts a compiler on a proxy that wasn't built
// for it.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { load, terminatedHosts, envoyConfig, cloudInit } from "../generate.js";
import { commands, render, applyPlan } from "../infra.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "../../..");
const production = () => load({ deploy: path.join(HERE, "../production/network.json"), classes: path.join(HERE, "../classes.json") });

test("the production plan is complete: no placeholder, images pinned, the cloud-init built", async () => {
  const model = await production();
  assert.equal(model.project, "graffiticode");
  const text = render(commands(model));
  assert.ok(!/<[^>]+>/.test(text), "no placeholder left in production's commands");
  assert.ok(cloudInit(model, envoyConfig(model)).length > 1000);
  assert.match(text, /--image=cos-129-19506-549-7 /);
  assert.match(text, /managed-zones create compilers-root .*--dns-name=\./, "the DNS lockdown is step 0's root zone");
});

test("production stays print-only: --apply refuses it", async () => {
  const model = await production();
  assert.throws(() => applyPlan(model, commands(model), [1]), /runs only against graffiticode-isolate01, not graffiticode/);
});

test("each first-wave compiler has its own class, holding only its inventoried hosts", async () => {
  const model = await production();
  assert.deepEqual(model.classes["compilers-l0176"].hosts, ["api.graffiticode.org", "auth.graffiticode.org", "broker-sja7fatcta-uc.a.run.app", "policy-sja7fatcta-uc.a.run.app", "www.googleapis.com"]);
  assert.deepEqual(model.classes["compilers-l0000"].hosts, ["api.graffiticode.org", "auth.graffiticode.org", "policy-sja7fatcta-uc.a.run.app", "www.googleapis.com"]);
  // Broker only for L0176, its one caller.
  for (const [name, cls] of Object.entries(model.classes)) {
    if (name !== "compilers-l0176") assert.ok(!cls.hosts.some(h => h.startsWith("broker-")), name);
  }
  // Every terminated host gets a certificate secret, readable by the proxy alone.
  const text = render(commands(model));
  for (const h of terminatedHosts(model)) {
    assert.match(text, new RegExp(`secrets create egress-proxy-cert-${h.replace(/\./g, "-")} `), h);
  }
  const certBindings = text.split("\n").filter(l => /secrets add-iam-policy-binding egress-proxy-cert-/.test(l));
  assert.equal(certBindings.length, terminatedHosts(model).length);
  for (const l of certBindings) assert.match(l, /--member=serviceAccount:egress-proxy@graffiticode\.iam\.gserviceaccount\.com /, "only the proxy reads a certificate key");
});

test("deploy.json puts no compiler on the proxy unless production/network.json built the proxy for it", async () => {
  // A deploy.json network block makes the next release of that service use the proxy. Until
  // rollout step 3 there are none; from then on each must match its planned block exactly.
  const deploy = JSON.parse(await readFile(path.join(ROOT, "deploy.json"), "utf8"));
  const planned = JSON.parse(await readFile(path.join(HERE, "../production/network.json"), "utf8")).services;
  for (const [name, service] of Object.entries(deploy.services ?? {})) {
    if (!service.network) continue;
    assert.ok(planned[name], `${name} has a network block but the proxy wasn't built for it`);
    assert.deepEqual(service.network, planned[name].network, `${name}'s network block differs from its planned one`);
  }
});

test("production's user-data fits a metadata value with room to grow (256 KB cap)", async () => {
  // Step 1's preparation found the plain config made it 253 KB; gzipped, it's a fraction.
  const model = await production();
  const bytes = Buffer.byteLength(cloudInit(model, envoyConfig(model)));
  assert.ok(bytes < 96 * 1024, `user-data is ${bytes} bytes`);
});
