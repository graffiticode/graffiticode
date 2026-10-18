// The step 1 checklist is generated from infra.js's own commands, so it can't drift.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { load, envoyConfig, cloudInit, sha256 } from "../generate.js";
import { commands, render } from "../infra.js";
import { checklist } from "../checklist.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const production = () => load({ deploy: path.join(HERE, "../production/network.json"), classes: path.join(HERE, "../classes.json") });

test("the checklist holds steps 1–10's commands exactly, each step with a check", async () => {
  const model = await production();
  const text = checklist(model);
  const steps = commands(model).slice(0, 10);
  for (const [i, s] of steps.entries()) {
    assert.ok(text.includes(`## ${i + 1}. ${s.title}`), s.title);
    for (const c of s.lines.filter(l => !String(l).startsWith("#"))) assert.ok(text.includes(String(c)), String(c));
  }
  assert.ok(!text.includes("rolling-action start-update"), "step 11 is for later patches");
  assert.equal(text.split("\n").filter(l => /^- \[ \] Check:/.test(l)).length, 10);
  assert.ok(text.includes(envoyConfig(model).node.metadata.isolate01.config_sha256));
  assert.ok(text.includes("roles/editor OR roles/owner"), "the pre-flight gate");
});

test("before step 8 it has the operator check the cloud-init's digest against the template's name", async () => {
  const model = await production();
  const name = sha256(cloudInit(model, envoyConfig(model))).slice(0, 12);
  assert.ok(render(commands(model)).includes(`instance-templates create egress-proxy-${name} `));
  assert.ok(checklist(model).includes(`it starts with \`${name}\``));
});

test("the committed checklist is the generated one", async () => {
  const committed = await readFile(path.join(HERE, "../production/step1-checklist.md"), "utf8");
  assert.equal(committed, checklist(await production()), "regenerate: node deploy/egress-proxy/checklist.js > deploy/egress-proxy/production/step1-checklist.md");
});
