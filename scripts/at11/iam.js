#!/usr/bin/env node
// AT-11, the IAM probe (ISOLATE-01; plan: ~/.claude/plans/isolate-01-compiler-egress.md,
// "AT-11"). A network refusal must never pass as an IAM denial, so this runs on a path that
// does reach Google's APIs (the probe image without the compiler network config) and asks the
// real resources with the identity's own metadata token.
//
//   node scripts/at11/iam.js --role compiler --subject l0176-run --config iam.json [--out dir]
//   node scripts/at11/iam.js --role control  --subject at11-control --config iam.json [--out dir]
//
// Each role is its own Cloud Run job (a job has one identity), started by the operator's
// collector (collect.js) with one run nonce; the collector pairs the runs (`combine`).
//
// As a compiler, every check must come back 403 PERMISSION_DENIED naming the permission (a
// 401, a 404, a malformed request or a network error fails it: the path was wrong, not the
// identity), and testIamPermissions must grant nothing. Each check also names the answers that
// mean the request got past IAM (for a Firestore create, ALREADY_EXISTS): from a compiler
// those fail it. As the control (an account granted exactly the matching permissions on
// canary resources), the same requests must give exactly those answers, and testIamPermissions
// must grant every permission asked. A compiler run counts only beside a passing control run
// of the same nonce and image digest; without one it's void.
// Nothing here is run until rollout step 7 (deployment deferred).

import { readFile } from "node:fs/promises";
import { writeEvidence, parseArgs } from "./lib.js";

// iam.json:
//   project:   "graffiticode"
//   secrets:   the privileged secrets, as "projects/<p>/secrets/<name>" (PRIVILEGED.secrets)
//   databases: ["projects/graffiticode/databases/broker", ...]     Broker's and Policy's, each
//              holding the sentinel document at11/sentinel (created once by the operator)
//   kmsKeys:   ["projects/.../cryptoKeys/policy-signing/cryptoKeyVersions/1"]
//   impersonate: the privileged accounts (PRIVILEGED.accounts)
//   service:   "projects/graffiticode/locations/us-central1/services/l0176"   its own
//   ownAudience: "https://broker-...a.run.app"                      for the compiler's own positive control
//   canary:    { secrets: [...], databases: [...], kmsKeys: [...], impersonate: [...], service: "...", project: "..." }
//              the control's resources, each the same kind as above (its database has its own
//              at11/sentinel)

// What a compiler run must cover: each name must appear in its config, or the run fails.
export const PRIVILEGED = {
  secrets: [
    "projects/graffiticode/secrets/broker-callers",
    "projects/graffiticode/secrets/BROKER_SECRET_KEY",
    "projects/graffiticode/secrets/policy-callers",
    "projects/graffiticode/secrets/audit-pseudonym-secret",
    "projects/graffiticode/secrets/act-as-callers",
    "projects/graffiticode/secrets/act-as-grant-secret",
    "projects/graffiticode/secrets/auth-internal-api-key",
    "projects/graffiticode/secrets/edge-auth-secret",
    "projects/graffiticode-app/secrets/ACT_AS_GRANT_SECRET",
  ],
  accounts: [
    "policy-run@graffiticode.iam.gserviceaccount.com",
    "broker-run@graffiticode.iam.gserviceaccount.com",
    // An api-run ID token for the L0176 audience gets past gateway-only system signing.
    "api-run@graffiticode.iam.gserviceaccount.com",
    "auth-run@graffiticode.iam.gserviceaccount.com",
    // graffiticode-app's act-as grant signers.
    "console-run@graffiticode-app.iam.gserviceaccount.com",
    "mcp-run@graffiticode-app.iam.gserviceaccount.com",
    "openapi-run@graffiticode-app.iam.gserviceaccount.com",
  ],
  minDatabases: 2,
  minKmsKeys: 1,
};

// Everything that lets one identity act as another (iam.serviceAccounts.*). signBlob counts on
// its own: a signed blob can be a self-signed JWT, exchanged for the account's tokens.
export const IMPERSONATION_PERMISSIONS = [
  "iam.serviceAccounts.getAccessToken",
  "iam.serviceAccounts.getOpenIdToken",
  "iam.serviceAccounts.signJwt",
  "iam.serviceAccounts.signBlob",
  "iam.serviceAccounts.implicitDelegation",
  "iam.serviceAccounts.actAs",
];

export const FIRESTORE_PERMISSIONS = ["datastore.entities.get", "datastore.entities.list", "datastore.entities.create", "datastore.entities.update", "datastore.entities.delete"];

// Firestore's REST denial doesn't name the permission.
const FIRESTORE_DENIED = "Missing or insufficient permissions.";
const OK = [{ status: 200 }];
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Every request is harmless if, wrongly, it's allowed: reads, a sign of a zero digest or of
// junk bytes, a JWT that expires in a minute for an audience nothing accepts, a token that is
// redacted, a create of a document that already exists, a delete whose precondition can't
// match, an update of a document that doesn't exist. Permissions that only a mutating call
// could show (setIamPolicy, run.services.update) are asked with testIamPermissions, never by
// calling them. `allowed` is each check's exact answer past IAM: { status, rpc } where rpc is
// the body's error.status.
const API = {
  secret: name => ({ kind: "secret access", method: "GET", url: `https://secretmanager.googleapis.com/v1/${name}/versions/latest:access`, permission: "secretmanager.versions.access", allowed: OK }),
  secretTest: name => ({ kind: "secret test", method: "POST", url: `https://secretmanager.googleapis.com/v1/${name}:testIamPermissions`, body: { permissions: ["secretmanager.versions.access"] }, test: true }),
  firestoreGet: db => ({ kind: "firestore get", method: "GET", url: `https://firestore.googleapis.com/v1/${db}/documents/at11/probe`, permission: "datastore.entities.get", deniedMessage: FIRESTORE_DENIED, allowed: [{ status: 200 }, { status: 404, rpc: "NOT_FOUND" }] }),
  // listCollectionIds needs only datastore.entities.list (ListDocuments needs get as well).
  firestoreList: db => ({ kind: "firestore list", method: "POST", url: `https://firestore.googleapis.com/v1/${db}/documents:listCollectionIds`, body: { pageSize: 1 }, permission: "datastore.entities.list", deniedMessage: FIRESTORE_DENIED, allowed: OK }),
  firestoreUpdate: db => ({ kind: "firestore update", method: "PATCH", url: `https://firestore.googleapis.com/v1/${db}/documents/at11/never-exists?currentDocument.exists=true`, body: { fields: { at: { stringValue: "at11" } } }, permission: "datastore.entities.update", deniedMessage: FIRESTORE_DENIED, allowed: [{ status: 404, rpc: "NOT_FOUND" }] }),
  firestoreCreate: db => ({ kind: "firestore create", method: "POST", url: `https://firestore.googleapis.com/v1/${db}/documents/at11?documentId=sentinel`, body: { fields: {} }, permission: "datastore.entities.create", deniedMessage: FIRESTORE_DENIED, allowed: [{ status: 409, rpc: "ALREADY_EXISTS" }] }),
  // One precondition only: updateTime (exists and updateTime together are invalid). The
  // sentinel's update time is never the epoch.
  firestoreDelete: db => ({ kind: "firestore delete", method: "DELETE", url: `https://firestore.googleapis.com/v1/${db}/documents/at11/sentinel?currentDocument.updateTime=1970-01-01T00:00:00Z`, permission: "datastore.entities.delete", deniedMessage: FIRESTORE_DENIED, allowed: [{ status: 400, rpc: "FAILED_PRECONDITION" }] }),
  kmsSign: key => ({ kind: "kms sign", method: "POST", url: `https://cloudkms.googleapis.com/v1/${key}:asymmetricSign`, body: { digest: { sha256: Buffer.alloc(32).toString("base64") } }, permission: "cloudkms.cryptoKeyVersions.useToSign", allowed: OK }),
  kmsTest: key => ({ kind: "kms test", method: "POST", url: `https://cloudkms.googleapis.com/v1/${key.replace(/\/cryptoKeyVersions\/\d+$/, "")}:testIamPermissions`, body: { permissions: ["cloudkms.cryptoKeyVersions.useToSign"] }, test: true }),
  accessToken: sa => ({ kind: "impersonate generateAccessToken", method: "POST", url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateAccessToken`, body: { scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: "300s" }, permission: "iam.serviceAccounts.getAccessToken", allowed: OK }),
  idToken: sa => ({ kind: "impersonate generateIdToken", method: "POST", url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateIdToken`, body: { audience: "urn:graffiticode:at11" }, permission: "iam.serviceAccounts.getOpenIdToken", allowed: OK }),
  signJwt: sa => ({ kind: "impersonate signJwt", method: "POST", url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:signJwt`, body: { payload: JSON.stringify({ iss: sa, sub: sa, aud: "urn:graffiticode:at11", iat: nowSeconds(), exp: nowSeconds() + 60 }) }, permission: "iam.serviceAccounts.signJwt", allowed: OK }),
  signBlob: sa => ({ kind: "impersonate signBlob", method: "POST", url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:signBlob`, body: { payload: Buffer.from("at11 probe: not a token").toString("base64") }, permission: "iam.serviceAccounts.signBlob", allowed: OK }),
  saTest: sa => ({ kind: "impersonate test", method: "POST", url: `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${sa}:testIamPermissions`, body: { permissions: [...IMPERSONATION_PERMISSIONS, "iam.serviceAccounts.setIamPolicy"] }, test: true }),
  runTest: svc => ({ kind: "run test", method: "POST", url: `https://run.googleapis.com/v2/${svc}:testIamPermissions`, body: { permissions: ["run.services.update", "run.services.setIamPolicy"] }, test: true }),
  projectTest: project => ({ kind: "project test", method: "POST", url: `https://cloudresourcemanager.googleapis.com/v3/projects/${project}:testIamPermissions`, body: { permissions: ["resourcemanager.projects.setIamPolicy", "run.services.update", "iam.serviceAccounts.actAs", ...FIRESTORE_PERMISSIONS] }, test: true }),
};

// The checks for a set of resources (the real ones for a compiler, the canaries for the control).
export function checksFor(r) {
  const list = [];
  const add = (target, req) => list.push({ id: `${req.kind} ${target}`, ...req });
  for (const s of r.secrets ?? []) { add(s, API.secret(s)); add(s, API.secretTest(s)); }
  for (const d of r.databases ?? []) {
    for (const make of [API.firestoreGet, API.firestoreList, API.firestoreUpdate, API.firestoreCreate, API.firestoreDelete]) add(d, make(d));
  }
  for (const k of r.kmsKeys ?? []) { add(k, API.kmsSign(k)); add(k, API.kmsTest(k)); }
  for (const sa of r.impersonate ?? []) {
    for (const make of [API.accessToken, API.idToken, API.signJwt, API.signBlob, API.saTest]) add(sa, make(sa));
  }
  if (r.service) add(r.service, API.runTest(r.service));
  if (r.project) add(r.project, API.projectTest(r.project));
  return list;
}

// What a compiler config is missing of PRIVILEGED.
export function coverageProblems(config) {
  const problems = [];
  const secrets = new Set(config.secrets ?? []);
  const accounts = new Set(config.impersonate ?? []);
  for (const s of PRIVILEGED.secrets) if (!secrets.has(s)) problems.push(`secret ${s}`);
  for (const a of PRIVILEGED.accounts) if (!accounts.has(a)) problems.push(`account ${a}`);
  if ((config.databases ?? []).length < PRIVILEGED.minDatabases) problems.push(`at least ${PRIVILEGED.minDatabases} databases (Broker's and Policy's)`);
  if ((config.kmsKeys ?? []).length < PRIVILEGED.minKmsKeys) problems.push("Policy's signing key");
  if (!config.service) problems.push("its own service");
  if (!config.project) problems.push("the project");
  return problems;
}

const rpcOf = response => response.body?.error?.status;
const matchesAnswer = (answer, response) => response.status === answer.status && (answer.rpc === undefined || rpcOf(response) === answer.rpc);
const describe = response => `${response.status} ${rpcOf(response) ?? ""}`.trim();

// What one response means for a compiler: the denial it must be, or why it doesn't count.
export function judgeDenied(check, response) {
  if (response.error) return { passed: false, why: `no answer (${response.error}): the check didn't reach the API` };
  if (check.test) {
    if (response.status !== 200) return { passed: false, why: `testIamPermissions answered ${describe(response)}` };
    const granted = response.body?.permissions ?? [];
    return granted.length ? { passed: false, why: `granted ${granted.join(", ")}` } : { passed: true };
  }
  if (rpcOf(response) === "INVALID_ARGUMENT") return { passed: false, why: `${describe(response)}: the request is malformed, so this proves nothing` };
  if ((check.allowed ?? OK).some(a => matchesAnswer(a, response))) return { passed: false, why: `ALLOWED (${describe(response)}): the identity got past ${check.permission}` };
  if (response.status === 403 && rpcOf(response) === "PERMISSION_DENIED") {
    const message = response.body.error.message ?? "";
    const named = message.includes(check.permission) || (check.deniedMessage !== undefined && message.includes(check.deniedMessage));
    return named ? { passed: true } : { passed: false, why: `403 without ${check.permission} named: ${message}` };
  }
  if (response.status === 401) return { passed: false, why: "401: the token was wrong, so this proves nothing about the identity" };
  if (response.status === 404) return { passed: false, why: "404: the resource path is wrong, so this proves nothing" };
  return { passed: false, why: `answered ${describe(response)}` };
}

// What one response means for the control: exactly the check's answer past IAM, through the
// identical client; testIamPermissions must grant every permission asked.
export function judgeAllowed(check, response) {
  if (response.error) return { passed: false, why: `no answer (${response.error})` };
  if (check.test) {
    const granted = new Set(response.body?.permissions ?? []);
    const wanted = check.body.permissions;
    const missing = wanted.filter(p => !granted.has(p));
    return response.status === 200 && !missing.length ? { passed: true } : { passed: false, why: `testIamPermissions granted ${wanted.length - missing.length}/${wanted.length}; missing ${missing.join(", ")}` };
  }
  if (rpcOf(response) === "INVALID_ARGUMENT") return { passed: false, why: `${describe(response)}: the request is malformed` };
  if ((check.allowed ?? OK).some(a => matchesAnswer(a, response))) return { passed: true };
  return { passed: false, why: `answered ${describe(response)}, not ${(check.allowed ?? OK).map(a => `${a.status}${a.rpc ? ` ${a.rpc}` : ""}`).join(" or ")}` };
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
  for (const k of ["payload", "accessToken", "token", "signature", "signedJwt", "signedBlob", "fields"]) if (k in out) out[k] = "[redacted]";
  return out;
};

export async function runIam(config, role, { token, doFetch = fetch, idToken } = {}) {
  const resources = role === "control" ? config.canary : config;
  if (!resources) throw new Error(`no ${role === "control" ? "canary " : ""}resources in the config`);
  const judge = role === "control" ? judgeAllowed : judgeDenied;
  const rows = [];
  if (role === "compiler") {
    const missing = coverageProblems(config);
    rows.push({ id: "coverage", kind: "coverage", passed: !missing.length, ...(missing.length ? { why: `the config doesn't cover: ${missing.join("; ")}` } : {}) });
  }
  for (const check of checksFor(resources)) {
    const response = await send(check, token, doFetch);
    rows.push({ id: check.id, kind: check.kind, method: check.method, url: check.url, response, ...judge(check, response) });
  }
  if (role === "compiler" && config.ownAudience) {
    // The compiler's own positive control: it can do what it's meant to.
    const ok = await (idToken ?? (a => metadata(`instance/service-accounts/default/identity?audience=${encodeURIComponent(a)}`)))(config.ownAudience).then(t => t.split(".").length === 3, () => false);
    rows.push({ id: `own id token for ${config.ownAudience}`, kind: "own id token", positiveControl: true, passed: ok, ...(ok ? {} : { why: "the compiler couldn't mint its own ID token" }) });
  }
  return { probe: "iam", role, passed: rows.length > 0 && rows.every(r => r.passed), rows };
}

// A compiler run counts only beside a passing control run of the same probe version, run
// nonce and image digest, each with its own execution, and only if every kind of check the
// compiler made has a passing control of the same kind (so a denial can't be a client or path
// error). `digests` maps each execution id to its image digest, from the collector.
export function combine(compiler, control, { digests } = {}) {
  if (compiler.role !== "compiler" || control.role !== "control") throw new Error("combine takes a compiler run and a control run");
  if (!control.passed) return { void: true, passed: false, why: "the control run failed, so the compiler's denials prove nothing" };
  if (compiler.version !== control.version) return { void: true, passed: false, why: "the runs are from different probe versions" };
  if (!compiler.nonce || compiler.nonce !== control.nonce) return { void: true, passed: false, why: "the runs don't share a run nonce" };
  if (!compiler.execution || !control.execution || compiler.execution === control.execution) return { void: true, passed: false, why: "each run needs its own execution id" };
  if (digests) {
    const [a, b] = [digests[compiler.execution], digests[control.execution]];
    if (!a || !b || a !== b) return { void: true, passed: false, why: "the runs aren't from one image digest" };
  }
  const controlled = new Set(control.rows.filter(r => r.passed).map(r => r.kind));
  const uncovered = [...new Set(compiler.rows.filter(r => !r.positiveControl && r.kind !== "coverage" && !controlled.has(r.kind)).map(r => r.kind))];
  if (uncovered.length) return { void: true, passed: false, why: `no control for: ${uncovered.join("; ")}` };
  return { void: false, passed: compiler.passed };
}

export const VERSION = "at11-iam-2";

async function main() {
  const args = parseArgs(process.argv.slice(2), ["--role", "--subject", "--config", "--out"]);
  const role = args["--role"];
  if (!["compiler", "control"].includes(role) || !args["--subject"] || !args["--config"]) {
    throw new Error("usage: iam.js --role compiler|control --subject <account> --config <iam.json> [--out dir]");
  }
  const config = JSON.parse(await readFile(args["--config"], "utf8"));
  const token = JSON.parse(await metadata("instance/service-accounts/default/token")).access_token;
  const email = await metadata("instance/service-accounts/default/email");
  const result = {
    subject: args["--subject"],
    identity: email,
    version: VERSION,
    nonce: process.env.AT11_NONCE ?? null,
    execution: process.env.CLOUD_RUN_EXECUTION ?? null,
    at: new Date().toISOString(),
    ...(await runIam(config, role, { token })),
  };
  const file = await writeEvidence(args["--out"], args["--subject"], `iam-${role}`, result);
  // A job's filesystem doesn't outlive it: the evidence also goes to the log, one line.
  console.log(`AT11-EVIDENCE ${JSON.stringify(result)}`);
  for (const r of result.rows) console.log(`${r.passed ? "ok  " : "FAIL"} ${r.id}${r.why ? ` — ${r.why}` : ""}`);
  console.log(`${result.passed ? "PASSED" : "FAILED"} as ${email} (only the collector's combined verdict counts); evidence: ${file}`);
  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
