// RETAIN-01 (W5 stage 2): what a protected write leaves behind is kept,
// whatever happens to its connection. Runs against the Firestore emulator only
// (FIRESTORE_EMULATOR_HOST set), with Policy's and Broker's real Firestore
// stores:
//   firebase emulators:exec --only firestore "npx jest src/retention.spec.ts"
import { randomBytes, randomUUID } from "node:crypto";
import admin from "firebase-admin";
import { generateKeyPair, exportJWK } from "jose";
import {
  createPolicy,
  createLocalSigner,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch,
  createConnectionManager,
  createFirestoreConnectionStore,
  createFirestoreInvocationStore,
  createFirestoreGrantStore,
  createFirestorePublicationStore,
  PolicyDenied
} from "@graffiticode/policy";
import {
  createBroker,
  BrokerRefused,
  buildOperations,
  createFirestoreOnceStore,
  createFirestoreReceiptStore,
  createFirestoreSecretStore,
  createFirestoreActivityStore,
  createSecretBox,
  argsDigest,
  localAuthorizer
} from "./index.js";

const run = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

const PROTECTED_ON = createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });
const OWNER = "0xretentionowner";
const L0176 = { role: "compiler", lang: "0176" };
const WRITE = {
  questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: "Q" } }],
  itemRecords: [{ reference: "graffiticode-t-0", definition: { widgets: [{ reference: "q-0" }] }, status: "unpublished" }]
};

run("retention across connection deletion (RETAIN-01)", () => {
  let db;
  let policy;
  let broker;
  let manager;
  let providerCalls;
  let connectionId;

  beforeAll(() => {
    const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: "demo-graffiticode" });
    db = app.firestore();
  });

  beforeEach(async () => {
    // A connection of its own per test: the emulator's database is shared.
    connectionId = `conn-${randomUUID()}`;
    const pair = await generateKeyPair("ES256", { extractable: true });
    const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
    const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
    const audit = createAudit({ sink: () => {}, pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
    const connections = createFirestoreConnectionStore(db);
    const grants = createFirestoreGrantStore(db);
    await connections.put({ connectionId, ownerUid: OWNER, backend: "learnosity", status: "active" });
    policy = createPolicy({ protectedSwitch: PROTECTED_ON, signer, jwks, connections, grants, invocations: createFirestoreInvocationStore(db), publications: createFirestorePublicationStore(db), audit });
    const secrets = createFirestoreSecretStore(db, { box: createSecretBox({ key: randomBytes(32).toString("base64") }) });
    await secrets.create(connectionId, { ownerUid: OWNER, backend: "learnosity", key: "consumer-key", secret: "learnosity-secret" });
    providerCalls = [];
    broker = createBroker({
      protectedSwitch: PROTECTED_ON,
      jwks,
      operations: buildOperations({
        sdk: { init: (service, consumer, secret, body, action) => ({ service, body, action }) },
        domain: "d",
        dataApi: async ({ route }) => { providerCalls.push(route); return { meta: { status: true } }; },
      }),
      secrets,
      once: createFirestoreOnceStore(db),
      receipts: createFirestoreReceiptStore(db),
      activity: createFirestoreActivityStore(db),
      authorize: localAuthorizer(policy),
      audit,
    });
    // Policy's management API, with its Broker admin calls answered by the same secret store.
    manager = createConnectionManager({
      connections,
      grants,
      audit,
      brokerAdmin: { createSecret: async () => {}, rotateSecret: async () => {}, deleteSecret: async id => secrets.delete(id) },
    });
  });

  const invocation = idempotencyKey => policy.allocateInvocation({
    caller: { role: "gateway" }, user: { uid: OWNER }, connectionId, taskId: "task-1", inputDigest: argsDigest({}), idempotencyKey,
  });
  // A save's execution token, minted as L0176 would for the invocation behind `idempotencyKey`.
  const saveToken = async idempotencyKey => {
    const { invocationToken } = await invocation(idempotencyKey);
    const { sessionToken } = await policy.snapshot({
      caller: L0176, user: { uid: OWNER }, lang: "0176", connectionId, fns: ["init", "save-to-itembank"], invocationToken, stage: "s0",
    });
    const { executionToken } = await policy.mint({
      caller: L0176, sessionToken, fn: "save-to-itembank", op: "learnosity.write-items", occurrenceId: "n1.0", argsDigest: argsDigest(WRITE),
    });
    return executionToken;
  };
  const save = token => broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE });

  // Every record a save writes, found from its idempotency key: the key's
  // binding, the invocation, and the receipt's claim, steps and outcome.
  const recordsOf = async idempotencyKey => {
    const keys = await db.collection("idempotency-keys").where("binding.connectionId", "==", connectionId).get();
    const key = keys.docs.map(d => d.data()).find(k => k.invocationId);
    const inv = key ? await db.collection("invocations").doc(key.invocationId).get() : null;
    const claims = await db.collection("receipts").where("binding.connectionId", "==", connectionId).get();
    const receipt = claims.docs[0]?.ref;
    return {
      key: keys.size,
      invocation: Boolean(inv?.exists),
      receipts: claims.size,
      steps: receipt ? (await receipt.collection("steps").get()).size : 0,
      outcome: receipt ? (await receipt.collection("outcome").doc("final").get()).exists : false,
      idempotencyKey,
    };
  };

  it("keeps the invocation, its key and the receipt after the connection is deleted, and refuses a retry without calling the provider", async () => {
    const first = await save(await saveToken("job-1"));
    expect(first).toMatchObject({ status: "succeeded", steps: ["questions", "items"] });
    expect(providerCalls).toEqual(["/itembank/questions", "/itembank/items"]);
    // A token minted before the deletion, held for a retry.
    const held = await saveToken("job-1");
    const before = await recordsOf("job-1");
    expect(before).toMatchObject({ key: 1, invocation: true, receipts: 1, steps: 2, outcome: true });

    await manager.remove({ caller: { role: "console" }, user: { uid: OWNER }, connectionId });

    // Nothing the save left behind is gone.
    expect(await recordsOf("job-1")).toEqual(before);
    // A retry is refused: Policy no longer finds the connection, and Broker,
    // asked with the held token, has no credential to use. The provider is never called.
    await expect(saveToken("job-1")).rejects.toEqual(expect.objectContaining({ reason: "connection-not-found" }));
    await expect(saveToken("job-1")).rejects.toBeInstanceOf(PolicyDenied);
    await expect(save(held)).rejects.toEqual(expect.objectContaining({ reason: "no-credential" }));
    await expect(save(held)).rejects.toBeInstanceOf(BrokerRefused);
    expect(providerCalls).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("replays the recorded outcome, and never re-executes, while authorization is still valid", async () => {
    await save(await saveToken("job-2"));
    const replay = await save(await saveToken("job-2"));
    expect(replay).toMatchObject({ status: "succeeded", replayed: true });
    expect(providerCalls).toEqual(["/itembank/questions", "/itembank/items"]);
  });
});
