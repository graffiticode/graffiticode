/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
// Live execution authorization in Broker (W2 PR 5; spec EXEC-02, REVOKE-01,
// API-02, AT-05, AT-06). Broker asks a real in-memory Policy before every
// effect. AT-05: authority removed after mint means zero effects. AT-06:
// authority removed between provider writes leaves the first and stops the
// second (partial). Plus Policy outages, replays, the decided timing rules
// (headroom, bounded waits, post-decision checks), provenance, and the
// caller's same-operation recovery.
import { generateKeyPair, exportJWK, importJWK, SignJWT } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import {
  createPolicy,
  createLocalSigner,
  issueToken,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createMemoryGrantStore,
  grantIdFor,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch,
  ISSUER,
  SYSTEM_PREVIEW_SUBJECT
} from "@graffiticode/policy";
import {
  createBroker,
  BrokerRefused,
  contractRefusal,
  buildOperations,
  createMemoryOnceStore,
  createMemoryReceiptStore,
  createMemoryActivityStore,
  createMemorySecretStore,
  argsDigest,
  localAuthorizer,
  AuthorizationUnavailable,
  DEFAULT_LIMITS,
  headroomMs
} from "./index.js";

const OWNER = "0xowneruid";
const OTHER = "0xotheruid";
const SYSTEM = "0xsystemowner";
const L0176 = { role: "compiler", lang: "0176" };
const WRITE_OP = "learnosity.write-items";
const SIGN_OP = "learnosity.sign-items-preview";
const PREVIEW = { id: "p", questions: [{ type: "mcq", response_id: "r1" }] };
const WRITE = {
  questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: "?", options: [{ label: "A", value: "0" }], validation: { valid_response: { score: 1, value: ["0"] } } } }],
  itemRecords: [{ reference: "item-0", status: "unpublished", definition: { widgets: [{ reference: "q-0" }] }, questions: [{ reference: "q-0" }] }]
};

let signer;
let privateJwk;
let policy;
let connections;
let grants;
let publications;
let systemConnections;
let receipts;
let routes;
let signed;
let onRoute;
let deps;
let records;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateJwk = await exportJWK(pair.privateKey);
  signer = await createLocalSigner({ privateJwk, kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  records = [];
  const audit = createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  const on = createProtectedSwitch({ cacheMs: 0, readFlag: async () => ({ enabled: true }) });
  connections = createMemoryConnectionStore([
    { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" },
    { connectionId: "conn-sys", ownerUid: SYSTEM, backend: "learnosity", status: "active" },
  ]);
  grants = createMemoryGrantStore([{
    grantId: grantIdFor({ connectionId: "conn-1", recipientUid: OTHER }),
    connectionId: "conn-1",
    ownerUid: OWNER,
    recipientUid: OTHER,
    permissions: [{ lang: "0176", fn: "init" }, { lang: "0176", fn: "save-to-itembank" }],
    expiresAt: null,
  }]);
  publications = createMemoryPublicationStore();
  await publications.create({ publicationId: "pub-1", publisherUid: OWNER, ownerUid: OWNER, connectionId: "conn-1", lang: "0176" });
  systemConnections = { learnosity: "conn-sys" };
  policy = createPolicy({ protectedSwitch: on, signer, jwks, connections, grants, publications, systemConnections, invocations: createMemoryInvocationStore(), audit });
  routes = [];
  signed = [];
  onRoute = null;
  receipts = createMemoryReceiptStore();
  deps = {
    protectedSwitch: on,
    jwks,
    audit,
    operations: buildOperations({
      sdk: { init: (service, consumer, secret, body) => { signed.push(service); return { service, body }; } },
      domain: "d",
      dataApi: async ({ route }) => {
        routes.push(route);
        await onRoute?.(route);
        return { meta: { status: true } };
      }
    }),
    secrets: createMemorySecretStore({
      "conn-1": { ownerUid: OWNER, backend: "learnosity", key: "k", secret: "s" },
      "conn-sys": { ownerUid: SYSTEM, backend: "learnosity", key: "k", secret: "s" },
    }),
    once: createMemoryOnceStore(),
    receipts,
    activity: createMemoryActivityStore(),
    authorize: localAuthorizer(policy),
  };
});

const broker = (over = {}) => createBroker({ ...deps, ...over });
// An execution token as mint would issue it; `over` changes any claim.
const token = (over: Record<string, unknown> = {}, s = signer) => issueToken(s, "execution", {
  sub: OWNER,
  own: OWNER,
  conn: "conn-1",
  backend: "learnosity",
  lang: "0176",
  fn: "save-to-itembank",
  op: WRITE_OP,
  sid: "sid-1",
  opid: "inv-1/s0/n1.0",
  argd: argsDigest(WRITE),
  rv: REGISTRY_VERSION,
  prv: "user",
  ...over,
});
const signToken = (over = {}) => token({ fn: "init", op: SIGN_OP, argd: argsDigest(PREVIEW), ...over });
const write = async (b, t?: string) => b.execute({ caller: L0176, token: t ?? await token(), op: WRITE_OP, payload: WRITE });
const sign = async (b, t?: string) => b.execute({ caller: L0176, token: t ?? await signToken(), op: SIGN_OP, payload: PREVIEW });
const refused = async (promise, reason, status?: number) => {
  const err = await promise.then(() => null, e => e);
  expect(err).toBeInstanceOf(BrokerRefused);
  expect(err.reason).toBe(reason);
  if (status !== undefined) expect(err.status).toBe(status);
};
const revokeGrant = () => grants.delete(grantIdFor({ connectionId: "conn-1", recipientUid: OTHER }));
const disable = async id => connections.put({ ...(await connections.get(id)), status: "disabled" });

describe("AT-05: authority removed after mint, then execute: zero effects", () => {
  it.each([
    ["the grant revoked", { sub: OTHER }, revokeGrant, "not-owner"],
    ["the grant expired", { sub: OTHER }, async () => grants.put({ ...(await grants.get(grantIdFor({ connectionId: "conn-1", recipientUid: OTHER }))), expiresAt: "2000-01-01T00:00:00.000Z" }), "not-owner"],
    ["the owner narrowing their own use", {}, async () => connections.put({ ...(await connections.get("conn-1")), ownerPermissions: [{ lang: "0176", fn: "init" }] }), "not-granted"],
    ["the connection disabled", {}, () => disable("conn-1"), "connection-disabled"],
  ])("a write, %s", async (_name, claims, revoke, reason) => {
    const t = await token(claims);
    await revoke();
    const out = await write(broker(), t);
    expect(out).toMatchObject({ status: "failed", steps: [], reason: `authorization-denied:${reason}` });
    expect(routes).toEqual([]);
    expect(await receipts.getOutcome("inv-1/s0/n1.0")).toMatchObject({ status: "failed", reason: `authorization-denied:${reason}` });
  });

  it.each([
    ["the grant revoked", { sub: OTHER }, revokeGrant, "not-owner"],
    ["the connection disabled", {}, () => disable("conn-1"), "connection-disabled"],
    ["unpublished", { prv: "publication", pub: "pub-1" }, () => publications.delete("pub-1"), "publication-not-found"],
    ["the system connection replaced", { sub: SYSTEM_PREVIEW_SUBJECT, own: SYSTEM, conn: "conn-sys", prv: "system" }, async () => { systemConnections.learnosity = "conn-other"; }, "not-system-connection"],
  ])("a signature, %s", async (_name, claims, revoke, reason) => {
    const t = await signToken(claims);
    await expect(sign(broker(), t)).resolves.toMatchObject({ status: "succeeded" });
    signed = [];
    const again = await signToken({ ...claims, opid: "inv-1/s0/n2.0" });
    await revoke();
    await refused(sign(broker(), again), `authorization-denied:${reason}`, 403);
    expect(signed).toEqual([]);
  });
});

describe("Policy unavailable: no dispatch, no signature, no replay", () => {
  const down = async () => { throw new AuthorizationUnavailable("policy unreachable"); };
  it("a write fails with nothing dispatched", async () => {
    expect(await write(broker({ authorize: down }))).toMatchObject({ status: "failed", steps: [], reason: "authorization-unavailable" });
    expect(routes).toEqual([]);
  });
  it("a signature is refused (503)", async () => {
    await refused(sign(broker({ authorize: down })), "authorization-unavailable", 503);
    expect(signed).toEqual([]);
  });
  it("a replay is refused, its receipt untouched", async () => {
    await write(broker());
    await refused(write(broker({ authorize: down }), await token()), "authorization-unavailable", 503);
    expect(await receipts.getOutcome("inv-1/s0/n1.0")).toMatchObject({ status: "succeeded" });
  });
});

describe("one fresh decision per step", () => {
  it("asks before each registered step, in order, and never reuses a decision", async () => {
    const asks = [];
    const spy = async ask => { asks.push(ask); return localAuthorizer(policy)(ask); };
    await expect(write(broker({ authorize: spy }))).resolves.toMatchObject({ status: "succeeded", steps: ["questions", "items"] });
    expect(asks.map(a => [a.step, a.purpose, a.after])).toEqual([["questions", "dispatch", null], ["items", "dispatch", "questions"]]);
    expect(asks.every(a => a.signal instanceof AbortSignal)).toBe(true);
    await sign(broker({ authorize: spy }));
    expect(asks.at(-1)).toMatchObject({ step: "sign", purpose: "sign", after: null, op: SIGN_OP });
  });
});

describe("AT-06: authority removed between provider writes", () => {
  it("keeps the first effect, never starts the second, and reports partial", async () => {
    const t = await token({ sub: OTHER });
    onRoute = async route => { if (route === "/itembank/questions") await revokeGrant(); };
    const out = await write(broker(), t);
    expect(out).toMatchObject({ status: "partial", steps: ["questions"], reason: "authorization-denied:not-owner" });
    expect(routes).toEqual(["/itembank/questions"]);
  });

  it("reports uncertain, with the completed steps, when a dispatched response is lost", async () => {
    onRoute = async route => { if (route === "/itembank/items") throw new Error("socket hang up"); };
    expect(await write(broker())).toMatchObject({ status: "uncertain", steps: ["questions"] });
  });

  // The race (REVOKE-01): a revocation committed after a step's decision may
  // let that step dispatch; the next decision sees it.
  it("lets a step authorized before the revocation dispatch, and stops the next", async () => {
    const t = await token({ sub: OTHER });
    const racing = async ask => {
      const decision = await localAuthorizer(policy)(ask);
      if (ask.step === "items") await revokeGrant();
      return decision;
    };
    expect(await write(broker({ authorize: racing }), t)).toMatchObject({ status: "succeeded", steps: ["questions", "items"] });
    // A fresh token for the completed operation asks again before replaying.
    await refused(write(broker(), await token({ sub: OTHER })), "authorization-denied:not-owner", 403);
    expect(await receipts.getOutcome("inv-1/s0/n1.0")).toMatchObject({ status: "succeeded" });
  });
});

describe("timing", () => {
  it("refuses a token that can't outlast the deadline before spending it (token-expiring)", async () => {
    const t = await token();
    const exp = (JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString())).exp * 1000;
    // Arriving with one millisecond less than H left.
    await refused(write(broker({ now: () => exp - headroomMs(DEFAULT_LIMITS) + 1 }), t), "token-expiring", 409);
    expect(routes).toEqual([]);
    expect(await receipts.getOutcome("inv-1/s0/n1.0")).toBeNull();
    // Not spent: the same token still runs on a timely arrival.
    await expect(write(broker(), t)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("waits for a decision at most authorizeMs, and discards a late one", async () => {
    let release;
    const late = () => new Promise(resolve => { release = resolve; });
    const out = await write(broker({ authorize: late, limits: { ...DEFAULT_LIMITS, authorizeMs: 20 } }));
    expect(out).toMatchObject({ status: "failed", steps: [], reason: "authorization-unavailable" });
    release({ decisionId: "late" });
    await new Promise(resolve => setImmediate(resolve));
    expect(routes).toEqual([]);
  });

  it("never accepts a decision that arrives after the deadline", async () => {
    let t = Date.now();
    // The decision arrives after the deadline has passed. Its wait's cutoff is
    // never later than the deadline, so it is discarded as late; stalls after
    // a timely decision are covered under "timing after the decision".
    const slow = async ask => { const d = await localAuthorizer(policy)(ask); t += DEFAULT_LIMITS.executionMs + 1; return d; };
    const out = await write(broker({ authorize: slow, now: () => t }));
    expect(out).toMatchObject({ status: "failed", steps: [], reason: "authorization-unavailable" });
    expect(routes).toEqual([]);
  });

  it("stops before the next step once the deadline passes mid-operation", async () => {
    let t = Date.now();
    onRoute = async route => { if (route === "/itembank/questions") t += DEFAULT_LIMITS.executionMs; };
    expect(await write(broker({ now: () => t }))).toMatchObject({ status: "partial", steps: ["questions"], reason: "deadline-exceeded" });
    expect(routes).toEqual(["/itembank/questions"]);
  });
});

describe("provenance", () => {
  it("refuses a token without prv (the execution profile requires it)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: OWNER, own: OWNER, conn: "conn-1", backend: "learnosity", lang: "0176", fn: "init", op: SIGN_OP, sid: "s", opid: "inv-1/s0/n1.0", argd: argsDigest(PREVIEW), rv: REGISTRY_VERSION };
    const old = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "gc-exec+jwt" })
      .setIssuer(ISSUER).setAudience("urn:graffiticode:broker").setIssuedAt(now).setExpirationTime(now + 60).setJti("j")
      .sign(await importJWK(privateJwk, "ES256"));
    await refused(sign(broker(), old), "bad-token", 401);
  });

  it("refuses provenance claims that don't form one, before anything else", async () => {
    await refused(sign(broker(), await signToken({ prv: "system" })), "bad-provenance", 403);
    await refused(sign(broker(), await signToken({ prv: "user", pub: "pub-1" })), "bad-provenance", 403);
    expect(signed).toEqual([]);
  });
});

// The caller's recovery: L0176 doesn't re-mint within a compile; the refused
// compile is retried with the same idempotency key, so the same invocation
// and operation id, and a fresh token. Here, two refusals that leave nothing
// behind, each followed by a fresh token for the same operation.
describe("recovery with a fresh token for the same operation", () => {
  it("after token-expiring, writes exactly once", async () => {
    const stale = await token();
    const exp = (JSON.parse(Buffer.from(stale.split(".")[1], "base64url").toString())).exp * 1000;
    await refused(write(broker({ now: () => exp - 1000 }), stale), "token-expiring", 409);
    expect(await write(broker(), await token())).toMatchObject({ status: "succeeded" });
    expect(await write(broker(), await token())).toMatchObject({ status: "succeeded", replayed: true });
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("after a token without provenance, writes exactly once", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { prv, ...noProvenance } = { sub: OWNER, own: OWNER, conn: "conn-1", backend: "learnosity", lang: "0176", fn: "save-to-itembank", op: WRITE_OP, sid: "s", opid: "inv-1/s0/n1.0", argd: argsDigest(WRITE), rv: REGISTRY_VERSION, prv: "user" };
    const old = await new SignJWT(noProvenance)
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "gc-exec+jwt" })
      .setIssuer(ISSUER).setAudience("urn:graffiticode:broker").setIssuedAt(now).setExpirationTime(now + 60).setJti("j-old")
      .sign(await importJWK(privateJwk, "ES256"));
    await refused(write(broker(), old), "bad-token", 401);
    expect(await write(broker(), await token())).toMatchObject({ status: "succeeded" });
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });
});

// Review of 41359cc: nothing awaited may come between the final checks and
// the effect, and a decision is late by the clock, not by which promise wins.
describe("timing after the decision", () => {
  // A clock the test moves; an audit sink that stalls by moving it.
  let t;
  const stallAt = (event, ms) => async r => { if (r.event === event) t += ms; };
  beforeEach(() => { t = Date.now(); });

  it("refuses a signature when auditing the decision outlasts the deadline", async () => {
    const b = broker({ now: () => t, audit: stallAt("execute-step", DEFAULT_LIMITS.executionMs + 1) });
    await refused(sign(b), "deadline-exceeded", 503);
    expect(signed).toEqual([]);
  });

  it("records an unsent request as failed, never uncertain, when that stall uses up the deadline", async () => {
    const b = broker({ now: () => t, audit: stallAt("execute-step", DEFAULT_LIMITS.executionMs + 1) });
    expect(await write(b)).toMatchObject({ status: "failed", steps: [], reason: "deadline-exceeded" });
    expect(routes).toEqual([]);
  });

  it("refuses a replay when auditing it outlasts the deadline", async () => {
    await write(broker());
    const b = broker({ now: () => t, audit: stallAt("execute", DEFAULT_LIMITS.executionMs + 1) });
    await refused(write(b, await token()), "deadline-exceeded", 503);
  });

  it("discards a decision that took longer than authorizeMs, even before the timer fires", async () => {
    // Answers at once in real time, so the 10 ms timer can't have fired, but
    // 40 ms have passed by the broker's clock.
    const slow = async ask => { const d = await localAuthorizer(policy)(ask); t += 40; return d; };
    const b = broker({ now: () => t, authorize: slow, limits: { ...DEFAULT_LIMITS, authorizeMs: 10 } });
    expect(await write(b)).toMatchObject({ status: "failed", steps: [], reason: "authorization-unavailable" });
    expect(routes).toEqual([]);
  });
});

// The caller's recovery along the planned path, not just Broker's half: the
// gateway allocates the invocation by idempotency key, and the compiler
// (L0176) takes a snapshot for its stage and mints for its occurrence. A
// refused compile is retried with the same key, so it reaches the same
// invocation and operation id and mints a fresh token.
describe("recovery through the gateway and compiler path", () => {
  const GATEWAY = { role: "gateway" };
  const compile = async (idempotencyKey, { execute = (b, executionToken) => write(b, executionToken), b = broker() } = {}) => {
    const { invocationToken } = await policy.allocateInvocation({
      caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: "task-1", inputDigest: "c".repeat(64), idempotencyKey
    });
    const { sessionToken } = await policy.snapshot({
      caller: L0176, user: { uid: OWNER }, lang: "0176", connectionId: "conn-1", fns: ["save-to-itembank"], invocationToken, stage: "s0"
    });
    const { executionToken, operationId } = await policy.mint({
      caller: L0176, sessionToken, fn: "save-to-itembank", op: WRITE_OP, occurrenceId: "n1.0", argsDigest: argsDigest(WRITE)
    });
    return { operationId, out: await execute(b, executionToken).then(o => o, e => e) };
  };

  it("after token-expiring, the retry re-mints for the same operation and writes once", async () => {
    // The first attempt reaches Broker too late for its token.
    const first = await compile("job-1", { b: broker({ now: () => Date.now() + 25_000 }) });
    expect(first.out).toBeInstanceOf(BrokerRefused);
    expect(first.out.reason).toBe("token-expiring");
    const retry = await compile("job-1");
    expect(retry.operationId).toBe(first.operationId);
    expect(retry.out).toMatchObject({ status: "succeeded" });
    const again = await compile("job-1");
    expect(again.out).toMatchObject({ status: "succeeded", replayed: true });
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("after a token from a Policy that predates provenance, the retry re-mints and writes once", async () => {
    // The first token as an older Policy would have issued it: no `prv`.
    const withoutProvenance = async (b, executionToken) => {
      const { prv, iss, aud, iat, exp, jti, ...claims } = JSON.parse(Buffer.from(executionToken.split(".")[1], "base64url").toString());
      const old = await new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "gc-exec+jwt" })
        .setIssuer(iss).setAudience(aud).setIssuedAt(iat).setExpirationTime(exp).setJti(jti)
        .sign(await importJWK(privateJwk, "ES256"));
      return write(b, old);
    };
    const first = await compile("job-2", { execute: withoutProvenance });
    expect(first.out).toBeInstanceOf(BrokerRefused);
    expect(first.out.reason).toBe("bad-token");
    expect(routes).toEqual([]);
    const retry = await compile("job-2");
    expect(retry.operationId).toBe(first.operationId);
    expect(retry.out).toMatchObject({ status: "succeeded" });
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });
});

// W3 PR 2: an outcome names its effects (spec FAIL-01) and its audit record
// the correlation and prior effects (spec AUDIT-01).
describe("effects and correlation", () => {
  const finalRecord = () => records.filter(r => r.event === "execute").at(-1);

  it("names the step that didn't happen, the reason and its category", async () => {
    const t = await token({ sub: OTHER });
    onRoute = async route => { if (route === "/itembank/questions") await revokeGrant(); };
    expect(await write(broker(), t)).toMatchObject({
      status: "partial", steps: ["questions"], failedStep: "items", reason: "authorization-denied:not-owner", category: "permission",
    });
    expect(await receipts.getOutcome("inv-1/s0/n1.0")).toMatchObject({ status: "partial", steps: ["questions"], failedStep: "items", category: "permission" });
    expect(finalRecord()).toMatchObject({
      outcome: "partial",
      steps: ["questions"],
      failedStep: "items",
      reason: "authorization-denied:not-owner",
      category: "permission",
      opid: "inv-1/s0/n1.0",
      invocationId: "inv-1",
      stage: "s0",
      provenance: "user",
      callerRole: "compiler",
    });
  });

  it("keeps uncertain with no completed step when the first response is lost", async () => {
    onRoute = async route => { if (route === "/itembank/questions") throw new Error("socket hang up"); };
    const out = await write(broker());
    expect(out).toMatchObject({ status: "uncertain", steps: [], failedStep: "questions" });
    expect(out).not.toHaveProperty("category");
    expect(finalRecord()).toMatchObject({ outcome: "uncertain", steps: [], failedStep: "questions" });
  });

  it("replays the recorded effects", async () => {
    const t = await token({ sub: OTHER });
    onRoute = async route => { if (route === "/itembank/items") throw new Error("socket hang up"); };
    await write(broker(), t);
    onRoute = null;
    expect(await write(broker(), await token({ sub: OTHER }))).toMatchObject({ status: "uncertain", steps: ["questions"], failedStep: "items", replayed: true });
  });

  // Receipts recorded before W3 have no failedStep, reason or category.
  it("replays an older receipt without the new fields", async () => {
    const binding = { principal: OWNER, ownerUid: OWNER, connectionId: "conn-1", lang: "0176", fn: "save-to-itembank", op: WRITE_OP, registryVersion: REGISTRY_VERSION, argsDigest: argsDigest(WRITE) };
    await receipts.claim("inv-1/s0/n1.0", binding);
    await receipts.putOutcome("inv-1/s0/n1.0", { status: "partial", steps: ["questions"], result: null });
    const out = await write(broker());
    expect(out).toEqual({ status: "partial", steps: ["questions"], result: null, replayed: true });
    expect(routes).toEqual([]);
  });

  it("records a successful write's steps and correlation", async () => {
    await write(broker());
    expect(finalRecord()).toMatchObject({ outcome: "allowed", steps: ["questions", "items"], opid: "inv-1/s0/n1.0", invocationId: "inv-1", stage: "s0" });
    const steps = records.filter(r => r.event === "execute-step");
    expect(steps.map(r => [r.step, r.purpose])).toEqual([["questions", "dispatch"], ["items", "dispatch"]]);
    expect(steps.every(r => r.invocationId === "inv-1" && typeof r.decisionId === "string")).toBe(true);
  });
});

// Contract v2 (W4 PR 3): the version a token was issued under, and its plan
// binding as far as the token alone shows it. Policy checks the plan itself
// at every authorization.
describe("contract v2 (RELEASE-01, TOKEN-01)", () => {
  const PLAN = "f".repeat(64);
  const allowAll = async () => ({ decisionId: "d-1" });

  it("judges a token's contract on its claims alone", () => {
    const user = { prv: "user", opid: "inv-1/s1/n1.0" };
    expect(contractRefusal(user)).toBeNull();
    expect(contractRefusal({ ...user, cv: 1 }, 2)).toBe("contract-version-unsupported");
    expect(contractRefusal({ ...user, cv: 3 })).toBe("contract-version-unsupported");
    expect(contractRefusal({ ...user, cv: 2 }, 2)).toBe("plan-required");
    expect(contractRefusal({ ...user, cv: 2, pld: PLAN, stg: "s1" }, 2)).toBeNull();
    expect(contractRefusal({ ...user, cv: 2, pld: PLAN, stg: "s0" })).toBe("plan-binding-mismatch");
    expect(contractRefusal({ ...user, cv: 2, pld: PLAN })).toBe("plan-binding-mismatch");
    expect(contractRefusal({ ...user, cv: 2, stg: "s1" })).toBe("plan-binding-mismatch");
    // Publication and system tokens are bound by their own authority.
    expect(contractRefusal({ prv: "system", cv: 2, opid: "sys-1/preview/p.0" }, 2)).toBeNull();
    expect(contractRefusal({ prv: "publication", pub: "pub-1", cv: 2, opid: "inv-1/view/p.0" }, 2)).toBeNull();
  });

  it("refuses a contract version it doesn't support before anything is spent", async () => {
    const t = await token({ cv: 3 });
    await refused(write(broker(), t), "contract-version-unsupported", 409);
    expect(routes).toEqual([]);
    expect(await receipts.getOutcome("inv-1/s0/n1.0")).toBeNull();
    // Not spent: the same jti is still unclaimed.
    expect(records.filter(r => r.event === "execute" && r.outcome === "denied").at(-1)).toMatchObject({ reason: "contract-version-unsupported" });
  });

  it("at minimum 2, refuses unbound user tokens and v1 tokens, and runs bound and system ones", async () => {
    const strict = broker({ minContractVersion: 2, authorize: allowAll });
    await refused(write(strict, await token()), "contract-version-unsupported", 409);
    await refused(write(strict, await token({ cv: 2 })), "plan-required", 409);
    await refused(write(strict, await token({ cv: 2, pld: PLAN, stg: "s1" })), "plan-binding-mismatch", 409);
    expect(routes).toEqual([]);
    await expect(write(strict, await token({ cv: 2, pld: PLAN, stg: "s0" }))).resolves.toMatchObject({ status: "succeeded" });
    await expect(sign(strict, await signToken({ sub: SYSTEM_PREVIEW_SUBJECT, own: SYSTEM, conn: "conn-sys", prv: "system", cv: 2, opid: "sys-1/preview/p.0" }))).resolves.toMatchObject({ status: "succeeded" });
  });

  it("names the plan on the receipt and in the audit, so retiring a revision can find its writes", async () => {
    const out = await write(broker({ authorize: allowAll }), await token({ cv: 2, pld: PLAN, stg: "s0" }));
    expect(out).toMatchObject({ status: "succeeded" });
    const claim = await receipts.claim("inv-1/s0/n1.0", {});
    expect(claim).toMatchObject({ created: false, claim: { pld: PLAN } });
    expect(records.filter(r => r.event === "execute").at(-1)).toMatchObject({ outcome: "allowed", planDigest: PLAN });
    // An unbound write's receipt names no plan.
    await write(broker({ authorize: allowAll }), await token({ opid: "inv-2/s0/n1.0" }));
    expect((await receipts.claim("inv-2/s0/n1.0", {})).claim.pld).toBeUndefined();
  });
});
