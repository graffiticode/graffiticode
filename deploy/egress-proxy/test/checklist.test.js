// The step 1 checklist is generated from infra.js's own commands, so it can't drift.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { load, envoyConfig, cloudInit, userDataDigest } from "../generate.js";
import { commands, render } from "../infra.js";
import { checklist, privateValues, shellQuote, ROLES } from "../checklist.js";
import { execFileSync } from "node:child_process";

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
  const name = userDataDigest(cloudInit(model, envoyConfig(model))).slice(0, 12);
  assert.ok(render(commands(model)).includes(`instance-templates create egress-proxy-${name} `));
  assert.ok(checklist(model).includes(`it starts with \`${name}\``));
});

test("the committed checklist is the generated one", async () => {
  const committed = await readFile(path.join(HERE, "../production/step1-checklist.md"), "utf8");
  assert.equal(committed, checklist(await production()), "regenerate: node deploy/egress-proxy/checklist.js > deploy/egress-proxy/production/step1-checklist.md");
});

test("the template's name doesn't depend on how gzip encoded the user-data", async () => {
  // CI's zlib and a laptop's compress differently; the logical digest decodes first.
  const { gzipSync } = await import("node:zlib");
  const model = await production();
  const text = cloudInit(model, envoyConfig(model));
  const body = JSON.parse(text.slice(text.indexOf("{")));
  const file = body.write_files.find(f => f.encoding === "gz+b64");
  const plain = (await import("node:zlib")).gunzipSync(Buffer.from(file.content, "base64"));
  file.content = gzipSync(plain, { level: 1 }).toString("base64");
  const reencoded = text.slice(0, text.indexOf("{")) + JSON.stringify(body, null, 2) + "\n";
  assert.notEqual(reencoded, text, "different gzip bytes");
  assert.equal(userDataDigest(reencoded), userDataDigest(text), "the same template name");
});

// People are named by role in the committed checklist; real addresses come
// only from a private file at generation time (--private-values), and that
// output stays local.
test("the committed checklist names people by role, never by address", async () => {
  const committed = await readFile(path.join(HERE, "../production/step1-checklist.md"), "utf8");
  for (const role of Object.values(ROLES)) assert.ok(committed.includes(role), `${role} is named`);
  const addresses = (committed.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? []).filter(a => !a.endsWith(".gserviceaccount.com"));
  assert.deepEqual(addresses, [], "no personal address in the committed checklist");
  assert.ok(committed.includes("--channel-labels='email_address=<alert-recipient>'"), "the alert channel's command names the role");
});

test("private values fill the roles, and only well-formed addresses are accepted", async () => {
  const model = await production();
  const values = privateValues(JSON.stringify({ alertRecipient: "alerts@example.com", approvedOwners: { orgAdmin: "admin@example.com", operator: "op@example.com", secondOwner: "second@example.org" } }));
  const filled = checklist(model, values);
  assert.ok(filled.includes("--channel-labels='email_address=alerts@example.com'"));
  assert.ok(filled.includes("The approved owners admin@example.com, op@example.com and second@example.org are accepted"));
  for (const role of Object.values(ROLES)) assert.ok(!filled.includes(role), `${role} is filled`);
  // Only the people change: every other line is the committed checklist's.
  const plain = checklist(model).split("\n");
  const changed = filled.split("\n").filter((l, i) => l !== plain[i]);
  assert.equal(changed.length, 3, "the owners line, the alert line and the alert command");
  for (const bad of [{}, { alertRecipient: "x", approvedOwners: {} }, { alertRecipient: "a@example.com", approvedOwners: { orgAdmin: "b@example.com", operator: "c@example.com" } },
    { alertRecipient: "a@example.com\" --flag", approvedOwners: { orgAdmin: "b@example.com", operator: "c@example.com", secondOwner: "d@example.com" } }]) {
    assert.throws(() => privateValues(bad), /must be an email address/);
  }
});

// Regression (#480 review): an address the validator accepts can still hold
// shell syntax, so the generated command must quote it. Run the command's
// argument list through a real shell, with `printf` in place of gcloud, and
// check the label arrives as one literal word and nothing was substituted.
test("a private address is one literal word in the generated alert command", async () => {
  const model = await production();
  const owners = { orgAdmin: "b@example.com", operator: "c@example.com", secondOwner: "d@example.com" };
  // These are shell syntax on purpose (${IFS} is the shell's, not a template).
  // eslint-disable-next-line no-template-curly-in-string
  for (const alertRecipient of ["alerts$(printf${IFS}PROBE)@example.com", "a${IFS}b;printf${IFS}PROBE;@example.com", "a|printf&@example.com"]) {
    const values = privateValues({ alertRecipient, approvedOwners: owners });
    const line = checklist(model, values).split("\n").find(l => l.includes("monitoring channels create"));
    assert.ok(line.includes(`--channel-labels=${shellQuote(`email_address=${alertRecipient}`)}`), "the whole label is quoted");
    const args = line.trim().replace(/^gcloud beta monitoring channels create /, "");
    const words = execFileSync("bash", ["-c", `printf '%s\\0' ${args}`], { encoding: "utf8" }).split("\0").slice(0, -1);
    assert.ok(words.includes(`--channel-labels=email_address=${alertRecipient}`), `the label is passed literally: ${alertRecipient}`);
    assert.ok(!words.some(w => w.includes("PROBE") && !w.includes("printf")), "no substitution ran");
  }
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});
