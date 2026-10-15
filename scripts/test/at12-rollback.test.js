/* eslint-disable camelcase -- Learnosity field names (valid_response) */
// AT-12, cutover and rollback portion (spec RELEASE-01; capability plan W4,
// section G), against the ACTUAL pre-W4 code: Policy and Broker as released in
// W3, built by scripts/at12-baseline.js into .at12-baseline/, beside the
// current ones. It shows which checks a rollback below W4 would lose (so
// protected execution must stay off for one), that the current services
// fail closed on the old ones' proofs, that old receipts survive, and that
// release-check (and so `enable`) refuses while an old revision is reachable.
//
//   node scripts/at12-baseline.js && node --test scripts/test/at12-rollback.test.js
//
// CI runs it as its own job (.github/workflows/ci.yml, at12-rollback).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateKeyPair, exportJWK, decodeJwt } from "jose";
import { BASELINE_COMMIT, BASELINE_DIR } from "../at12-baseline.js";
import { releaseCheck } from "../../packages/deploy/src/release.js";
import { createGit } from "../../packages/deploy/src/git.js";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (!existsSync(path.join(BASELINE_DIR, ".at12-built"))) {
  throw new Error("Build the W3 baseline first: node scripts/at12-baseline.js");
}
const load = async rel => import(pathToFileURL(path.join(BASELINE_DIR, rel)).href);
const OLD = { policy: await load("packages/policy/dist/index.js"), broker: await load("packages/broker/dist/index.js") };
const NEW = { policy: await import("@graffiticode/policy"), broker: await import("@graffiticode/broker") };

const OWNER = "0xowner";
const GATEWAY = { role: "gateway" };
const L0176 = { role: "compiler", lang: "0176" };
const WRITE = "learnosity.write-items";
const PAYLOAD = {
  questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: "?", options: [{ label: "A", value: "0" }], validation: { valid_response: { score: 1, value: ["0"] } } } }],
  itemRecords: [{ reference: "item-0", status: "unpublished", definition: { widgets: [{ reference: "q-0" }] }, questions: [{ reference: "q-0" }] }],
};

const pair = await generateKeyPair("ES256", { extractable: true });
const privateJwk = await exportJWK(pair.privateKey);
const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };

// A Policy of either version over its own stores; the minimum is the new one's.
const policyOf = async (V, { minContractVersion } = {}) => V.policy.createPolicy({
  signer: await V.policy.createLocalSigner({ privateJwk, kid: "k1" }),
  jwks,
  connections: V.policy.createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]),
  invocations: V.policy.createMemoryInvocationStore(),
  publications: V.policy.createMemoryPublicationStore(),
  protectedSwitch: V.policy.createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
  audit: async () => {},
  ...(minContractVersion ? { minContractVersion } : {}),
});
// A Broker of either version, authorizing with the given Policy in process.
// Across versions, a refusal must reach the Broker as its own denial, the way
// its HTTP authorizer turns Policy's 403 and reason into one (in process, an
// instanceof check across two module copies would read it as unavailable).
// `refusals` collects Policy's own reasons, which an old Broker may not record.
const authorizerFor = (V, policy, refusals = []) => async ({ signal: _signal, ...ask }) => {
  try {
    return await policy.authorizeExecution({ caller: { role: "broker" }, ...ask });
  } catch (e) {
    if (typeof e?.reason === "string") { refusals.push(e.reason); throw new V.broker.AuthorizationDenied(e.reason); }
    throw e;
  }
};
const brokerOf = (V, { authorizer, receipts = V.broker.createMemoryReceiptStore(), providerCalls, refusals, minContractVersion } = {}) => V.broker.createBroker({
  jwks,
  protectedSwitch: V.policy?.createProtectedSwitch
    ? V.policy.createProtectedSwitch({ readFlag: async () => ({ enabled: true }) })
    : NEW.policy.createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
  audit: async () => {},
  operations: V.broker.buildOperations({
    sdk: { init: () => ({}) },
    domain: "d",
    dataApi: async ({ route }) => { providerCalls.push(route); return { meta: { status: true } }; },
  }),
  secrets: V.broker.createMemorySecretStore({ "conn-1": { ownerUid: OWNER, backend: "learnosity", key: "k", secret: "s" } }),
  once: V.broker.createMemoryOnceStore(),
  receipts,
  activity: V.broker.createMemoryActivityStore(),
  authorize: authorizerFor(V, authorizer, refusals),
  ...(minContractVersion ? { minContractVersion } : {}),
});
// An execution token from a Policy, as the gateway and L0176 obtain one.
const writeToken = async (policy, { key = "job-1" } = {}) => {
  const { invocationToken } = await policy.allocateInvocation({ caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: "chain", inputDigest: "a".repeat(64), idempotencyKey: key });
  const { sessionToken } = await policy.snapshot({ caller: L0176, user: { uid: OWNER }, lang: "0176", connectionId: "conn-1", fns: ["save-to-itembank"], invocationToken, stage: "s0" });
  const { executionToken } = await policy.mint({ caller: L0176, sessionToken, fn: "save-to-itembank", op: WRITE, occurrenceId: "n1.0", argsDigest: NEW.broker.argsDigest(PAYLOAD) });
  return executionToken;
};
const execute = (broker, token) => broker.execute({ caller: L0176, token, op: WRITE, payload: PAYLOAD });

test("the W3 Policy has none of W4's checks: no admission, and it ignores a plan", async () => {
  const old = await policyOf(OLD);
  assert.equal(old.admit, undefined);
  assert.equal(old.planLookup, undefined);
  const { invocationToken } = await old.allocateInvocation({ caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: "chain", inputDigest: "a".repeat(64), admission: true });
  // A forged admission token and manifest are ignored: it issues an unbound session anyway.
  const { sessionToken } = await old.snapshot({ caller: L0176, user: { uid: OWNER }, lang: "0176", connectionId: "conn-1", fns: ["save-to-itembank"], invocationToken, stage: "s0", admissionToken: "forged", manifest: { revision: "anything" } });
  const session = decodeJwt(sessionToken);
  assert.equal(session.cv, undefined);
  assert.equal(session.pld, undefined);
  const token = decodeJwt(await writeToken(old, { key: "job-2" }));
  assert.equal(token.cv, undefined);
});

test("the current Broker at minimum 2 refuses the W3 Policy's proofs, before anything is spent", async () => {
  const providerCalls = [];
  const old = await policyOf(OLD);
  const broker = brokerOf(NEW, { authorizer: old, providerCalls, minContractVersion: 2 });
  await assert.rejects(execute(broker, await writeToken(old)), e => e.reason === "contract-version-unsupported");
  assert.deepEqual(providerCalls, []);
});

// The W3 builds are on registry v6; the current code is on v7 (Author
// removed), so the two refuse each other's proofs on the registry before
// anything else. A W3 Broker asks the current Policy about a W3 proof: refused
// (registry-version-changed), nothing done. A proof re-signed for the current
// registry is refused by the W3 Broker itself (registry-version-mismatch),
// before it asks. The contract minimum at authorization is no longer
// reachable across these versions; Policy's own tests cover it.
const resigned = async (token, over) => {
  const { iss: _iss, aud: _aud, iat: _iat, exp: _exp, jti: _jti, ...claims } = decodeJwt(token);
  return NEW.policy.issueToken(await NEW.policy.createLocalSigner({ privateJwk, kid: "k1" }), "execution", { ...claims, ...over });
};

test("the W3 Broker and the current Policy at minimum 2 refuse each other's proofs, and nothing is done", async () => {
  const providerCalls = [];
  const refusals = [];
  const current = await policyOf(NEW, { minContractVersion: 2 });
  const old = await policyOf(OLD);
  const broker = () => brokerOf(OLD, { authorizer: current, providerCalls, refusals });
  const out = await execute(broker(), await writeToken(old));
  assert.equal(out.status, "failed");
  assert.deepEqual(out.steps, []);
  assert.equal(out.reason, "authorization-denied:registry-version-changed");
  assert.deepEqual(refusals, ["registry-version-changed"]);
  for (const over of [{ rv: REGISTRY_VERSION }, { rv: REGISTRY_VERSION, cv: 3 }]) {
    await assert.rejects(execute(broker(), await resigned(await writeToken(old, { key: `job-${over.cv ?? 2}` }), over)), e => e.reason === "registry-version-mismatch");
  }
  assert.deepEqual(refusals, ["registry-version-changed"]);
  assert.deepEqual(providerCalls, []);
});

// Receipts the W3 Broker wrote are never executed again by the current one.
// Their own proofs are refused on the registry (v6, now v7); a fresh token for
// the same operation, on the current registry, is refused by the receipt's own
// registry check; and after the cutover, by the contract minimum, before the
// receipt is read (the gateway answers invocation-incompatible).
test("receipts the W3 Broker wrote are never re-executed: refused across the registry change and the cutover", async () => {
  const providerCalls = [];
  const old = await policyOf(OLD);
  const receipts = OLD.broker.createMemoryReceiptStore();
  const first = await execute(brokerOf(OLD, { authorizer: old, receipts, providerCalls }), await writeToken(old));
  assert.equal(first.status, "succeeded");
  const written = [...providerCalls];
  const current = brokerOf(NEW, { authorizer: old, receipts, providerCalls });
  await assert.rejects(execute(current, await writeToken(old)), e => e.reason === "registry-version-mismatch");
  await assert.rejects(execute(current, await resigned(await writeToken(old), { rv: REGISTRY_VERSION })), e => e.reason === "receipt-registry-version-mismatch");
  const cutover = brokerOf(NEW, { authorizer: old, receipts, providerCalls, minContractVersion: 2 });
  await assert.rejects(execute(cutover, await writeToken(old)), e => e.reason === "contract-version-unsupported");
  assert.deepEqual(providerCalls, written);
});

// The refusals leave a W3 receipt as it was written. Rolled back, the W3
// Broker replays its stored outcome; on the current code, reconciliation
// reports it (claimed before W5, so without evidence) and changes nothing.
// The receipts are the current code's store over what the W3 Broker wrote,
// as Firestore keeps the same documents across a release.
test("a W3 receipt survives: still as written, replayed after a rollback, and reported by reconciliation", async () => {
  const providerCalls = [];
  const old = await policyOf(OLD);
  const receipts = NEW.broker.createMemoryReceiptStore();
  const token = await writeToken(old);
  const first = await execute(brokerOf(OLD, { authorizer: old, receipts, providerCalls }), token);
  assert.equal(first.status, "succeeded");
  const { opid } = decodeJwt(token);
  const invocationId = String(opid).split("/")[0];
  const written = [...providerCalls];
  const receipt = async () => ({ claims: await receipts.listClaims(invocationId), outcome: await receipts.getOutcome(opid), steps: await receipts.getSteps(opid) });
  const before = await receipt();
  assert.equal(before.claims.length, 1);
  assert.equal(before.outcome.status, "succeeded");

  const current = brokerOf(NEW, { authorizer: old, receipts, providerCalls });
  await assert.rejects(execute(current, await writeToken(old)), e => e.reason === "registry-version-mismatch");
  await assert.rejects(execute(current, await resigned(await writeToken(old), { rv: REGISTRY_VERSION })), e => e.reason === "receipt-registry-version-mismatch");
  const cutover = brokerOf(NEW, { authorizer: old, receipts, providerCalls, minContractVersion: 2 });
  await assert.rejects(execute(cutover, await writeToken(old)), e => e.reason === "contract-version-unsupported");
  assert.deepEqual(await receipt(), before);

  const replay = await execute(brokerOf(OLD, { authorizer: old, receipts, providerCalls }), await writeToken(old));
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, "succeeded");
  assert.deepEqual(replay.steps, first.steps);
  assert.deepEqual(replay.result, first.result);

  const reconcile = NEW.broker.createReconciler({
    receipts,
    secrets: NEW.broker.createMemorySecretStore({ "conn-1": { ownerUid: OWNER, backend: "learnosity", key: "k", secret: "s" } }),
    operations: NEW.broker.buildOperations({ sdk: { init: () => ({}) }, domain: "d", dataApi: async ({ route }) => { providerCalls.push(route); return { meta: { status: true } }; } }),
    limits: { executionMs: 1000, providerCallMs: 1000 },
    audit: async () => {},
  });
  const report = await reconcile({ connectionId: "conn-1", invocationId, decisionId: "decision-1" });
  assert.deepEqual(report, { invocationId, operations: [{ operationId: opid, verdict: "unresolved", reason: "no-evidence" }] });
  assert.deepEqual((await receipt()).outcome, before.outcome);
  assert.deepEqual(providerCalls, written);
});

test("release-check refuses while a revision below the W4 milestone is reachable, by its tag", async () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const service = {
    status: {
      traffic: [
        { revisionName: "l0176-current", percent: 100 },
        { revisionName: "l0176-w3", tag: "w3" },
      ]
    }
  };
  const labels = { "l0176-current": head, "l0176-w3": BASELINE_COMMIT };
  const cloud = async args => {
    if (args[1] === "revisions" && args[2] === "describe") return { metadata: { labels: { "commit-sha": labels[args[3]], "gc-dirty": "false" } } };
    return structuredClone(service);
  };
  const records = new Map(Object.keys(labels).map(revision => [revision, { revision, status: "approved", contractVersions: [1, 2] }]));
  const context = { config: { service: "l0176", pinnable: { lang: "0176" }, retireTags: true, baselines: [{ milestone: "W4", commit: head }] } };
  const check = await releaseCheck(context, { cloud, git: createGit(ROOT), revisions: { list: async () => records } });
  assert.equal(check.ok, false);
  assert.deepEqual(check.belowBaseline, ["l0176-w3"]);
  // With that tag retired, nothing below the milestone is reachable.
  service.status.traffic = service.status.traffic.filter(t => t.tag !== "w3");
  assert.equal((await releaseCheck(context, { cloud, git: createGit(ROOT), revisions: { list: async () => records } })).ok, true);
});
