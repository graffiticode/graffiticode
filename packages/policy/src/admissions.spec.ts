// Chain admission and contract v2 in Policy (capability plan W4, PR 2; spec
// ADMIT-01..03, RUN-01, RELEASE-01, TOKEN-01): one decision per chain over
// pinned, approved revisions at one consistent read; plans bound into every
// later snapshot, mint and authorization; marked invocations never falling
// back to v1; per-provenance claims; and the minimum contract version.
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { encodeChainId } from "@graffiticode/common/chain";
import { planDigest } from "@graffiticode/common/contract";
import {
  createPolicy,
  PolicyDenied,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryLeaseFence,
  createMemoryApprovals,
  createMemoryPublicationStore,
  createProtectedSwitch,
  issueToken,
  verifyToken,
  createAudit,
  createPseudonymizer,
  validateAuditRecord,
} from "./index.js";

const OWNER = "0xowner";
const OTHER = "0xother";
const GATEWAY = { role: "gateway" };
const L0176 = { role: "compiler", lang: "0176" };
const L0000 = { role: "compiler", lang: "0000" };
const BROKER = { role: "broker" };
const hex = c => c.repeat(64);
const IMAGE_176 = `sha256:${hex("1")}`;
const IMAGE_000 = `sha256:${hex("0")}`;
const TASKS = ["task-data", "task-prog"];
const WRITE = "learnosity.write-items";
const ARGD = hex("a");

// s0 is the leftmost task (the data stage, L0000); s1 the L0176 program.
const manifests = (over = {}) => [
  { stage: "s0", lang: "0000", sourceDigest: hex("b"), programDigest: hex("c"), optionsDigest: hex("d"), revision: "l0000-r1", imageDigest: IMAGE_000, registryVersion: 0, requiredFunctions: [] },
  { stage: "s1", lang: "0176", sourceDigest: hex("e"), programDigest: hex("f"), optionsDigest: hex("d"), revision: "l0176-r1", imageDigest: IMAGE_176, registryVersion: REGISTRY_VERSION, requiredFunctions: ["save-to-itembank", "init"], ...over },
];
const approved = (lang, revision, imageDigest, extra = {}): [string, any] => [`${lang}/${revision}`, {
  lang, revision, imageDigest, tag: `t-${revision}`, tagUrl: `https://t-${revision}---svc.run.app`, status: "approved", contractVersions: [1, 2], ...extra,
}];

let policy;
let signer;
let jwks;
let records;
let invocations;
let fence;
let approvals;
let connections;
let clock;
let audited;
const build = (over = {}) => createPolicy({
  signer,
  jwks,
  connections,
  invocations,
  publications: createMemoryPublicationStore(),
  audit: async r => { audited.push(r); },
  protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
  approvals,
  fence,
  now: () => clock,
  ...over,
});

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  clock = 1_000_000;
  audited = [];
  const leases = new Map();
  invocations = createMemoryInvocationStore({ leases });
  fence = createMemoryLeaseFence({ leases, now: () => clock });
  records = new Map([approved("0000", "l0000-r1", IMAGE_000), approved("0176", "l0176-r1", IMAGE_176)]);
  approvals = createMemoryApprovals(records);
  connections = createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]);
  policy = build();
});

const denied = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(PolicyDenied);
  await promise.catch(e => expect(e.reason).toBe(reason));
};
const allocate = (over = {}) => policy.allocateInvocation({
  caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: encodeChainId(TASKS), inputDigest: hex("9"), idempotencyKey: "job-1", admission: true, ...over,
});
const admit = (invocationToken, over = {}) => policy.admit({ caller: GATEWAY, user: { uid: OWNER }, invocationToken, taskIds: TASKS, stages: manifests(), ...over });
const snapshot = (invocationToken, admissionToken, over = {}) => policy.snapshot({
  caller: L0176,
  user: { uid: OWNER },
  lang: "0176",
  connectionId: "conn-1",
  fns: ["init", "save-to-itembank"],
  invocationToken,
  stage: "s1",
  admissionToken,
  manifest: manifests()[1],
  ...over,
});
const admitted = async () => {
  const inv = await allocate();
  const admission = await admit(inv.invocationToken);
  return { inv, admission };
};
const boundSession = async () => {
  const { inv, admission } = await admitted();
  const { sessionToken } = await snapshot(inv.invocationToken, admission.admissionToken);
  return { inv, admission, sessionToken };
};
const mint = (sessionToken, over = {}) => policy.mint({ caller: L0176, sessionToken, fn: "save-to-itembank", op: WRITE, occurrenceId: "n1.0", argsDigest: ARGD, ...over });
const authorize = (executionToken, over = {}) => policy.authorizeExecution({ caller: BROKER, executionToken, op: WRITE, argsDigest: ARGD, step: "questions", purpose: "dispatch", after: null, ...over });
const claimsOf = async (profile, token) => (await verifyToken(jwks, profile, token)).claims;

describe("the invocation marker (W4 section C)", () => {
  it("marks an invocation allocated for admission, durably, and a retry reports the invocation's own marker", async () => {
    const marked = await allocate();
    expect(marked).toMatchObject({ contract: 2, planDigest: null, reused: false });
    expect((await claimsOf("invocation", marked.invocationToken)).cv).toBe(2);
    // A retry under the same key can't unmark it, nor mark an unmarked one.
    expect(await allocate({ admission: false })).toMatchObject({ invocationId: marked.invocationId, contract: 2, reused: true });
    const plain = await allocate({ idempotencyKey: "job-2", admission: false });
    expect(plain.contract).toBe(1);
    expect((await allocate({ idempotencyKey: "job-2", admission: true })).contract).toBe(1);
    await denied(allocate({ admission: "yes" }), "bad-request");
  });
});

describe("the cutover (RELEASE-01; review of PR 6)", () => {
  it("marks every new invocation from minimum 2 and says so; an invocation from before can't be resumed", async () => {
    const before = await allocate({ idempotencyKey: "old-job", admission: false });
    expect(before).toMatchObject({ contract: 1, minContractVersion: 1 });
    policy = build({ minContractVersion: 2 });
    expect(await allocate({ idempotencyKey: "new-job", admission: false })).toMatchObject({ contract: 2, minContractVersion: 2 });
    // The old invocation's retry keeps its own marker, and the gateway is told the minimum.
    expect(await allocate({ idempotencyKey: "old-job", admission: false })).toMatchObject({ invocationId: before.invocationId, contract: 1, minContractVersion: 2 });
    // Its proofs are refused as incompatible, not as merely unbound.
    const unbound = await issueToken(signer, "session", {
      sub: OWNER, own: OWNER, conn: "conn-1", backend: "learnosity", lang: "0176", inv: before.invocationId, stg: "s1", rv: REGISTRY_VERSION, fns: ["save-to-itembank"], cv: 2,
    });
    await denied(mint(unbound), "invocation-incompatible");
  });
});

describe("admission (ADMIT-01, ADMIT-02)", () => {
  it("decides the whole chain once, pins every stage, and returns a Policy-audience admission token", async () => {
    const inv = await allocate();
    const out = await admit(inv.invocationToken);
    const expected = planDigest({
      contractVersion: 2,
      invocationId: inv.invocationId,
      taskIds: TASKS,
      connectionId: "conn-1",
      inputDigest: hex("9"),
      registryVersion: REGISTRY_VERSION,
      stages: manifests().map(m => ({ ...m, requiredFunctions: [...m.requiredFunctions].sort() })),
    });
    expect(out.planDigest).toBe(expected);
    expect(out.stages).toEqual([
      { stage: "s0", lang: "0000", revision: "l0000-r1", tagUrl: "https://t-l0000-r1---svc.run.app" },
      { stage: "s1", lang: "0176", revision: "l0176-r1", tagUrl: "https://t-l0176-r1---svc.run.app" },
    ]);
    expect(await claimsOf("admission", out.admissionToken)).toMatchObject({ aud: "urn:graffiticode:policy", sub: OWNER, conn: "conn-1", inv: inv.invocationId, pld: expected, cv: 2 });
    expect(audited.at(-1)).toMatchObject({ event: "admission", outcome: "allowed", reason: "new", planDigest: expected, invocationId: inv.invocationId });
    // The lease was consumed by the plan write.
    expect(fence.leases.size).toBe(0);
    // A retry with the same manifests reuses the plan, after fresh authorization.
    expect((await admit(inv.invocationToken)).planDigest).toBe(expected);
    expect(audited.at(-1)).toMatchObject({ outcome: "allowed", reason: "reused" });
  });

  it("compares the chain canonically: any encoding of the same task list is the same chain", async () => {
    const inv = await allocate({ taskId: `${encodeChainId([TASKS[0]])}+${encodeChainId([TASKS[1]])}` });
    expect((await admit(inv.invocationToken)).planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses the whole chain when any stage is refused, and stores nothing", async () => {
    const inv = await allocate();
    // The owner narrowed their own use to init: the save stage is refused.
    connections = createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active", ownerPermissions: [{ lang: "0176", fn: "init" }] }]);
    policy = build();
    await denied(admit(inv.invocationToken), "not-granted");
    expect(invocations.plans.size).toBe(0);
    expect((await invocations.get(inv.invocationId)).planDigest).toBeNull();
  });

  it.each([
    ["a chain other than the invocation's", { taskIds: ["task-data", "task-other"] }, "plan-binding-mismatch"],
    ["a stage in a language with no approved revisions", { stages: [{ ...manifests()[0], lang: "0184", revision: "l0184-r1" }, manifests()[1]] }, "stage-not-pinnable"],
    ["a revision that isn't approved", { stages: [manifests()[0], { ...manifests()[1], revision: "l0176-r9" }] }, "revision-not-approved"],
    ["another image than the approved one", { stages: [manifests()[0], { ...manifests()[1], imageDigest: `sha256:${hex("7")}` }] }, "plan-binding-mismatch"],
    ["another registry", { stages: [manifests()[0], { ...manifests()[1], registryVersion: REGISTRY_VERSION + 1 }] }, "registry-version-mismatch"],
    ["a protected language claiming no registry", { stages: [manifests()[0], { ...manifests()[1], registryVersion: 0 }] }, "registry-version-mismatch"],
    ["a language without protected functions claiming one", { stages: [{ ...manifests()[0], registryVersion: REGISTRY_VERSION }, manifests()[1]] }, "registry-version-mismatch"],
    ["a function the registry doesn't list", { stages: [manifests()[0], { ...manifests()[1], requiredFunctions: ["drop-tables"] }] }, "bad-request"],
    ["stages out of order", { stages: [manifests()[1], manifests()[0]] }, "bad-request"],
    ["a missing stage", { stages: [manifests()[1]] }, "bad-request"],
  ])("refuses %s", async (_label, over, reason) => {
    const inv = await allocate();
    await denied(admit(inv.invocationToken, over), reason);
    expect(invocations.plans.size).toBe(0);
  });

  it("refuses revisions mid-retirement, without v2 support, or a retry whose pinned revision went away", async () => {
    const inv = await allocate();
    records.set("0176/l0176-r1", { ...records.get("0176/l0176-r1"), status: "retiring" });
    await denied(admit(inv.invocationToken), "revision-retiring");
    records.set("0176/l0176-r1", { ...records.get("0176/l0176-r1"), status: "approved", contractVersions: [1] });
    await denied(admit(inv.invocationToken), "contract-version-unsupported");
    records.set("0176/l0176-r1", { ...records.get("0176/l0176-r1"), contractVersions: [1, 2] });
    await admit(inv.invocationToken);
    records.set("0176/l0176-r1", { ...records.get("0176/l0176-r1"), status: "retired" });
    await denied(admit(inv.invocationToken), "pinned-revision-unavailable");
  });

  it("refuses an unmarked invocation, another owner's, and a retry with other manifests", async () => {
    const plain = await allocate({ idempotencyKey: "job-2", admission: false });
    await denied(admit(plain.invocationToken), "invocation-incompatible");
    const inv = await allocate();
    await denied(policy.admit({ caller: GATEWAY, user: { uid: OTHER }, invocationToken: inv.invocationToken, taskIds: TASKS, stages: manifests() }), "bad-invocation");
    await denied(policy.admit({ caller: L0176, user: { uid: OWNER }, invocationToken: inv.invocationToken, taskIds: TASKS, stages: manifests() }), "caller-not-entry-point");
    await admit(inv.invocationToken);
    await denied(admit(inv.invocationToken, { stages: manifests({ programDigest: hex("5") }) }), "plan-mismatch");
  });

  it("can't store a plan once retirement has fenced its lease, and stores none when too stale", async () => {
    const inv = await allocate();
    // Retirement invalidates the lease after the approval read, before the write.
    const read = approvals.read;
    approvals.read = async (...args) => { const out = await read(...args); fence.invalidate("l0176-r1"); return out; };
    await denied(admit(inv.invocationToken), "revision-retiring");
    approvals.read = async (...args) => { const out = await read(...args); clock += 6000; return out; };
    await denied(admit(inv.invocationToken), "admission-stale");
    expect(invocations.plans.size).toBe(0);
  });

  it("is refused while protected execution is paused, and without the approvals store", async () => {
    const inv = await allocate();
    policy = build({ protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: false }) }) });
    await denied(admit(inv.invocationToken), "maintenance");
    policy = build({ approvals: null });
    await denied(admit(inv.invocationToken), "unavailable");
  });
});

describe("plan lookup (decision 3)", () => {
  it("gives a retry its plan before it resolves compiler URLs, and only to the invocation's owner", async () => {
    const inv = await allocate();
    expect(await policy.planLookup({ caller: GATEWAY, user: { uid: OWNER }, invocationToken: inv.invocationToken })).toEqual({ contract: 2, plan: null });
    const { planDigest: digest } = await admit(inv.invocationToken);
    records.set("0000/l0000-r1", { ...records.get("0000/l0000-r1"), status: "retiring" });
    expect(await policy.planLookup({ caller: GATEWAY, user: { uid: OWNER }, invocationToken: inv.invocationToken })).toEqual({
      contract: 2,
      plan: {
        planDigest: digest,
        stages: [
          { stage: "s0", lang: "0000", revision: "l0000-r1", tagUrl: "https://t-l0000-r1---svc.run.app", available: false },
          { stage: "s1", lang: "0176", revision: "l0176-r1", tagUrl: "https://t-l0176-r1---svc.run.app", available: true },
        ]
      },
    });
    await denied(policy.planLookup({ caller: GATEWAY, user: { uid: OTHER }, invocationToken: inv.invocationToken }), "bad-invocation");
    await denied(policy.planLookup({ caller: GATEWAY, user: { uid: OWNER }, invocationToken: "inv-123" }), "bad-invocation");
    await denied(policy.planLookup({ caller: L0176, user: { uid: OWNER }, invocationToken: inv.invocationToken }), "caller-not-entry-point");
  });
});

describe("plan-bound snapshots (ADMIT-03)", () => {
  it("binds the session to its plan and stage, and only narrows the plan", async () => {
    const { inv, admission } = await admitted();
    const out = await snapshot(inv.invocationToken, admission.admissionToken, { fns: ["init", "save-to-itembank", "author"] });
    expect(out.allowed.sort()).toEqual(["init", "save-to-itembank"]);
    const claims = await claimsOf("session", out.sessionToken);
    expect(claims).toMatchObject({ cv: 2, pld: admission.planDigest, stg: "s1" });
    expect(claims.bind).toEqual({
      lang: "0176",
      sourceDigest: hex("e"),
      programDigest: hex("f"),
      optionsDigest: hex("d"),
      revision: "l0176-r1",
      imageDigest: IMAGE_176,
      requiredFunctions: ["init", "save-to-itembank"],
    });
  });

  it("binds a stage with no protected functions too, granting nothing to mint", async () => {
    const { inv, admission } = await admitted();
    const out = await policy.snapshot({ caller: L0000, user: { uid: OWNER }, lang: "0000", connectionId: "conn-1", fns: [], invocationToken: inv.invocationToken, stage: "s0", admissionToken: admission.admissionToken, manifest: manifests()[0] });
    expect(out.allowed).toEqual([]);
    const claims = await claimsOf("session", out.sessionToken);
    expect(claims).toMatchObject({ cv: 2, stg: "s0", fns: [] });
    expect((claims.bind as { requiredFunctions: string[] }).requiredFunctions).toEqual([]);
  });

  it.each([
    ["a different program", { manifest: { ...manifests()[1], programDigest: hex("5") } }, "plan-binding-mismatch"],
    ["different options", { manifest: { ...manifests()[1], optionsDigest: hex("5") } }, "plan-binding-mismatch"],
    ["a different revision", { manifest: { ...manifests()[1], revision: "l0176-r2" } }, "plan-binding-mismatch"],
    ["another stage", { stage: "s0" }, "plan-binding-mismatch"],
    ["no manifest", { manifest: null }, "plan-binding-mismatch"],
    ["a forged admission token", { admissionToken: "x.y.z" }, "bad-token"],
  ])("refuses %s", async (_label, over, reason) => {
    const { inv, admission } = await admitted();
    await denied(snapshot(inv.invocationToken, admission.admissionToken, over), reason);
  });

  it("refuses another invocation's admission token, and a pinned revision retired since", async () => {
    const { inv, admission } = await admitted();
    const other = await allocate({ idempotencyKey: "job-3" });
    await denied(snapshot(other.invocationToken, admission.admissionToken), "plan-binding-mismatch");
    records.set("0176/l0176-r1", { ...records.get("0176/l0176-r1"), status: "retired" });
    await denied(snapshot(inv.invocationToken, admission.admissionToken), "pinned-revision-unavailable");
  });

  it("never lets a marked invocation fall back to a per-stage session; an unmarked one keeps v1 until the cutover", async () => {
    const marked = await allocate();
    await denied(snapshot(marked.invocationToken, null), "plan-required");
    const plain = await allocate({ idempotencyKey: "job-2", admission: false });
    const legacy = await snapshot(plain.invocationToken, null, { manifest: null });
    expect((await claimsOf("session", legacy.sessionToken))).toMatchObject({ cv: 1 });
    expect((await claimsOf("session", legacy.sessionToken)).pld).toBeUndefined();
    // From the cutover an unmarked invocation can't be resumed at all.
    policy = build({ minContractVersion: 2 });
    await denied(snapshot(plain.invocationToken, null, { manifest: null }), "invocation-incompatible");
  });
});

describe("mint and authorize-execution under a plan", () => {
  it("carries the plan and stage into the execution token, and authorizes each step against the stored plan", async () => {
    const { admission, sessionToken } = await boundSession();
    const { executionToken, operationId } = await mint(sessionToken);
    expect(await claimsOf("execution", executionToken)).toMatchObject({ cv: 2, pld: admission.planDigest, stg: "s1", prv: "user" });
    expect(operationId).toMatch(/\/s1\/n1\.0$/);
    expect(await authorize(executionToken)).toMatchObject({ decisionId: expect.any(String) });
    expect(audited.at(-1)).toMatchObject({ event: "authorize-execution", outcome: "allowed", planDigest: admission.planDigest });
  });

  it("refuses a function the plan didn't admit for the stage, even if the session lists it", async () => {
    const { inv, admission } = await admitted();
    const sessionToken = await issueToken(signer, "session", {
      sub: OWNER,
      own: OWNER,
      conn: "conn-1",
      backend: "learnosity",
      lang: "0176",
      inv: inv.invocationId,
      stg: "s0",
      rv: REGISTRY_VERSION,
      fns: ["save-to-itembank"],
      cv: 2,
      pld: admission.planDigest,
      bind: {},
    });
    // s0 is the L0000 stage: it admits no function.
    await denied(mint(sessionToken), "plan-binding-mismatch");
  });

  it("refuses a token whose stage disagrees with its operation id, or whose plan is another invocation's", async () => {
    const { admission, sessionToken } = await boundSession();
    const { executionToken } = await mint(sessionToken);
    const claims = await claimsOf("execution", executionToken);
    const { iss, aud, iat, exp, jti, ...rest } = claims;
    const reissue = over => issueToken(signer, "execution", { ...rest, ...over });
    await denied(authorize(await reissue({ stg: "s0" })), "plan-binding-mismatch");
    await denied(authorize(await reissue({ opid: "inv-other/s1/n1.0" })), "plan-binding-mismatch");
    await denied(authorize(await reissue({ pld: hex("4") })), "plan-binding-mismatch");
    expect(admission.planDigest).toBeTruthy();
  });

  it("stops at the next effect once the pinned revision is retired", async () => {
    const { sessionToken } = await boundSession();
    const { executionToken } = await mint(sessionToken);
    records.set("0176/l0176-r1", { ...records.get("0176/l0176-r1"), status: "retiring" });
    await denied(authorize(executionToken), "pinned-revision-unavailable");
    await denied(mint(sessionToken, { occurrenceId: "n1.1" }), "pinned-revision-unavailable");
  });

  it("never lets a marked invocation's operation run unbound, and refuses v1 proofs at minimum version 2", async () => {
    const marked = await allocate();
    const unbound = await issueToken(signer, "session", {
      sub: OWNER, own: OWNER, conn: "conn-1", backend: "learnosity", lang: "0176", inv: marked.invocationId, stg: "s1", rv: REGISTRY_VERSION, fns: ["save-to-itembank"],
    });
    await denied(mint(unbound), "plan-required");
    const plain = await allocate({ idempotencyKey: "job-2", admission: false });
    const legacy = await snapshot(plain.invocationToken, null, { manifest: null });
    const { executionToken } = await mint(legacy.sessionToken);
    expect((await claimsOf("execution", executionToken)).cv).toBe(1);
    expect(await authorize(executionToken)).toMatchObject({ decisionId: expect.any(String) });
    policy = build({ minContractVersion: 2 });
    await denied(mint(legacy.sessionToken, { occurrenceId: "n1.1" }), "contract-version-unsupported");
    await denied(authorize(executionToken), "contract-version-unsupported");
    // A contract version no one supports is refused at any minimum.
    policy = build();
    const { iss, aud, iat, exp, jti, ...rest } = await claimsOf("execution", executionToken);
    await denied(authorize(await issueToken(signer, "execution", { ...rest, cv: 3 })), "contract-version-unsupported");
  });

  it("issues system preview sessions at v2 by their own authority, so they mint at minimum version 2", async () => {
    connections = createMemoryConnectionStore([
      { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" },
      { connectionId: "conn-sys", ownerUid: "0xsystem", backend: "learnosity", status: "active" },
    ]);
    policy = build({ systemConnections: { learnosity: "conn-sys" }, minContractVersion: 2 });
    const { sessionToken } = await policy.previewSession({ caller: L0176, lang: "0176" });
    expect((await claimsOf("session", sessionToken)).cv).toBe(2);
    const { executionToken } = await policy.mint({ caller: L0176, sessionToken, fn: "init", op: "learnosity.sign-questions-preview", occurrenceId: "prog.0", argsDigest: ARGD });
    expect(await claimsOf("execution", executionToken)).toMatchObject({ cv: 2, prv: "system" });
    expect((await claimsOf("execution", executionToken)).pld).toBeUndefined();
  });
});

describe("audit (AUDIT-01)", () => {
  it("records each admission with its plan and invocation, through the field validators", async () => {
    const lines = [];
    policy = build({ audit: createAudit({ sink: r => { lines.push(r); }, pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) }) });
    const inv = await allocate();
    const { planDigest: digest } = await admit(inv.invocationToken);
    const record = lines.find(r => r.event === "admission");
    expect(record).toMatchObject({ event: "admission", outcome: "allowed", planDigest: digest, invocationId: inv.invocationId, connectionId: "conn-1", callerRole: "gateway" });
    expect(JSON.stringify(lines)).not.toContain(OWNER);
    expect(validateAuditRecord({ planDigest: "not a digest" })).toEqual({ planDigest: "invalid" });
  });
});
