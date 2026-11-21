// C5a slice 2 (docs/c5-l0013-commands-plan.md decisions 5, 8 and 9): Broker's
// service-credential branch, its item scope, and `gcs.put-thumbnail` against
// a fake Cloud Storage.
/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
import { generateKeyPair, exportJWK } from "jose";
import { createLocalSigner, issueToken, createAudit, createPseudonymizer, createProtectedSwitch } from "@graffiticode/policy";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import {
  createBroker,
  BrokerRefused,
  buildOperations,
  buildThumbnailOperations,
  buildGcsStorage,
  parseThumbnailBuckets,
  PreconditionFailed,
  ProviderRejected,
  createMemoryOnceStore,
  createMemoryReceiptStore,
  createMemoryActivityStore,
  createMemorySecretStore,
  createReconciler,
  createReceiptReader,
  argsDigest,
  sha256Hex,
  stagedObjectName,
  thumbnailUrl,
  RECONCILE_GRACE_MS,
  DEFAULT_LIMITS,
} from "./index.js";

const PROTECTED_ON = createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });
const OWNER = "0xowneruid";
const ITEM = "wI9f3f1XtOWIe7TTJoKE";
const OTHER_ITEM = "otherItem0000000000";
const CMD = `c:${"a".repeat(64)}`;
const PLD = "b".repeat(64);
const INV = "inv-0001";
const GATE = "graffiticode-c5a-gate";
const STAGING = "graffiticode-command-staging";
const L0013 = { role: "compiler", lang: "0013" };
const L0176 = { role: "compiler", lang: "0176" };
const SECRET = "learnosity-secret-value-xyz";

const png = (label: string) => new Uint8Array(Buffer.from(`\x89PNG ${label}`));

// A Cloud Storage with generations and preconditions, like the real one.
const makeStorage = () => {
  const objects = new Map<string, { bytes: Uint8Array, generation: number, metadata: Record<string, string> }>();
  let generation = 1000;
  const key = (bucket, name) => `${bucket}/${name}`;
  const storage = {
    objects,
    reads: [] as string[],
    uploads: [] as { name: string, ifGenerationMatch: string, metadata: Record<string, string> }[],
    beforeUpload: null as null | ((upload: { name: string, metadata: Record<string, string> }) => Promise<void>),
    loseUpload: false,
    async getMetadata(bucket, name) {
      const o = objects.get(key(bucket, name));
      return o ? { generation: String(o.generation), metadata: { ...o.metadata } } : null;
    },
    async read(bucket, name) {
      storage.reads.push(key(bucket, name));
      return objects.get(key(bucket, name))?.bytes ?? null;
    },
    // As the real client: preparation first, then a send that dispatches.
    async prepareUpload(bucket, name, bytes, options) {
      storage.prepared += 1;
      return { send: async timeoutMs => storage.upload(bucket, name, bytes, { ...options, timeoutMs }) };
    },
    prepared: 0,
    async upload(bucket, name, bytes, { ifGenerationMatch, metadata }) {
      storage.uploads.push({ name: key(bucket, name), ifGenerationMatch: String(ifGenerationMatch), metadata });
      if (storage.beforeUpload) await storage.beforeUpload({ name: key(bucket, name), metadata });
      const current = objects.get(key(bucket, name));
      if (String(ifGenerationMatch) !== String(current ? current.generation : 0)) throw new PreconditionFailed("412");
      objects.set(key(bucket, name), { bytes, generation: ++generation, metadata: { ...metadata } });
      if (storage.loseUpload) throw new Error("socket hang up");
      return { generation: String(generation) };
    },
    // A write outside Broker (the test's own setup).
    put(bucket, name, bytes, metadata = {}) {
      objects.set(key(bucket, name), { bytes, generation: ++generation, metadata });
    },
    published(item = ITEM) {
      return objects.get(key(GATE, `${item}.png`)) ?? null;
    },
  };
  return storage;
};

let signer;
let jwks;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
});

// One Broker over its own stores and storage. `faults` as in broker.js.
// `receipts` replaces the memory receipt store (a crash hook); `beforeDecision`
// runs inside each authorization, before its decision (an interleaving hook).
const makeEnv = ({ faults = null, receipts = createMemoryReceiptStore(), beforeDecision = null, now = undefined }: { faults?: any, receipts?: any, beforeDecision?: null | ((ask) => Promise<void>), now?: () => number } = {}) => {
  const storage = makeStorage();
  const records = [];
  const asks = [];
  let deny = null as null | ((ask) => boolean);
  let unavailable = null as null | ((ask) => boolean);
  const audit = createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  const dataApiCalls = [];
  const operations = {
    ...buildOperations({
      sdk: { init: (service, consumer, secret, body, action) => ({ service, consumer, body, action }) },
      domain: "l0176.graffiticode.org",
      dataApi: async ({ route }) => {
        dataApiCalls.push(route);
        return { meta: { status: true } };
      },
    }),
    ...buildThumbnailOperations({ storage, buckets: { thumbnails: GATE, staging: STAGING }, attempts: 4 }),
  };
  const deps = {
    protectedSwitch: PROTECTED_ON,
    jwks,
    operations,
    secrets: createMemorySecretStore({ "conn-1": { ownerUid: OWNER, backend: "learnosity", key: "consumer-key", secret: SECRET } }),
    once: createMemoryOnceStore(),
    receipts,
    activity: createMemoryActivityStore(),
    authorize: async ({ signal: _signal, ...ask }) => {
      asks.push(ask);
      if (beforeDecision) await beforeDecision(ask);
      if (deny?.(ask)) {
        const { AuthorizationDenied } = await import("./authorizer.js");
        throw new AuthorizationDenied("step-not-registered");
      }
      if (unavailable?.(ask)) {
        const { AuthorizationUnavailable } = await import("./authorizer.js");
        throw new AuthorizationUnavailable("policy answered 503");
      }
      return { decisionId: `decision-${String(asks.length).padStart(4, "0")}` };
    },
    audit,
    faults,
    ...(now ? { now } : {}),
  };
  const broker = createBroker(deps);
  // Reconciliation, once the write's deadline and grace have passed.
  const reconcile = createReconciler({ receipts, secrets: deps.secrets, operations, limits: DEFAULT_LIMITS, audit, now: () => Date.now() + DEFAULT_LIMITS.executionMs + RECONCILE_GRACE_MS + 1000 });
  const reader = createReceiptReader({ receipts });
  return { storage, receipts, records, asks, broker, reconcile, reader, operations, dataApiCalls, denyWhen: fn => { deny = fn; }, unavailableWhen: fn => { unavailable = fn; } };
};

const thumbnail = (bytes: Uint8Array, captureSequence: number, item = ITEM) => ({ item, sha256: sha256Hex(bytes), captureSequence });

// An execution token as Policy mints one for a v3 snap occurrence.
const snapToken = (payload, { stage = "s0", occurrence = "o1", inv = INV, ...over }: Record<string, unknown> = {}) =>
  issueToken(signer, "execution", {
    sub: OWNER,
    lang: "0013",
    fn: "snap",
    op: "gcs.put-thumbnail",
    sid: "session-1",
    opid: `${inv}/${stage}/${occurrence}`,
    argd: argsDigest(payload),
    rv: REGISTRY_VERSION,
    prv: "user",
    cv: 3,
    scp: { kind: "item", id: ITEM },
    pld: PLD,
    stg: stage,
    cmd: CMD,
    fg: 1,
    ...over,
  });

// Stage `bytes` where Policy's `stage` puts them (decision 9).
const stage = (env, bytes, { stage: stg = "s0", occurrence = "o1", inv = INV } = {}) =>
  env.storage.put(STAGING, stagedObjectName({ commandId: CMD, operationId: `${inv}/${stg}/${occurrence}` }), bytes);

const snap = async (env, payload, opts: Record<string, unknown> = {}) =>
  env.broker.execute({ caller: L0013, token: await snapToken(payload, opts), op: "gcs.put-thumbnail", payload });

const refused = async (promise, reason) => {
  const e = await promise.catch(err => err);
  expect(e).toBeInstanceOf(BrokerRefused);
  expect(e.reason).toBe(reason);
  return e;
};

const opid = (stg = "s0", occurrence = "o1") => `${INV}/${stg}/${occurrence}`;
const resultFor = (bytes, captureSequence, item = ITEM) => ({ item, captureSequence, sha256: sha256Hex(bytes), url: thumbnailUrl({ bucket: GATE, item, sha256: sha256Hex(bytes) }) });

describe("credential and scope (decision 5)", () => {
  it("refuses a service operation whose token selects a connection", async () => {
    const env = makeEnv();
    const bytes = png("a");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    const token = await issueToken(signer, "execution", {
      sub: OWNER,
      own: OWNER,
      conn: "conn-1",
      backend: "gcs",
      lang: "0013",
      fn: "snap",
      op: "gcs.put-thumbnail",
      sid: "session-1",
      opid: opid(),
      argd: argsDigest(payload),
      rv: REGISTRY_VERSION,
      prv: "user",
      cv: 3,
      pld: PLD,
      stg: "s0",
      cmd: CMD,
      fg: 1,
    });
    await refused(env.broker.execute({ caller: L0013, token, op: "gcs.put-thumbnail", payload }), "credential-scope-mismatch");
    expect(await env.receipts.getClaim(opid())).toBeNull();
    expect(env.storage.reads).toEqual([]);
  });

  it("refuses a connection operation whose token selects an item", async () => {
    const env = makeEnv();
    const payload = { questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq" } }], itemRecords: [] };
    const token = await issueToken(signer, "execution", {
      sub: OWNER,
      lang: "0176",
      fn: "save-to-itembank",
      op: "learnosity.write-items",
      sid: "session-1",
      opid: opid(),
      argd: argsDigest(payload),
      rv: REGISTRY_VERSION,
      prv: "user",
      cv: 3,
      scp: { kind: "item", id: ITEM },
      pld: PLD,
      stg: "s0",
      cmd: CMD,
      fg: 1,
    });
    await refused(env.broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload }), "credential-scope-mismatch");
    expect(await env.receipts.getClaim(opid())).toBeNull();
    expect(env.dataApiCalls).toEqual([]);
  });

  it("refuses a payload for another item than the token's, before the claim", async () => {
    const env = makeEnv();
    const bytes = png("a");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1, OTHER_ITEM);
    await refused(snap(env, payload), "credential-scope-mismatch");
    expect(await env.receipts.getClaim(opid())).toBeNull();
    expect(env.storage.reads).toEqual([]);
    expect(env.asks).toEqual([]);
    expect(env.records.find(r => r.reason === "credential-scope-mismatch")).toMatchObject({ outcome: "denied", category: "permission", itemId: ITEM });
  });

  it("refuses a snap token that names no command, whose staging it couldn't find", async () => {
    const env = makeEnv();
    const bytes = png("a");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    const token = await issueToken(signer, "execution", {
      sub: OWNER,
      lang: "0013",
      fn: "snap",
      op: "gcs.put-thumbnail",
      sid: "session-1",
      opid: opid(),
      argd: argsDigest(payload),
      rv: REGISTRY_VERSION,
      prv: "user",
      cv: 3,
      scp: { kind: "item", id: ITEM },
      pld: PLD,
      stg: "s0",
    });
    await refused(env.broker.execute({ caller: L0013, token, op: "gcs.put-thumbnail", payload }), "command-claims-required");
    expect(env.storage.reads).toEqual([]);
  });

  it("refuses a snap token spent by another language's compiler", async () => {
    const env = makeEnv();
    const bytes = png("a");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    await refused(env.broker.execute({ caller: L0176, token: await snapToken(payload), op: "gcs.put-thumbnail", payload }), "caller-language-mismatch");
  });

  it("records the selected scope in a v3 receipt's binding, and leaves a v2 binding as it was", async () => {
    const env = makeEnv();
    const bytes = png("a");
    stage(env, bytes);
    await snap(env, thumbnail(bytes, 1));
    const { binding } = await env.receipts.getClaim(opid());
    expect(binding).toEqual({ principal: OWNER, scope: { kind: "item", id: ITEM }, lang: "0013", fn: "snap", op: "gcs.put-thumbnail", registryVersion: REGISTRY_VERSION, argsDigest: argsDigest(thumbnail(bytes, 1)) });

    // An L0176 save in a mixed v3 chain: its connection, as a scope.
    const save = { questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq" } }], itemRecords: [] };
    const base = { sub: OWNER, own: OWNER, conn: "conn-1", backend: "learnosity", lang: "0176", fn: "save-to-itembank", op: "learnosity.write-items", sid: "session-2", argd: argsDigest(save), rv: REGISTRY_VERSION, prv: "user" };
    const v3 = await issueToken(signer, "execution", { ...base, opid: `${INV}/s1/n1.0`, cv: 3, pld: PLD, stg: "s1" });
    expect(await env.broker.execute({ caller: L0176, token: v3, op: "learnosity.write-items", payload: save })).toMatchObject({ status: "succeeded" });
    expect((await env.receipts.getClaim(`${INV}/s1/n1.0`)).binding).toEqual({ principal: OWNER, ownerUid: OWNER, scope: { kind: "connection", id: "conn-1" }, lang: "0176", fn: "save-to-itembank", op: "learnosity.write-items", registryVersion: REGISTRY_VERSION, argsDigest: argsDigest(save) });

    const v2 = await issueToken(signer, "execution", { ...base, opid: "inv-0002/s0/n1.0", cv: 2, pld: PLD, stg: "s0" });
    expect(await env.broker.execute({ caller: L0176, token: v2, op: "learnosity.write-items", payload: save })).toMatchObject({ status: "succeeded" });
    expect((await env.receipts.getClaim("inv-0002/s0/n1.0")).binding).toEqual({ principal: OWNER, ownerUid: OWNER, connectionId: "conn-1", lang: "0176", fn: "save-to-itembank", op: "learnosity.write-items", registryVersion: REGISTRY_VERSION, argsDigest: argsDigest(save) });
    // L0176's step requests carry no attempt: exactly as before.
    const saveAsks = env.asks.filter(a => a.op === "learnosity.write-items");
    expect(saveAsks.map(a => Object.keys(a).sort())).toEqual(saveAsks.map(() => ["after", "argsDigest", "executionToken", "op", "purpose", "step"]));
  });

  it("refuses to be built with an operation whose credential disagrees with the registry", () => {
    const env = makeEnv();
    const { "gcs.put-thumbnail": thumb, ...rest } = env.operations as any;
    expect(() => createBroker({ ...(env as any), protectedSwitch: PROTECTED_ON, authorize: async () => ({ decisionId: "decision-0001" }), activity: createMemoryActivityStore(), audit: async () => {}, operations: { ...rest, "gcs.put-thumbnail": { ...thumb, credential: undefined, references: p => p } } }))
      .toThrow(/disagrees with the registry/);
  });
});

describe("publishing (decision 8)", () => {
  it("publishes the first capture, with its sequence on the object and a stable result", async () => {
    const env = makeEnv();
    const bytes = png("first");
    stage(env, bytes);
    const out = await snap(env, thumbnail(bytes, 1));
    expect(out).toEqual({ status: "succeeded", steps: ["publish"], result: resultFor(bytes, 1) });
    const published = env.storage.published();
    expect(Buffer.from(published.bytes).toString()).toBe(Buffer.from(bytes).toString());
    expect(published.metadata).toEqual({ captureSequence: "1", commandId: CMD, sha256: sha256Hex(bytes), item: ITEM });
    // Absent: created only if still absent.
    expect(env.storage.uploads[0].ifGenerationMatch).toBe("0");
    expect(await env.receipts.getStepRecords(opid())).toMatchObject([{ step: "publish", observed: "published" }]);
    expect(await env.receipts.getStepAttempts(opid())).toEqual([expect.objectContaining({ step: "publish", attempt: 1, observed: "published", decisionId: "decision-0001" })]);
    expect(env.asks).toEqual([expect.objectContaining({ op: "gcs.put-thumbnail", step: "publish", purpose: "dispatch", after: null, attempt: 1 })]);
    expect(env.records.filter(r => r.event === "execute-step")).toEqual([expect.objectContaining({ step: "publish", attempt: 1, decisionId: "decision-0001", itemId: ITEM })]);
    // Never the legacy bucket.
    expect(env.storage.uploads.map(u => u.name)).toEqual([`${GATE}/${ITEM}.png`]);
  });

  it("completes an older capture arriving after a newer one with its own result, writing nothing", async () => {
    const env = makeEnv();
    const newer = png("newer");
    const older = png("older");
    stage(env, newer, { occurrence: "o2" });
    stage(env, older, { occurrence: "o1" });
    await snap(env, thumbnail(newer, 6), { occurrence: "o2" });
    const before = env.storage.published();
    const out = await snap(env, thumbnail(older, 5), { occurrence: "o1" });
    expect(out).toEqual({ status: "succeeded", steps: ["publish"], result: resultFor(older, 5) });
    expect(env.storage.published()).toBe(before);
    expect(env.storage.uploads).toHaveLength(1);
    expect(await env.receipts.getStepRecords(opid("s0", "o1"))).toMatchObject([{ step: "publish", observed: "newer-present" }]);
  });

  it("replaces an object with no sequence, as the migration copy leaves (decision 8)", async () => {
    const env = makeEnv();
    env.storage.put(GATE, `${ITEM}.png`, png("copied"));
    const bytes = png("capture");
    stage(env, bytes);
    expect(await snap(env, thumbnail(bytes, 1))).toMatchObject({ status: "succeeded" });
    expect(env.storage.published().metadata.captureSequence).toBe("1");
  });

  it("ends a 412 race on the newer capture: the older wins first, the newer retries under a fresh decision", async () => {
    const env = makeEnv();
    env.storage.put(GATE, `${ITEM}.png`, png("four"), { captureSequence: "4" });
    const a = png("A");
    const b = png("B");
    stage(env, a, { occurrence: "oa" });
    stage(env, b, { occurrence: "ob" });
    let aOut;
    // B has read sequence 4 and is about to write: A, which also read 4,
    // writes first.
    env.storage.beforeUpload = async ({ metadata }) => {
      if (metadata.captureSequence !== "6" || aOut) return;
      env.storage.beforeUpload = null;
      aOut = await snap(env, thumbnail(a, 5), { occurrence: "oa" });
    };
    const bOut = await snap(env, thumbnail(b, 6), { occurrence: "ob" });
    expect(aOut).toEqual({ status: "succeeded", steps: ["publish"], result: resultFor(a, 5) });
    expect(await env.receipts.getStepRecords(opid("s0", "oa"))).toMatchObject([{ observed: "published" }]);
    expect(bOut).toEqual({ status: "succeeded", steps: ["publish"], result: resultFor(b, 6) });
    expect(env.storage.published().metadata.captureSequence).toBe("6");
    const attempts = await env.receipts.getStepAttempts(opid("s0", "ob"));
    expect(attempts.map(t => [t.attempt, t.observed])).toEqual([[1, "precondition-failed"], [2, "published"]]);
    expect(new Set(attempts.map(t => t.decisionId)).size).toBe(2);
    // Attempt 2 was asked for on its own, after the step itself.
    const bAsks = env.asks.filter(q => q.argsDigest === argsDigest(thumbnail(b, 6)));
    expect(bAsks.map(q => [q.attempt, q.after])).toEqual([[1, null], [2, "publish"]]);
    const bSteps = env.records.filter(r => r.event === "execute-step" && r.opid === opid("s0", "ob"));
    expect(bSteps.map(r => r.attempt)).toEqual([1, 2]);
    expect(bSteps[0].decisionId).not.toBe(bSteps[1].decisionId);
  });

  it("fails `precondition-contention` after four 412s, never having written", async () => {
    const env = makeEnv();
    env.storage.put(GATE, `${ITEM}.png`, png("four"), { captureSequence: "4" });
    const b = png("B");
    stage(env, b);
    // An older capture keeps winning just before each of B's writes.
    env.storage.beforeUpload = async ({ name }) => env.storage.put(GATE, name.slice(GATE.length + 1), png("older"), { captureSequence: "5" });
    const out = await snap(env, thumbnail(b, 6));
    expect(out).toMatchObject({ status: "failed", steps: [], reason: "precondition-contention", category: "conflict", failedStep: "publish" });
    expect(env.storage.published().metadata.captureSequence).toBe("5");
    expect((await env.receipts.getStepAttempts(opid())).map(t => t.observed)).toEqual(Array(4).fill("precondition-failed"));
    expect(env.asks.map(q => q.attempt)).toEqual([1, 2, 3, 4]);
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "failed", reason: "precondition-contention" });
  });

  it("stops when Policy refuses the next attempt, recording what the earlier ones observed", async () => {
    const env = makeEnv();
    env.storage.put(GATE, `${ITEM}.png`, png("four"), { captureSequence: "4" });
    const b = png("B");
    stage(env, b);
    env.storage.beforeUpload = async ({ name }) => env.storage.put(GATE, name.slice(GATE.length + 1), png("older"), { captureSequence: "5" });
    env.denyWhen(ask => ask.attempt === 2);
    const out = await snap(env, thumbnail(b, 6));
    expect(out).toMatchObject({ status: "failed", steps: [], reason: "authorization-denied:step-not-registered", failedStep: "publish" });
    expect((await env.receipts.getStepAttempts(opid())).map(t => t.observed)).toEqual(["precondition-failed"]);
    expect(env.storage.uploads).toHaveLength(1);
  });

  it("records an upload whose response was lost as uncertain", async () => {
    const env = makeEnv();
    const bytes = png("lost");
    stage(env, bytes);
    env.storage.loseUpload = true;
    expect(await snap(env, thumbnail(bytes, 1))).toMatchObject({ status: "uncertain", reason: "provider-response-lost", failedStep: "publish" });
  });

  it("answers a retry of a written operation from its receipt, reading and writing nothing", async () => {
    const env = makeEnv();
    const bytes = png("once");
    stage(env, bytes);
    const first = await snap(env, thumbnail(bytes, 1));
    const reads = env.storage.reads.length;
    const retry = await snap(env, thumbnail(bytes, 1));
    expect(retry).toEqual({ status: "succeeded", result: first.result, steps: ["publish"], replayed: true });
    expect(env.storage.reads).toHaveLength(reads);
    expect(env.storage.uploads).toHaveLength(1);
  });
});

describe("staging (decision 9)", () => {
  // C5d (docs/c5d-refusal-and-hold-plan.md decisions 1–4): a definite
  // refusal is recorded as the operation's outcome, claim and outcome in one
  // transaction, after Policy authorizes the `refusal` step.
  const refusalRecorded = async (env, payload) => {
    const claim = await env.receipts.getClaim(opid());
    expect(claim).toMatchObject({ binding: { principal: OWNER, scope: { kind: "item", id: ITEM }, lang: "0013", fn: "snap", op: "gcs.put-thumbnail", registryVersion: REGISTRY_VERSION, argsDigest: argsDigest(payload) }, pld: PLD, evidence: { refused: "staging-unavailable" } });
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "failed", steps: [], result: null, reason: "staging-unavailable", category: "conflict" });
    // No run opened, nothing dispatched or sent.
    expect(await env.receipts.getRunState(opid())).toEqual({ run: 0, aborted: false });
    expect(await env.receipts.getStepAttempts(opid())).toEqual([]);
    expect(env.storage.uploads).toEqual([]);
    expect(env.storage.prepared).toBe(0);
    expect(env.asks).toEqual([{ executionToken: expect.any(String), op: "gcs.put-thumbnail", argsDigest: argsDigest(payload), step: "refusal", purpose: "record", after: null }]);
    expect(env.records.filter(r => r.event === "execute-step")).toEqual([expect.objectContaining({ step: "refusal", purpose: "record", decisionId: "decision-0001" })]);
    expect(env.records.filter(r => r.event === "execute").at(-1)).toMatchObject({ outcome: "failed", reason: "staging-unavailable", steps: [], category: "conflict" });
    // Settlement reads it as a recorded failure, never uncertain.
    expect((await env.reader({ invocationId: INV })).operations).toEqual([expect.objectContaining({ operationId: opid(), recorded: true, status: "failed", steps: [], result: null, reason: "staging-unavailable", category: "conflict" })]);
  };

  it("records missing staged bytes with no claim as the operation's failed outcome, and still answers 409", async () => {
    const env = makeEnv();
    const payload = thumbnail(png("never staged"), 1);
    const e = await refused(snap(env, payload), "staging-unavailable");
    expect(e.status).toBe(409);
    expect(e.detail).toBeUndefined();
    await refusalRecorded(env, payload);
  });

  it("records staged bytes that don't match the bound digest the same way", async () => {
    const env = makeEnv();
    stage(env, png("what was staged"));
    const payload = thumbnail(png("what was bound"), 1);
    expect((await refused(snap(env, payload), "staging-unavailable")).status).toBe(409);
    await refusalRecorded(env, payload);
  });

  it("answers a retry after a recorded refusal by replaying failed, with the bytes restored: no staging read, no publish", async () => {
    const env = makeEnv();
    const bytes = png("deleted, then restored");
    const payload = thumbnail(bytes, 1);
    await refused(snap(env, payload), "staging-unavailable");
    stage(env, bytes);
    const reads = env.storage.reads.length;
    expect(await snap(env, payload)).toEqual({ status: "failed", result: null, steps: [], reason: "staging-unavailable", category: "conflict", replayed: true });
    expect(env.storage.reads).toHaveLength(reads);
    expect(env.storage.uploads).toEqual([]);
    expect(env.storage.published()).toBeNull();
  });

  it("refuses the same operation id with other arguments after a refusal, changing nothing", async () => {
    const env = makeEnv();
    await refused(snap(env, thumbnail(png("a"), 1)), "staging-unavailable");
    const before = [await env.receipts.getClaim(opid()), await env.receipts.getOutcome(opid())];
    await refused(snap(env, thumbnail(png("b"), 1)), "operation-id-reused");
    expect([await env.receipts.getClaim(opid()), await env.receipts.getOutcome(opid())]).toEqual(before);
  });

  it.each([
    ["denied", env => env.denyWhen(ask => ask.purpose === "record")],
    ["unavailable", env => env.unavailableWhen(ask => ask.purpose === "record")],
  ])("records nothing when the refusal's authorization is %s, answers as before, and records once on a later authorized retry", async (_label, block) => {
    const env = makeEnv();
    const payload = thumbnail(png("never staged"), 1);
    block(env);
    expect((await refused(snap(env, payload), "staging-unavailable")).status).toBe(409);
    expect(await env.receipts.getClaim(opid())).toBeNull();
    expect(await env.receipts.getOutcome(opid())).toBeNull();
    expect((await env.reader({ invocationId: INV })).operations).toEqual([]);
    env.denyWhen(null);
    env.unavailableWhen(null);
    await refused(snap(env, payload), "staging-unavailable");
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "failed", reason: "staging-unavailable" });
    expect(await snap(env, payload)).toMatchObject({ status: "failed", replayed: true });
  });

  it("records nothing when the refusal's decision comes after the deadline", async () => {
    let clock = Date.now();
    let late = true;
    const env = makeEnv({ now: () => clock, beforeDecision: async ask => { if (ask.purpose === "record" && late) clock += DEFAULT_LIMITS.executionMs + 1; } });
    const payload = thumbnail(png("never staged"), 1);
    expect((await refused(snap(env, payload), "staging-unavailable")).status).toBe(409);
    expect(await env.receipts.getClaim(opid())).toBeNull();
    expect(await env.receipts.getOutcome(opid())).toBeNull();
    late = false;
    clock = Date.now();
    await refused(snap(env, payload), "staging-unavailable");
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "failed", reason: "staging-unavailable" });
  });

  it("refuses, as unavailable, when staging can't be read now: a throw, a 5xx or a timeout records nothing, and the retry publishes", async () => {
    const env = makeEnv();
    const bytes = png("a");
    stage(env, bytes);
    const read = env.storage.read;
    // The real client over a server error, and over a request that timed out.
    const client = fetchImpl => buildGcsStorage({ accessToken: async () => "t", fetch: fetchImpl as any });
    const serverError = client(async () => new Response("", { status: 503 }));
    const timedOut = client(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    const failures = [
      async () => { throw new Error("socket hang up"); },
      (bucket, name, o) => serverError.read(bucket, name, o),
      (bucket, name, o) => timedOut.read(bucket, name, o),
    ];
    for (const failing of failures) {
      env.storage.read = failing as any;
      const e = await refused(snap(env, thumbnail(bytes, 1)), "unavailable");
      expect(e.status).toBe(503);
      expect(await env.receipts.getClaim(opid())).toBeNull();
      expect(await env.receipts.getOutcome(opid())).toBeNull();
    }
    expect(env.asks).toEqual([]);
    env.storage.read = read;
    expect(await snap(env, thumbnail(bytes, 1))).toEqual({ status: "succeeded", steps: ["publish"], result: resultFor(bytes, 1) });
    expect(env.storage.uploads).toHaveLength(1);
  });

  it("reads each stage's own staged object when two stages share an occurrence id", async () => {
    const env = makeEnv();
    const first = png("stage zero");
    const second = png("stage one");
    stage(env, first, { stage: "s0", occurrence: "o1" });
    stage(env, second, { stage: "s1", occurrence: "o1" });
    expect(await snap(env, thumbnail(first, 1), { stage: "s0" })).toMatchObject({ status: "succeeded", result: resultFor(first, 1) });
    expect(await snap(env, thumbnail(second, 2), { stage: "s1" })).toMatchObject({ status: "succeeded", result: resultFor(second, 2) });
    expect(env.storage.reads).toEqual([`${STAGING}/${CMD}/s0/o1.png`, `${STAGING}/${CMD}/s1/o1.png`]);
    expect(Buffer.from(env.storage.published().bytes).toString()).toBe(Buffer.from(second).toString());
  });

  it("never reads staging once a claim exists: deleted after a dropped outcome, the retry replays and reconciliation resolves applied", async () => {
    const env = makeEnv({ faults: { dropOutcome: true, principals: new Set([OWNER]) } });
    const bytes = png("dropped");
    stage(env, bytes);
    await expect(snap(env, thumbnail(bytes, 1))).rejects.toThrow(/dropped/);
    env.storage.objects.delete(`${STAGING}/${stagedObjectName({ commandId: CMD, operationId: opid() })}`);
    const reads = env.storage.reads.length;
    const retry = await snap(env, thumbnail(bytes, 1));
    expect(retry).toEqual({ status: "uncertain", steps: ["publish"], replayed: true });
    expect(env.storage.reads).toHaveLength(reads);
    const reconciled = await env.reconcile({ itemId: ITEM, invocationId: INV, decisionId: "decision-recon-1" });
    expect(reconciled.operations).toEqual([expect.objectContaining({ operationId: opid(), verdict: "applied", final: true, result: resultFor(bytes, 1), resultSource: "evidence" })]);
  });
});

describe("reconciliation (decisions 5 and 8)", () => {
  it("resolves a dropped outcome applied after a newer capture, with exactly the result the undropped run returned", async () => {
    const a = png("A");
    const b = png("B");
    // The control run: A's outcome isn't dropped.
    const control = makeEnv();
    stage(control, a, { occurrence: "oa" });
    const controlOut = await snap(control, thumbnail(a, 5), { occurrence: "oa" });

    const env = makeEnv({ faults: { dropOutcome: true, principals: new Set([OWNER]) } });
    stage(env, a, { occurrence: "oa" });
    await expect(snap(env, thumbnail(a, 5), { occurrence: "oa" })).rejects.toThrow(/dropped/);
    expect(await env.receipts.getOutcome(opid("s0", "oa"))).toBeNull();
    // A newer capture publishes, through an undropped Broker over the same storage.
    env.storage.put(GATE, `${ITEM}.png`, b, { captureSequence: "6", commandId: CMD, sha256: sha256Hex(b), item: ITEM });

    const reconciled = await env.reconcile({ itemId: ITEM, invocationId: INV, decisionId: "decision-recon-1" });
    expect(reconciled.operations).toHaveLength(1);
    expect(reconciled.operations[0]).toMatchObject({ verdict: "applied", final: true, resultSource: "evidence", observation: { found: true, captureSequence: 6 } });
    expect(reconciled.operations[0].result).toEqual(controlOut.result);
    // Policy's settlement reads the same result.
    const read = await createReceiptReader({ receipts: env.receipts })({ invocationId: INV });
    expect(read.operations[0].resolution).toEqual({ verdict: "applied", result: controlOut.result, resultSource: "evidence" });
  });

  it("resolves a crash between the upload and its outcome applied, and the retry writes nothing", async () => {
    const env = makeEnv();
    const bytes = png("crash");
    stage(env, bytes);
    env.receipts.putOutcome = async () => { throw new Error("process died"); };
    await snap(env, thumbnail(bytes, 1));
    const retry = await snap(env, thumbnail(bytes, 1));
    expect(retry).toMatchObject({ status: "uncertain", replayed: true });
    expect(env.storage.uploads).toHaveLength(1);
    const reconciled = await env.reconcile({ itemId: ITEM, invocationId: INV, decisionId: "decision-recon-1" });
    expect(reconciled.operations[0]).toMatchObject({ verdict: "applied", result: resultFor(bytes, 1) });
  });

  it("leaves a capture unresolved while the published sequence is lower, since an upload could still land", async () => {
    const env = makeEnv();
    const bytes = png("in flight");
    stage(env, bytes);
    env.storage.put(GATE, `${ITEM}.png`, png("older"), { captureSequence: "2" });
    // The upload's response never came: it may yet land.
    env.storage.upload = async () => { throw new Error("timed out"); };
    expect(await snap(env, thumbnail(bytes, 3))).toMatchObject({ status: "uncertain" });
    const reconciled = await env.reconcile({ itemId: ITEM, invocationId: INV, decisionId: "decision-recon-1" });
    expect(reconciled.operations[0]).toMatchObject({ verdict: "unresolved", final: false, observation: { found: true, captureSequence: 2 } });
  });

  it("keeps an item's receipts and a connection's apart", async () => {
    const env = makeEnv();
    const bytes = png("a");
    stage(env, bytes);
    await snap(env, thumbnail(bytes, 1));
    await expect(env.reconcile({ connectionId: "conn-1", invocationId: INV, decisionId: "decision-recon-1" })).rejects.toMatchObject({ reason: "receipt-not-found" });
    await expect(env.reconcile({ itemId: OTHER_ITEM, invocationId: INV, decisionId: "decision-recon-1" })).rejects.toMatchObject({ reason: "receipt-not-found" });
    expect((await env.reconcile({ itemId: ITEM, invocationId: INV, decisionId: "decision-recon-1" })).operations).toHaveLength(1);
  });
});

describe("configuration", () => {
  it("takes both buckets together, and never the legacy one", () => {
    expect(parseThumbnailBuckets({})).toBeNull();
    expect(parseThumbnailBuckets({ THUMBNAIL_BUCKET: GATE, COMMAND_STAGING_BUCKET: STAGING })).toEqual({ thumbnails: GATE, staging: STAGING });
    expect(() => parseThumbnailBuckets({ THUMBNAIL_BUCKET: GATE })).toThrow(/together/);
    expect(() => parseThumbnailBuckets({ THUMBNAIL_BUCKET: "graffiticode.appspot.com", COMMAND_STAGING_BUCKET: STAGING })).toThrow(/legacy/);
    expect(() => parseThumbnailBuckets({ THUMBNAIL_BUCKET: GATE, COMMAND_STAGING_BUCKET: GATE })).toThrow(/differ/);
    expect(() => buildThumbnailOperations({ storage: makeStorage(), buckets: { thumbnails: "graffiticode.appspot.com", staging: STAGING }, attempts: 4 })).toThrow();
  });

  it("refuses a snap token when no buckets are configured", async () => {
    const env = makeEnv();
    const { "gcs.put-thumbnail": _thumb, ...learnosityOnly } = env.operations as any;
    const broker = createBroker({
      protectedSwitch: PROTECTED_ON,
      jwks,
      operations: learnosityOnly,
      secrets: createMemorySecretStore({}),
      once: createMemoryOnceStore(),
      receipts: env.receipts,
      activity: createMemoryActivityStore(),
      authorize: async () => ({ decisionId: "decision-0001" }),
      audit: async () => {},
    });
    const bytes = png("a");
    const payload = thumbnail(bytes, 1);
    await refused(broker.execute({ caller: L0013, token: await snapToken(payload), op: "gcs.put-thumbnail", payload }), "operation-mismatch");
  });
});

describe("the Cloud Storage client", () => {
  const respond = (status, body: any = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const client = handler => {
    const calls = [];
    const storage = buildGcsStorage({ accessToken: async () => "access-token", fetch: (async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); }) as any });
    return { storage, calls };
  };

  it("reads metadata and bytes, absent as null", async () => {
    const { storage, calls } = client(url => (url.includes("missing") ? respond(404) : url.includes("alt=media") ? respond(200, "bytes") : respond(200, { generation: "17", metadata: { captureSequence: "3" } })));
    expect(await storage.getMetadata("b", "x.png", { timeoutMs: 1000 })).toEqual({ generation: "17", metadata: { captureSequence: "3" } });
    expect(await storage.getMetadata("b", "missing.png", { timeoutMs: 1000 })).toBeNull();
    expect(Buffer.from(await storage.read("b", "c:1/s0/o1.png", { timeoutMs: 1000 })).toString()).toBe("bytes");
    expect(calls[2].url).toContain("/o/c%3A1%2Fs0%2Fo1.png?alt=media");
    expect(calls[0].init.headers.Authorization).toBe("Bearer access-token");
  });

  it("uploads with the generation precondition, and tells a 412, a refusal and an unknown failure apart", async () => {
    let status = 200;
    const { storage, calls } = client(() => respond(status, { generation: "18" }));
    const upload = async () => (await storage.prepareUpload("b", "x.png", new Uint8Array([1, 2]), { ifGenerationMatch: "17", metadata: { captureSequence: "4" }, contentType: "image/png", cacheControl: "no-cache" })).send(1000);
    expect(await upload()).toEqual({ generation: "18" });
    expect(calls[0].init.headers.Authorization).toBe("Bearer access-token");
    expect(calls[0].url).toContain("ifGenerationMatch=17");
    expect(Buffer.from(calls[0].init.body).toString()).toContain("\"captureSequence\":\"4\"");
    status = 412;
    await expect(upload()).rejects.toBeInstanceOf(PreconditionFailed);
    status = 403;
    await expect(upload()).rejects.toBeInstanceOf(ProviderRejected);
    for (status of [429, 503]) {
      const e = await upload().catch(err => err);
      expect(e).not.toBeInstanceOf(ProviderRejected);
      expect(e).not.toBeInstanceOf(PreconditionFailed);
    }
  });

  it("does everything asynchronous while preparing: send calls fetch before awaiting anything", async () => {
    let tokens = 0;
    const calls = [];
    const storage = buildGcsStorage({
      accessToken: async () => { tokens += 1; return "access-token"; },
      fetch: (async (url, init) => { calls.push({ url: String(url), init }); return respond(200, { generation: "18" }); }) as any,
    });
    const request = await storage.prepareUpload("b", "x.png", new Uint8Array([1]), { ifGenerationMatch: "0", metadata: {}, contentType: "image/png", cacheControl: "no-cache" });
    expect(tokens).toBe(1);
    expect(calls).toHaveLength(0);
    const sent = request.send(1000);
    // Dispatched synchronously, before the returned promise is awaited.
    expect(calls).toHaveLength(1);
    expect(tokens).toBe(1);
    await sent;
  });
});

// The owner's review of #401: authorization comes after all preparation,
// anonymous public captures run on their narrow terms, and a staging failure
// never hides a concurrent receipt.
describe("review of #401", () => {
  it("doesn't publish when authority is revoked while the attempt is prepared", async () => {
    const env = makeEnv();
    const bytes = png("revoked-during-read");
    stage(env, bytes);
    const read = env.storage.getMetadata.bind(env.storage);
    env.storage.getMetadata = async (...args) => {
      const head = await read(...args);
      env.denyWhen(() => true);
      return head;
    };
    const out = await snap(env, thumbnail(bytes, 1));
    expect(env.storage.uploads).toHaveLength(0);
    expect(out).toMatchObject({ status: "failed", reason: "authorization-denied:step-not-registered" });
    // The upload was prepared, then refused: authorization came last.
    expect(env.storage.prepared).toBe(1);
  });

  it("doesn't start an upload once preparation has used up the deadline", async () => {
    const env = makeEnv();
    let clock = Date.now();
    const broker = createBroker({
      jwks,
      operations: env.operations,
      receipts: env.receipts,
      secrets: createMemorySecretStore({}),
      once: createMemoryOnceStore(),
      activity: createMemoryActivityStore(),
      protectedSwitch: PROTECTED_ON,
      authorize: async () => ({ decisionId: "decision-0001" }),
      audit: async () => {},
      now: () => clock,
      limits: { providerCallMs: 500, executionMs: 1000, authorizeMs: 100 } as any,
    });
    const bytes = png("late-metadata");
    stage(env, bytes);
    const read = env.storage.getMetadata.bind(env.storage);
    env.storage.getMetadata = async (...args) => {
      const head = await read(...args);
      clock += 1500;
      return head;
    };
    const payload = thumbnail(bytes, 1);
    // Nothing was sent: the run is aborted (7e), refused as temporary.
    const e = await broker.execute({ caller: L0013, token: await snapToken(payload), op: "gcs.put-thumbnail", payload }).catch(err => err);
    expect(env.storage.uploads).toHaveLength(0);
    expect(e).toBeInstanceOf(BrokerRefused);
    expect(e).toMatchObject({ reason: "deadline-exceeded", status: 503 });
    expect(await env.receipts.getOutcome(opid())).toBeNull();
    expect(await env.receipts.getRunState(opid())).toEqual({ run: 0, aborted: true });
  });

  it("refuses to prepare past the deadline, before any authorization", async () => {
    const env = makeEnv();
    let clock = Date.now();
    const asks = [];
    const broker = createBroker({
      jwks,
      operations: env.operations,
      receipts: env.receipts,
      secrets: createMemorySecretStore({}),
      once: createMemoryOnceStore(),
      activity: createMemoryActivityStore(),
      protectedSwitch: PROTECTED_ON,
      authorize: async ask => { asks.push(ask); return { decisionId: "decision-0001" }; },
      audit: async () => {},
      now: () => clock,
      limits: { providerCallMs: 500, executionMs: 1000, authorizeMs: 100 } as any,
    });
    const bytes = png("late-claim");
    stage(env, bytes);
    // The claim itself is slow: no time is left to read the object.
    const claim = env.receipts.claim.bind(env.receipts);
    env.receipts.claim = async (...args) => { clock += 1500; return claim(...args); };
    const payload = thumbnail(bytes, 1);
    const e = await broker.execute({ caller: L0013, token: await snapToken(payload), op: "gcs.put-thumbnail", payload }).catch(err => err);
    expect(e).toMatchObject({ reason: "deadline-exceeded", status: 503 });
    expect(asks).toEqual([]);
    expect(env.storage.uploads).toHaveLength(0);
    expect(await env.receipts.getRunState(opid())).toEqual({ run: 0, aborted: true });
  });

  it("runs a Policy-authorized anonymous public capture, and audits its provenance", async () => {
    const env = makeEnv();
    const bytes = png("anonymous-public-capture");
    stage(env, bytes);
    const out = await snap(env, thumbnail(bytes, 1), { sub: "anonymous", prv: "anonymous" });
    expect(out.status).toBe("succeeded");
    expect(env.records.find(r => r.event === "execute" && r.outcome === "allowed")).toMatchObject({ provenance: "anonymous", itemId: ITEM });
    expect((await env.receipts.getClaim(opid())).binding).toMatchObject({ principal: "anonymous", scope: { kind: "item", id: ITEM } });
  });

  it("keeps anonymous to its narrow terms: never L0176, never a connection, never a user's subject", async () => {
    const env = makeEnv();
    const bytes = png("a");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    // A user's provenance with the anonymous subject, and the reverse.
    await refused(snap(env, payload, { sub: "anonymous" }), "bad-provenance");
    await refused(snap(env, payload, { prv: "anonymous" }), "bad-provenance");
    // An anonymous L0176 save, through a connection or naming an item.
    const save = { questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq" } }], itemRecords: [] };
    const base = { sub: "anonymous", prv: "anonymous", lang: "0176", fn: "save-to-itembank", op: "learnosity.write-items", sid: "session-2", opid: `${INV}/s1/n1.0`, argd: argsDigest(save), rv: REGISTRY_VERSION, cv: 3, pld: PLD, stg: "s1" };
    for (const scope of [{ own: OWNER, conn: "conn-1", backend: "learnosity" }, { scp: { kind: "item", id: ITEM } }]) {
      const token = await issueToken(signer, "execution", { ...base, ...scope });
      await refused(env.broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: save }), "bad-provenance");
    }
    // An anonymous L0176 signature, too.
    const preview = { id: "t", name: "T", questions: [{ response_id: "r-0", type: "mcq" }] };
    const sign = await issueToken(signer, "execution", { ...base, fn: "init", op: "learnosity.sign-items-preview", argd: argsDigest(preview), own: OWNER, conn: "conn-1", backend: "learnosity" });
    await refused(env.broker.execute({ caller: L0176, token: sign, op: "learnosity.sign-items-preview", payload: preview }), "bad-provenance");
    // Not under contract v2.
    await refused(snap(env, payload, { sub: "anonymous", prv: "anonymous", cv: 2, scp: undefined, own: OWNER, conn: "conn-1", backend: "gcs" }), "bad-provenance");
    expect(env.storage.uploads).toEqual([]);
    expect(env.dataApiCalls).toEqual([]);
  });

  it("replays a concurrent winner when staging disappears while this request reads it", async () => {
    const env = makeEnv();
    const bytes = png("concurrent-staging-expiry");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    const read = env.storage.read.bind(env.storage);
    let entered;
    let release;
    const reading = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let first = true;
    env.storage.read = async (...args) => {
      if (first) {
        first = false;
        entered();
        await held;
      }
      return read(...args);
    };
    const pending = snap(env, payload).then(value => ({ value, error: null }), error => ({ value: null, error }));
    await reading;
    const winner = await snap(env, payload);
    env.storage.objects.delete(`${STAGING}/${stagedObjectName({ commandId: CMD, operationId: opid() })}`);
    release();
    const retry = await pending;
    expect(winner.status).toBe("succeeded");
    expect(retry.error).toBeNull();
    expect(retry.value).toMatchObject({ status: "succeeded", replayed: true, result: winner.result });
    expect(env.storage.uploads).toHaveLength(1);
  });

  it("replays a concurrent claim too when staging can't be read now", async () => {
    const env = makeEnv();
    const bytes = png("concurrent-unreadable");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    const read = env.storage.read.bind(env.storage);
    let entered;
    let release;
    const reading = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let first = true;
    env.storage.read = async (...args) => {
      if (first) {
        first = false;
        entered();
        await held;
        throw new Error("503");
      }
      return read(...args);
    };
    const pending = snap(env, payload);
    await reading;
    const winner = await snap(env, payload);
    release();
    expect(await pending).toMatchObject({ status: "succeeded", replayed: true, result: winner.result });
  });
});

// The owner's review of #403 (broker.js 7e): a run that stopped before any
// dispatch, for a temporary reason, wrote nothing and is aborted, never a
// recorded failure; a later token for the same operation runs again.
describe("reopening a run that stopped before dispatch (7e)", () => {
  it("aborts a run whose authorization was unavailable, and runs the operation again with a fresh token", async () => {
    const env = makeEnv();
    const bytes = png("outage");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    env.unavailableWhen(() => true);
    const e = await refused(snap(env, payload), "authorization-unavailable");
    expect(e.status).toBe(503);
    expect(env.storage.uploads).toEqual([]);
    expect(await env.receipts.getOutcome(opid())).toBeNull();
    expect(await env.receipts.getRunState(opid())).toEqual({ run: 0, aborted: true });
    // It reads as never claimed: no receipt for settlement, none to reconcile
    // or replay.
    expect((await createReceiptReader({ receipts: env.receipts })({ invocationId: INV })).operations).toEqual([]);
    await expect(env.reconcile({ itemId: ITEM, invocationId: INV, decisionId: "decision-recon-1" })).rejects.toMatchObject({ reason: "receipt-not-found" });
    const replay = await issueToken(signer, "replay", { sub: OWNER, lang: "0013", fn: "snap", op: "gcs.put-thumbnail", sid: "session-1", opid: opid(), argd: argsDigest(payload), rv: REGISTRY_VERSION, prv: "user", cv: 3, scp: { kind: "item", id: ITEM }, pld: PLD, stg: "s0", cmd: CMD, fg: 1 });
    await refused(env.broker.execute({ caller: L0013, token: replay, op: "gcs.put-thumbnail", payload }), "replay-not-found");
    // Policy answers again: the next run publishes, once.
    env.unavailableWhen(null);
    const out = await snap(env, payload);
    expect(out).toEqual({ status: "succeeded", steps: ["publish"], result: resultFor(bytes, 1) });
    expect(env.storage.uploads).toHaveLength(1);
    expect(await env.receipts.getRunState(opid())).toEqual({ run: 1, aborted: false });
    expect((await createReceiptReader({ receipts: env.receipts })({ invocationId: INV })).operations).toEqual([expect.objectContaining({ status: "succeeded", recorded: true })]);
    // And then answers from its receipt.
    expect(await snap(env, payload)).toMatchObject({ status: "succeeded", replayed: true });
    expect(env.storage.uploads).toHaveLength(1);
  });

  it("starts the next run once, when two requests reopen it together", async () => {
    const env = makeEnv();
    const bytes = png("race");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    env.unavailableWhen(() => true);
    await refused(snap(env, payload), "authorization-unavailable");
    env.unavailableWhen(null);
    const [a, b] = await Promise.all([snap(env, payload), snap(env, payload)]);
    expect([a.replayed === true, b.replayed === true].sort()).toEqual([false, true]);
    expect(env.storage.uploads).toHaveLength(1);
  });

  it("aborts a run whose metadata read failed, before any authorization", async () => {
    const env = makeEnv();
    const bytes = png("read failed");
    stage(env, bytes);
    const getMetadata = env.storage.getMetadata;
    env.storage.getMetadata = async () => { throw new Error("503"); };
    await refused(snap(env, thumbnail(bytes, 1)), "unavailable");
    expect(env.asks).toEqual([]);
    env.storage.getMetadata = getMetadata;
    expect(await snap(env, thumbnail(bytes, 1))).toMatchObject({ status: "succeeded" });
  });

  // C5d (the refusal plan, §1 and decision 1): the reopened run records the
  // refusal as its outcome, the run and the outcome in one transaction.
  it("records a reopened run whose staging has gone as failed at run 1, keeping the claim's evidence", async () => {
    const env = makeEnv();
    const bytes = png("gone");
    stage(env, bytes);
    env.unavailableWhen(() => true);
    await refused(snap(env, thumbnail(bytes, 1)), "authorization-unavailable");
    env.unavailableWhen(null);
    const evidence = (await env.receipts.getClaim(opid())).evidence;
    env.storage.objects.delete(`${STAGING}/${stagedObjectName({ commandId: CMD, operationId: opid() })}`);
    expect((await refused(snap(env, thumbnail(bytes, 1)), "staging-unavailable")).status).toBe(409);
    expect(await env.receipts.getRunState(opid())).toEqual({ run: 1, aborted: false });
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "failed", steps: [], result: null, reason: "staging-unavailable", category: "conflict" });
    expect((await env.receipts.getClaim(opid())).evidence).toEqual(evidence);
    expect(env.asks.filter(a => a.purpose === "record")).toHaveLength(1);
    expect((await env.reader({ invocationId: INV })).operations).toEqual([expect.objectContaining({ recorded: true, status: "failed", reason: "staging-unavailable" })]);
    // And then replays it, even with the bytes back.
    stage(env, bytes);
    expect(await snap(env, thumbnail(bytes, 1))).toMatchObject({ status: "failed", reason: "staging-unavailable", replayed: true });
    expect(env.storage.uploads).toEqual([]);
  });

  it("records a failure, as always, once any request was authorized for dispatch", async () => {
    const env = makeEnv();
    env.storage.put(GATE, `${ITEM}.png`, png("four"), { captureSequence: "4" });
    const b = png("B");
    stage(env, b);
    env.storage.beforeUpload = async ({ name }) => env.storage.put(GATE, name.slice(GATE.length + 1), png("older"), { captureSequence: "5" });
    env.unavailableWhen(ask => ask.attempt === 2);
    const out = await snap(env, thumbnail(b, 6));
    expect(out).toMatchObject({ status: "failed", reason: "authorization-unavailable" });
    expect(await env.receipts.getRunState(opid())).toEqual({ run: 0, aborted: false });
  });

  it("leaves a connection write's failure before dispatch recorded, as before", async () => {
    const env = makeEnv();
    env.unavailableWhen(() => true);
    const save = { questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq" } }], itemRecords: [] };
    const token = await issueToken(signer, "execution", { sub: OWNER, own: OWNER, conn: "conn-1", backend: "learnosity", lang: "0176", fn: "save-to-itembank", op: "learnosity.write-items", sid: "session-2", opid: `${INV}/s1/n1.0`, argd: argsDigest(save), rv: REGISTRY_VERSION, prv: "user", cv: 2, pld: PLD, stg: "s1" });
    expect(await env.broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: save })).toMatchObject({ status: "failed", reason: "authorization-unavailable" });
    expect(await env.receipts.getOutcome(`${INV}/s1/n1.0`)).toMatchObject({ status: "failed" });
  });
});

// The owner's re-review of #403: an abort and a run's outcome exclude each
// other, and an outcome is fenced to its run, so an abort whose answer was
// lost can't let its run record a failure over its successor's publish.
describe("an abort whose acknowledgment was lost (7e)", () => {
  it("never lets the older run record a failure while its successor publishes", async () => {
    const env = makeEnv();
    const bytes = png("lost abort ack");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    let sawAbort;
    let loseAck;
    const aborted = new Promise(resolve => { sawAbort = resolve; });
    const ackLost = new Promise(resolve => { loseAck = resolve; });
    const abort = env.receipts.abortRun.bind(env.receipts);
    env.receipts.abortRun = async (...args) => {
      await abort(...args); // Committed; the answer is delayed, then lost.
      sawAbort();
      await ackLost;
      throw new Error("abort acknowledgment lost");
    };
    env.unavailableWhen(() => true);
    const original: Promise<{ value?: any, error?: any }> = snap(env, payload).then(value => ({ value }), error => ({ error }));
    await aborted;
    // A second request sees the committed abort and starts the next run.
    env.unavailableWhen(null);
    let atUpload;
    let finishUpload;
    const uploading = new Promise(resolve => { atUpload = resolve; });
    const proceed = new Promise(resolve => { finishUpload = resolve; });
    env.storage.beforeUpload = async () => { atUpload(); await proceed; };
    const retry = snap(env, payload);
    await uploading;
    // The older run hears nothing back: its fenced failure is refused, which
    // confirms its abort, and it is refused as temporary.
    loseAck();
    const old = await original;
    expect(old.error).toBeInstanceOf(BrokerRefused);
    expect(old.error).toMatchObject({ reason: "authorization-unavailable", status: 503 });
    finishUpload();
    expect((await retry).status).toBe("succeeded");
    expect(env.storage.uploads).toHaveLength(1);
    expect(env.storage.published()).not.toBeNull();
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "succeeded" });
  });

  // The owner's review at 3e618850: the successor finishes first, then the
  // older run's abort answer is lost. The fence is checked before the
  // recorded outcome, so the older request is refused as temporary.
  it("refuses the older run as temporary when its successor already finished", async () => {
    const env = makeEnv();
    const bytes = png("successor first");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    let sawAbort;
    let loseAck;
    const aborted = new Promise(resolve => { sawAbort = resolve; });
    const ackLost = new Promise(resolve => { loseAck = resolve; });
    const abort = env.receipts.abortRun.bind(env.receipts);
    env.receipts.abortRun = async (...args) => {
      await abort(...args);
      sawAbort();
      await ackLost;
      throw new Error("abort acknowledgment lost");
    };
    env.unavailableWhen(() => true);
    const original: Promise<{ value?: any, error?: any }> = snap(env, payload).then(value => ({ value }), error => ({ error }));
    await aborted;
    env.unavailableWhen(null);
    expect((await snap(env, payload)).status).toBe("succeeded");
    loseAck();
    const old = await original;
    expect(old.error).toBeInstanceOf(BrokerRefused);
    expect(old.error).toMatchObject({ reason: "authorization-unavailable", status: 503 });
    expect(env.storage.uploads).toHaveLength(1);
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "succeeded" });
  });

  it("records the failure when the lost abort never committed", async () => {
    const env = makeEnv();
    const bytes = png("abort never landed");
    stage(env, bytes);
    env.receipts.abortRun = async () => { throw new Error("abort never reached the store"); };
    env.unavailableWhen(() => true);
    expect(await snap(env, thumbnail(bytes, 1))).toMatchObject({ status: "failed", reason: "authorization-unavailable" });
    expect(await env.receipts.getRunState(opid())).toEqual({ run: 0, aborted: false });
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "failed" });
  });

  it("makes abort, outcome and the next run exclude each other in the store", async () => {
    const { createMemoryReceiptStore: fresh, RunFenced } = await import("./index.js");
    const receipts = fresh();
    const op = opid();
    expect(await receipts.getRunState(op)).toEqual({ run: 0, aborted: false });
    expect(await receipts.startRun(op, 1)).toBe(false);
    await receipts.abortRun(op, 0, { reason: "authorization-unavailable" });
    await expect(receipts.abortRun(op, 0, { reason: "again" })).rejects.toBeInstanceOf(RunFenced);
    await expect(receipts.putOutcome(op, { status: "failed" }, { run: 0 })).rejects.toBeInstanceOf(RunFenced);
    expect(await receipts.startRun(op, 2)).toBe(false);
    expect(await receipts.startRun(op, 1)).toBe(true);
    expect(await receipts.startRun(op, 1)).toBe(false);
    await expect(receipts.putOutcome(op, { status: "failed" }, { run: 0 })).rejects.toBeInstanceOf(RunFenced);
    await receipts.putOutcome(op, { status: "succeeded" }, { run: 1 });
    await expect(receipts.abortRun(op, 1, { reason: "late" })).rejects.toBeInstanceOf(RunFenced);
    // A superseded run is fenced even once the outcome exists.
    await expect(receipts.putOutcome(op, { status: "failed" }, { run: 0 })).rejects.toBeInstanceOf(RunFenced);
    expect(await receipts.getOutcome(op)).toMatchObject({ status: "succeeded" });
  });
});

// C5d (docs/c5d-refusal-and-hold-plan.md §4): a refusal's record is one
// transaction, so a crash inside it leaves neither record; and the claim's
// create-once decides every race between a refusal and a claim or a run.
describe("the staging refusal's transaction (C5d)", () => {
  const stagedName = () => `${STAGING}/${stagedObjectName({ commandId: CMD, operationId: opid() })}`;
  const crashing = (operation: string) => {
    const hook = { armed: true };
    const receipts = createMemoryReceiptStore({ beforeCommit: name => { if (hook.armed && name === operation) throw new Error("process died inside the transaction"); } });
    return { receipts, hook };
  };

  it("leaves neither the claim nor the outcome after a crash inside claimRefused, and the next execute records once", async () => {
    const { receipts, hook } = crashing("claimRefused");
    const env = makeEnv({ receipts });
    const payload = thumbnail(png("never staged"), 1);
    await expect(snap(env, payload)).rejects.toThrow(/inside the transaction/);
    expect(await receipts.getClaim(opid())).toBeNull();
    expect(await receipts.getOutcome(opid())).toBeNull();
    // Absent, never uncertain.
    expect((await env.reader({ invocationId: INV })).operations).toEqual([]);
    await expect(env.reconcile({ itemId: ITEM, invocationId: INV, decisionId: "decision-recon-1" })).rejects.toMatchObject({ reason: "receipt-not-found" });
    hook.armed = false;
    await refused(snap(env, payload), "staging-unavailable");
    expect(await receipts.getOutcome(opid())).toMatchObject({ status: "failed", reason: "staging-unavailable" });
    expect((await env.reader({ invocationId: INV })).operations).toEqual([expect.objectContaining({ recorded: true, status: "failed" })]);
    expect(env.records.filter(r => r.event === "execute" && r.outcome === "failed")).toHaveLength(1);
  });

  it("leaves the aborted run and no outcome after a crash inside refuseRun, and the next execute records once", async () => {
    const { receipts, hook } = crashing("refuseRun");
    const env = makeEnv({ receipts });
    const bytes = png("gone");
    stage(env, bytes);
    env.unavailableWhen(() => true);
    await refused(snap(env, thumbnail(bytes, 1)), "authorization-unavailable");
    env.unavailableWhen(null);
    env.storage.objects.delete(stagedName());
    await expect(snap(env, thumbnail(bytes, 1))).rejects.toThrow(/inside the transaction/);
    expect(await receipts.getRunState(opid())).toEqual({ run: 0, aborted: true });
    expect(await receipts.getOutcome(opid())).toBeNull();
    expect((await env.reader({ invocationId: INV })).operations).toEqual([]);
    hook.armed = false;
    await refused(snap(env, thumbnail(bytes, 1)), "staging-unavailable");
    expect(await receipts.getRunState(opid())).toEqual({ run: 1, aborted: false });
    expect(await receipts.getOutcome(opid())).toMatchObject({ status: "failed", reason: "staging-unavailable" });
  });

  it("makes claimRefused and refuseRun each one atomic step in the store", async () => {
    const { createMemoryReceiptStore: fresh, stagingRefusalOutcome } = await import("./index.js");
    const receipts = fresh();
    const op = opid();
    const binding = { principal: OWNER, op: "gcs.put-thumbnail" };
    expect(await receipts.claimRefused(op, binding, { pld: PLD, evidence: { refused: "staging-unavailable" } }, stagingRefusalOutcome())).toEqual({ created: true });
    expect(await receipts.getClaim(op)).toMatchObject({ binding, pld: PLD, evidence: { refused: "staging-unavailable" } });
    expect(await receipts.getOutcome(op)).toMatchObject(stagingRefusalOutcome());
    // A second writes nothing and returns the claim.
    expect(await receipts.claimRefused(op, { principal: "other" }, {}, { status: "succeeded", steps: [] })).toEqual({ created: false, claim: expect.objectContaining({ binding }) });
    expect(await receipts.getOutcome(op)).toMatchObject({ status: "failed" });
    // refuseRun only where startRun would succeed.
    const other = opid("s0", "o2");
    await receipts.claim(other, binding);
    expect(await receipts.refuseRun(other, 1, stagingRefusalOutcome())).toBe(false);
    await receipts.abortRun(other, 0, { reason: "authorization-unavailable" });
    expect(await receipts.refuseRun(other, 2, stagingRefusalOutcome())).toBe(false);
    expect(await receipts.refuseRun(other, 1, stagingRefusalOutcome())).toBe(true);
    expect(await receipts.refuseRun(other, 1, stagingRefusalOutcome())).toBe(false);
    expect(await receipts.startRun(other, 1)).toBe(false);
    expect(await receipts.getRunState(other)).toEqual({ run: 1, aborted: false });
    // The run has ended: it can't be aborted or record again.
    await expect(receipts.abortRun(other, 1, { reason: "late" })).rejects.toThrow();
    await expect(receipts.putOutcome(other, { status: "succeeded" }, { run: 1 })).rejects.toThrow(/already recorded/);
  });
});

describe("races between a refusal and a claim (C5d)", () => {
  const stagedName = () => `${STAGING}/${stagedObjectName({ commandId: CMD, operationId: opid() })}`;
  const gate = () => {
    let open;
    const opened = new Promise<void>(resolve => { open = resolve; });
    return { open: () => open(), opened };
  };
  const settled = promise => promise.then(value => ({ value, error: null }), error => ({ value: null, error }));

  it("A claims first: B, which read staging as missing, loses its record and replays A's outcome", async () => {
    let runA = null;
    const env = makeEnv({ beforeDecision: async ask => { if (ask.purpose === "record" && runA) { const a = runA; runA = null; await a(); } } });
    const bytes = png("A has it");
    const payload = thumbnail(bytes, 1);
    let aOut;
    // B finds nothing staged; while B asks to record its refusal, A, which
    // has the bytes, runs to completion.
    runA = async () => { stage(env, bytes); aOut = await snap(env, payload); };
    const bOut = await snap(env, payload);
    expect(aOut).toEqual({ status: "succeeded", steps: ["publish"], result: resultFor(bytes, 1) });
    expect(bOut).toEqual({ status: "succeeded", steps: ["publish"], result: resultFor(bytes, 1), replayed: true });
    expect(env.storage.uploads).toHaveLength(1);
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "succeeded" });
    expect((await env.receipts.getClaim(opid())).evidence.refused).toBeUndefined();
  });

  it("B records first: A, which read the bytes, finds the claim and replays failed, with no upload", async () => {
    const env = makeEnv();
    const bytes = png("A read it, then it went");
    stage(env, bytes);
    const payload = thumbnail(bytes, 1);
    const read = env.storage.read.bind(env.storage);
    const held = gate();
    const entered = gate();
    let first = true;
    env.storage.read = async (...args) => {
      if (first) {
        first = false;
        const bytesRead = await read(...args);
        entered.open();
        await held.opened;
        return bytesRead;
      }
      return read(...args);
    };
    const a = settled(snap(env, payload));
    await entered.opened;
    env.storage.objects.delete(stagedName());
    await refused(snap(env, payload), "staging-unavailable");
    held.open();
    const out = await a;
    expect(out.error).toBeNull();
    expect(out.value).toMatchObject({ status: "failed", reason: "staging-unavailable", steps: [], replayed: true });
    expect(env.storage.uploads).toEqual([]);
    expect(env.storage.prepared).toBe(0);
  });

  it("two concurrent refusals record one outcome, and both answer", async () => {
    let arrived = 0;
    const both = gate();
    const env = makeEnv({ beforeDecision: async ask => { if (ask.purpose === "record") { arrived += 1; if (arrived === 2) both.open(); await both.opened; } } });
    const payload = thumbnail(png("never staged"), 1);
    const [x, y] = await Promise.all([settled(snap(env, payload)), settled(snap(env, payload))]);
    const answers = [x, y].map(r => (r.error ? `refused:${r.error.reason}:${r.error.status}` : `${r.value.status}:${r.value.reason}:${r.value.replayed}`)).sort();
    expect(answers).toEqual(["failed:staging-unavailable:true", "refused:staging-unavailable:409"]);
    expect(env.records.filter(r => r.event === "execute" && r.outcome === "failed")).toHaveLength(1);
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "failed", reason: "staging-unavailable" });
  });

  // An aborted run 0, reopened by A (bytes back) and B (bytes gone).
  const aborted = async (env, bytes) => {
    stage(env, bytes);
    env.unavailableWhen(() => true);
    await refused(snap(env, thumbnail(bytes, 1)), "authorization-unavailable");
    env.unavailableWhen(null);
  };

  it("a reopen racing refuseRun: B's refusal starts the run first, and A's startRun loses and replays failed", async () => {
    const env = makeEnv();
    const bytes = png("reopen race B first");
    await aborted(env, bytes);
    const payload = thumbnail(bytes, 1);
    const read = env.storage.read.bind(env.storage);
    const held = gate();
    const entered = gate();
    let calls = 0;
    env.storage.read = async (...args) => {
      calls += 1;
      if (calls === 1) {
        const bytesRead = await read(...args);
        entered.open();
        await held.opened;
        return bytesRead;
      }
      return null;
    };
    const a = settled(snap(env, payload));
    await entered.opened;
    await refused(snap(env, payload), "staging-unavailable");
    held.open();
    expect((await a).value).toMatchObject({ status: "failed", reason: "staging-unavailable", replayed: true });
    expect(env.storage.uploads).toEqual([]);
    expect(await env.receipts.getRunState(opid())).toEqual({ run: 1, aborted: false });
  });

  it("a reopen racing refuseRun: A starts the run and publishes first, and B's refuseRun loses and replays it", async () => {
    let runA = null;
    const env = makeEnv({ beforeDecision: async ask => { if (ask.purpose === "record" && runA) { const a = runA; runA = null; await a(); } } });
    const bytes = png("reopen race A first");
    await aborted(env, bytes);
    const payload = thumbnail(bytes, 1);
    env.storage.objects.delete(stagedName());
    let aOut;
    runA = async () => { stage(env, bytes); aOut = await snap(env, payload); };
    const bOut = await snap(env, payload);
    expect(aOut).toMatchObject({ status: "succeeded" });
    expect(bOut).toMatchObject({ status: "succeeded", replayed: true });
    expect(env.storage.uploads).toHaveLength(1);
    expect(await env.receipts.getOutcome(opid())).toMatchObject({ status: "succeeded" });
  });

  it("two concurrent refuseRuns on the reopened run record one outcome", async () => {
    let arrived = 0;
    const both = gate();
    const env = makeEnv({ beforeDecision: async ask => { if (ask.purpose === "record") { arrived += 1; if (arrived === 2) both.open(); await both.opened; } } });
    const bytes = png("two reopens");
    await aborted(env, bytes);
    env.storage.objects.delete(stagedName());
    const payload = thumbnail(bytes, 1);
    const [x, y] = await Promise.all([settled(snap(env, payload)), settled(snap(env, payload))]);
    expect([x, y].filter(r => r.error?.reason === "staging-unavailable")).toHaveLength(1);
    expect([x, y].filter(r => r.value?.replayed === true && r.value.status === "failed")).toHaveLength(1);
    expect(await env.receipts.getRunState(opid())).toEqual({ run: 1, aborted: false });
    expect(env.records.filter(r => r.event === "execute" && r.outcome === "failed")).toHaveLength(1);
  });
});
