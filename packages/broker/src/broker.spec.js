/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
import { generateKeyPair, exportJWK } from "jose";
import {
  createPolicy,
  createLocalSigner,
  issueToken,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch
} from "@graffiticode/policy";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import {
  createBroker,
  BrokerRefused,
  buildOperations,
  ProviderRejected,
  createMemoryOnceStore,
  createMemoryReceiptStore,
  createMemoryActivityStore,
  createMemorySecretStore,
  argsDigest
} from "./index.js";

// Protected execution on (the maintenance switch is tested on its own).
const PROTECTED_ON = createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });

const OWNER = "0xowneruid";
const SECRET = "learnosity-secret-value-xyz";
const L0176 = { role: "compiler", lang: "0176" };

const PREVIEW = {
  id: "t",
  name: "Test",
  session_id: "s1",
  questions: [{ response_id: "artcompiler-mcq-t-0", type: "mcq", stimulus: "Q" }]
};
const WRITE = {
  questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: "Q" } }],
  itemRecords: [{ reference: "graffiticode-t-0", definition: { widgets: [{ reference: "q-0" }] }, status: "unpublished" }]
};

let policy;
let broker;
let receipts;
let activity;
let providerCalls;
let onProviderCall;
let routes;
let failItems;
let lostItems;
let secrets;
let brokerDeps;
let signer;
let records;
let otherSigner;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const other = await generateKeyPair("ES256", { extractable: true });
  otherSigner = await createLocalSigner({ privateJwk: await exportJWK(other.privateKey), kid: "k1" });
  records = [];
  const audit = createAudit({
    sink: r => records.push(r),
    pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" })
  });
  const connections = createMemoryConnectionStore([
    { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }
  ]);
  // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
  policy = createPolicy({ protectedSwitch: PROTECTED_ON, signer, jwks, connections, invocations: createMemoryInvocationStore(), audit });
  routes = [];
  failItems = false;
  lostItems = false;
  const sdk = {
    init: (service, consumer, secret, body, action) => ({ service, consumer, signedWithSecret: secret === SECRET, body, action })
  };
  const dataApi = async ({ route, timeoutMs }) => {
    routes.push(route);
    providerCalls.push({ route, timeoutMs, active: await activity.count() });
    if (onProviderCall) await onProviderCall(route);
    if (failItems && route === "/itembank/items") throw new ProviderRejected("Learnosity Data API failed: /itembank/items");
    if (lostItems && route === "/itembank/items") throw new Error("request timed out");
    return { meta: { status: true } };
  };
  receipts = createMemoryReceiptStore();
  activity = createMemoryActivityStore();
  providerCalls = [];
  onProviderCall = null;
  secrets = createMemorySecretStore({ "conn-1": { ownerUid: OWNER, backend: "learnosity", key: "consumer-key", secret: SECRET } });
  brokerDeps = {
    protectedSwitch: PROTECTED_ON,
    jwks,
    operations: buildOperations({ sdk, domain: "l0176.graffiticode.org", dataApi }),
    secrets,
    once: createMemoryOnceStore(),
    receipts,
    activity,
    audit
  };
  broker = createBroker(brokerDeps);
});

// A retry sends the same idempotency key, so it continues the same invocation.
const invocation = (idempotencyKey = "job-1") => policy.allocateInvocation({
  caller: { role: "gateway" },
  user: { uid: OWNER },
  connectionId: "conn-1",
  taskId: "task-1",
  inputDigest: argsDigest({}),
  idempotencyKey
});

// @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
const session = async ({ idempotencyKey, ...over } = {}) => policy.snapshot({
  caller: L0176,
  user: { uid: OWNER },
  lang: "0176",
  connectionId: "conn-1",
  fns: ["init", "save-to-itembank", "author"],
  invocationToken: (await invocation(idempotencyKey)).invocationToken,
  stage: "s0",
  ...over
}).then(r => r.sessionToken);

const mint = async (sessionToken, { fn, op, payload, occurrenceId = "n1.0" }) =>
  (await policy.mint({ caller: L0176, sessionToken, fn, op, occurrenceId, argsDigest: argsDigest(payload) })).executionToken;

const previewToken = async (payload = PREVIEW) =>
  mint(await session(), { fn: "init", op: "learnosity.sign-questions-preview", payload });

// @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
const saveToken = async ({ idempotencyKey = "job-1", payload = WRITE, occurrenceId } = {}) =>
  mint(await session({ idempotencyKey }), {
    fn: "save-to-itembank",
    op: "learnosity.write-items",
    payload,
    occurrenceId
  });

const refused = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(BrokerRefused);
  await expect(promise).rejects.toMatchObject({ reason });
};

// A compile with no user connection signs through the Graffiticode-owned
// system connection (policy POST /v1/preview-session). The broker needs no
// change: it verifies the execution token and spends the credential stored
// for the system connection, bound to its owner and backend.
describe("system preview sessions", () => {
  const SYSTEM = "0xgraffiticode";
  let sysPolicy;
  let misbound;
  beforeEach(async () => {
    const connections = createMemoryConnectionStore([
      { connectionId: "conn-sys", ownerUid: SYSTEM, backend: "learnosity", status: "active" },
      { connectionId: "conn-sys-bad", ownerUid: SYSTEM, backend: "learnosity", status: "active" }
    ]);
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    const make = connectionId => createPolicy({
      protectedSwitch: PROTECTED_ON,
      signer,
      jwks: brokerDeps.jwks,
      connections,
      invocations: createMemoryInvocationStore(),
      systemConnections: { learnosity: connectionId },
      audit: async () => {}
    });
    sysPolicy = make("conn-sys");
    misbound = make("conn-sys-bad");
    await secrets.create("conn-sys", { ownerUid: SYSTEM, backend: "learnosity", key: "system-key", secret: SECRET });
    // A credential stored under another owner than the connection record's.
    await secrets.create("conn-sys-bad", { ownerUid: OWNER, backend: "learnosity", key: "system-key", secret: SECRET });
  });
  const sysToken = async ({ fn = "init", op, payload, p = sysPolicy }) => {
    const { sessionToken } = await p.previewSession({ caller: L0176, lang: "0176" });
    return (await p.mint({ caller: L0176, sessionToken, fn, op, occurrenceId: "prog.0", argsDigest: argsDigest(payload) })).executionToken;
  };

  it("signs Questions and Items previews with the system connection's credential", async () => {
    for (const op of ["learnosity.sign-questions-preview", "learnosity.sign-items-preview"]) {
      const token = await sysToken({ op, payload: PREVIEW });
      const { status, result } = await broker.execute({ caller: L0176, token, op, payload: PREVIEW });
      expect(status).toBe("succeeded");
      expect(result.request.signedWithSecret).toBe(true);
      expect(result.request.consumer.consumer_key).toBe("system-key");
    }
  });

  it("is refused if the stored credential belongs to another owner", async () => {
    const token = await sysToken({ op: "learnosity.sign-questions-preview", payload: PREVIEW, p: misbound });
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "credential-binding-mismatch");
  });
});

describe("preview signing", () => {
  it("signs a constrained preview with the broker's own identity fields", async () => {
    const token = await previewToken();
    const { status, result } = await broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW });
    expect(status).toBe("succeeded");
    expect(result.request.service).toBe("questions");
    expect(result.request.signedWithSecret).toBe(true);
    expect(result.request.consumer.domain).toBe("l0176.graffiticode.org");
    expect(routes).toEqual([]);
  });

  it("rejects a payload carrying identity or config fields", async () => {
    const payload = { ...PREVIEW, user_id: "someone", security: {} };
    const token = await previewToken(payload);
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload }), "payload-rejected");
  });

  it("rejects a payload other than the one the token was minted for", async () => {
    const token = await previewToken();
    const payload = { ...PREVIEW, name: "Other" };
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload }), "args-mismatch");
  });

  it("rejects a token used for a different operation", async () => {
    const token = await previewToken();
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.sign-items-preview", payload: PREVIEW }), "operation-mismatch");
  });

  it("never lets a preview token sign Author requests or write", async () => {
    const token = await previewToken();
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.sign-author", payload: { reference: "r" } }), "operation-mismatch");
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE }), "operation-mismatch");
  });

  it("rejects a token spent by a compiler of another language", async () => {
    const token = await previewToken();
    await refused(broker.execute({ caller: { role: "compiler", lang: "0000" }, token, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "caller-language-mismatch");
    await refused(broker.execute({ caller: { role: "console" }, token, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "caller-language-mismatch");
  });

  it("rejects a replayed token", async () => {
    const token = await previewToken();
    await broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW });
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "token-replayed");
  });

  it("rejects a session token, and a token from another signer", async () => {
    const sessionToken = await session();
    await refused(broker.execute({ caller: L0176, token: sessionToken, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "bad-token");
    const forged = await issueToken(otherSigner, "execution", {
      sub: OWNER,
      conn: "conn-1",
      backend: "learnosity",
      lang: "0176",
      fn: "init",
      op: "learnosity.sign-questions-preview",
      argd: argsDigest(PREVIEW)
    });
    await refused(broker.execute({ caller: L0176, token: forged, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "bad-token");
  });

  it("refuses a credential not bound to the token's owner and backend", async () => {
    const token = await previewToken();
    await secrets.delete("conn-1");
    await expect(secrets.create("conn-1", { ownerUid: "0xsomeoneelse", backend: "learnosity", key: "k", secret: "s" }))
      .rejects.toThrow(/already used/);
    const rebound = createMemorySecretStore({ "conn-1": { ownerUid: "0xsomeoneelse", backend: "learnosity", key: "k", secret: "s" } });
    const other = createBroker({ ...brokerDeps, secrets: rebound });
    await refused(other.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "credential-binding-mismatch");
  });

  it("refuses a validly signed token minted for another registry version", async () => {
    const token = await issueToken(signer, "execution", {
      sub: OWNER,
      own: OWNER,
      conn: "conn-1",
      backend: "learnosity",
      lang: "0176",
      fn: "init",
      op: "learnosity.sign-questions-preview",
      argd: argsDigest(PREVIEW),
      rv: -1
    });
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "registry-version-mismatch");
  });
});

describe("item-bank writes", () => {
  it("writes questions, then items, and records the outcome", async () => {
    const token = await saveToken();
    const out = await broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE });
    expect(out.status).toBe("succeeded");
    expect(out.steps).toEqual(["questions", "items"]);
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("returns the recorded outcome to a retry from a new request, without writing again", async () => {
    await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    const retry = await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    expect(retry).toMatchObject({ status: "succeeded", replayed: true });
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("writes again for an intentional rerun (a new invocation)", async () => {
    await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    const rerun = await broker.execute({ caller: L0176, token: await saveToken({ idempotencyKey: "job-2" }), op: "learnosity.write-items", payload: WRITE });
    expect(rerun).toMatchObject({ status: "succeeded" });
    expect(rerun.replayed).toBeUndefined();
    expect(routes).toHaveLength(4);
  });

  it("executes once when two fresh tokens for one operation race", async () => {
    const [a, b] = await Promise.all([saveToken(), saveToken()]);
    const results = await Promise.all([
      broker.execute({ caller: L0176, token: a, op: "learnosity.write-items", payload: WRITE }),
      broker.execute({ caller: L0176, token: b, op: "learnosity.write-items", payload: WRITE })
    ]);
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
    expect(results.filter(r => r.replayed)).toHaveLength(1);
  });

  it("gives distinct occurrences in one save their own executions", async () => {
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    await broker.execute({ caller: L0176, token: await saveToken({ occurrenceId: "n1.0" }), op: "learnosity.write-items", payload: WRITE });
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    await broker.execute({ caller: L0176, token: await saveToken({ occurrenceId: "n1.1" }), op: "learnosity.write-items", payload: WRITE });
    expect(routes).toHaveLength(4);
  });

  it("reports a failure after the first write as partial, and never re-runs it", async () => {
    failItems = true;
    const first = await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    expect(first).toMatchObject({ status: "partial", steps: ["questions"] });
    failItems = false;
    const retry = await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    expect(retry).toMatchObject({ status: "partial", replayed: true });
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("records a provider error that is not a definite rejection as uncertain", async () => {
    lostItems = true;
    const first = await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    expect(first).toMatchObject({ status: "uncertain", steps: ["questions"] });
    lostItems = false;
    const retry = await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    expect(retry).toMatchObject({ status: "uncertain", replayed: true });
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  const recordedBinding = (over = {}) => ({
    principal: OWNER,
    ownerUid: OWNER,
    connectionId: "conn-1",
    lang: "0176",
    fn: "save-to-itembank",
    op: "learnosity.write-items",
    registryVersion: REGISTRY_VERSION,
    argsDigest: argsDigest(WRITE),
    ...over
  });

  it("reports an attempt that never finished as uncertain", async () => {
    const token = await saveToken();
    const { invocationId } = await invocation();
    await receipts.claim(`${invocationId}/s0/n1.0`, recordedBinding());
    const out = await broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE });
    expect(out).toEqual({ status: "uncertain", replayed: true });
    expect(routes).toEqual([]);
  });

  it("refuses to replay a receipt recorded under another registry version", async () => {
    const token = await saveToken();
    const { invocationId } = await invocation();
    await receipts.claim(`${invocationId}/s0/n1.0`, recordedBinding({ registryVersion: REGISTRY_VERSION - 1 }));
    await receipts.putOutcome(`${invocationId}/s0/n1.0`, { status: "succeeded", steps: [], result: null });
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE }), "receipt-registry-version-mismatch");
    expect(routes).toEqual([]);
  });

  it("refuses to replay a receipt bound to another owner or language", async () => {
    for (const [i, over] of [{ ownerUid: "0xsomeoneelse" }, { lang: "0000" }].entries()) {
      const token = await saveToken({ idempotencyKey: `job-bind-${i}` });
      const { invocationId } = await invocation(`job-bind-${i}`);
      await receipts.claim(`${invocationId}/s0/n1.0`, recordedBinding(over));
      await refused(broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE }), "operation-id-reused");
    }
    expect(routes).toEqual([]);
  });

  it("refuses an operation id reused with different arguments", async () => {
    await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    const changed = { ...WRITE, questionRecords: [{ ...WRITE.questionRecords[0], data: { type: "mcq", stimulus: "Changed" } }] };
    const token = await saveToken({ payload: changed });
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: changed }), "operation-id-reused");
    expect(routes).toHaveLength(2);
  });

  it("never publishes", async () => {
    const payload = { ...WRITE, itemRecords: [{ ...WRITE.itemRecords[0], status: "published" }] };
    const token = await saveToken({ payload });
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload }), "payload-rejected");
  });
});

describe("author signing", () => {
  const authorToken = async payload =>
    mint(await session(), { fn: "author", op: "learnosity.sign-author", payload });

  it("builds a fixed request from the reference and allowed widget types", async () => {
    const payload = { reference: "graffiticode-t-0", widgetTypes: ["mcq"] };
    const { result } = await broker.execute({ caller: L0176, token: await authorToken(payload), op: "learnosity.sign-author", payload });
    expect(result.request.service).toBe("author");
    expect(result.request.body.mode).toBe("item_edit");
    expect(result.request.body.reference).toBe("graffiticode-t-0");
  });

  it("rejects caller config and widget types outside the allowlist", async () => {
    const withConfig = { reference: "r", config: { item_list: {} } };
    await refused(broker.execute({ caller: L0176, token: await authorToken(withConfig), op: "learnosity.sign-author", payload: withConfig }), "payload-rejected");
    const badWidget = { reference: "r", widgetTypes: ["anything"] };
    await refused(broker.execute({ caller: L0176, token: await authorToken(badWidget), op: "learnosity.sign-author", payload: badWidget }), "payload-rejected");
  });
});

describe("audit", () => {
  it("records decisions without tokens, secrets or raw ids", async () => {
    const token = await previewToken();
    await broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW });
    await broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW }).catch(() => {});
    const text = JSON.stringify(records);
    expect(text).not.toContain(token);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(OWNER);
    expect(records.filter(r => r.event === "execute").map(r => r.outcome)).toEqual(["allowed", "denied"]);
  });
});

// W0: while protected execution is switched off, the broker refuses before
// anything stateful, so the token is not spent and nothing is written.
describe("maintenance switch", () => {
  let enabled;
  let canary;
  let paused;
  beforeEach(() => {
    enabled = false;
    canary = undefined;
    paused = createBroker({ ...brokerDeps, protectedSwitch: createProtectedSwitch({ cacheMs: 0, readFlag: async () => ({ enabled, canary }) }) });
  });

  it("still executes for the canary pair while paused, matched on the token, audited as such", async () => {
    canary = { uid: OWNER, connectionId: "conn-1" };
    const preview = await paused.execute({ caller: L0176, token: await previewToken(), op: "learnosity.sign-questions-preview", payload: PREVIEW });
    expect(preview.status).toBe("succeeded");
    const write = await paused.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    expect(write.status).toBe("succeeded");
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
    expect(records.filter(r => r.reason === "canary-during-maintenance")).toHaveLength(2);
  });

  it("refuses a token for anyone else while paused, whatever the canary names", async () => {
    for (const c of [{ uid: OWNER, connectionId: "conn-2" }, { uid: "0xsomeoneelse", connectionId: "conn-1" }]) {
      canary = c;
      await refused(paused.execute({ caller: L0176, token: await previewToken(), op: "learnosity.sign-questions-preview", payload: PREVIEW }), "maintenance");
    }
  });

  it("refuses a valid execution with maintenance (503), audited, without spending the token", async () => {
    const token = await previewToken();
    const attempt = () => paused.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW });
    await refused(attempt(), "maintenance");
    await expect(attempt()).rejects.toMatchObject({ status: 503 });
    expect(records.at(-1)).toMatchObject({ event: "execute", outcome: "denied", reason: "maintenance" });
    enabled = true;
    await expect(attempt()).resolves.toMatchObject({ status: "succeeded" });
  });

  it("makes no provider request and claims no receipt for a write", async () => {
    const token = await saveToken();
    await refused(paused.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE }), "maintenance");
    expect(routes).toEqual([]);
    const { invocationId } = await invocation();
    expect(await receipts.getOutcome(`${invocationId}/s0/n1.0`)).toBeNull();
    enabled = true;
    await expect(paused.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE })).resolves.toMatchObject({ status: "succeeded" });
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("still rejects a bad token or the wrong caller first", async () => {
    await refused(paused.execute({ caller: L0176, token: "not-a-token", op: "learnosity.sign-questions-preview", payload: PREVIEW }), "bad-token");
    const token = await previewToken();
    await refused(paused.execute({ caller: { role: "compiler", lang: "0000" }, token, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "caller-language-mismatch");
  });

  it("cannot be built without a switch", () => {
    const { protectedSwitch, ...rest } = brokerDeps;
    expect(() => createBroker(rest)).toThrow(/protectedSwitch/);
  });
});

// W0: bounded execution. Each provider request gets a timeout; no request
// starts after the operation's deadline; active writes are counted for
// draining.
describe("time limits and active executions", () => {
  // A clock the test advances; the broker reads it for every deadline check.
  let t;
  const timed = limits => createBroker({ ...brokerDeps, limits, now: () => t });
  const save = async b => b.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
  beforeEach(() => { t = 1_000_000; });

  it("gives each provider request its timeout, capped by the time left", async () => {
    onProviderCall = () => { t += 7_000; };
    const out = await save(timed({ providerCallMs: 10_000, executionMs: 12_000 }));
    expect(out.status).toBe("succeeded");
    expect(providerCalls.map(c => c.timeoutMs)).toEqual([10_000, 5_000]);
  });

  it("starts no request after the deadline: the write stops as partial, and a retry replays it", async () => {
    onProviderCall = route => { if (route === "/itembank/questions") t += 30_000; };
    const out = await save(timed({ providerCallMs: 10_000, executionMs: 30_000 }));
    expect(out).toMatchObject({ status: "partial", steps: ["questions"] });
    expect(out.error).toMatch(/deadline/);
    expect(routes).toEqual(["/itembank/questions"]);
    const retry = await save(broker);
    expect(retry).toMatchObject({ status: "partial", replayed: true });
    expect(routes).toEqual(["/itembank/questions"]);
  });

  it("records failed when the deadline passes before any request", async () => {
    const b = createBroker({ ...brokerDeps, limits: { providerCallMs: 1, executionMs: 1 }, now: () => (t += 5) });
    const out = await save(b);
    expect(out).toMatchObject({ status: "failed", steps: [] });
    expect(routes).toEqual([]);
  });

  it("counts a write as active while it runs, and not after, whatever its outcome", async () => {
    expect(await activity.count()).toBe(0);
    await save(broker);
    expect(providerCalls.map(c => c.active)).toEqual([1, 1]);
    expect(await activity.count()).toBe(0);
    lostItems = true;
    await broker.execute({ caller: L0176, token: await saveToken({ idempotencyKey: "job-2" }), op: "learnosity.write-items", payload: WRITE });
    expect(await activity.count()).toBe(0);
  });

  it("makes no claim and no provider request when it cannot register the write", async () => {
    const b = createBroker({ ...brokerDeps, activity: { ...activity, begin: async () => { throw new Error("firestore unavailable"); } } });
    await expect(save(b)).rejects.toThrow(/firestore unavailable/);
    expect(routes).toEqual([]);
    const { invocationId } = await invocation();
    const claim = await receipts.claim(`${invocationId}/s0/n1.0`, { probe: true });
    expect(claim.created).toBe(true);
  });

  it("expires an entry a crash left behind, and reports the drain bound", async () => {
    await activity.begin("crashed", Date.now() + 1000);
    expect(await activity.count(Date.now())).toBe(1);
    expect(await activity.count(Date.now() + 1001)).toBe(0);
    expect(await broker.activeExecutions()).toEqual({ count: expect.any(Number), maxExecutionMs: 50_000 });
  });

  it("does not track signing, which has no provider effect", async () => {
    const begins = [];
    const b = createBroker({ ...brokerDeps, activity: { ...activity, begin: async id => { begins.push(id); } } });
    await b.execute({ caller: L0176, token: await previewToken(), op: "learnosity.sign-questions-preview", payload: PREVIEW });
    expect(begins).toEqual([]);
  });

  // Review finding 1: a replay for the same operation must not remove the
  // entry of the attempt that is still writing.
  it("keeps counting an in-flight write while another request replays its receipt", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    onProviderCall = route => route === "/itembank/questions" ? gate : undefined;
    const first = broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    while (providerCalls.length === 0) await new Promise(resolve => setImmediate(resolve));
    expect(await activity.count()).toBe(1);
    const replay = await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    expect(replay).toMatchObject({ status: "uncertain", replayed: true });
    expect(await activity.count()).toBe(1);
    release();
    expect((await first).status).toBe("succeeded");
    expect(await activity.count()).toBe(0);
  });

  // Review finding 2: the deadline runs from the request's arrival, so a slow
  // claim cannot let a provider request start after the drain bound.
  it("dispatches nothing when preparation outlasts the deadline, and counts the write until then", async () => {
    let countDuringClaim;
    const slowReceipts = {
      ...receipts,
      claim: async (...args) => {
        countDuringClaim = await activity.count(t);
        t += 60_000;
        return receipts.claim(...args);
      }
    };
    const b = createBroker({ ...brokerDeps, receipts: slowReceipts, now: () => t });
    const out = await save(b);
    expect(countDuringClaim).toBe(1);
    expect(out).toMatchObject({ status: "failed", steps: [] });
    expect(out.error).toMatch(/deadline/);
    expect(routes).toEqual([]);
  });

  it("expires an attempt's entry at the bound measured from its arrival", async () => {
    let expiresAt;
    const b = createBroker({ ...brokerDeps, activity: { ...activity, begin: async (_id, at) => { expiresAt = at; } }, now: () => t });
    await save(b);
    expect(expiresAt).toBe(1_000_000 + 50_000);
  });

  it("cannot be built without an activity store", () => {
    const { activity: _activity, ...rest } = brokerDeps;
    expect(() => createBroker(rest)).toThrow(/activity/);
  });
});
