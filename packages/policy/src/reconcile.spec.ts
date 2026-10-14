// Reconciliation requests (WRITE-02, W5 stage 3): who may ask, for which save.
import { generateKeyPair, exportJWK } from "jose";
import {
  createPolicy,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createMemoryGrantStore,
  grantIdFor,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch,
  PolicyDenied,
} from "./index.js";

const PROTECTED_ON = createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });
const OWNER = "0xowner";
const ALICE = "0xalice";
const MALLORY = "0xmallory";
const CONSOLE = { role: "console" };
const GATEWAY = { role: "gateway" };

let policy;
let asked;
let records;
let grants;
let brokerAnswer;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  records = [];
  asked = [];
  brokerAnswer = async ({ invocationId }) => ({ invocationId, operations: [{ operationId: `${invocationId}/s0/n1.0`, verdict: "applied", final: true }] });
  grants = createMemoryGrantStore();
  const connections = createMemoryConnectionStore([
    { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" },
    { connectionId: "conn-2", ownerUid: OWNER, backend: "learnosity", status: "active" },
  ]);
  policy = createPolicy({
    protectedSwitch: PROTECTED_ON,
    signer,
    jwks,
    connections,
    grants,
    invocations: createMemoryInvocationStore(),
    publications: createMemoryPublicationStore(),
    audit: createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) }),
    brokerReconcile: async args => { asked.push(args); return brokerAnswer(args); },
  });
});

const share = (recipientUid, permissions) => grants.put({
  grantId: grantIdFor({ connectionId: "conn-1", recipientUid }),
  connectionId: "conn-1",
  ownerUid: OWNER,
  recipientUid,
  permissions,
  expiresAt: null,
  createdAt: new Date().toISOString(),
});
const save = (uid, idempotencyKey, connectionId = "conn-1") => policy.allocateInvocation({
  caller: GATEWAY, user: { uid }, connectionId, taskId: "task-1", inputDigest: "a".repeat(64), idempotencyKey,
});
const ask = (uid, over = {}) => policy.reconcile({ caller: CONSOLE, user: { uid }, connectionId: "conn-1", ...over });
const denied = async (promise, reason) => {
  const e = await promise.catch(err => err);
  expect(e).toBeInstanceOf(PolicyDenied);
  expect(e.reason).toBe(reason);
};
const SAVE = [{ lang: "0176", fn: "save-to-itembank" }];

describe("reconciliation requests (WRITE-02)", () => {
  it("lets the owner reconcile their save by the exact key it used, and asks Broker for that invocation", async () => {
    const { invocationId } = await save(OWNER, "recompile:1234");
    await save(OWNER, "save:task-1"); // an earlier attempt, under another key
    const out = await ask(OWNER, { idempotencyKey: "recompile:1234" });
    expect(out.operations[0]).toMatchObject({ verdict: "applied" });
    expect(asked).toEqual([{ connectionId: "conn-1", invocationId, decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    expect(records.at(-1)).toMatchObject({ event: "reconcile-request", outcome: "allowed", invocationId, decisionId: asked[0].decisionId });
  });

  it("lets a grantee reconcile their own save while their grant still covers a write, and the owner reconcile it by invocation id", async () => {
    await share(ALICE, SAVE);
    const { invocationId } = await save(ALICE, "save:alice");
    await expect(ask(ALICE, { idempotencyKey: "save:alice" })).resolves.toBeTruthy();
    await expect(ask(OWNER, { invocationId })).resolves.toBeTruthy();
    // Narrowed to previews: no longer.
    await share(ALICE, [{ lang: "0176", fn: "init" }]);
    await denied(ask(ALICE, { idempotencyKey: "save:alice" }), "not-granted");
  });

  it("never reaches someone else's save", async () => {
    await share(ALICE, SAVE);
    await share(MALLORY, SAVE);
    const { invocationId } = await save(ALICE, "save:alice");
    // Another grantee: not their invocation, by id or by trying her key as theirs.
    await denied(ask(MALLORY, { invocationId }), "not-granted");
    await denied(ask(MALLORY, { idempotencyKey: "save:alice" }), "invocation-not-found");
    // Someone with no grant at all.
    await denied(ask("0xstranger", { invocationId }), "not-owner");
    expect(asked).toEqual([]);
  });

  it("refuses an invocation on another connection", async () => {
    const { invocationId } = await save(OWNER, "save:other", "conn-2");
    await denied(ask(OWNER, { invocationId }), "invocation-not-found");
    await denied(ask(OWNER, { idempotencyKey: "save:other" }), "invocation-not-found");
  });

  it("takes requests from the console only, for a signed-in user, naming the save one way", async () => {
    const { invocationId } = await save(OWNER, "k");
    await denied(policy.reconcile({ caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", invocationId }), "caller-not-entry-point");
    await denied(policy.reconcile({ caller: CONSOLE, user: null, connectionId: "conn-1", invocationId }), "no-user");
    await denied(ask(OWNER, {}), "bad-request");
    await denied(ask(OWNER, { invocationId, idempotencyKey: "k" }), "bad-request");
    expect(asked).toEqual([]);
  });

  it("passes on Broker's refusal, and treats a lost answer as unavailable", async () => {
    const { invocationId } = await save(OWNER, "k");
    brokerAnswer = async () => { throw Object.assign(new Error("refused"), { reason: "receipt-not-found" }); };
    await denied(ask(OWNER, { invocationId }), "receipt-not-found");
    brokerAnswer = async () => { throw new Error("socket hang up"); };
    await denied(ask(OWNER, { invocationId }), "unavailable");
    expect(records.filter(r => r.event === "reconcile-request").map(r => [r.outcome, r.reason, r.category])).toEqual([
      ["denied", "receipt-not-found", "malformed"], ["denied", "unavailable", "unavailable"],
    ]);
  });
});
