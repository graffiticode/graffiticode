/* eslint-disable camelcase -- Learnosity's stored fields are snake_case */
// Reconciliation (WRITE-02, W5 stage 3): createReconciler against memory
// stores and a fake provider read.
import {
  createMemoryReceiptStore,
  createMemorySecretStore,
  createReconciler,
  ReconcileRefused,
  RECONCILE_GRACE_MS,
  MARK_KEY,
  writeEvidence,
} from "./index.js";

const OWNER = "0xowner";
const CONN = "conn-1";
const INV = "inv-0001";
const OP = `${INV}/s0/n1.0`;
const LIMITS = { executionMs: 30_000, providerCallMs: 10_000, authorizeMs: 5_000 };
const PAYLOAD = {
  questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: "Q" } }],
  itemRecords: [{ reference: "item-0", definition: { widgets: [{ reference: "q-0" }] }, questions: [{ reference: "q-0" }], status: "unpublished" }],
};
const CLAIMED_AT = Date.parse("2026-10-14T12:00:00Z");
const AFTER = CLAIMED_AT + LIMITS.executionMs + RECONCILE_GRACE_MS + 1;

// What the provider stores for the payload, marked by `op` (or unmarked).
const storedFor = (op = OP) => ({
  question: new Map([["q-0", { reference: "q-0", type: "mcq", widget_type: "response", metadata: null, data: { ...PAYLOAD.questionRecords[0].data, ...(op ? { metadata: { [MARK_KEY]: op } } : {}) } }]]),
  item: new Map([["item-0", { ...PAYLOAD.itemRecords[0], title: null, tags: {}, ...(op ? { metadata: { [MARK_KEY]: op } } : {}) }]]),
});

let receipts;
let records;
let reads;
let stored;
let readFails;
let reconcile;
let clock;
let secrets;
let build;

const claim = async (opid = OP, { evidence = writeEvidence(PAYLOAD), connectionId = CONN, ownerUid = OWNER } = {}) => {
  await receipts.claim(opid, { principal: OWNER, ownerUid, connectionId, lang: "0176", fn: "save-to-itembank", op: "learnosity.write-items", registryVersion: 7, argsDigest: "a" }, { ...(evidence ? { evidence } : {}) });
};

beforeEach(() => {
  receipts = createMemoryReceiptStore();
  const listClaims = receipts.listClaims.bind(receipts);
  receipts.listClaims = async id => (await listClaims(id)).map(c => ({ ...c, claimedAt: new Date(CLAIMED_AT).toISOString() }));
  records = [];
  reads = 0;
  stored = storedFor();
  readFails = false;
  clock = AFTER;
  const operations = {
    "learnosity.write-items": {
      kind: "write",
      readBack: async evidence => {
        reads++;
        if (readFails) throw new Error("provider down");
        expect(evidence.records.map(r => r.reference)).toEqual(["q-0", "item-0"]);
        return stored;
      },
    },
  };
  secrets = createMemorySecretStore({ [CONN]: { ownerUid: OWNER, backend: "learnosity", key: "k", secret: "s" } });
  build = () => createReconciler({ receipts, secrets, operations, limits: LIMITS, audit: async r => { records.push(r); }, now: () => clock });
  reconcile = build();
});

const ask = () => reconcile({ connectionId: CONN, invocationId: INV, decisionId: "decision-0001" });
const refusedWith = async reason => {
  const e = await ask().catch(err => err);
  expect(e).toBeInstanceOf(ReconcileRefused);
  expect(e.reason).toBe(reason);
};

describe("reconciliation (WRITE-02)", () => {
  it("resolves applied when every record carries this operation's mark, once", async () => {
    await claim();
    const first = await ask();
    expect(first.operations).toEqual([expect.objectContaining({ operationId: OP, verdict: "applied", final: true })]);
    expect(first.operations[0].records.map(r => [r.reference, r.landed, r.matches])).toEqual([["q-0", true, true], ["item-0", true, true]]);
    expect(await receipts.getResolution(OP)).toMatchObject({ verdict: "applied" });
    // A final resolution is returned as it is, with no new read.
    const again = await ask();
    expect(again.operations).toEqual([{ operationId: OP, verdict: "applied", final: true }]);
    expect(reads).toBe(1);
    expect(records.filter(r => r.event === "reconcile").map(r => r.reason)).toEqual(["applied"]);
  });

  it("stays unresolved when any record lacks the mark, records the attempt, and resolves later when the mark appears", async () => {
    await claim();
    stored.item.set("item-0", { ...stored.item.get("item-0"), metadata: { [MARK_KEY]: `${INV}/s0/n9.9` } });
    const first = await ask();
    expect(first.operations[0]).toMatchObject({ verdict: "unresolved", final: false });
    expect(first.operations[0].records.map(r => r.landed)).toEqual([true, false]);
    expect(await receipts.getResolution(OP)).toBeNull();
    expect(await receipts.getAttempts(OP)).toEqual([expect.objectContaining({ verdict: "unresolved" })]);
    stored = storedFor();
    expect((await ask()).operations[0]).toMatchObject({ verdict: "applied", final: true });
    expect((await receipts.getAttempts(OP)).map(a => a.verdict)).toEqual(["unresolved", "applied"]);
  });

  it("treats a missing record as unknown, never as not applied", async () => {
    await claim();
    stored = { question: new Map(), item: new Map() };
    const out = (await ask()).operations[0];
    expect(out).toMatchObject({ verdict: "unresolved" });
    expect(out.records.every(r => !r.found && !r.landed)).toBe(true);
    expect(JSON.stringify(out)).not.toContain("not_applied");
  });

  it("records whether the content currently matches, as an observation only", async () => {
    await claim();
    const changed = storedFor();
    changed.question.set("q-0", { ...changed.question.get("q-0"), data: { ...changed.question.get("q-0").data, stimulus: "edited since" } });
    stored = changed;
    const out = (await ask()).operations[0];
    expect(out.verdict).toBe("applied");
    expect(out.records.map(r => r.matches)).toEqual([false, true]);
  });

  it("reads nothing before the write's deadline plus the grace period", async () => {
    await claim();
    clock = CLAIMED_AT + LIMITS.executionMs + RECONCILE_GRACE_MS - 1;
    expect((await ask()).operations[0]).toMatchObject({ verdict: "too-early" });
    expect(reads).toBe(0);
    expect(await receipts.getAttempts(OP)).toEqual([]);
  });

  it("can't resolve a receipt claimed before W5, without evidence", async () => {
    await claim(OP, { evidence: null });
    expect((await ask()).operations[0]).toMatchObject({ verdict: "unresolved", reason: "no-evidence" });
    expect(reads).toBe(0);
  });

  it("refuses an evidence format it doesn't know", async () => {
    await claim(OP, { evidence: { ...writeEvidence(PAYLOAD), format: 2 } });
    expect((await ask()).operations[0]).toMatchObject({ verdict: "unresolved", reason: "evidence-format-unknown" });
    expect(reads).toBe(0);
  });

  it("records a failed read as unresolved", async () => {
    await claim();
    readFails = true;
    expect((await ask()).operations[0]).toMatchObject({ verdict: "unresolved", reason: "read-failed" });
    expect(await receipts.getAttempts(OP)).toEqual([expect.objectContaining({ reason: "read-failed" })]);
  });

  it("only looks at write receipts of that invocation on that connection", async () => {
    await claim(OP, { connectionId: "conn-other" });
    await refusedWith("receipt-not-found");
    expect(reads).toBe(0);
  });

  it("refuses with a credential for another owner, or none", async () => {
    await claim(OP, { ownerUid: "0xsomeoneelse" });
    await refusedWith("credential-binding-mismatch");
    await secrets.delete(CONN);
    await refusedWith("no-credential");
    expect(reads).toBe(0);
    expect(records.filter(r => r.outcome === "denied").map(r => r.reason)).toEqual(["credential-binding-mismatch", "no-credential"]);
  });

  it("lets the first definitive resolution stand: an agreeing race keeps one, a disagreeing one is a recorded conflict", async () => {
    await claim();
    const [a, b] = await Promise.all([ask(), ask()]);
    expect([a, b].map(r => r.operations[0].verdict)).toEqual(["applied", "applied"]);
    expect((await receipts.getAttempts(OP)).length).toBe(2);
    expect(await receipts.getResolution(OP)).toMatchObject({ verdict: "applied" });
  });

  it("leaves a disagreeing resolution that won a race unchanged, and audits the conflict", async () => {
    await claim();
    // Another attempt records a different definitive verdict between this
    // attempt's read and its create (as a future verdict kind might).
    const create = receipts.createResolution.bind(receipts);
    receipts.createResolution = async (id, resolution) => {
      await create(id, { verdict: "not_applied", attemptId: "other", decisionId: "d" });
      return create(id, resolution);
    };
    const out = (await ask()).operations[0];
    expect(out).toMatchObject({ verdict: "applied", final: false });
    expect(await receipts.getResolution(OP)).toMatchObject({ verdict: "not_applied" });
    expect(records.map(r => r.reason)).toContain("resolution-conflict");
  });
});

// End to end, in process: Policy decides, the real Broker writes to a fake
// provider that stores what it's sent, and reconciliation reads it back.
describe("reconciliation end to end (WRITE-02)", () => {
  const setup = async () => {
    const { generateKeyPair, exportJWK } = await import("jose");
    const P = await import("@graffiticode/policy");
    const B = await import("./index.js");
    const pair = await generateKeyPair("ES256", { extractable: true });
    const signer = await P.createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
    const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
    const audit = P.createAudit({ sink: () => {}, pseudonymize: P.createPseudonymizer({ secret: "test-secret-0123456789" }) });
    const on = P.createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });
    const store = { "/itembank/questions": new Map(), "/itembank/items": new Map() };
    const sdk = { init: (service, consumer, secret, body, action) => ({ body, action }) };
    const dataApi = async ({ route, request }) => {
      const rows = route === "/itembank/questions" ? request.body.questions : request.body.items;
      if (request.action === "set") for (const r of rows) store[route].set(r.reference, structuredClone(r));
      if (request.action === "get") return { meta: { status: true }, data: request.body.references.filter(ref => store[route].has(ref)).map(ref => structuredClone(store[route].get(ref))) };
      return { meta: { status: true }, data: [] };
    };
    const operations = B.buildOperations({ sdk, domain: "d", dataApi });
    const secrets = B.createMemorySecretStore({ [CONN]: { ownerUid: OWNER, backend: "learnosity", key: "k", secret: "s" } });
    const receipts = B.createMemoryReceiptStore();
    let clock = Date.now();
    const limits = { executionMs: 30_000, providerCallMs: 10_000, authorizeMs: 5_000 };
    const reconciler = B.createReconciler({ receipts, secrets, operations, limits, audit, now: () => clock });
    const policy = P.createPolicy({
      protectedSwitch: on,
      signer,
      jwks,
      audit,
      connections: P.createMemoryConnectionStore([{ connectionId: CONN, ownerUid: OWNER, backend: "learnosity", status: "active" }]),
      invocations: P.createMemoryInvocationStore(),
      publications: P.createMemoryPublicationStore(),
      brokerReconcile: reconciler,
    });
    const broker = B.createBroker({ protectedSwitch: on, jwks, operations, secrets, once: B.createMemoryOnceStore(), receipts, activity: B.createMemoryActivityStore(), authorize: B.localAuthorizer(policy), audit, limits: limits as any });
    const L0176 = { role: "compiler", lang: "0176" };
    const saveWith = async key => {
      const { invocationToken } = await policy.allocateInvocation({ caller: { role: "gateway" }, user: { uid: OWNER }, connectionId: CONN, taskId: "t", inputDigest: B.argsDigest({}), idempotencyKey: key });
      const { sessionToken } = await policy.snapshot({ caller: L0176, user: { uid: OWNER }, lang: "0176", connectionId: CONN, fns: ["init", "save-to-itembank"], invocationToken, stage: "s0" });
      const { executionToken } = await policy.mint({ caller: L0176, sessionToken, fn: "save-to-itembank", op: "learnosity.write-items", occurrenceId: "n1.0", argsDigest: B.argsDigest(PAYLOAD) });
      return broker.execute({ caller: L0176, token: executionToken, op: "learnosity.write-items", payload: PAYLOAD });
    };
    return { policy, store, saveWith, later: () => { clock = Date.now() + limits.executionMs + RECONCILE_GRACE_MS + 1000; } };
  };

  it("finds the operation's marks on what it wrote, and resolves it applied", async () => {
    const { policy, saveWith, later } = await setup();
    expect(await saveWith("save:1")).toMatchObject({ status: "succeeded" });
    later();
    const out = await policy.reconcile({ caller: { role: "console" }, user: { uid: OWNER }, connectionId: CONN, idempotencyKey: "save:1" });
    expect(out.operations).toEqual([expect.objectContaining({ verdict: "applied", final: true })]);
    expect(out.operations[0].records.every(r => r.landed && r.matches)).toBe(true);
  });

  it("stays unresolved when a later write replaced the mark, and says the content no longer matches", async () => {
    const { policy, store, saveWith, later } = await setup();
    await saveWith("save:1");
    // Someone else's later write of the same item, without this operation's mark.
    store["/itembank/items"].set("item-0", { ...PAYLOAD.itemRecords[0], status: "unpublished", metadata: { [MARK_KEY]: "inv-other/s0/n1.0" }, definition: { widgets: [] } });
    later();
    const out = (await policy.reconcile({ caller: { role: "console" }, user: { uid: OWNER }, connectionId: CONN, idempotencyKey: "save:1" })).operations[0];
    expect(out.verdict).toBe("unresolved");
    expect(out.records.map(r => [r.reference, r.landed, r.matches])).toEqual([["q-0", true, true], ["item-0", false, false]]);
  });
});
