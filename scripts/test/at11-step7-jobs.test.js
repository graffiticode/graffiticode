// AT-11 step 7: the generated probe configs and the operator's job commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { classesOf, probeConfig, commands, CANARY } from "../at11/step7-jobs.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const json = async p => JSON.parse(await readFile(path.join(ROOT, p), "utf8"));
const setup = async () => {
  const services = (await json("deploy.json")).services;
  const collect = await json("deploy/egress-proxy/step7/at11/collect.json");
  const base = await json("deploy/egress-proxy/step3/at11/probe-l0176.json");
  return { services, collect, base, classes: classesOf(services) };
};
const IMAGE = "us-central1-docker.pkg.dev/graffiticode/services/at11-probe@sha256:abc";

test("each class gets its own kind, Broker relationship and run.app target", async () => {
  const { classes, base } = await setup();
  const by = Object.fromEntries(classes.map(c => [c.subnet, probeConfig(c, base, { admin: "10.8.0.10" })]));
  assert.deepEqual(Object.keys(by).sort(), ["compilers-default", "compilers-l0000", "compilers-l0013", "compilers-l0176", "compilers-l0185"]);
  assert.equal(by["compilers-default"].kind, "default");
  assert.equal(by["compilers-l0185"].kind, "open");
  for (const c of ["compilers-l0000", "compilers-l0176", "compilers-l0013"]) assert.equal(by[c].kind, "lang");
  // Only L0176 lists Broker.
  assert.equal(by["compilers-l0176"].broker.relationship, "invoker");
  for (const c of ["compilers-default", "compilers-l0000", "compilers-l0013", "compilers-l0185"]) assert.equal(by[c].broker.relationship, "unlisted");
  // A class that lists Policy can't use Policy as its unlisted run.app target.
  for (const c of ["compilers-l0000", "compilers-l0176"]) assert.ok(!by[c].runApp[0].startsWith("policy-"), c);
  for (const c of Object.values(by)) {
    assert.ok(!c.listed.includes(c.runApp[0]), `${c.$comment}: the run.app target is listed`);
    assert.equal(c.fronting.host, c.runApp[0]);
    assert.equal(c.admin.address, "10.8.0.10");
  }
  assert.deepEqual(by["compilers-l0013"].external, ["storage.googleapis.com"]);
  assert.ok(by["compilers-l0013"].listed.includes("app.graffiticode.org"));
  assert.equal(by["compilers-default"].external, undefined);
  // The open class's canary goes through the open route, so it isn't listed there.
  assert.ok(by["compilers-l0185"].canary && !by["compilers-l0185"].listed.includes(by["compilers-l0185"].canary));
});

test("the committed probe configs and iam.json canary are what the generator writes", async () => {
  const { classes, base } = await setup();
  for (const c of classes) {
    const committed = await json(`deploy/egress-proxy/step7/at11/probe-${c.subnet}.json`);
    assert.deepEqual(committed, probeConfig(c, base, { admin: committed.admin.address }), c.subnet);
  }
  assert.deepEqual((await json("deploy/egress-proxy/step7/at11/iam.json")).canary, CANARY);
});

test("every compiler gets an IAM job, every deploy.json compiler a net job on its own class, and the control runs in its own project", async () => {
  const { services, collect, classes } = await setup();
  const text = commands({ collect, classes, services, image: IMAGE });
  const deploys = text.split("\n").filter(l => l.startsWith("gcloud run jobs deploy "));
  const nets = collect.compilers.filter(c => c.net);
  assert.equal(deploys.length, 1 + collect.compilers.length + nets.length);
  assert.ok(deploys.every(l => l.includes(`--image=${IMAGE}`)), "one image for every job");
  const control = deploys.find(l => l.includes(` ${collect.control} `));
  assert.match(control, /--project=graffiticode-isolate01 /);
  assert.match(control, /--role,control,--subject,at11-control/);
  for (const c of nets) {
    const lang = c.subject.replace(/-run$/, "");
    const line = deploys.find(l => l.includes(` ${c.net} `));
    const subnet = services[lang].network.subnet;
    assert.ok(line.includes(`--subnet=${subnet} `) && line.includes("--vpc-egress=all-traffic") && line.includes(`--config,/config/probe-${subnet}.json`), line);
    assert.ok(line.includes(`--service-account=${c.subject}@graffiticode.iam.gserviceaccount.com`), line);
  }
  // An IAM job has no network config: a network refusal must never pass as an IAM denial.
  for (const c of collect.compilers) {
    const line = deploys.find(l => l.includes(` ${c.iam} `));
    assert.ok(!line.includes("--network") && line.includes(`--role,compiler,--subject,${c.subject}`), line);
  }
});

test("the teardown deletes every compiler job and the pull grant, and leaves the control and the sentinels", async () => {
  const { services, collect, classes } = await setup();
  const text = commands({ collect, classes, services, image: IMAGE });
  const teardown = text.slice(text.indexOf("# 6."));
  const deletes = teardown.split("\n").filter(l => l.startsWith("gcloud run jobs delete "));
  assert.equal(deletes.length, collect.compilers.length + collect.compilers.filter(c => c.net).length);
  assert.ok(!deletes.some(l => l.includes(` ${collect.control} `)));
  assert.match(teardown, /remove-iam-policy-binding services .*artifactregistry\.reader/);
  assert.ok(!/firestore/.test(teardown));
  // The sentinels are created only where none exists.
  assert.match(text, /documents\/at11\/sentinel\?currentDocument\.exists=false/);
});
