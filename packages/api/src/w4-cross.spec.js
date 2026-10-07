/* eslint-disable camelcase -- Learnosity and Google ID-token fields are snake_case */
// Chain admission across the services (capability plan W4, PR 7a; spec AT-03,
// AT-04, AT-07, AT-08). Policy and Broker run as real HTTP servers; the
// gateway's data path uses its real admission client, which preflights
// compiler stand-ins over HTTP, one server per compiler revision. A stand-in
// does what @graffiticode/l0000 0.10 does under a plan: it computes its own
// manifest, presents it with the admission token at Policy's snapshot, checks
// the binding Policy signed, and only then mints and executes at Broker.
// Every refusal is checked for zero effects: no snapshot, no mint, no compile
// and no provider request.
import http from "node:http";
import { generateKeyPair, exportJWK } from "jose";
import { canonicalDigest } from "@graffiticode/common/canonical";
import {
  createPolicy, createPolicyApp, createConnectionManager, createCallerIdentity, createLocalSigner,
  createMemoryConnectionStore, createMemoryInvocationStore, createMemoryLeaseFence, createMemoryApprovals,
  createMemoryPublicationStore, createMemoryGrantStore, createAudit, createPseudonymizer, createProtectedSwitch,
  verifyToken
} from "@graffiticode/policy";
import { buildPolicyRequest } from "@graffiticode/policy/client";
import {
  createBroker, createBrokerApp, buildOperations, createMemoryOnceStore, createMemoryReceiptStore,
  createMemoryActivityStore, createMemorySecretStore, buildPolicyAuthorizer, argsDigest
} from "@graffiticode/broker";
import { buildDataApi } from "./data.js";
import { buildAllocateInvocation } from "./invocations.js";
import { buildChainAdmission } from "./admission.js";
import { createApiAudit } from "./audit.js";
import { buildMemoryArtifactStorer } from "./storage/artifacts.js";
import { createStorers } from "./storage/index.js";
import { clearFirestore } from "./testing/firestore.js";

const OWNER = "0xowner0000000000000000000000000000000001";
const SA = {
  gateway: "api-run@graffiticode.iam.gserviceaccount.com",
  compiler: "l0176-run@graffiticode.iam.gserviceaccount.com",
  broker: "broker-run@graffiticode.iam.gserviceaccount.com",
};
const b64 = v => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const idTokenFor = account => async audience => (audience.startsWith("urn:") ? `idt|${account}|${audience}` : `${b64("{}")}.${b64({ email: account })}.`);
const verifyIdToken = async (token, audience) => {
  const [kind, email, aud] = token.split("|");
  if (kind !== "idt" || aud !== audience) throw new Error("bad token");
  return { iss: "https://accounts.google.com", email, email_verified: true, aud };
};
const verifyUser = async token => { if (!token.startsWith("user:")) throw new Error("bad user token"); return { uid: token.slice(5) }; };

const openServers = [];
const listen = handler => new Promise(resolve => {
  const server = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`));
  openServers.push(server);
});
afterEach(async () => {
  const servers = openServers.splice(0);
  await Promise.all(servers.map(s => new Promise(resolve => { s.closeAllConnections?.(); s.close(() => resolve()); })));
});
const readJson = req => new Promise(resolve => { let s = ""; req.on("data", d => { s += d; }); req.on("end", () => resolve(s ? JSON.parse(s) : {})); });

const WRITE_OP = "learnosity.write-items";
const SIGN_OP = "learnosity.sign-items-preview";
const AUTHOR_OP = "learnosity.sign-author";
const PAYLOAD = {
  questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: "?", options: [{ label: "A", value: "0" }], validation: { valid_response: { score: 1, value: ["0"] } } } }],
  itemRecords: [{ reference: "item-0", status: "unpublished", definition: { widgets: [{ reference: "q-0" }] }, questions: [{ reference: "q-0" }] }]
};
const PREVIEW = { id: "p", questions: [{ type: "mcq", response_id: "r1" }] };
// A stand-in program's kind is its one string. What each requires, as L0176's
// preflight declares it (an Author activity arriving as data needs `author`).
const REQUIRED = { save: ["init", "save-to-itembank"], preview: ["init"], "author-from-data": ["author", "init"] };
const programOf = kind => ({ 1: { tag: "STR", elts: [kind] }, 2: { tag: "EXPRS", elts: [1] }, root: 2 });
const kindOf = code => code?.[1]?.elts?.[0];

let w;

beforeEach(async () => {
  await clearFirestore();
  const counts = { preflights: 0, compiles: 0, provider: [] };
  const pseudonymize = createPseudonymizer({ secret: "test-secret-0123456789" });
  const records = [];
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const on = createProtectedSwitch({ cacheMs: 0, readFlag: async () => ({ enabled: true }) });
  const connections = createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]);
  const leases = new Map();
  const invocations = createMemoryInvocationStore({ leases });
  const approvals = createMemoryApprovals(new Map());
  const audit = createAudit({ sink: r => records.push(r), pseudonymize });
  const policy = createPolicy({
    protectedSwitch: on,
    signer,
    jwks,
    connections,
    grants: createMemoryGrantStore(),
    publications: createMemoryPublicationStore(),
    invocations,
    approvals,
    fence: createMemoryLeaseFence({ leases }),
    audit,
  });
  const callers = { [SA.gateway]: { role: "gateway" }, [SA.compiler]: { role: "compiler", lang: "0176" }, [SA.broker]: { role: "broker" } };
  const policyUrl = await listen(createPolicyApp({
    policy,
    verifyUser,
    publicJwks: jwks,
    audit,
    manager: createConnectionManager({ connections, grants: createMemoryGrantStore(), audit, brokerAdmin: {} }),
    identifyCaller: createCallerIdentity({ verifyIdToken, audience: "urn:graffiticode:policy", callers }),
  }));
  const brokerUrl = await listen(createBrokerApp({
    broker: createBroker({
      protectedSwitch: on,
      jwks,
      audit,
      operations: buildOperations({
        sdk: { init: (service, consumer, secret, body) => ({ service, signature: "sig", body }) },
        domain: "d",
        dataApi: async ({ route }) => { counts.provider.push(route); return { meta: { status: true } }; },
      }),
      secrets: createMemorySecretStore({ "conn-1": { ownerUid: OWNER, backend: "learnosity", key: "k", secret: "s" } }),
      once: createMemoryOnceStore(),
      receipts: createMemoryReceiptStore(),
      activity: createMemoryActivityStore(),
      authorize: buildPolicyAuthorizer({ policyUrl, idToken: idTokenFor(SA.broker) }),
    }),
    secrets: null,
    audit,
    identifyCaller: createCallerIdentity({ verifyIdToken, audience: "urn:graffiticode:broker", callers: { [SA.compiler]: { role: "compiler", lang: "0176" } } }),
  }));

  // Compiler revisions: each serves /preflight for the gateway, and runs the
  // stage's compile when the gateway routes to its tag URL. `report` lets a
  // test make a revision describe itself as another.
  const asCompiler = buildPolicyRequest({ policyUrl, idToken: idTokenFor(SA.compiler) });
  const revisions = new Map();
  const manifestFrom = (rev, code, stage) => ({
    stage,
    lang: "0176",
    sourceDigest: canonicalDigest(code),
    programDigest: canonicalDigest({ kind: kindOf(code), lowered: true }),
    optionsDigest: canonicalDigest({}),
    revision: rev.report?.revision ?? rev.revision,
    imageDigest: rev.imageDigest,
    registryVersion: 6,
    requiredFunctions: REQUIRED[kindOf(code)] ?? ["init"],
  });
  const startRevision = async (name, { approved = true } = {}) => {
    const rev = { revision: `l0176-${name}`, imageDigest: `sha256:${canonicalDigest(name)}`, url: null, report: null, down: false };
    rev.url = await listen(async (req, res) => {
      const body = await readJson(req);
      const reply = (status, json) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
      if (rev.down) return reply(503, { status: "error", error: { reason: "unavailable" } });
      if (req.url !== "/preflight") return reply(404, {});
      if (req.headers["x-caller-identity"] !== `idt|${SA.gateway}|urn:graffiticode:0176`) return reply(401, { status: "error", error: { reason: "caller-rejected" } });
      counts.preflights += 1;
      return reply(200, { status: "success", data: { manifest: manifestFrom(rev, body.code, body.stage) } });
    });
    revisions.set(rev.url, rev);
    if (approved) {
      approvals.records.set(`0176/${rev.revision}`, { lang: "0176", revision: rev.revision, imageDigest: rev.imageDigest, tag: name, tagUrl: rev.url, status: "approved", contractVersions: [1, 2] });
    }
    return rev;
  };
  const serving = { rev: await startRevision("ra") };

  // The gateway's compile of one stage at the revision it was routed to.
  const execute = async (executionToken, op, payload) => {
    const t = idTokenFor(SA.compiler);
    const res = await fetch(`${brokerUrl}/v1/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${executionToken}`, "X-Caller-Identity": await t("urn:graffiticode:broker"), "X-Serverless-Authorization": `Bearer ${await t(brokerUrl)}` },
      body: JSON.stringify({ op, payload }),
    });
    return { status: res.status, body: /** @type {any} */ (await res.json()) };
  };
  const compile = async ({ code, data, auth, connectionId, invocationToken, stage, admissionToken = null, baseUrl = null }) => {
    counts.compiles += 1;
    const rev = baseUrl ? revisions.get(baseUrl) : serving.rev;
    const manifest = manifestFrom(rev, code, stage);
    const fail = (message, effects = []) => ({ errors: [{ message }], effects, revision: rev.revision });
    const snap = /** @type {any} */ (await asCompiler("POST", "/v1/snapshot", {
      authToken: auth, body: { lang: "0176", connectionId, fns: manifest.requiredFunctions, invocationToken, stage, ...(admissionToken ? { admissionToken, manifest } : {}) },
    }).catch(e => ({ refused: e })));
    if (snap.refused) return fail(`refused: ${snap.refused.reason}`);
    if (snap.status !== 200) return fail(`snapshot failed: ${snap.body?.error?.reason}`);
    // The binding check: the session must be policy's, and pin this manifest.
    const { claims } = await verifyToken(jwks, "session", snap.body.data.sessionToken);
    const { stage: _s, registryVersion: _r, ...own } = manifest;
    if (admissionToken && canonicalDigest(claims.bind) !== canonicalDigest({ ...own, requiredFunctions: [...own.requiredFunctions].sort() })) return fail("not the pinned compiler");
    const kind = kindOf(code);
    const [fn, op, payload] = kind === "save" ? ["save-to-itembank", WRITE_OP, PAYLOAD] : kind === "author-from-data" ? ["author", AUTHOR_OP, { reference: "r" }] : ["init", SIGN_OP, PREVIEW];
    const mint = /** @type {any} */ (await asCompiler("POST", "/v1/mint", { body: { sessionToken: snap.body.data.sessionToken, fn, op, occurrenceId: "n1.0", argsDigest: argsDigest(payload) } }).catch(e => ({ refused: e })));
    if (mint.refused || mint.status !== 200) return fail(`mint refused: ${mint.refused?.reason ?? mint.body?.error?.reason}`, [{ fn, op, status: "failed", steps: [] }]);
    const out = await execute(mint.body.data.executionToken, op, payload);
    const effect = out.status === 200 ? { fn, op, status: out.body.data.status, steps: out.body.data.steps ?? [], ...(out.body.data.replayed ? { replayed: true } : {}) } : { fn, op, status: "failed", steps: [] };
    if (effect.status !== "succeeded") return fail(`${op} ${effect.status}`, [effect]);
    return { data: { ...data, [stage]: kind }, errors: [], ...(fn === "save-to-itembank" ? { effects: [effect] } : {}), revision: rev.revision };
  };

  const { taskStorer, compileStorer } = createStorers();
  const gatewayFor = ({ artifactStorer = buildMemoryArtifactStorer() } = {}) => buildDataApi(/** @type {any} */ ({
    compile,
    allocateInvocation: buildAllocateInvocation({ policyUrl, idToken: idTokenFor(SA.gateway) }),
    artifactStorer,
    audit: createApiAudit({ sink: r => records.push({ service: "api", ...r }) }),
    chainAdmission: buildChainAdmission({ policyUrl, idToken: idTokenFor(SA.gateway), baseUrlFor: async () => serving.rev.url }),
    admissionWanted: () => true,
  }));
  // s0 (leftmost, runs last) and s1 (runs first).
  const chain = async (s0, s1) => taskStorer.appendIds(
    await taskStorer.create(/** @type {any} */ ({ task: { lang: "0176", code: programOf(s0) } })),
    await taskStorer.create(/** @type {any} */ ({ task: { lang: "0176", code: programOf(s1) } })),
  );
  w = { policy, approvals, connections, counts, records, serving, startRevision, chain, gatewayFor, taskStorer, compileStorer };
});

const run = (id, { gateway = w.gatewayFor(), key = "job-1", uid = OWNER } = {}) =>
  gateway.get({ taskStorer: w.taskStorer, compileStorer: w.compileStorer, id, auth: { uid }, authToken: `user:${uid}`, connectionId: "conn-1", idempotencyKey: key });
const snapshots = () => w.records.filter(r => r.event === "snapshot" && r.outcome === "allowed").length;
const mints = () => w.records.filter(r => r.event === "mint" && r.outcome === "allowed").length;
const expectZeroEffects = () => {
  expect(w.counts.compiles).toBe(0);
  expect(snapshots()).toBe(0);
  expect(mints()).toBe(0);
  expect(w.counts.provider).toEqual([]);
};

describe("AT-03: one decision for the chain, before anything runs", () => {
  it("admits a chain whose stages are all granted, then runs it: the save happens once", async () => {
    const out = await run(await w.chain("preview", "save"));
    expect(out.errors).toEqual([]);
    expect(w.counts.preflights).toBe(2);
    expect(w.counts.provider).toEqual(["/itembank/questions", "/itembank/items"]);
    expect(w.records.filter(r => r.event === "admission" && r.outcome === "allowed")).toHaveLength(1);
  });

  it("denies the final stage when the first would save: zero transformations, signatures and provider requests", async () => {
    // s1 saves first; s0, the final stage, would sign an Author activity
    // arriving as data. Author is off, so the whole chain is refused.
    const out = await run(await w.chain("author-from-data", "save"));
    expect(out.errors[0]).toMatchObject({ code: "fn-not-enabled", category: "permission" });
    expect(w.counts.preflights).toBe(2);
    expectZeroEffects();
    // Policy decided it; the gateway records the refusal it passed on.
    expect(w.records.filter(r => r.event === "admission" && r.outcome === "denied" && !r.service)).toEqual([expect.objectContaining({ reason: "fn-not-enabled", callerRole: "gateway" })]);
    expect(w.records.filter(r => r.event === "admission" && r.service === "api")).toEqual([expect.objectContaining({ outcome: "denied", reason: "fn-not-enabled" })]);
  });

  it("an unavailable preflight blocks the chain, as does a compiler revision that isn't approved", async () => {
    w.serving.rev.down = true;
    const down = await run(await w.chain("preview", "save"), { key: "job-down" });
    expect(down.errors[0]).toMatchObject({ code: "preflight-unavailable" });
    w.serving.rev.down = false;
    w.serving.rev = await w.startRevision("rogue", { approved: false });
    const rogue = await run(await w.chain("preview", "save"), { key: "job-rogue" });
    expect(rogue.errors[0]).toMatchObject({ code: "revision-not-approved" });
    expectZeroEffects();
  });
});

describe("AT-04: what changes after admission is refused", () => {
  it("a revision that starts describing itself as an unapproved one is refused at admission, and nothing more runs", async () => {
    const id = await w.chain("preview", "save");
    // Admit on ra, then ra starts describing itself as another revision.
    const gateway = w.gatewayFor();
    const rev = w.serving.rev;
    const preflight = await run(id, { gateway, key: "job-x" });
    expect(preflight.errors).toEqual([]);
    const before = w.counts.provider.length;
    rev.report = { revision: "l0176-elsewhere" };
    const after = await run(id, { gateway, key: "job-y" });
    // A fresh invocation preflights the changed report, which isn't approved.
    expect(after.errors[0]).toMatchObject({ code: "revision-not-approved" });
    expect(w.counts.provider.length).toBe(before);
  });

  it("a plan pinned to one revision can't run at another: the stage's own manifest no longer matches", async () => {
    const id = await w.chain("preview", "save");
    await run(id, { key: "job-1" });
    const writes = w.counts.provider.length;
    // The pinned tag now routes to a revision that reports itself as itself.
    const pinned = w.serving.rev;
    pinned.report = { revision: "l0176-swapped" };
    w.approvals.records.set("0176/l0176-swapped", { ...w.approvals.records.get("0176/l0176-ra"), revision: "l0176-swapped" });
    const retry = await run(id, { key: "job-1" });
    expect(retry.errors[0].code).toMatch(/plan-mismatch|plan-binding-mismatch/);
    expect(w.counts.provider.length).toBe(writes);
  });
});

describe("AT-07: retries keep their first plan", () => {
  it("a deploy between attempts doesn't change what a retry runs: it preflights the pinned revision and replays", async () => {
    const id = await w.chain("preview", "save");
    expect((await run(id)).errors).toEqual([]);
    const writes = [...w.counts.provider];
    const pinned = w.serving.rev;
    // A new revision is deployed and serves now.
    w.serving.rev = await w.startRevision("rb");
    const retry = await run(id);
    expect(retry.errors).toEqual([]);
    // The retry's preflights went to the pinned revision, and its save replayed.
    const admissions = w.records.filter(r => r.event === "admission" && r.outcome === "allowed");
    expect(admissions.map(r => r.reason)).toEqual(["new", "reused"]);
    expect(w.counts.provider).toEqual(writes);
    expect(retry.effects).toEqual([expect.objectContaining({ fn: "save-to-itembank", status: "succeeded", replayed: true })]);
    expect(pinned.url).not.toBe(w.serving.rev.url);
  });

  it("a retry after the owner narrowed their permissions is refused at admission, and replays nothing", async () => {
    const id = await w.chain("preview", "save");
    await run(id);
    const writes = w.counts.provider.length;
    await w.connections.put({ ...(await w.connections.get("conn-1")), ownerPermissions: [{ lang: "0176", fn: "init" }] });
    const retry = await run(id);
    expect(retry.errors[0]).toMatchObject({ code: "not-granted" });
    expect(w.counts.provider.length).toBe(writes);
  });

  it("a key reused with a different chain is refused before anything is preflighted", async () => {
    await run(await w.chain("preview", "save"), { key: "job-k" });
    const preflights = w.counts.preflights;
    const other = await run(await w.chain("save", "preview"), { key: "job-k" });
    expect(other.errors[0]).toMatchObject({ code: "idempotency-key-reused" });
    expect(w.counts.preflights).toBe(preflights);
  });
});

describe("AT-08: recovery", () => {
  it("recovers a write whose artifact wasn't stored with the same plan, writing nothing again", async () => {
    const id = await w.chain("preview", "save");
    const broken = w.gatewayFor({ artifactStorer: /** @type {any} */ ({ put: async () => { throw new Error("storage down"); } }) });
    const first = await run(id, { gateway: broken });
    expect(first.artifact).toMatchObject({ stored: false, error: "artifact-storage-unavailable", retryable: true });
    const writes = [...w.counts.provider];
    const recovered = await run(id);
    expect(recovered.errors).toEqual([]);
    expect(recovered.artifact).toBeUndefined();
    expect(w.counts.provider).toEqual(writes);
  });

  it("can't recover against a revision retired since: pinned-revision-unavailable, nothing runs", async () => {
    const id = await w.chain("preview", "save");
    await run(id);
    const writes = w.counts.provider.length;
    const compiles = w.counts.compiles;
    const record = w.approvals.records.get("0176/l0176-ra");
    w.approvals.records.set("0176/l0176-ra", { ...record, status: "retired" });
    const retry = await run(id);
    expect(retry.errors[0]).toMatchObject({ code: "pinned-revision-unavailable" });
    expect(retry.errors[0].message).toMatch(/may repeat its writes/);
    expect(w.counts.provider.length).toBe(writes);
    expect(w.counts.compiles).toBe(compiles);
  });
});
