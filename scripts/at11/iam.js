#!/usr/bin/env node
// AT-11, the IAM probe (ISOLATE-01; plan: ~/.claude/plans/isolate-01-compiler-egress.md,
// "AT-11"). A network refusal must never pass as an IAM denial, so this runs on a path that
// does reach Google's APIs (the probe image without the compiler network config) and asks the
// real resources with the identity's own metadata token.
//
//   node scripts/at11/iam.js --role compiler --subject l0176-run --config iam.json [--out dir]
//   node scripts/at11/iam.js --role control  --subject at11-control --config iam.json [--out dir]
//   node scripts/at11/iam.js --combine <compiler-evidence.json> <control-evidence.json>
//
// As a compiler, every check must come back 403 PERMISSION_DENIED (a 401, a 404 or a network
// error fails it: the path was wrong, not the identity), and testIamPermissions must grant
// nothing. As the control (an account granted exactly the matching permissions on canary
// resources), the same requests must succeed. --combine passes a compiler run only together
// with a passing control run from the same image; without one the compiler run is void.
// Nothing here is run until rollout step 7 (deployment deferred).

import { readFile } from "node:fs/promises";
import { writeEvidence, parseArgs } from "./lib.js";

// iam.json:
//   project:   "graffiticode"
//   secrets:   ["projects/graffiticode/secrets/broker-...", ...]   Broker's and Policy's
//   databases: ["projects/graffiticode/databases/broker", ...]     Broker's and Policy's
//   kmsKeys:   ["projects/.../cryptoKeys/policy-signing/cryptoKeyVersions/1"]
//   impersonate: ["policy-run@graffiticode.iam.gserviceaccount.com", "broker-run@..."]
//   service:   "projects/graffiticode/locations/us-central1/services/l0176"   its own
//   ownAudience: "https://broker-...a.run.app"                      for the compiler's own positive control
//   canary:    { secrets: [...], databases: [...], kmsKeys: [...], impersonate: [...], service: "...", project: "..." }
//              the control's resources, each the same kind as above

// Every request is harmless if, wrongly, it's allowed: reads, a sign of a zero digest, a
// token that is redacted, an update with validateOnly, a write that requires a document that
// doesn't exist. Permissions that only a mutating call could show (setIamPolicy) are asked
// with testIamPermissions, never by calling them.
const API = {
  secret: name => ({ method: "GET", url: `https://secretmanager.googleapis.com/v1/${name}/versions/latest:access`, permission: "secretmanager.versions.access" }),
  secretTest: name => ({ method: "POST", url: `https://secretmanager.googleapis.com/v1/${name}:testIamPermissions`, body: { permissions: ["secretmanager.versions.access"] }, test: true }),
  firestoreRead: db => ({ method: "GET", url: `https://firestore.googleapis.com/v1/${db}/documents/at11/probe`, permission: "datastore.entities.get", notFoundIsSuccess: true }),
  firestoreWrite: db => ({ method: "PATCH", url: `https://firestore.googleapis.com/v1/${db}/documents/at11/never-exists?currentDocument.exists=true`, body: { fields: { at: { stringValue: "at11" } } }, permission: "datastore.entities.update", notFoundIsSuccess: true }),
  kmsSign: key => ({ method: "POST", url: `https://cloudkms.googleapis.com/v1/${key}:asymmetricSign`, body: { digest: { sha256: Buffer.alloc(32).toString("base64") } }, permission: "cloudkms.cryptoKeyVersions.useToSign" }),
  kmsTest: key => ({ method: "POST", url: `https://cloudkms.googleapis.com/v1/${key.replace(/\/cryptoKeyVersions\/\d+$/, "")}:testIamPermissions`, body: { permissions: ["cloudkms.cryptoKeyVersions.useToSign"] }, test: true }),
  accessToken: sa => ({ method: "POST", url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateAccessToken`, body: { scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: "300s" }, permission: "iam.serviceAccounts.getAccessToken" }),
  idToken: sa => ({ method: "POST", url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateIdToken`, body: { audience: "urn:graffiticode:at11" }, permission: "iam.serviceAccounts.getOpenIdToken" }),
  saTest: sa => ({ method: "POST", url: `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${sa}:testIamPermissions`, body: { permissions: ["iam.serviceAccounts.getAccessToken", "iam.serviceAccounts.getOpenIdToken", "iam.serviceAccounts.setIamPolicy"] }, test: true }),
  // An identity past IAM gets as far as validating the empty update (400), and nothing changes.
  runUpdate: svc => ({ method: "PATCH", url: `https://run.googleapis.com/v2/${svc}?validateOnly=true`, body: {}, permission: "run.services.update", badRequestIsSuccess: true }),
  runTest: svc => ({ method: "POST", url: `https://run.googleapis.com/v2/${svc}:testIamPermissions`, body: { permissions: ["run.services.update", "run.services.setIamPolicy"] }, test: true }),
  projectTest: project => ({ method: "POST", url: `https://cloudresourcemanager.googleapis.com/v3/projects/${project}:testIamPermissions`, body: { permissions: ["resourcemanager.projects.setIamPolicy", "run.services.update", "iam.serviceAccounts.actAs"] }, test: true }),
};

// The checks for a set of resources (the real ones for a compiler, the canaries for the control).
export function checksFor(r) {
  const list = [];
  const add = (id, req) => list.push({ id, ...req });
  for (const s of r.secrets ?? []) { add(`secret ${s}`, API.secret(s)); add(`secret test ${s}`, API.secretTest(s)); }
  for (const d of r.databases ?? []) { add(`firestore read ${d}`, API.firestoreRead(d)); add(`firestore write ${d}`, API.firestoreWrite(d)); }
  for (const k of r.kmsKeys ?? []) { add(`kms sign ${k}`, API.kmsSign(k)); add(`kms test ${k}`, API.kmsTest(k)); }
  for (const sa of r.impersonate ?? []) {
    add(`access token as ${sa}`, API.accessToken(sa));
    add(`id token as ${sa}`, API.idToken(sa));
    add(`sa test ${sa}`, API.saTest(sa));
  }
  if (r.service) { add(`run update ${r.service}`, API.runUpdate(r.service)); add(`run test ${r.service}`, API.runTest(r.service)); }
  if (r.project) add(`project test ${r.project}`, API.projectTest(r.project));
  return list;
}

// What one response means for a compiler: the denial it must be, or why it doesn't count.
export function judgeDenied(check, response) {
  if (response.error) return { passed: false, why: `no answer (${response.error}): the check didn't reach the API` };
  if (check.test) {
    if (response.status !== 200) return { passed: false, why: `testIamPermissions answered ${response.status}` };
    const granted = response.body?.permissions ?? [];
    return granted.length ? { passed: false, why: `granted ${granted.join(", ")}` } : { passed: true };
  }
  const status = response.body?.error?.status;
  if (response.status === 403 && status === "PERMISSION_DENIED") {
    const message = response.body.error.message ?? "";
    const named = !check.permission || message.includes(check.permission) || message.toLowerCase().includes("permission");
    return named ? { passed: true } : { passed: false, why: `403 without the permission named: ${message}` };
  }
  if (response.status === 401) return { passed: false, why: "401: the token was wrong, so this proves nothing about the identity" };
  if (response.status === 404) return { passed: false, why: "404: the resource path is wrong, so this proves nothing" };
  if (response.status >= 200 && response.status < 300) return { passed: false, why: `ALLOWED (${response.status}): the identity can ${check.permission}` };
  return { passed: false, why: `answered ${response.status} ${status ?? ""}`.trim() };
}

// What one response means for the control: it must succeed through the identical client.
export function judgeAllowed(check, response) {
  if (response.error) return { passed: false, why: `no answer (${response.error})` };
  if (check.test) {
    const granted = response.body?.permissions ?? [];
    const wanted = check.body.permissions;
    return response.status === 200 && granted.length > 0 ? { passed: true } : { passed: false, why: `testIamPermissions granted ${granted.length}/${wanted.length}` };
  }
  if (response.status >= 200 && response.status < 300) return { passed: true };
  if (check.notFoundIsSuccess && response.status === 404) return { passed: true };
  if (check.badRequestIsSuccess && response.status === 400) return { passed: true };
  return { passed: false, why: `answered ${response.status} ${response.body?.error?.status ?? ""}`.trim() };
}

async function metadata(path) {
  const res = await fetch(`http://metadata.google.internal/computeMetadata/v1/${path}`, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata ${path}: ${res.status}`);
  return res.text();
}

export async function send(check, token, doFetch = fetch) {
  try {
    const res = await doFetch(check.url, {
      method: check.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: check.body ? JSON.stringify(check.body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body: redact(body) };
  } catch (e) {
    return { error: e?.cause?.code ?? e?.name ?? String(e) };
  }
}

// Never keep a secret payload, token or signature in evidence.
const redact = body => {
  if (!body || typeof body !== "object") return body;
  const out = { ...body };
  for (const k of ["payload", "accessToken", "token", "signature"]) if (k in out) out[k] = "[redacted]";
  return out;
};

export async function runIam(config, role, { token, doFetch = fetch, idToken } = {}) {
  const resources = role === "control" ? config.canary : config;
  if (!resources) throw new Error(`no ${role === "control" ? "canary " : ""}resources in the config`);
  const judge = role === "control" ? judgeAllowed : judgeDenied;
  const rows = [];
  for (const check of checksFor(resources)) {
    const response = await send(check, token, doFetch);
    rows.push({ id: check.id, method: check.method, url: check.url, response, ...judge(check, response) });
  }
  if (role === "compiler" && config.ownAudience) {
    // The compiler's own positive control: it can do what it's meant to.
    const ok = await (idToken ?? (a => metadata(`instance/service-accounts/default/identity?audience=${encodeURIComponent(a)}`)))(config.ownAudience).then(t => t.split(".").length === 3, () => false);
    rows.push({ id: `own id token for ${config.ownAudience}`, positiveControl: true, passed: ok, ...(ok ? {} : { why: "the compiler couldn't mint its own ID token" }) });
  }
  return { probe: "iam", role, passed: rows.length > 0 && rows.every(r => r.passed), rows };
}

// A compiler run counts only beside a passing control run of the same probe version.
export function combine(compiler, control) {
  if (compiler.role !== "compiler" || control.role !== "control") throw new Error("combine takes a compiler run and a control run");
  if (!control.passed) return { void: true, passed: false, why: "the control run failed, so the compiler's denials prove nothing" };
  if (compiler.version !== control.version) return { void: true, passed: false, why: "the runs are from different probe versions" };
  const controlIds = new Set(control.rows.map(r => r.id.replace(/ \S+$/, "")));
  const uncovered = compiler.rows.filter(r => !r.positiveControl && !controlIds.has(r.id.replace(/ \S+$/, ""))).map(r => r.id);
  if (uncovered.length) return { void: true, passed: false, why: `no control for: ${uncovered.join("; ")}` };
  return { void: false, passed: compiler.passed };
}

export const VERSION = "at11-iam-1";

async function main() {
  const args = parseArgs(process.argv.slice(2), ["--role", "--subject", "--config", "--out", "--combine"]);
  if (args["--combine"]) {
    const [compilerFile, controlFile] = [args["--combine"], ...args._];
    const result = combine(JSON.parse(await readFile(compilerFile, "utf8")), JSON.parse(await readFile(controlFile, "utf8")));
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  }
  const role = args["--role"];
  if (!["compiler", "control"].includes(role) || !args["--subject"] || !args["--config"]) {
    throw new Error("usage: iam.js --role compiler|control --subject <account> --config <iam.json> [--out dir] | --combine <compiler.json> <control.json>");
  }
  const config = JSON.parse(await readFile(args["--config"], "utf8"));
  const token = JSON.parse(await metadata("instance/service-accounts/default/token")).access_token;
  const email = await metadata("instance/service-accounts/default/email");
  const result = { subject: args["--subject"], identity: email, version: VERSION, at: new Date().toISOString(), ...(await runIam(config, role, { token })) };
  const file = await writeEvidence(args["--out"], args["--subject"], `iam-${role}`, result);
  // A job's filesystem doesn't outlive it: the evidence also goes to the log, one line.
  console.log(`AT11-EVIDENCE ${JSON.stringify(result)}`);
  for (const r of result.rows) console.log(`${r.passed ? "ok  " : "FAIL"} ${r.id}${r.why ? ` — ${r.why}` : ""}`);
  console.log(`${result.passed ? "PASSED" : "FAILED"} as ${email}; evidence: ${file}`);
  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
