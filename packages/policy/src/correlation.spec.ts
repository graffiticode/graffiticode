// Audit correlation and values in Policy (W3 PR 2; spec AUDIT-01): one
// compile is traceable from its invocation to each execution decision, by
// ids taken only from verified tokens; refusals before allocation or token
// verification carry only what was verified; values a refused request
// supplies are recorded as "invalid" unless the registry knows them.
import { generateKeyPair, exportJWK } from "jose";
import { createHash } from "node:crypto";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import {
  createPolicy,
  PolicyDenied,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch,
  issueToken
} from "./index.js";

const OWNER = "0xowneruid";
const GATEWAY = { role: "gateway" };
const L0176 = { role: "compiler", lang: "0176" };
const BROKER = { role: "broker" };
const ARGD = "a".repeat(64);
const WRITE = "learnosity.write-items";

let policy;
let signer;
let records;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  records = [];
  policy = createPolicy({
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    signer,
    jwks,
    connections: createMemoryConnectionStore([
      { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" },
      { connectionId: "conn-sys", ownerUid: "0xsystem", backend: "learnosity", status: "active" },
    ]),
    invocations: createMemoryInvocationStore(),
    publications: createMemoryPublicationStore(),
    systemConnections: { learnosity: "conn-sys" },
    audit: createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) }),
  });
});

const ofEvent = event => records.filter(r => r.event === event);
const denied = promise => promise.then(() => { throw new Error("expected a denial"); }, e => { if (!(e instanceof PolicyDenied)) throw e; });

// One compile through the connection, as the gateway and L0176 make it.
const compileOnce = async () => {
  const { invocationToken, invocationId } = await policy.allocateInvocation({
    caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: "task-1", inputDigest: createHash("sha256").update("x").digest("hex"),
  });
  const { sessionToken } = await policy.snapshot({ caller: L0176, user: { uid: OWNER }, lang: "0176", connectionId: "conn-1", fns: ["save-to-itembank"], invocationToken, stage: "s0" });
  const { executionToken, operationId } = await policy.mint({ caller: L0176, sessionToken, fn: "save-to-itembank", op: WRITE, occurrenceId: "n1.0", argsDigest: ARGD });
  return { invocationId, executionToken, operationId };
};

describe("correlation (spec AUDIT-01)", () => {
  it("traces one compile from its invocation to each decision, with verified callers", async () => {
    const { invocationId, executionToken, operationId } = await compileOnce();
    await policy.authorizeExecution({ caller: BROKER, executionToken, op: WRITE, argsDigest: ARGD, step: "questions", purpose: "dispatch", after: null });
    await policy.authorizeExecution({ caller: BROKER, executionToken, op: WRITE, argsDigest: ARGD, step: "items", purpose: "dispatch", after: "questions" });
    expect(ofEvent("invocation")).toEqual([expect.objectContaining({ outcome: "allowed", invocationId, callerRole: "gateway" })]);
    expect(ofEvent("snapshot")).toEqual([expect.objectContaining({ outcome: "allowed", invocationId, stage: "s0", callerRole: "compiler" })]);
    expect(ofEvent("mint")).toEqual([expect.objectContaining({ outcome: "allowed", invocationId, stage: "s0", opid: operationId, callerRole: "compiler" })]);
    const decisions = ofEvent("authorize-execution");
    expect(decisions.map(r => [r.step, r.invocationId, r.stage, r.opid, r.callerRole])).toEqual([
      ["questions", invocationId, "s0", operationId, "broker"],
      ["items", invocationId, "s0", operationId, "broker"],
    ]);
    expect(new Set(decisions.map(r => r.decisionId)).size).toBe(2);
  });

  it("names a system preview's own session id, with no gateway invocation", async () => {
    await policy.previewSession({ caller: L0176, lang: "0176" });
    const [record] = ofEvent("preview-session");
    expect(record).toMatchObject({ outcome: "allowed", stage: "preview", callerRole: "compiler" });
    expect(record.invocationId).toMatch(/^sys-/);
    expect(ofEvent("invocation")).toEqual([]);
  });

  it("names the publication once it exists, never a refused request's id", async () => {
    await denied(policy.authorizeView({ caller: GATEWAY, publicationId: "pub-made-up" }));
    expect(ofEvent("publication-view").at(-1)).not.toHaveProperty("publicationId");
  });

  // Before allocation or token verification there is no invocation to name:
  // the record carries only what was verified (here, the caller's role).
  it("records a refusal before allocation with only verified identity", async () => {
    await denied(policy.allocateInvocation({ caller: GATEWAY, user: null, connectionId: "conn-1", taskId: "t", inputDigest: ARGD }));
    const [record] = ofEvent("invocation");
    expect(record).toMatchObject({ outcome: "denied", reason: "no-user", callerRole: "gateway" });
    expect(record).not.toHaveProperty("invocationId");
    expect(record).not.toHaveProperty("user");
  });
});

describe("audit values from a refused request (spec AUDIT-01)", () => {
  it("records what an unauthenticated caller put in op, step and purpose as invalid", async () => {
    await denied(policy.authorizeExecution({
      caller: L0176, executionToken: "x", op: "alice@example.com", argsDigest: ARGD, step: "What is 2+2?", purpose: "exfiltrate", after: null,
    }));
    const [record] = ofEvent("authorize-execution");
    expect(record).toMatchObject({ outcome: "denied", reason: "caller-not-broker", op: "invalid", step: "invalid", purpose: "invalid", callerRole: "compiler" });
    expect(JSON.stringify(records)).not.toMatch(/alice@example|What is 2\+2|exfiltrate/);
  });

  it("keeps registry names a refused request supplies, since the registry vouches for them", async () => {
    await denied(policy.authorizeExecution({ caller: BROKER, executionToken: "not-a-token", op: WRITE, argsDigest: ARGD, step: "items", purpose: "dispatch", after: null }));
    expect(ofEvent("authorize-execution")[0]).toMatchObject({ reason: "bad-token", op: WRITE, step: "items", purpose: "dispatch" });
  });

  it("records a bad session's function and operation only if the registry knows them", async () => {
    const sessionToken = await issueToken(signer, "session", { sub: OWNER, own: OWNER, conn: "conn-1", backend: "learnosity", lang: "0176", inv: "inv-1", stg: "s0", rv: REGISTRY_VERSION, fns: ["init"] });
    await denied(policy.mint({ caller: L0176, sessionToken: sessionToken + "x", fn: "mallory@example.com", op: "free text", occurrenceId: "n1.0", argsDigest: ARGD }));
    expect(ofEvent("mint")[0]).toMatchObject({ reason: "bad-session", op: "invalid" });
    expect(JSON.stringify(records)).not.toMatch(/mallory@example|free text/);
  });
});
