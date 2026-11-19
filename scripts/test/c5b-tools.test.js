// C5b's Step 30 tools, offline: the bucket probe (scripts/c5b/bucket-probe.js)
// run with fetch stubbed, and the bucket policy CLI (scripts/c5b/bucket-policy.js).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { STEP30_EXPECTED } from "../lib/c5b-thumbnails.js";

const PROBE = new URL("../c5b/bucket-probe.js", import.meta.url);
let n = 0;
// Runs the probe in-process: fetch answers from `answer(method, url)`, the
// metadata server answers a token and email, and the one output line is parsed.
const probe = async (env, answer) => {
  const requests = [];
  const saved = { fetch: globalThis.fetch, log: console.log, env: { ...process.env }, exitCode: process.exitCode };
  let line = null;
  let printed;
  const output = new Promise(resolve => { printed = resolve; });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (String(url).startsWith("http://metadata.google.internal")) {
      return new Response(String(url).endsWith("/token") ? JSON.stringify({ access_token: "probe-token" }) : "broker-run@graffiticode.iam.gserviceaccount.com");
    }
    requests.push({ method, url: String(url), auth: Boolean(init.headers?.Authorization) });
    const status = answer(method, String(url));
    return new Response(status === 204 ? null : JSON.stringify({ generation: "77" }), { status });
  };
  console.log = l => { line = l; printed(); };
  Object.assign(process.env, { PROBE_BUCKET: "graffiticode-thumbnails", PROBE_STAGING: "graffiticode-command-staging", PROBE_RUN: "r1", ...env });
  try {
    await import(`${PROBE.href}?run=${n++}`);
    await Promise.race([output, new Promise((resolve, reject) => setTimeout(() => reject(new Error("the probe printed nothing")), 5000).unref())]);
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    process.env = saved.env;
    // A failing probe sets the exit code; the test judges it from the output.
    process.exitCode = saved.exitCode;
  }
  assert.match(line, /^C5B-BUCKET-PROBE /);
  return { out: JSON.parse(line.slice("C5B-BUCKET-PROBE ".length)), requests };
};

const brokerAnswers = (method, url) => {
  if (url.includes("graffiticode-command-staging")) return 403;
  if (method === "DELETE") return 204;
  if (url.includes("ifGenerationMatch=1")) return 412;
  return 200;
};
test("broker-run: create, metadata, stale 412, overwrite, delete b.png, staging refused; a.png kept", async () => {
  const { out, requests } = await probe({ PROBE_AS: "broker" }, brokerAnswers);
  assert.equal(out.passed, true, JSON.stringify(out.checks));
  assert.deepEqual(out.checks.map(c => c.id), ["a-create", "a-metadata", "a-stale", "a-overwrite", "b-create", "b-delete", "staging-create"]);
  assert.ok(requests.every(r => r.auth));
  assert.ok(!requests.some(r => r.method === "DELETE" && r.url.includes("a.png")), "a.png stays for the anonymous checks");
  assert.match(requests[3].url, /ifGenerationMatch=77/);
  // A wrong answer fails the probe.
  const bad = await probe({ PROBE_AS: "broker" }, (m, u) => (u.includes("ifGenerationMatch=1") ? 200 : brokerAnswers(m, u)));
  assert.equal(bad.out.passed, false);
});

test("policy-run and l0013r-run: create on the thumbnails bucket refused", async () => {
  for (const as of ["policy", "l0013r"]) {
    const { out } = await probe({ PROBE_AS: as }, () => 403);
    assert.deepEqual(out.checks.map(c => [c.id, c.status, c.ok]), [["create", 403, true]]);
    assert.equal((await probe({ PROBE_AS: as }, () => 200)).out.passed, false);
  }
});

test("anonymous: a.png readable, b.png gone, both listings refused, with no credentials", async () => {
  const { out, requests } = await probe({ PROBE_AS: "anonymous" }, (m, u) => (u.endsWith("/a.png") ? 200 : u.endsWith("/b.png") ? 404 : u.includes("/storage/v1/b/") ? 401 : 403));
  assert.equal(out.passed, true, JSON.stringify(out.checks));
  assert.equal(out.email, null);
  assert.ok(requests.every(r => !r.auth));
  assert.deepEqual(out.checks.map(c => c.id), ["a-read", "b-read", "list-json", "list-xml"]);
  // A listable bucket (decision 1's concern) fails.
  const listable = await probe({ PROBE_AS: "anonymous" }, (m, u) => (u.endsWith("/b.png") ? 404 : 200));
  assert.equal(listable.out.passed, false);
  assert.deepEqual(listable.out.checks.filter(c => !c.ok).map(c => c.id), ["list-json", "list-xml"]);
});

const CLI = new URL("../c5b/bucket-policy.js", import.meta.url).pathname;
test("bucket-policy.js: edit keeps the etag and merges; check passes only the exact expected bindings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "c5b-policy-"));
  const fresh = path.join(dir, "fresh.json");
  writeFileSync(fresh, JSON.stringify({
    etag: "CAE=",
    bindings: [
      { role: "roles/storage.legacyBucketOwner", members: ["projectEditor:graffiticode", "projectOwner:graffiticode"] },
      { role: "roles/storage.legacyObjectReader", members: ["projectViewer:graffiticode"] },
      { role: "roles/storage.legacyObjectOwner", members: ["projectOwner:graffiticode", "projectEditor:graffiticode"] },
    ]
  }));
  const intended = JSON.parse(execFileSync("node", [CLI, "edit", fresh]).toString());
  assert.equal(intended.etag, "CAE=");
  const after = path.join(dir, "after.json");
  writeFileSync(after, JSON.stringify(intended));
  assert.equal(JSON.parse(execFileSync("node", [CLI, "check", after]).toString()).same, true);
  // Applying the edit again: the same policy.
  const again = JSON.parse(execFileSync("node", [CLI, "edit", after]).toString());
  assert.deepEqual(again, intended);
  // An extra member fails the check.
  writeFileSync(after, JSON.stringify({ bindings: [...STEP30_EXPECTED, { role: "roles/storage.objectViewer", members: ["allUsers"] }] }));
  assert.throws(() => execFileSync("node", [CLI, "check", after], { stdio: "pipe" }), /Command failed/);
  writeFileSync(after, JSON.stringify({ bindings: STEP30_EXPECTED }));
  assert.throws(() => execFileSync("node", [CLI, "edit", after], { stdio: "pipe" }), /Command failed/, "no etag: refused");
  // A conditional grant with the approved members fails the check (#428 review).
  const conditional = structuredClone(STEP30_EXPECTED);
  conditional.find(b => b.role === "roles/storage.objectUser").condition = { title: "probes-only", expression: "true" };
  writeFileSync(after, JSON.stringify({ bindings: conditional }));
  assert.throws(() => execFileSync("node", [CLI, "check", after], { stdio: "pipe" }), /Command failed/);
});
