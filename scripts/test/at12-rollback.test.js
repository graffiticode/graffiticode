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

test("the W3 Broker skips the contract check, but the current Policy at minimum 2 still refuses at authorization", async () => {
  const providerCalls = [];
  const refusals = [];
  const current = await policyOf(NEW, { minContractVersion: 2 });
  const old = await policyOf(OLD);
  const broker = brokerOf(OLD, { authorizer: current, providerCalls, refusals });
  // The old Broker accepts a proof without `cv` and asks Policy: refused.
  // W3's failure table predates W4's reasons, so it records the refusal as
  // unclassified (W3's rule for a reason it doesn't know): still nothing done.
  const out = await execute(broker, await writeToken(old));
  assert.equal(out.status, "failed");
  assert.deepEqual(out.steps, []);
  assert.equal(out.reason, "unclassified-reason");
  assert.deepEqual(refusals, ["contract-version-unsupported"]);
  assert.deepEqual(providerCalls, []);
  // A contract version no one supports, too.
  const { iss: _iss, aud: _aud, iat: _iat, exp: _exp, jti: _jti, ...claims } = decodeJwt(await writeToken(old, { key: "job-3" }));
  const sneaky = await NEW.policy.issueToken(await NEW.policy.createLocalSigner({ privateJwk, kid: "k1" }), "execution", { ...claims, cv: 3 });
  const later = await execute(brokerOf(OLD, { authorizer: current, providerCalls, refusals }), sneaky);
  assert.equal(later.status, "failed");
  assert.equal(later.reason, "unclassified-reason");
  assert.deepEqual(refusals, ["contract-version-unsupported", "contract-version-unsupported"]);
  assert.deepEqual(providerCalls, []);
});

test("receipts the W3 Broker wrote survive: the current Broker replays them and writes nothing", async () => {
  const providerCalls = [];
  const old = await policyOf(OLD);
  const receipts = OLD.broker.createMemoryReceiptStore();
  const first = await execute(brokerOf(OLD, { authorizer: old, receipts, providerCalls }), await writeToken(old));
  assert.equal(first.status, "succeeded");
  const written = [...providerCalls];
  // The same operation again, now through the current Broker over the same receipts.
  const again = await execute(brokerOf(NEW, { authorizer: old, receipts, providerCalls }), await writeToken(old));
  assert.equal(again.status, "succeeded");
  assert.equal(again.replayed, true);
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
