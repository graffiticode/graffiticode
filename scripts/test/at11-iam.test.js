import test from "node:test";
import assert from "node:assert/strict";
import { checksFor, judgeDenied, judgeAllowed, runIam, combine, coverageProblems, subjectProblems, accountOf, resolveForSubject, VERSION, PRIVILEGED, IMPERSONATION_PERMISSIONS, FIRESTORE_PERMISSIONS } from "../at11/iam.js";

const iamConfig = {
  project: "graffiticode",
  secrets: [...PRIVILEGED.secrets],
  databases: ["projects/graffiticode/databases/broker", "projects/graffiticode/databases/policy"],
  kmsKeys: ["projects/graffiticode/locations/global/keyRings/policy/cryptoKeys/sign/cryptoKeyVersions/1"],
  impersonate: [...PRIVILEGED.accounts],
  service: "projects/graffiticode/locations/us-central1/services/l0176",
  ownAudience: "https://broker.example",
  canary: {
    project: "graffiticode",
    secrets: ["projects/graffiticode/secrets/at11-canary"],
    databases: ["projects/graffiticode/databases/at11-canary"],
    kmsKeys: ["projects/graffiticode/locations/global/keyRings/at11/cryptoKeys/canary/cryptoKeyVersions/1"],
    impersonate: ["at11-canary@graffiticode.iam.gserviceaccount.com"],
    service: "projects/graffiticode/locations/us-central1/services/at11-canary",
  },
};

const answer = (status, rpc, message) => ({ status, body: rpc ? { error: { code: status, status: rpc, message: message ?? rpc } } : {} });
const denied = permission => answer(403, "PERMISSION_DENIED", `Permission '${permission}' denied on resource (or it may not exist).`);
const firestoreDenied = () => answer(403, "PERMISSION_DENIED", "Missing or insufficient permissions.");
const byKind = (kind, config = iamConfig) => checksFor(config).find(c => c.kind === kind);

test("no IAM check could change anything if it were wrongly allowed", () => {
  for (const c of checksFor(iamConfig)) {
    assert.ok(!/:setIamPolicy$/.test(c.url), `${c.id} calls setIamPolicy`);
    assert.ok(!(c.method === "PATCH" && c.url.includes("run.googleapis.com")), `${c.id}: run.services.update is asked through testIamPermissions only`);
    if (c.method === "PATCH" && c.url.includes("firestore")) assert.match(c.url, /currentDocument\.exists=true/);
    if (c.method === "DELETE") {
      // One precondition only: Firestore refuses exists and updateTime together.
      assert.match(c.url, /currentDocument\.updateTime=1970-01-01T00:00:00Z$/);
      assert.ok(!/currentDocument\.exists/.test(c.url), c.url);
    }
    if (c.kind === "firestore create") assert.match(c.url, /documentId=sentinel$/);
  }
  assert.ok(checksFor(iamConfig).some(c => c.test && c.body.permissions.includes("resourcemanager.projects.setIamPolicy")));
});

test("every privileged account is checked by every impersonation method, signBlob included (A12)", () => {
  const checks = checksFor(iamConfig);
  for (const sa of PRIVILEGED.accounts) {
    for (const kind of ["impersonate generateAccessToken", "impersonate generateIdToken", "impersonate signJwt", "impersonate signBlob", "impersonate test"]) {
      assert.ok(checks.some(c => c.kind === kind && c.url.includes(sa)), `${kind} for ${sa}`);
    }
    const t = checks.find(c => c.kind === "impersonate test" && c.url.includes(sa));
    for (const p of IMPERSONATION_PERMISSIONS) assert.ok(t.body.permissions.includes(p), `${sa} testIamPermissions asks ${p}`);
  }
  assert.ok(IMPERSONATION_PERMISSIONS.includes("iam.serviceAccounts.signBlob"));
  // A compiler that keeps only signBlob on a privileged account fails.
  const signBlob = byKind("impersonate signBlob");
  assert.match(judgeDenied(signBlob, { status: 200, body: { keyId: "k", signedBlob: "[redacted]" } }).why, /ALLOWED/);
  const test = byKind("impersonate test");
  assert.match(judgeDenied(test, { status: 200, body: { permissions: ["iam.serviceAccounts.signBlob"] } }).why, /granted iam\.serviceAccounts\.signBlob/);
});

test("a compiler config must cover every privileged secret and account", () => {
  assert.deepEqual(coverageProblems(iamConfig), []);
  const missing = coverageProblems({ ...iamConfig, secrets: iamConfig.secrets.filter(s => !s.endsWith("edge-auth-secret")), impersonate: iamConfig.impersonate.filter(a => !a.startsWith("api-run@")) });
  assert.deepEqual(missing, ["secret projects/graffiticode/secrets/edge-auth-secret", "account api-run@graffiticode.iam.gserviceaccount.com"]);
});

test("only a 403 PERMISSION_DENIED naming the permission (or an empty grant) counts as a denial", () => {
  const read = byKind("secret access");
  assert.equal(judgeDenied(read, denied("secretmanager.versions.access")).passed, true);
  assert.equal(judgeDenied(read, answer(403, "PERMISSION_DENIED", "permission denied")).passed, false, "the specific permission must be named");
  assert.equal(judgeDenied(read, answer(403, "PERMISSION_DENIED", "Permission 'cloudkms.cryptoKeyVersions.useToSign' denied")).passed, false, "another permission named");
  assert.equal(judgeDenied(read, answer(404, "NOT_FOUND")).passed, false);
  assert.equal(judgeDenied(read, { status: 401, body: {} }).passed, false);
  assert.equal(judgeDenied(read, { error: "ECONNREFUSED" }).passed, false);
  assert.match(judgeDenied(read, { status: 200, body: {} }).why, /ALLOWED/);
  const tested = byKind("secret test");
  assert.equal(judgeDenied(tested, { status: 200, body: {} }).passed, true);
  assert.equal(judgeDenied(tested, { status: 200, body: { permissions: ["secretmanager.versions.access"] } }).passed, false);
});

test("each Firestore permission is its own check, with its exact answer past IAM (A16, A20, A23)", () => {
  const kinds = ["firestore get", "firestore list", "firestore update", "firestore create", "firestore delete"];
  for (const d of iamConfig.databases) for (const k of kinds) assert.ok(checksFor(iamConfig).some(c => c.kind === k && c.url.includes(d)), `${k} ${d}`);
  // The list check uses listCollectionIds, which needs only datastore.entities.list.
  assert.match(byKind("firestore list").url, /\/documents:listCollectionIds$/);
  // The project test cross-checks all five entity permissions.
  const project = byKind("project test");
  for (const p of FIRESTORE_PERMISSIONS) assert.ok(project.body.permissions.includes(p), p);
  // Past IAM, each gives its own answer: that's ALLOWED for a compiler, and the control's pass.
  const past = {
    "firestore get": answer(404, "NOT_FOUND"),
    "firestore list": { status: 200, body: { collectionIds: ["at11"] } },
    "firestore update": answer(404, "NOT_FOUND"),
    "firestore create": answer(409, "ALREADY_EXISTS"),
    "firestore delete": answer(400, "FAILED_PRECONDITION"),
  };
  for (const [kind, response] of Object.entries(past)) {
    assert.match(judgeDenied(byKind(kind), response).why, /ALLOWED/, kind);
    assert.equal(judgeAllowed(byKind(kind), response).passed, true, kind);
    assert.equal(judgeDenied(byKind(kind), firestoreDenied()).passed, true, `${kind} denied`);
  }
  // A malformed request (INVALID_ARGUMENT, a 400) fails both: a broken probe passes nothing.
  const invalid = answer(400, "INVALID_ARGUMENT", "Only one of exists and update_time may be set");
  assert.equal(judgeDenied(byKind("firestore delete"), invalid).passed, false);
  assert.equal(judgeAllowed(byKind("firestore delete"), invalid).passed, false);
  // A bare 400 is never a success unless the check names it.
  assert.equal(judgeAllowed(byKind("firestore create"), answer(400, "FAILED_PRECONDITION")).passed, false);
  assert.equal(judgeAllowed(byKind("kms sign"), { status: 400, body: {} }).passed, false);
});

// Responses for a compiler whose only Firestore grant is `grant` on every database.
const fetchWith = grant => async (url, init) => {
  if (url.endsWith(":testIamPermissions")) return new Response("{}", { status: 200 });
  if (url.includes("firestore.googleapis.com")) {
    const kind = init.method === "GET" ? "get" : url.includes(":listCollectionIds") ? "list" : init.method === "PATCH" ? "update" : init.method === "DELETE" ? "delete" : "create";
    if (kind !== grant) return new Response(JSON.stringify(firestoreDenied().body), { status: 403 });
    const past = { get: [404, "NOT_FOUND"], list: [200], update: [404, "NOT_FOUND"], create: [409, "ALREADY_EXISTS"], delete: [400, "FAILED_PRECONDITION"] }[kind];
    return new Response(JSON.stringify(past[1] ? { error: { code: past[0], status: past[1], message: past[1] } } : { collectionIds: [] }), { status: past[0] });
  }
  const permission = url.includes("secretmanager")
    ? "secretmanager.versions.access"
    : url.includes(":asymmetricSign")
      ? "cloudkms.cryptoKeyVersions.useToSign"
      : url.includes(":generateAccessToken")
        ? "iam.serviceAccounts.getAccessToken"
        : url.includes(":generateIdToken")
          ? "iam.serviceAccounts.getOpenIdToken"
          : url.includes(":signJwt")
            ? "iam.serviceAccounts.signJwt"
            : "iam.serviceAccounts.signBlob";
  return new Response(JSON.stringify(denied(permission).body), { status: 403 });
};

test("a create-only or list-only Firestore identity fails the probe (A16, A23)", async () => {
  const none = await runIam(iamConfig, "compiler", { token: "t", doFetch: fetchWith(null), idToken: async () => "a.b.c" });
  assert.equal(none.passed, true, JSON.stringify(none.rows.filter(r => !r.passed)));
  for (const grant of ["create", "list", "delete", "update", "get"]) {
    const run = await runIam(iamConfig, "compiler", { token: "t", doFetch: fetchWith(grant), idToken: async () => "a.b.c" });
    assert.equal(run.passed, false, grant);
    const failing = run.rows.filter(r => !r.passed);
    assert.ok(failing.length >= 2 && failing.every(r => r.kind === `firestore ${grant}`), `${grant}: ${failing.map(r => r.id)}`);
  }
});

test("the control must give each check's exact answer, and testIamPermissions every permission (A9)", () => {
  assert.equal(judgeAllowed(byKind("secret access"), { status: 200, body: {} }).passed, true);
  assert.equal(judgeAllowed(byKind("secret access"), denied("secretmanager.versions.access")).passed, false);
  const t = byKind("impersonate test");
  assert.equal(judgeAllowed(t, { status: 200, body: { permissions: ["iam.serviceAccounts.getAccessToken"] } }).passed, false, "one permission isn't all of them");
  assert.equal(judgeAllowed(t, { status: 200, body: { permissions: t.body.permissions } }).passed, true);
});

test("an IAM run reaches every check, fails without coverage, and redacts what an allowed call returns", async () => {
  const run = await runIam(iamConfig, "compiler", { token: "t", doFetch: fetchWith(null), idToken: async () => "a.b.c" });
  assert.equal(run.passed, true);
  assert.ok(run.rows.find(r => r.positiveControl).passed);
  assert.ok(run.rows.find(r => r.id === "coverage").passed);
  const thin = await runIam({ ...iamConfig, impersonate: ["policy-run@graffiticode.iam.gserviceaccount.com"] }, "compiler", { token: "t", doFetch: fetchWith(null), idToken: async () => "a.b.c" });
  assert.equal(thin.passed, false);
  assert.match(thin.rows.find(r => r.id === "coverage").why, /api-run@/);
  const leaky = await runIam({ ...iamConfig, secrets: iamConfig.secrets }, "compiler", { token: "t", doFetch: async () => new Response(JSON.stringify({ payload: { data: "c2VjcmV0" }, signedBlob: "c2ln" }), { status: 200 }) });
  assert.equal(leaky.passed, false);
  const secretRow = leaky.rows.find(r => r.kind === "secret access");
  assert.equal(secretRow.response.body.payload, "[redacted]");
  assert.ok(!JSON.stringify(leaky).includes("c2VjcmV0"));
  assert.ok(!JSON.stringify(leaky).includes("c2ln"));
});

test("the control covers each impersonation method, signBlob included, on the canary account (A12)", async () => {
  const control = await runIam(iamConfig, "control", {
    token: "t",
    doFetch: async (url, init) => {
      if (url.endsWith(":testIamPermissions")) return new Response(JSON.stringify({ permissions: JSON.parse(init.body).permissions }), { status: 200 });
      if (url.includes("firestore")) return fetchWith(init.method === "GET" ? "get" : url.includes(":listCollectionIds") ? "list" : init.method === "PATCH" ? "update" : init.method === "DELETE" ? "delete" : "create")(url, init);
      return new Response(JSON.stringify({ signedBlob: "x", signedJwt: "x", accessToken: "x", token: "x" }), { status: 200 });
    },
  });
  assert.equal(control.passed, true, JSON.stringify(control.rows.filter(r => !r.passed)));
  for (const kind of ["impersonate generateAccessToken", "impersonate generateIdToken", "impersonate signJwt", "impersonate signBlob"]) assert.ok(control.rows.some(r => r.kind === kind && r.passed), kind);
});

test("a compiler run is void without a passing control of the same nonce and image digest (A19)", () => {
  const compiler = { role: "compiler", version: VERSION, nonce: "n1", execution: "at11-iam-l0176-abc", passed: true, rows: [{ id: "coverage", kind: "coverage", passed: true }, { id: "secret access projects/x/secrets/a", kind: "secret access", passed: true }, { id: "own id token for b", kind: "own id token", positiveControl: true, passed: true }] };
  const control = { role: "control", version: VERSION, nonce: "n1", execution: "at11-iam-control-def", passed: true, rows: [{ id: "secret access projects/x/secrets/canary", kind: "secret access", passed: true }] };
  const digests = { "at11-iam-l0176-abc": "sha256:1", "at11-iam-control-def": "sha256:1" };
  assert.deepEqual(combine(compiler, control, { digests }), { void: false, passed: true });
  assert.equal(combine(compiler, { ...control, passed: false }, { digests }).void, true);
  assert.equal(combine(compiler, { ...control, version: "other" }, { digests }).void, true);
  assert.equal(combine(compiler, { ...control, nonce: "n2" }, { digests }).void, true);
  assert.equal(combine(compiler, { ...control, execution: compiler.execution }, { digests }).void, true);
  assert.equal(combine(compiler, control, { digests: { ...digests, "at11-iam-control-def": "sha256:2" } }).void, true);
  assert.match(combine({ ...compiler, rows: [...compiler.rows, { id: "kms sign projects/k", kind: "kms sign", passed: true }] }, control, { digests }).why, /no control for: kms sign/);
});

test("stand-ins replace PRIVILEGED only in the scratch project (step 0)", () => {
  const scratch = {
    project: "graffiticode-isolate01",
    standIns: true,
    secrets: ["projects/graffiticode-isolate01/secrets/egress-proxy-cert-api-graffiticode-org"],
    databases: ["projects/graffiticode-isolate01/databases/at11-priv-a", "projects/graffiticode-isolate01/databases/at11-priv-b"],
    kmsKeys: ["projects/graffiticode-isolate01/locations/us-central1/keyRings/at11/cryptoKeys/priv-signing/cryptoKeyVersions/1"],
    impersonate: ["egress-proxy@graffiticode-isolate01.iam.gserviceaccount.com"],
    service: "projects/graffiticode-isolate01/locations/us-central1/services/at11-own-default",
  };
  assert.deepEqual(coverageProblems(scratch), []);
  assert.match(coverageProblems({ ...scratch, project: "graffiticode" })[0], /only in graffiticode-isolate01, not graffiticode/, "production can't use stand-ins");
  assert.ok(coverageProblems({ ...scratch, databases: scratch.databases.slice(0, 1) }).some(p => /2 stand-in databases/.test(p)));
  assert.ok(coverageProblems({ ...scratch, impersonate: ["api-run@graffiticode.iam.gserviceaccount.com"] }).some(p => /impersonate outside/.test(p)), "a stand-in must be a scratch resource");
  assert.ok(coverageProblems({ ...scratch, standIns: false }).length > 5, "without standIns, PRIVILEGED applies");
});

// Step 7: each compiler run is the identity it names, with its own positive control.
test("a compiler config must carry its own positive control", () => {
  const { ownAudience: _a, ...without } = iamConfig;
  assert.ok(coverageProblems(without).some(p => /positive control/.test(p)));
  assert.ok(!coverageProblems(iamConfig).some(p => /positive control/.test(p)));
});

test("a compiler run fails unless it ran as its subject, against its own service", async () => {
  const service = iamConfig.service;
  const lang = service.split("/services/")[1];
  const subject = `${lang}-run`;
  assert.equal(accountOf(subject), `${lang}-run@graffiticode.iam.gserviceaccount.com`);
  assert.deepEqual(subjectProblems(subject, accountOf(subject), iamConfig), []);
  assert.match(subjectProblems(subject, "l0000-run@graffiticode.iam.gserviceaccount.com", iamConfig).join(), /ran as l0000-run/);
  assert.match(subjectProblems("l0158-run", "l0158-run@graffiticode.iam.gserviceaccount.com", iamConfig).join(), /isn't l0158's/);
  const ok = await runIam(iamConfig, "compiler", { token: "t", doFetch: fetchWith(null), idToken: async () => "a.b.c", subject, identity: accountOf(subject) });
  assert.equal(ok.passed, true);
  const impostor = await runIam(iamConfig, "compiler", { token: "t", doFetch: fetchWith(null), idToken: async () => "a.b.c", subject, identity: "at11-control@graffiticode.iam.gserviceaccount.com" });
  assert.equal(impostor.passed, false);
  assert.match(impostor.rows.find(r => r.id === "subject").why, /ran as at11-control/);
});

test("no 400 counts as a success, for the compiler or the control, except the one each check names", () => {
  for (const check of checksFor({ ...iamConfig.canary ?? iamConfig })) {
    if (check.test) continue;
    for (const rpc of [undefined, "INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE"]) {
      const response = { status: 400, body: rpc ? { error: { status: rpc } } : {} };
      const named = (check.allowed ?? []).some(a => a.status === 400 && a.rpc === rpc);
      assert.equal(judgeDenied(check, response).passed, false, `${check.id} ${rpc}: a 400 passed as a denial`);
      assert.equal(judgeAllowed(check, response).passed, named, `${check.id} ${rpc}: a 400 passed the control`);
    }
  }
});

test("one IAM config serves every compiler: {lang} in its service comes from the subject", () => {
  const shared = { ...iamConfig, service: "projects/graffiticode/locations/us-central1/services/{lang}" };
  assert.equal(resolveForSubject(shared, "l0002-run").service, "projects/graffiticode/locations/us-central1/services/l0002");
  assert.equal(resolveForSubject(shared, "l0176r-run@graffiticode.iam.gserviceaccount.com").service, "projects/graffiticode/locations/us-central1/services/l0176r");
  assert.deepEqual(subjectProblems("l0002-run", accountOf("l0002-run"), resolveForSubject(shared, "l0002-run")), []);
  assert.equal(resolveForSubject(iamConfig, "l0002-run"), iamConfig, "a config without {lang} is unchanged");
  assert.equal(resolveForSubject(shared, null), shared, "the control's config is unchanged");
});

test("the committed step 7 IAM config covers every privileged resource for any compiler, and voids runs until the control is provisioned", async () => {
  const { readFile } = await import("node:fs/promises");
  const shared = JSON.parse(await readFile(new URL("../../deploy/egress-proxy/step7/at11/iam.json", import.meta.url), "utf8"));
  for (const subject of ["l0002-run", "l0176-run", "l0176r-run"]) {
    const config = resolveForSubject(shared, subject);
    assert.deepEqual(coverageProblems(config), [], subject);
    assert.deepEqual(subjectProblems(subject, accountOf(subject), config), [], subject);
  }
  await assert.rejects(runIam(shared, "control", { token: "t", doFetch: async () => new Response("{}") }), /no canary resources/);
});
