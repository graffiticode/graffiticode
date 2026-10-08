import test from "node:test";
import assert from "node:assert/strict";
import { workloadChecks, analyzeImpersonation, authentications, disableWindow, activityFilter, keyEventsFilter, verdict, SHORT_LIVED_MS } from "../lib/sa-consumers.js";

const SA = "firebase-adminsdk-qflje@graffiticode.iam.gserviceaccount.com";
const OTHER = "api-run@graffiticode.iam.gserviceaccount.com";
const ok = value => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const denied = { code: 1, stdout: "", stderr: "ERROR: (gcloud) PERMISSION_DENIED: caller lacks permission\n" };
const disabledApi = { code: 1, stdout: "", stderr: "ERROR: API [cloudscheduler.googleapis.com] not enabled on project\n" };

// A project with one Cloud Run service (serving a revision, and a tagged older
// one), and empty inventories everywhere else. `over` replaces a response by
// its command (the args, without --format).
const world = (over = {}) => {
  const responses = {
    "run services list": ok([{
      metadata: { name: "api", labels: { "cloud.googleapis.com/location": "us-central1" } },
      status: { latestReadyRevisionName: "api-new", traffic: [{ revisionName: "api-new", percent: 100 }, { revisionName: "api-old", tag: "old" }] },
    }]),
    "run revisions describe api-new --region=us-central1": ok({ spec: { serviceAccountName: OTHER } }),
    "run revisions describe api-old --region=us-central1": ok({ spec: { serviceAccountName: OTHER } }),
    "run regions list": ok([{ locationId: "us-central1" }, { locationId: "europe-west1" }]),
    "run jobs list --region=us-central1": ok([]),
    "run jobs list --region=europe-west1": ok([]),
    "functions list --regions=-": ok([]),
    "app describe": { code: 1, stdout: "", stderr: "ERROR: (gcloud.app.describe) The project [graffiticode] does not contain an App Engine application.\n" },
    "compute instances list": ok([]),
    "compute regions list": ok([{ name: "us-central1" }, { name: "europe-west1" }]),
    "builds triggers list --region=global": ok([]),
    "builds triggers list --region=us-central1": ok([]),
    "builds triggers list --region=europe-west1": ok([]),
    "scheduler locations list": ok([{ locationId: "us-central1" }]),
    "scheduler jobs list --location=us-central1": ok([]),
    "eventarc locations list": ok([{ locationId: "us-central1" }]),
    "eventarc triggers list --location=us-central1": ok([]),
    "pubsub subscriptions list": ok([]),
    ...over,
  };
  const calls = [];
  const gcloud = async args => {
    const key = args.filter(a => !a.startsWith("--format")).join(" ");
    calls.push(key);
    return responses[key] ?? { code: 1, stdout: "", stderr: `ERROR: unexpected command ${key}\n` };
  };
  return { gcloud, calls };
};
const runWorkloads = async w => Promise.all(workloadChecks(w.gcloud, SA).map(c => c()));
const byCheck = results => Object.fromEntries(results.map(r => [r.check, r]));

test("passes when every inventory is read completely and nothing runs as the account", async () => {
  const w = world();
  const results = byCheck(await runWorkloads(w));
  for (const r of Object.values(results)) assert.equal(r.status, "PASS", `${r.check}: ${JSON.stringify(r)}`);
  assert.equal(results["cloud-run-revisions"].scanned, 2);
  assert.equal(results["app-engine-versions"].note, "the project has no App Engine application");
  // Cloud Build triggers are listed in global and in every region, not just the default.
  assert.deepEqual(w.calls.filter(c => c.startsWith("builds triggers")), [
    "builds triggers list --region=global", "builds triggers list --region=us-central1", "builds triggers list --region=europe-west1",
  ]);
});

test("a failed listing is INCOMPLETE, never none: a permission failure, a disabled API, a failed region listing", async () => {
  const results = byCheck(await runWorkloads(world({
    "compute instances list": denied,
    "scheduler jobs list --location=us-central1": disabledApi,
    "run regions list": denied,
  })));
  assert.equal(results["compute-instances"].status, "INCOMPLETE");
  assert.match(results["compute-instances"].incomplete[0], /PERMISSION_DENIED/);
  assert.equal(results["cloud-scheduler-jobs"].status, "INCOMPLETE");
  assert.match(results["cloud-scheduler-jobs"].incomplete[0], /not enabled/);
  assert.equal(results["cloud-run-jobs"].status, "INCOMPLETE");
  assert.equal(verdict(Object.values(results)).status, "INCOMPLETE");
});

test("App Engine passes only when the project has no application; any other failure is INCOMPLETE", async () => {
  const results = byCheck(await runWorkloads(world({ "app describe": disabledApi })));
  assert.equal(results["app-engine-versions"].status, "INCOMPLETE");
});

test("an older tagged Cloud Run revision running as the account is FOUND, whatever the template says", async () => {
  const results = byCheck(await runWorkloads(world({ "run revisions describe api-old --region=us-central1": ok({ spec: { serviceAccountName: SA } }) })));
  assert.equal(results["cloud-run-revisions"].status, "FOUND");
  assert.deepEqual(results["cloud-run-revisions"].found, ["api/api-old"]);
});

test("a regional trigger, a scheduler token, a push subscription or an instance running as it is FOUND", async () => {
  const results = byCheck(await runWorkloads(world({
    "builds triggers list --region=europe-west1": ok([{ name: "nightly", serviceAccount: `projects/graffiticode/serviceAccounts/${SA}` }]),
    "scheduler jobs list --location=us-central1": ok([{ name: "ping", httpTarget: { oidcToken: { serviceAccountEmail: SA } } }]),
    "pubsub subscriptions list": ok([{ name: "sub", pushConfig: { oidcToken: { serviceAccountEmail: SA } } }]),
    "compute instances list": ok([{ name: "vm", serviceAccounts: [{ email: SA }] }]),
  })));
  for (const c of ["cloud-build-triggers", "cloud-scheduler-jobs", "pubsub-push-subscriptions", "compute-instances"]) assert.equal(results[c].status, "FOUND", c);
  assert.equal(verdict(Object.values(results), { "cloud-build-triggers": "x" }).status, "FOUND");
});

// The Analyzer's response, as --show-response returns it.
const analysis = ({ identities = ["user:owner@example.com"], fullyExplored = true, impersonation = [], errors = [], conditional = false } = {}) => ({
  fullyExplored,
  mainAnalysis: {
    fullyExplored,
    nonCriticalErrors: errors,
    analysisResults: [{
      attachedResourceFullName: "//cloudresourcemanager.googleapis.com/projects/1",
      iamBinding: { role: "roles/owner" },
      accessControlLists: [{ conditionEvaluation: conditional ? { evaluationValue: "CONDITIONAL" } : undefined }],
      identityList: { identities: identities.map(name => ({ name })) },
      fullyExplored: true,
    }],
  },
  serviceAccountImpersonationAnalysis: impersonation,
});
const allowed = ["user:owner@example.com", `serviceAccount:${SA}`];

test("who can act as it: PASS only when fully explored and only the operators", () => {
  assert.equal(analyzeImpersonation(analysis(), { allowed }).status, "PASS");
});

test("who can act as it: anyone else is FOUND, including through an indirect impersonation path", () => {
  const direct = analyzeImpersonation(analysis({ identities: ["user:owner@example.com", "serviceAccount:ci@x.iam.gserviceaccount.com"] }), { allowed });
  assert.equal(direct.status, "FOUND");
  assert.equal(direct.found[0].identity, "serviceAccount:ci@x.iam.gserviceaccount.com");
  const indirect = analyzeImpersonation(analysis({
    impersonation: [{ fullyExplored: true, analysisResults: [{ iamBinding: { role: "roles/iam.serviceAccountTokenCreator" }, attachedResourceFullName: "//iam/x", identityList: { identities: [{ name: "user:someone@example.com" }] } }] }],
  }), { allowed });
  assert.equal(indirect.status, "FOUND");
  assert.match(indirect.found[0].via[0], /\(indirect\)/);
});

test("who can act as it: an incomplete analysis is INCOMPLETE: not fully explored, errors, unexpanded groups, conditions", () => {
  assert.equal(analyzeImpersonation(analysis({ fullyExplored: false }), { allowed }).status, "INCOMPLETE");
  assert.equal(analyzeImpersonation(analysis({ errors: [{ cause: "quota" }] }), { allowed }).status, "INCOMPLETE");
  assert.equal(analyzeImpersonation(analysis({ conditional: true }), { allowed }).status, "INCOMPLETE");
  const group = analyzeImpersonation(analysis({ identities: ["group:ops@example.com"] }), { allowed: [...allowed, "group:ops@example.com"] });
  assert.equal(group.status, "INCOMPLETE");
  assert.match(group.incomplete[0], /not expanded/);
  assert.equal(analyzeImpersonation({}, { allowed }).status, "INCOMPLETE");
});

const DISABLED = "2026-10-07T22:40:00.000Z";
const at = ms => new Date(Date.parse(DISABLED) + ms).toISOString();
const entry = (timestamp, keyName = null) => ({ timestamp, protoPayload: { serviceName: "firestore.googleapis.com", methodName: "Write", authenticationInfo: keyName ? { serviceAccountKeyName: keyName } : {} } });

test("authentications: none after the recorded disable time passes, with its limits stated", () => {
  const r = byCheck(authentications({ disabledAt: DISABLED, entries: { value: [entry(at(-1000), "keys/6bfb")] }, analyzer: [{ check: "analyzer-key-last-auth", last: "2026-09-11T07:00:00Z" }] }));
  assert.equal(r["key-disable-time"].status, "PASS");
  assert.equal(r["audit-log-activity"].status, "PASS");
  assert.match(r["audit-log-activity"].limits, /Data Access/);
  assert.equal(r["analyzer-key-last-auth"].status, "PASS");
});

test("authentications: activity after the disable is FOUND, told apart by how it authenticated", () => {
  const r = byCheck(authentications({
    disabledAt: DISABLED,
    entries: { value: [entry(at(10 * 60 * 1000), "projects/-/serviceAccounts/x/keys/6bfb"), entry(at(SHORT_LIVED_MS + 60000))] },
    analyzer: [],
    account: SA,
    keyId: "6bfb",
  }));
  assert.equal(r["audit-log-activity"].status, "FOUND");
  assert.match(r["audit-log-activity"].found[0], /a credential issued with the key before it was disabled/);
  assert.match(r["audit-log-activity"].found[1], /credential source unknown/);
});

test("authentications: no disable time, a failed log read, or a same-day Analyzer date is INCOMPLETE; a later date is FOUND", () => {
  assert.equal(byCheck(authentications({ disabledAt: null, entries: { value: [] }, analyzer: [] }))["key-disable-time"].status, "INCOMPLETE");
  const unread = byCheck(authentications({ disabledAt: null, disableIncomplete: "logging read (key disable): exit 1: reauthentication failed", entries: { incomplete: "no window" }, analyzer: [] }));
  assert.match(unread["key-disable-time"].incomplete[0], /reauthentication failed/);
  assert.equal(byCheck(authentications({ disabledAt: DISABLED, entries: { incomplete: "logging read: exit 1" }, analyzer: [] }))["audit-log-activity"].status, "INCOMPLETE");
  const sameDay = byCheck(authentications({ disabledAt: DISABLED, entries: { value: [] }, analyzer: [{ check: "analyzer-account-last-auth", last: "2026-10-07T07:00:00Z" }] }));
  assert.equal(sameDay["analyzer-account-last-auth"].status, "INCOMPLETE");
  const later = byCheck(authentications({ disabledAt: DISABLED, entries: { value: [] }, analyzer: [{ check: "analyzer-account-last-auth", last: "2026-10-09T07:00:00Z" }] }));
  assert.equal(later["analyzer-account-last-auth"].status, "FOUND");
});

test("the verdict: an accepted INCOMPLETE records its reason; FOUND is never accepted; supplementary checks don't decide", () => {
  const results = [
    { check: "a", status: "PASS" },
    { check: "b", status: "INCOMPLETE", incomplete: ["x"] },
    { check: "asset-search (supplementary)", status: "SUPPLEMENTARY" },
  ];
  assert.equal(verdict(results).status, "INCOMPLETE");
  const accepted = verdict(results, { b: "checked by hand", c: "typo" });
  assert.equal(accepted.status, "PASS");
  assert.equal(accepted.checks[1].acceptedBecause, "checked by hand");
  assert.deepEqual(accepted.unusedAcceptances, ["c"]);
  assert.equal(verdict([{ check: "f", status: "FOUND" }], { f: "no" }).status, "FOUND");
});

// Review of #50: three gaps.
test("App Engine: a version running as the account is FOUND (gcloud nests it under `version`)", async () => {
  // As `gcloud app versions list --format=json` returns a version.
  const version = (id, serviceAccount) => ({
    id,
    service: "default",
    project: "graffiticode",
    version: { id, name: `apps/graffiticode/services/default/versions/${id}`, servingStatus: "SERVING", ...(serviceAccount ? { serviceAccount } : {}) },
  });
  const results = byCheck(await runWorkloads(world({
    "app describe": ok({ id: "graffiticode" }),
    "app versions list": ok([version("v1", SA), version("v2", null)]),
  })));
  assert.equal(results["app-engine-versions"].status, "FOUND");
  assert.deepEqual(results["app-engine-versions"].found, ["default/v1"]);
  assert.equal(results["app-engine-versions"].scanned, 2);
});

const keyEvent = (timestamp, method, failed = false) => ({
  timestamp,
  severity: failed ? "ERROR" : "NOTICE",
  protoPayload: { methodName: `google.iam.admin.v1.${method}`, ...(failed ? { status: { code: 7, message: "PERMISSION_DENIED" } } : {}) },
});

test("the window starts at the first SUCCESSFUL disable: a failed later attempt never moves it", () => {
  const w = disableWindow([
    keyEvent("2026-10-07T23:38:49Z", "DisableServiceAccountKey"),
    keyEvent("2026-10-08T12:00:00Z", "DisableServiceAccountKey", true),
  ]);
  assert.equal(w.disabledAt, "2026-10-07T23:38:49Z");
  assert.deepEqual(w.reenabled, []);
  assert.equal(w.failed.length, 1);
  assert.equal(disableWindow([keyEvent("2026-10-07T23:00:00Z", "DisableServiceAccountKey", true)]).disabledAt, null);
});

test("a re-enable after the disable is FOUND: the key was usable again", () => {
  const w = disableWindow([keyEvent("2026-10-07T23:38:49Z", "DisableServiceAccountKey"), keyEvent("2026-10-09T10:00:00Z", "EnableServiceAccountKey"), keyEvent("2026-10-09T11:00:00Z", "DisableServiceAccountKey")]);
  assert.equal(w.disabledAt, "2026-10-07T23:38:49Z");
  const r = byCheck(authentications({ disabledAt: w.disabledAt, reenabled: w.reenabled, entries: { value: [] }, analyzer: [] }));
  assert.equal(r["key-disable-time"].status, "FOUND");
  assert.match(r["key-disable-time"].found[0], /re-enabled at 2026-10-09T10:00:00Z/);
});

test("credential minting for the account by another principal is FOUND, and a missing key name is 'source unknown'", () => {
  const mint = { timestamp: at(2 * SHORT_LIVED_MS), protoPayload: { serviceName: "iamcredentials.googleapis.com", methodName: "GenerateAccessToken", resourceName: `projects/-/serviceAccounts/${SA}`, authenticationInfo: { principalEmail: "someone@example.com" } } };
  const noKey = { timestamp: at(3 * SHORT_LIVED_MS), protoPayload: { serviceName: "storage.googleapis.com", methodName: "storage.objects.update", authenticationInfo: { principalEmail: SA } } };
  const r = byCheck(authentications({ disabledAt: DISABLED, entries: { value: [mint, noKey] }, analyzer: [], account: SA, keyId: "6bfb0894" }));
  assert.equal(r["audit-log-activity"].status, "FOUND");
  assert.match(r["audit-log-activity"].found[0], /minted by someone@example.com/);
  assert.match(r["audit-log-activity"].found[1], /credential source unknown/);
});

// Review of #50: the activity query itself, not just classification.
test("the activity filter matches credential minting wherever the entry names the target account", () => {
  const f = activityFilter({ account: SA, uniqueId: "115770615674472306642", disabledAt: DISABLED });
  assert.ok(f.startsWith(`timestamp>="${DISABLED}" AND (`));
  assert.ok(f.includes(`protoPayload.authenticationInfo.principalEmail="${SA}"`));
  // Google's documented credential-generation entry: request.name and the resource labels, no resourceName.
  for (const field of [
    `protoPayload.request.name:"${SA}"`,
    "protoPayload.request.name:\"115770615674472306642\"",
    `resource.labels.email_id="${SA}"`,
    "resource.labels.unique_id=\"115770615674472306642\"",
    `protoPayload.resourceName:"${SA}"`,
    "protoPayload.resourceName:\"115770615674472306642\"",
  ]) assert.ok(f.includes(field), field);
  assert.ok(f.includes("protoPayload.serviceName=\"iamcredentials.googleapis.com\""));
  // Without the unique id, the email forms still apply.
  const noId = activityFilter({ account: SA, disabledAt: DISABLED });
  assert.ok(noId.includes(`resource.labels.email_id="${SA}"`));
  assert.equal(noId.includes("unique_id"), false);
});

test("both log queries read only the Cloud Audit logs, with exact method names", () => {
  const logs = "logName=(\"projects/graffiticode/logs/cloudaudit.googleapis.com%2Factivity\" OR \"projects/graffiticode/logs/cloudaudit.googleapis.com%2Fdata_access\")";
  const k = keyEventsFilter({ project: "graffiticode", keyId: "6bfb0894" });
  assert.ok(k.startsWith(`${logs} AND `));
  assert.ok(k.includes("protoPayload.methodName=(\"google.iam.admin.v1.DisableServiceAccountKey\" OR \"google.iam.admin.v1.EnableServiceAccountKey\")"));
  assert.ok(k.includes("protoPayload.resourceName:\"6bfb0894\""));
  const a = activityFilter({ account: SA, uniqueId: "1", disabledAt: DISABLED, project: "graffiticode" });
  assert.ok(a.startsWith(`${logs} AND timestamp>="${DISABLED}"`));
});
