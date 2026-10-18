/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
import { generateKeyPair, exportJWK, decodeJwt } from "jose";
import {
  createPolicy,
  createLocalSigner,
  issueToken,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch,
  SYSTEM_PREVIEW_SUBJECT
} from "@graffiticode/policy";
import { REGISTRY_VERSION, isStepRegistered, operationSteps } from "@graffiticode/common/protected-registry";
import {
  createBroker,
  BrokerRefused,
  buildOperations,
  learnosityTime,
  DEFAULT_PREVIEW_EXPIRES_MINUTES,
  ProviderRejected,
  createMemoryOnceStore,
  createMemoryReceiptStore,
  createMemoryActivityStore,
  StepConflict,
  createMemorySecretStore,
  argsDigest,
  localAuthorizer,
  MARK_KEY,
  writeEvidence,
  providerReferences,
  referenceTag,
  REFERENCE_PREFIX,
  MAX_SENT_REFERENCE_LENGTH,
  parsePreviewConnections,
  PREVIEW_TYPE,
  AuthorizationUnavailable,
  createMemorySessionSlotStore,
  DEFAULT_SYSTEM_SESSION_MAX_SIGNINGS,
  MAX_EXECUTION_TOKEN_LIFETIME_S,
  slotExpiresAt,
  parseSystemSessionMaxSignings
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
let sent;
let failItems;
let lostItems;
let secrets;
let brokerDeps;
let signer;
let records;
let otherSigner;
let policyDeps;
let buildOps;

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
  policyDeps = { protectedSwitch: PROTECTED_ON, signer, jwks, connections, invocations: createMemoryInvocationStore(), audit };
  policy = createPolicy(policyDeps);
  routes = [];
  sent = [];
  failItems = false;
  lostItems = false;
  const sdk = {
    init: (service, consumer, secret, body, action) => ({ service, consumer, signedWithSecret: secret === SECRET, body, action })
  };
  const dataApi = async ({ route, timeoutMs, request }) => {
    routes.push(route);
    sent.push({ route, body: request?.body });
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
  secrets = createMemorySecretStore({
    "conn-1": { ownerUid: OWNER, backend: "learnosity", key: "consumer-key", secret: SECRET },
    // The dedicated preview consumer every Questions preview signs with.
    "conn-preview": { ownerUid: "0xgraffiticode", backend: "learnosity", key: "preview-key", secret: SECRET },
  });
  brokerDeps = {
    protectedSwitch: PROTECTED_ON,
    jwks,
    operations: (buildOps = () => buildOperations({ sdk, domain: "l0176.graffiticode.org", dataApi }))(),
    secrets,
    previewConnections: { learnosity: "conn-preview" },
    once: createMemoryOnceStore(),
    receipts,
    activity,
    // Policy's real decisions, in process (W2).
    authorize: localAuthorizer(policy),
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

// `over` replaces any snapshot field.
const session = async ({ idempotencyKey, ...over }: { idempotencyKey?: string, [field: string]: unknown } = {}) => policy.snapshot({
  caller: L0176,
  user: { uid: OWNER },
  lang: "0176",
  connectionId: "conn-1",
  fns: ["init", "save-to-itembank"],
  invocationToken: (await invocation(idempotencyKey)).invocationToken,
  stage: "s0",
  ...over
}).then(r => r.sessionToken);

const mint = async (sessionToken, { fn, op, payload, occurrenceId = "n1.0" }) =>
  (await policy.mint({ caller: L0176, sessionToken, fn, op, occurrenceId, argsDigest: argsDigest(payload) })).executionToken;

const previewToken = async (payload = PREVIEW) =>
  mint(await session(), { fn: "init", op: "learnosity.sign-questions-preview", payload });

const saveToken = async ({ idempotencyKey = "job-1", payload = WRITE, occurrenceId }: { idempotencyKey?: string, payload?: object, occurrenceId?: string } = {}) =>
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
    // Only the stores system previews use (no publications); see app.spec.ts.
    // Through `unknown`: tsc finds too little overlap for a direct cast.
    const make = connectionId => createPolicy({
      protectedSwitch: PROTECTED_ON,
      signer,
      jwks: brokerDeps.jwks,
      connections,
      invocations: createMemoryInvocationStore(),
      systemConnections: { learnosity: connectionId },
      audit: async () => {}
    } as unknown as Parameters<typeof createPolicy>[0]);
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
  // Broker asks the Policy that knows the system connection.
  const sysBroker = (p = sysPolicy) => createBroker({ ...brokerDeps, authorize: localAuthorizer(p) });

  it("signs Items previews with the system connection's credential, and Questions previews with the preview consumer", async () => {
    for (const [op, key] of [["learnosity.sign-questions-preview", "preview-key"], ["learnosity.sign-items-preview", "system-key"]]) {
      const token = await sysToken({ op, payload: PREVIEW });
      const { status, result } = await sysBroker().execute({ caller: L0176, token, op, payload: PREVIEW });
      expect(status).toBe("succeeded");
      expect(result.request.signedWithSecret).toBe(true);
      expect(result.request.consumer.consumer_key).toBe(key);
    }
  });

  it("is refused if the stored credential belongs to another owner", async () => {
    const token = await sysToken({ op: "learnosity.sign-items-preview", payload: PREVIEW, p: misbound });
    await refused(sysBroker(misbound).execute({ caller: L0176, token, op: "learnosity.sign-items-preview", payload: PREVIEW }), "credential-binding-mismatch");
  });

  // The system-preview rate limits plan, design point 3: a system session
  // allows SYSTEM_SESSION_MAX_SIGNINGS signatures, accounted here.
  describe("the per-session signature allowance", () => {
    const OP = "learnosity.sign-questions-preview";
    let slots;
    beforeEach(() => { slots = createMemorySessionSlotStore(); });
    const allowanceBroker = (over = {}) => createBroker({ ...brokerDeps, authorize: localAuthorizer(sysPolicy), slots, ...over });
    const newSession = async () => (await sysPolicy.previewSession({ caller: L0176, lang: "0176" })).sessionToken;
    // One mint per signing, as repeated `init`s in one compile make them.
    const mintIn = async (sessionToken, n) =>
      (await sysPolicy.mint({ caller: L0176, sessionToken, fn: "init", op: OP, occurrenceId: `init.${n}`, argsDigest: argsDigest(PREVIEW) })).executionToken;
    const signWith = (b, token) => b.execute({ caller: L0176, token, op: OP, payload: PREVIEW });
    const jtiOf = token => decodeJwt(token).jti;
    const stepsFor = jti => records.filter(r => r.event === "execute-step" && r.jti === jti);

    it("signs 4 times by default in one session, then refuses session-exhausted before any signing, audited as unavailable", async () => {
      const b = allowanceBroker();
      const s = await newSession();
      for (let n = 0; n < DEFAULT_SYSTEM_SESSION_MAX_SIGNINGS; n++) {
        await expect(signWith(b, await mintIn(s, n))).resolves.toMatchObject({ status: "succeeded" });
      }
      const fifth = await mintIn(s, 4);
      const err = await signWith(b, fifth).catch(e => e);
      expect(err).toBeInstanceOf(BrokerRefused);
      expect(err).toMatchObject({ reason: "session-exhausted", status: 429 });
      expect(records.at(-1)).toMatchObject({ event: "execute", outcome: "denied", reason: "session-exhausted", category: "unavailable", provenance: "system" });
      // Refused before its authorization, so before any signature.
      expect(stepsFor(jtiOf(fifth))).toEqual([]);
      // Spent, not replayable: the jti is claimed before the slot.
      await refused(signWith(b, fifth), "token-replayed");
      // Another session has its own allowance.
      await expect(signWith(b, await mintIn(await newSession(), 0))).resolves.toMatchObject({ status: "succeeded" });
    });

    it("keeps the count across a restart (a new Broker on the same store)", async () => {
      const s = await newSession();
      await signWith(allowanceBroker(), await mintIn(s, 0));
      await signWith(allowanceBroker(), await mintIn(s, 1));
      await signWith(allowanceBroker(), await mintIn(s, 2));
      await signWith(allowanceBroker(), await mintIn(s, 3));
      await refused(signWith(allowanceBroker(), await mintIn(s, 4)), "session-exhausted");
    });

    it("takes its size from systemSessionMaxSignings, and refuses a nonsense one", async () => {
      const b = allowanceBroker({ systemSessionMaxSignings: 2 });
      const s = await newSession();
      await signWith(b, await mintIn(s, 0));
      await signWith(b, await mintIn(s, 1));
      await refused(signWith(b, await mintIn(s, 2)), "session-exhausted");
      for (const systemSessionMaxSignings of [0, -1, 1.5, "4"]) {
        expect(() => allowanceBroker({ systemSessionMaxSignings })).toThrow(/systemSessionMaxSignings/);
      }
      expect(() => allowanceBroker({ slots: {} })).toThrow(/session slot store/);
    });

    it("counts a slot as soon as it is claimed, even if that execution then fails", async () => {
      const s = await newSession();
      const tokens = [];
      for (let n = 0; n < 5; n++) tokens.push(await mintIn(s, n));
      // Policy unreachable for the first: its slot is spent, with no signature.
      await refused(signWith(allowanceBroker({ authorize: async () => { throw new AuthorizationUnavailable("down"); } }), tokens[0]), "authorization-unavailable");
      const b = allowanceBroker();
      for (const t of tokens.slice(1, 4)) await expect(signWith(b, t)).resolves.toMatchObject({ status: "succeeded" });
      await refused(signWith(b, tokens[4]), "session-exhausted");
    });

    it("retains each slot past the last moment any token of its session can execute", async () => {
      const s = await newSession();
      const { exp: sexp } = decodeJwt(s);
      await signWith(allowanceBroker(), await mintIn(s, 0));
      // Storage TTL cleanup at any time up to sexp + the longest token lifetime finds nothing to remove.
      expect(await slots.sweep((sexp + MAX_EXECUTION_TOKEN_LIFETIME_S) * 1000)).toBe(0);
      expect(slotExpiresAt(sexp)).toBe((sexp + 60 + 300) * 1000);
      expect(await slots.sweep(slotExpiresAt(sexp))).toBe(1);
    });

    it("refuses a system-session token without a valid sexp as bad-token, before anything is spent", async () => {
      const b = allowanceBroker();
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        sub: SYSTEM_PREVIEW_SUBJECT,
        own: SYSTEM,
        conn: "conn-sys",
        backend: "learnosity",
        lang: "0176",
        fn: "init",
        op: OP,
        sid: "sid-sys-1",
        opid: "sys-1/preview/init.0",
        argd: argsDigest(PREVIEW),
        rv: REGISTRY_VERSION,
        prv: "system",
        cv: 2,
      };
      for (const over of [{}, { sexp: now - 120 }, { sexp: now + 3600 }, { sexp: now + 0.5 }, { sexp: now + 600, sid: "a/b" }]) {
        const token = await issueToken(signer, "execution", { ...claims, ...over });
        await refused(signWith(b, token), "bad-token");
        expect(records.at(-1)).toMatchObject({ event: "execute", outcome: "denied", reason: "bad-token", category: "authentication" });
      }
      // Nothing claimed: the same session id still has its whole allowance.
      const ok = await issueToken(signer, "execution", { ...claims, sexp: now + 600 });
      await expect(signWith(b, ok)).resolves.toMatchObject({ status: "succeeded" });
      expect(await slots.claim("sid-sys-1", 4, { expiresAt: 0 })).toBe(1);
    });

    it("never limits a connection's signatures", async () => {
      const b = allowanceBroker({ systemSessionMaxSignings: 1, authorize: localAuthorizer(policy) });
      const s = await session();
      for (let n = 0; n < 6; n++) {
        const token = await mint(s, { fn: "init", op: OP, payload: PREVIEW, occurrenceId: `n${n}.0` });
        expect(decodeJwt(token).sexp).toBeUndefined();
        await expect(signWith(b, token)).resolves.toMatchObject({ status: "succeeded" });
      }
    });

    it("reads SYSTEM_SESSION_MAX_SIGNINGS: default 4, 1 to 100, nonsense refused", () => {
      expect(parseSystemSessionMaxSignings({})).toBe(4);
      expect(parseSystemSessionMaxSignings({ SYSTEM_SESSION_MAX_SIGNINGS: "2" })).toBe(2);
      for (const v of ["0", "-1", "2.5", "101", "four"]) {
        expect(() => parseSystemSessionMaxSignings({ SYSTEM_SESSION_MAX_SIGNINGS: v })).toThrow(/SYSTEM_SESSION_MAX_SIGNINGS/);
      }
    });
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

  it("bounds every preview signature with expires, 10 minutes by default", async () => {
    const at = new Date(Date.UTC(2026, 9, 16, 21, 55, 30));
    const calls = [];
    const sdk = { init: (service, consumer) => { calls.push({ service, consumer }); return { service, consumer }; } };
    const ops = buildOperations({ sdk, domain: "l0176.graffiticode.org", dataApi: async () => ({ meta: { status: true } }), now: () => at });
    await ops["learnosity.sign-questions-preview"].run(PREVIEW, { key: "k", secret: "s" });
    await ops["learnosity.sign-items-preview"].run(PREVIEW, { key: "k", secret: "s" });
    expect(DEFAULT_PREVIEW_EXPIRES_MINUTES).toBe(10);
    expect(calls.map(c => [c.service, c.consumer.expires])).toEqual([["questions", "20261016-2205"], ["items", "20261016-2205"]]);
    // The configured window, and nonsense refused.
    const five = buildOperations({ sdk, domain: "d", dataApi: async () => ({}), now: () => at, previewExpiresMinutes: 5 });
    await five["learnosity.sign-questions-preview"].run(PREVIEW, { key: "k", secret: "s" });
    expect(calls.at(-1).consumer.expires).toBe("20261016-2200");
    for (const bad of [0, 61, 1.5, "10"]) expect(() => buildOperations({ sdk, domain: "d", dataApi: async () => ({}), previewExpiresMinutes: bad as unknown as number })).toThrow(/1 to 60/);
    expect(learnosityTime(new Date(Date.UTC(2026, 0, 2, 3, 4)))).toBe("20260102-0304");
  });

  it("a preview signed through Broker carries expires in its security packet", async () => {
    const token = await previewToken();
    const { result } = await broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW });
    expect(result.request.consumer.expires).toMatch(/^\d{8}-\d{4}$/);
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

  it("never lets a preview token write, or name an operation that does not exist", async () => {
    const token = await previewToken();
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE }), "operation-mismatch");
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.sign-author", payload: { reference: "r" } }), "operation-mismatch");
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
      own: OWNER,
      conn: "conn-1",
      backend: "learnosity",
      lang: "0176",
      fn: "init",
      op: "learnosity.sign-questions-preview",
      sid: "sid-1",
      opid: "inv-1/s0/n1",
      argd: argsDigest(PREVIEW),
      rv: REGISTRY_VERSION,
      prv: "user"
    });
    await refused(broker.execute({ caller: L0176, token: forged, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "bad-token");
  });

  it("refuses a credential not bound to the token's owner and backend", async () => {
    const token = await mint(await session(), { fn: "init", op: "learnosity.sign-items-preview", payload: PREVIEW });
    await secrets.delete("conn-1");
    await expect(secrets.create("conn-1", { ownerUid: "0xsomeoneelse", backend: "learnosity", key: "k", secret: "s" }))
      .rejects.toThrow(/already used/);
    const rebound = createMemorySecretStore({ "conn-1": { ownerUid: "0xsomeoneelse", backend: "learnosity", key: "k", secret: "s" } });
    const other = createBroker({ ...brokerDeps, secrets: rebound });
    await refused(other.execute({ caller: L0176, token, op: "learnosity.sign-items-preview", payload: PREVIEW }), "credential-binding-mismatch");
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
      sid: "sid-1",
      opid: "inv-1/s0/n1",
      argd: argsDigest(PREVIEW),
      rv: -1,
      prv: "user"
    });
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "registry-version-mismatch");
  });
});

// WRITE-02 (W5 stage 3): the claim records the write's evidence before any
// provider request, and every record Broker sends carries the operation's mark.
describe("write evidence and the operation mark", () => {
  const META = { distractor_rationale_response_level: ["why"] };
  const PAYLOAD = {
    questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: "Q", metadata: META } }],
    itemRecords: [{ reference: "graffiticode-t-0", definition: { widgets: [{ reference: "q-0" }] }, status: "unpublished" }]
  };
  const write = async (payload = PAYLOAD, occurrenceId = "n1.0") => broker.execute({ caller: L0176, token: await saveToken({ payload, occurrenceId }), op: "learnosity.write-items", payload });
  const claimOf = async opid => (await receipts.claim(opid, {})).claim;

  it("records each record's reference and digest, and where the mark goes, on the claim", async () => {
    await write();
    const [opid] = [...new Set(records.filter(r => r.event === "execute" && r.opid).map(r => r.opid))];
    const { evidence } = await claimOf(opid);
    // The evidence is of the records as written: under the operation's own
    // references (B1), with the program's content.
    const written = providerReferences(PAYLOAD, opid);
    const tag = `${REFERENCE_PREFIX}${referenceTag(opid as string)}-`;
    expect(evidence).toEqual(writeEvidence(written));
    expect(evidence).toMatchObject({
      format: 1,
      mark: { questions: `data.metadata.${MARK_KEY}`, items: `metadata.${MARK_KEY}` },
      records: [
        { step: "questions", kind: "question", reference: `${tag}q-0`, digest: argsDigest({ type: "mcq", data: PAYLOAD.questionRecords[0].data }) },
        { step: "items", kind: "item", reference: `${tag}graffiticode-t-0`, digest: argsDigest({ definition: { widgets: [{ reference: `${tag}q-0` }] }, status: "unpublished" }) },
      ],
    });
  });

  it("sends every record with this operation's mark, keeping the program's own metadata", async () => {
    await write();
    const [opid] = [...new Set(records.filter(r => r.event === "execute" && r.opid).map(r => r.opid))];
    const [questions, items] = sent;
    expect(questions.body.questions[0].data.metadata).toEqual({ ...META, [MARK_KEY]: opid });
    expect(items.body.items[0].metadata).toEqual({ [MARK_KEY]: opid });
    // The digests are of what the program sent, without the mark.
    expect((await claimOf(opid)).evidence.records[0].digest).toBe(argsDigest({ type: "mcq", data: PAYLOAD.questionRecords[0].data }));
  });

  it("refuses a record that already carries the mark: only Broker sets it", async () => {
    const forged = structuredClone(PAYLOAD);
    forged.questionRecords[0].data.metadata[MARK_KEY] = "inv-other/s0/n1.0";
    await refused(write(forged), "payload-rejected");
    const forgedItem = { ...PAYLOAD, itemRecords: [{ ...PAYLOAD.itemRecords[0], metadata: { [MARK_KEY]: "inv-other/s0/n1.0" } }] };
    await refused(write(forgedItem, "n2.0"), "payload-rejected");
    expect(routes).toEqual([]);
  });

  it("leaves a preview's signing untouched", async () => {
    await broker.execute({ caller: L0176, token: await previewToken(), op: "learnosity.sign-questions-preview", payload: PREVIEW });
    expect(JSON.stringify(sent)).not.toContain(MARK_KEY);
  });
});

// AT-10 A3 (registry v8): the Questions API doesn't sign the request, so a
// holder of a Questions preview signature can run a general session. Broker
// signs those only with the dedicated preview consumer, and pins what it can.
describe("the dedicated preview consumer and pinned preview fields (A3)", () => {
  const QUESTIONS = "learnosity.sign-questions-preview";
  const ITEMS = "learnosity.sign-items-preview";
  const sign = async (op, { payload = PREVIEW as Record<string, unknown>, b = broker } = {}) =>
    b.execute({ caller: L0176, token: await mint(await session(), { fn: "init", op, payload }), op, payload });

  it("signs a Questions preview through a user connection with the preview consumer, never the connection's", async () => {
    const { result } = await sign(QUESTIONS);
    expect(result.request.consumer.consumer_key).toBe("preview-key");
  });

  it("signs an Items preview with the token's connection", async () => {
    const { result } = await sign(ITEMS);
    expect(result.request.consumer.consumer_key).toBe("consumer-key");
  });

  it("refuses a Questions preview when no preview consumer is configured, and still signs Items", async () => {
    const unconfigured = createBroker({ ...brokerDeps, previewConnections: {} });
    await refused(sign(QUESTIONS, { b: unconfigured }), "preview-consumer-unconfigured");
    expect(records.filter(r => r.reason === "preview-consumer-unconfigured").map(r => r.outcome)).toEqual(["denied"]);
    expect((await sign(ITEMS, { b: unconfigured })).status).toBe("succeeded");
  });

  it("refuses a preview consumer stored for another backend", async () => {
    const wrong = createMemorySecretStore({ "conn-1": { ownerUid: OWNER, backend: "learnosity", key: "consumer-key", secret: SECRET }, "conn-preview": { ownerUid: "0xgraffiticode", backend: "other", key: "k", secret: "s" } });
    await refused(sign(QUESTIONS, { b: createBroker({ ...brokerDeps, secrets: wrong }) }), "credential-binding-mismatch");
  });

  it("pins type local_practice and a fresh session on both APIs, whatever the payload says", async () => {
    for (const op of [QUESTIONS, ITEMS]) {
      const sessions = new Set();
      for (const payload of [PREVIEW, { ...PREVIEW, type: PREVIEW_TYPE }, { ...PREVIEW, session_id: "chosen-by-caller" }]) {
        const { result } = await sign(op, { payload });
        expect(result.request.body.type).toBe(PREVIEW_TYPE);
        expect(result.request.body.session_id).not.toBe("chosen-by-caller");
        sessions.add(result.request.body.session_id);
        // The content is the payload's.
        expect(result.request.body.questions).toEqual(PREVIEW.questions);
      }
      expect(sessions.size).toBe(3);
    }
  });

  it("refuses a payload asking for any other activity type", async () => {
    for (const type of ["submit_practice", "feedback", ""]) {
      await refused(sign(QUESTIONS, { payload: { ...PREVIEW, type } }), "payload-rejected");
    }
  });

  it("won't build a signing operation that doesn't say which credential it signs with, or with a malformed map", () => {
    const ops = buildOps();
    const { signsWith: _s, ...unsaid } = ops[QUESTIONS];
    expect(() => createBroker({ ...brokerDeps, operations: { ...ops, [QUESTIONS]: unsaid } })).toThrow("needs signsWith");
    expect(() => createBroker({ ...brokerDeps, previewConnections: { learnosity: "" } })).toThrow("previewConnections");
  });

  it("reads BROKER_PREVIEW_CONNECTIONS strictly", () => {
    expect(parsePreviewConnections(undefined)).toEqual({});
    expect(parsePreviewConnections(" ")).toEqual({});
    expect(parsePreviewConnections("{\"learnosity\":\"conn-x\"}")).toEqual({ learnosity: "conn-x" });
    for (const bad of ["{", "[]", "{\"other\":\"c\"}", "{\"learnosity\":\"\"}", "{\"learnosity\":1}"]) {
      expect(() => parsePreviewConnections(bad)).toThrow(/BROKER_PREVIEW_CONNECTIONS/);
    }
  });
});

// B1 (AT-10, registry v8): a save only ever creates records. Broker writes
// each record under a reference derived from the operation id, so a save never
// changes a record already in the bank.
describe("fresh references per save (B1)", () => {
  const LINKED = {
    questionRecords: [
      { type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: "Q0" } },
      { type: "mcq", reference: "q-1", data: { type: "mcq", stimulus: "Q1" } },
    ],
    itemRecords: [{
      reference: "item-0",
      definition: { widgets: [{ reference: "q-0" }, { reference: "q-1" }] },
      questions: [{ reference: "q-0" }, { reference: "q-1" }],
      status: "unpublished",
    }],
  };
  const save = async ({ payload = LINKED, idempotencyKey = "job-1" }: { payload?: any, idempotencyKey?: string } = {}) =>
    broker.execute({ caller: L0176, token: await saveToken({ payload, idempotencyKey }), op: "learnosity.write-items", payload });
  const opidOf = () => records.filter(r => r.event === "execute" && r.opid).map(r => r.opid).at(-1);
  const sentRefs = () => {
    const [questions, items] = sent;
    const item = items.body.items[0];
    return {
      questions: questions.body.questions.map(q => q.reference),
      item: item.reference,
      widgets: item.definition.widgets.map(w => w.reference),
      links: item.questions.map(w => w.reference),
    };
  };

  it("maps once: the records, the item's links, the evidence and the returned references all agree", async () => {
    const out = await save();
    expect(out.status).toBe("succeeded");
    const opid = opidOf();
    const tag = `${REFERENCE_PREFIX}${referenceTag(opid)}-`;
    const refs = sentRefs();
    expect(refs).toEqual({
      questions: [`${tag}q-0`, `${tag}q-1`],
      item: `${tag}item-0`,
      widgets: [`${tag}q-0`, `${tag}q-1`],
      links: [`${tag}q-0`, `${tag}q-1`],
    });
    const { evidence } = (await receipts.claim(opid, {})).claim;
    expect(evidence.records.map(r => r.reference)).toEqual([...refs.questions, refs.item]);
    expect(out.result).toEqual({ saved: true, references: [refs.item], questionReferences: refs.questions });
    // Nothing is written under a reference the program sent.
    const all = sent.flatMap(({ body }) => [...(body.questions ?? []), ...(body.items ?? [])]).map(r => r.reference);
    expect(all.filter(r => ["q-0", "q-1", "item-0"].includes(r))).toEqual([]);
    // The content is the program's: only references (and the mark) change.
    expect(sent[0].body.questions[0].data).toEqual({ ...LINKED.questionRecords[0].data, metadata: { [MARK_KEY]: opid } });
  });

  it("reproduces the same references for a retry of the same operation, which replays its receipt", async () => {
    const first = await save();
    const retry = await save();
    expect(retry).toMatchObject({ status: "succeeded", replayed: true });
    expect(retry.result).toEqual(first.result);
    expect(routes).toHaveLength(2);
  });

  it("writes new references for a new invocation of the same program", async () => {
    const first = await save({ idempotencyKey: "job-1" });
    const second = await save({ idempotencyKey: "job-2" });
    expect(second.replayed).toBeUndefined();
    expect(second.result.references[0]).not.toBe(first.result.references[0]);
    const firstQuestions = new Set(first.result.questionReferences);
    expect(second.result.questionReferences.some(r => firstQuestions.has(r))).toBe(false);
  });

  it("is deterministic in the operation id and the payload alone", () => {
    expect(providerReferences(LINKED, "inv-1/s0/n1.0")).toEqual(providerReferences(structuredClone(LINKED), "inv-1/s0/n1.0"));
    expect(providerReferences(LINKED, "inv-1/s0/n1.0")).not.toEqual(providerReferences(LINKED, "inv-2/s0/n1.0"));
    // The payload itself is left as it was: its args digest still binds.
    const before = structuredClone(LINKED);
    providerReferences(LINKED, "inv-1/s0/n1.0");
    expect(LINKED).toEqual(before);
  });

  it("refuses an item linking to a question the save doesn't write", async () => {
    for (const where of ["widgets", "questions"]) {
      const payload = structuredClone(LINKED);
      if (where === "widgets") payload.itemRecords[0].definition.widgets.push({ reference: "someone-elses-question" });
      else payload.itemRecords[0].questions.push({ reference: "someone-elses-question" });
      const e = await save({ payload }).catch(err => err);
      expect(e).toBeInstanceOf(BrokerRefused);
      expect(e.reason).toBe("payload-rejected");
    }
    expect(routes).toEqual([]);
  });

  it("refuses a link with fields other than its reference, and a reference too long to map", async () => {
    const extra = structuredClone(LINKED);
    extra.itemRecords[0].definition.widgets[0] = { reference: "q-0", widget_type: "response" } as any;
    const long = structuredClone(LINKED);
    long.questionRecords[0].reference = "q".repeat(MAX_SENT_REFERENCE_LENGTH + 1);
    for (const payload of [extra, long]) {
      const e = await save({ payload }).catch(err => err);
      expect(e?.reason).toBe("payload-rejected");
    }
    expect(MAX_SENT_REFERENCE_LENGTH + REFERENCE_PREFIX.length + 17).toBe(250);
    expect(routes).toEqual([]);
  });

  it("keeps a question-only save to fresh references too", async () => {
    const payload = { questionRecords: LINKED.questionRecords, itemRecords: [] };
    const out = await save({ payload });
    const tag = `${REFERENCE_PREFIX}${referenceTag(opidOf())}-`;
    expect(sent[0].body.questions.map(q => q.reference)).toEqual([`${tag}q-0`, `${tag}q-1`]);
    expect(out.result.references).toEqual([`${tag}q-0`, `${tag}q-1`]);
  });

  it("writes nothing from a payload that reached the operation unmapped", async () => {
    const ops = buildOps();
    const calls = [];
    const providerCall = async step => { calls.push(step); return 1000; };
    await expect(ops["learnosity.write-items"].run(LINKED, { key: "k", secret: SECRET }, { onStep: async () => {}, providerCall, operationId: "inv-1/s0/n1.0" }))
      .rejects.toThrow("must carry its operation's references");
    expect(calls).toEqual([]);
  });

  it("won't build without a write operation's mapping", () => {
    const ops = buildOps();
    const { references: _r, ...unmapped } = ops["learnosity.write-items"];
    expect(() => createBroker({ ...brokerDeps, operations: { ...ops, "learnosity.write-items": unmapped } })).toThrow("needs a references mapping");
  });
});

describe("item-bank writes", () => {
  // The steps Broker reports are the registry's dispatch steps, in order
  // (registry v6; W2 authorizes each one).
  it("takes only registered steps, in registered order", async () => {
    const out = await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    const dispatch = (operationSteps("learnosity.write-items") ?? []).filter(s => s.purpose === "dispatch").map(s => s.id);
    expect(out.steps).toEqual(dispatch);
    out.steps.forEach((step, i) => {
      expect(isStepRegistered({ op: "learnosity.write-items", step, purpose: "dispatch", after: i ? out.steps[i - 1] : null })).toBe(true);
    });
  });

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
    await broker.execute({ caller: L0176, token: await saveToken({ occurrenceId: "n1.0" }), op: "learnosity.write-items", payload: WRITE });
    await broker.execute({ caller: L0176, token: await saveToken({ occurrenceId: "n1.1" }), op: "learnosity.write-items", payload: WRITE });
    expect(routes).toHaveLength(4);
  });

  it("reports a failure after the first write as partial, and never re-runs it", async () => {
    failItems = true;
    const first = await broker.execute({ caller: L0176, token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    expect(first).toMatchObject({ status: "partial", steps: ["questions"], reason: "provider-rejected", category: "malformed" });
    expect(records.at(-1)).toMatchObject({ outcome: "partial", reason: "provider-rejected", category: "malformed" });
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
    expect(out).toEqual({ status: "uncertain", steps: [], replayed: true });
    expect(routes).toEqual([]);
  });

  it("reports the persisted steps of an attempt that stopped between steps", async () => {
    const token = await saveToken();
    const { invocationId } = await invocation();
    await receipts.claim(`${invocationId}/s0/n1.0`, recordedBinding());
    await receipts.putStep(`${invocationId}/s0/n1.0`, 0, "questions");
    const out = await broker.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE });
    expect(out).toEqual({ status: "uncertain", steps: ["questions"], replayed: true });
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

// WRITE-01: each provider step is durable before the next provider request,
// and a storage failure at any point stops the operation without ever
// repeating a write.
describe("durable steps", () => {
  // The memory receipt store with faults injected, recording each persisted
  // step into the same log as the provider requests.
  type Fault = (...args: any[]) => Promise<any>;
  const faulty = ({ claim, putStep, putOutcome }: { claim?: Fault, putStep?: Fault, putOutcome?: Fault } = {}) => ({
    ...receipts,
    claim: claim ?? receipts.claim,
    putStep: putStep ?? (async (id, n, step) => {
      await receipts.putStep(id, n, step);
      routes.push(`persisted:${step}`);
    }),
    putOutcome: putOutcome ?? receipts.putOutcome,
  });
  const save = async (b, token?: string) => b.execute({ caller: L0176, token: token ?? await saveToken(), op: "learnosity.write-items", payload: WRITE });
  const opid = async () => `${(await invocation()).invocationId}/s0/n1.0`;
  const fail = async () => { throw new Error("storage unavailable"); };

  it("persists each step before making the next provider request", async () => {
    const out = await save(createBroker({ ...brokerDeps, receipts: faulty() }));
    expect(out).toMatchObject({ status: "succeeded", steps: ["questions", "items"] });
    expect(routes).toEqual(["/itembank/questions", "persisted:questions", "/itembank/items", "persisted:items"]);
    expect(await receipts.getSteps(await opid())).toEqual(["questions", "items"]);
  });

  it("makes no provider request when the receipt claim cannot be created", async () => {
    await expect(save(createBroker({ ...brokerDeps, receipts: faulty({ claim: fail }) }))).rejects.toThrow(/storage unavailable/);
    expect(routes).toEqual([]);
  });

  it("stops, and records uncertain, when a completed step cannot be persisted", async () => {
    const out = await save(createBroker({ ...brokerDeps, receipts: faulty({ putStep: fail }) }));
    expect(out).toMatchObject({ status: "uncertain", steps: ["questions"], reason: "step-not-persisted", category: "unavailable" });
    expect(records.at(-1)).toMatchObject({ outcome: "uncertain", reason: "step-not-persisted", category: "unavailable" });
    expect(out.error).toMatch(/could not be recorded/);
    expect(routes).toEqual(["/itembank/questions"]);
    const retry = await save(broker);
    expect(retry).toMatchObject({ status: "uncertain", steps: ["questions"], replayed: true });
    expect(routes).toEqual(["/itembank/questions"]);
  });

  it("never re-executes when neither the step nor the outcome can be persisted", async () => {
    const out = await save(createBroker({ ...brokerDeps, receipts: faulty({ putStep: fail, putOutcome: fail }) }));
    expect(out).toMatchObject({ status: "uncertain", steps: ["questions"] });
    const retry = await save(broker);
    expect(retry).toEqual({ status: "uncertain", steps: [], replayed: true });
    expect(routes).toEqual(["/itembank/questions"]);
  });

  it("returns the result when only the outcome cannot be persisted, and a replay reports uncertain with the steps", async () => {
    const out = await save(createBroker({ ...brokerDeps, receipts: faulty({ putOutcome: fail }) }));
    expect(out).toMatchObject({ status: "succeeded", steps: ["questions", "items"] });
    expect(records.at(-1)).toMatchObject({ outcome: "allowed", reason: "outcome-not-recorded" });
    const retry = await save(broker);
    expect(retry).toEqual({ status: "uncertain", steps: ["questions", "items"], replayed: true });
    expect(routes.filter(r => r.startsWith("/"))).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("acknowledges an identical step record and refuses a different one", async () => {
    const id = await opid();
    await receipts.putStep(id, 0, "questions");
    await expect(receipts.putStep(id, 0, "questions")).resolves.toBeUndefined();
    await expect(receipts.putStep(id, 0, "items")).rejects.toBeInstanceOf(StepConflict);
    await expect(receipts.putStep(id, -1, "items")).rejects.toThrow(/index/);
    expect(await receipts.getSteps(id)).toEqual(["questions"]);
  });
});

// Registry v7 (AUTHOR-01, closed by removal): Broker has no Author operation,
// so even a validly signed token naming one is refused before any signing.
describe("no Author signing", () => {
  it("has no Author operation to build", () => {
    expect(Object.keys(buildOps()).sort()).toEqual(["learnosity.sign-items-preview", "learnosity.sign-questions-preview", "learnosity.write-items"]);
  });

  it("refuses a validly signed token for Author, and signs nothing", async () => {
    const payload = { reference: "graffiticode-t-0" };
    const token = await issueToken(signer, "execution", {
      sub: OWNER,
      own: OWNER,
      conn: "conn-1",
      backend: "learnosity",
      lang: "0176",
      fn: "author",
      op: "learnosity.sign-author",
      sid: "sid-1",
      opid: "inv-1/s0/n1",
      argd: argsDigest(payload),
      rv: REGISTRY_VERSION,
      prv: "user"
    });
    await refused(broker.execute({ caller: L0176, token, op: "learnosity.sign-author", payload }), "operation-mismatch");
    expect(records.at(-1)).toMatchObject({ outcome: "denied", reason: "operation-mismatch" });
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

  it("cannot be built without Policy's authorization, or with incomplete limits", () => {
    const { authorize, ...rest } = brokerDeps;
    expect(() => createBroker(rest)).toThrow(/authorize/);
    expect(() => createBroker({ ...brokerDeps, limits: { providerCallMs: 10_000, executionMs: 30_000 } })).toThrow(/limits.authorizeMs/);
    expect(() => createBroker({ ...brokerDeps, limits: { providerCallMs: 10_000, executionMs: 0, authorizeMs: 5_000 } })).toThrow(/limits.executionMs/);
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
    const out = await save(timed({ providerCallMs: 10_000, executionMs: 12_000, authorizeMs: 5_000 }));
    expect(out.status).toBe("succeeded");
    expect(providerCalls.map(c => c.timeoutMs)).toEqual([10_000, 5_000]);
  });

  it("starts no request after the deadline: the write stops as partial, and a retry replays it", async () => {
    onProviderCall = route => { if (route === "/itembank/questions") t += 30_000; };
    const out = await save(timed({ providerCallMs: 10_000, executionMs: 30_000, authorizeMs: 5_000 }));
    expect(out).toMatchObject({ status: "partial", steps: ["questions"] });
    expect(out.error).toMatch(/deadline/);
    expect(routes).toEqual(["/itembank/questions"]);
    const retry = await save(broker);
    expect(retry).toMatchObject({ status: "partial", replayed: true });
    expect(routes).toEqual(["/itembank/questions"]);
  });

  it("records failed when the deadline passes before any request", async () => {
    const b = createBroker({ ...brokerDeps, limits: { providerCallMs: 1, executionMs: 1, authorizeMs: 1 }, now: () => (t += 5) });
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
    let release: (value?: unknown) => void = () => {};
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

  // Review: registration slower than any grace period. The switch flips off
  // while the write is registering; the post-registration read (past a cache
  // that would still say "on") refuses it before any provider request.
  it("refuses a write whose registration completes after the switch went off, whatever the cache says", async () => {
    let on = true;
    const sw = createProtectedSwitch({ cacheMs: 60_000, readFlag: async () => ({ enabled: on }) });
    await sw.state();
    const slowActivity = { ...activity, begin: async (...a) => { on = false; await activity.begin(...a); } };
    const b = createBroker({ ...brokerDeps, protectedSwitch: sw, activity: slowActivity });
    const token = await saveToken();
    await refused(b.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE }), "maintenance");
    expect(routes).toEqual([]);
    expect(await activity.count()).toBe(0);
    on = true;
    const again = createBroker({ ...brokerDeps, protectedSwitch: createProtectedSwitch({ cacheMs: 0, readFlag: async () => ({ enabled: on }) }) });
    await expect(again.execute({ caller: L0176, token, op: "learnosity.write-items", payload: WRITE })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("cannot be built without an activity store", () => {
    const { activity: _activity, ...rest } = brokerDeps;
    expect(() => createBroker(rest)).toThrow(/activity/);
  });
});
