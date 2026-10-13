// Chain admission at the gateway (capability plan W4, PR 6; spec ADMIT-01,
// ADMIT-02, ADMIT-03, API-01, RUN-01): a marked invocation's chain is
// preflighted stage by stage and admitted once before any stage executes,
// then runs through the pinned revisions with the admission token; any
// refusal or unavailable step runs nothing. CHAIN_ADMISSION decides which new
// invocations are marked; a marked one never falls back.
import { jest } from "@jest/globals";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { buildDataApi } from "./data.js";
import { createApiAudit } from "./audit.js";
import { InvocationRefused } from "./invocations.js";
import { buildChainAdmission, parseChainAdmission, PreflightUnavailable } from "./admission.js";
import { buildMemoryArtifactStorer } from "./storage/artifacts.js";
import { createStorers } from "./storage/index.js";
import { clearFirestore } from "./testing/firestore.js";
import { TASK1, TASK2 } from "./testing/fixture.js";

const hex = c => c.repeat(64);

let taskStorer;
let compileStorer;
let compile;
let records;
let chain;
let calls;

beforeEach(async () => {
  await clearFirestore();
  ({ taskStorer, compileStorer } = createStorers());
  records = [];
  calls = [];
  compile = jest.fn(async (/** @type {any} */ req) => {
    calls.push(["compile", req.stage, req.baseUrl ?? null, req.admissionToken ?? null]);
    return { data: { stage: req.stage }, errors: [], ...(req.admissionToken ? { revision: `rev-${req.lang}` } : {}) };
  });
});

// The two-stage chain the tests run: s0 is TASK1 (leftmost), s1 TASK2.
const chainOf = async () => {
  const id1 = await taskStorer.create({ task: TASK1 });
  const id2 = await taskStorer.create({ task: TASK2 });
  return { id: taskStorer.appendIds(id1, id2), tasks: [TASK1, TASK2] };
};
const manifestFor = (task, stage) => ({
  stage,
  lang: String(task.lang).padStart(4, "0"),
  sourceDigest: canonicalDigest(task.code),
  programDigest: hex("b"),
  optionsDigest: canonicalDigest({}),
  revision: `rev-${task.lang}`,
  imageDigest: `sha256:${hex("c")}`,
  registryVersion: 0,
  requiredFunctions: [],
});
// A stand-in for the admission client, recording every call.
const fakeChain = ({ plan = null, manifests = null, refuse = null, preflightDown = false } = {}) => /** @type {any} */ ({
  baseUrlFor: jest.fn(async lang => `https://serving-${lang}`),
  lookupPlan: jest.fn(async () => { calls.push(["lookup"]); return { contract: 2, plan }; }),
  preflight: jest.fn(async ({ baseUrl, lang, stage, code }) => {
    calls.push(["preflight", stage, baseUrl]);
    if (preflightDown) throw new PreflightUnavailable(`preflight of ${stage} unreachable`);
    // A compiler pins the program it was sent: the stored task's.
    return { manifest: manifests ? manifests[stage] : manifestFor({ lang, code }, stage) };
  }),
  admit: jest.fn(async ({ stages }) => {
    calls.push(["admit", stages.map(s => s.stage)]);
    if (refuse) throw new InvocationRefused(refuse);
    return { planDigest: hex("d"), admissionToken: "adm.tok.en", stages: stages.map(s => ({ stage: s.stage, lang: s.lang, revision: s.revision, tagUrl: `https://tag-${s.stage}` })) };
  }),
});
const api = ({ contract = 2, wanted = true, langOverrideStorer = undefined, ...over } = {}) => {
  const allocateInvocation = /** @type {any} */ (jest.fn)(async () => ({ invocationToken: "inv.tok.en", invocationId: "inv-1", seq: 1, ownerUid: "0xowner", contract }));
  const dataApi = buildDataApi(/** @type {any} */ ({
    compile,
    allocateInvocation,
    artifactStorer: buildMemoryArtifactStorer(),
    audit: createApiAudit({ sink: r => records.push(r) }),
    chainAdmission: chain,
    admissionWanted: () => wanted,
    langOverrideStorer,
    ...over,
  }));
  return { dataApi, allocateInvocation };
};
const get = async (dataApi, id, extra = {}) => dataApi.get({ taskStorer, compileStorer, id, auth: { uid: "0xuser" }, connectionId: "conn-1", idempotencyKey: "job-1", ...extra });
const compiles = () => calls.filter(c => c[0] === "compile");

describe("CHAIN_ADMISSION", () => {
  it("parses off, canary and all, and refuses anything else", () => {
    expect(parseChainAdmission({}).mode).toBe("off");
    expect(parseChainAdmission({}).wants("conn-1")).toBe(false);
    const canary = parseChainAdmission({ CHAIN_ADMISSION: "canary", CHAIN_ADMISSION_CONNECTIONS: "conn-c, conn-d" });
    expect([canary.wants("conn-c"), canary.wants("conn-d"), canary.wants("conn-1")]).toEqual([true, true, false]);
    expect(parseChainAdmission({ CHAIN_ADMISSION: "all" }).wants("anything")).toBe(true);
    expect(() => parseChainAdmission({ CHAIN_ADMISSION: "yes" })).toThrow(/off, canary or all/);
  });

  it("marks a new invocation only when admission is wanted for its connection", async () => {
    chain = fakeChain();
    const { id } = await chainOf();
    const wanted = api({ wanted: true });
    await get(wanted.dataApi, id);
    expect(wanted.allocateInvocation.mock.calls[0][0]).toMatchObject({ admission: true });
    const plain = api({ contract: 1, wanted: false });
    await get(plain.dataApi, id);
    expect(plain.allocateInvocation.mock.calls[0][0]).toMatchObject({ admission: false });
  });

  it("leaves an unmarked invocation on today's path: no preflight, no admission, no token", async () => {
    chain = fakeChain();
    const { id } = await chainOf();
    const out = await get(api({ contract: 1, wanted: false }).dataApi, id);
    expect(out.errors).toEqual([]);
    expect(calls.filter(c => c[0] !== "compile")).toEqual([]);
    expect(compiles().every(c => c[2] === null && c[3] === null)).toBe(true);
  });
});

describe("chain admission (ADMIT-01, ADMIT-02)", () => {
  it("preflights every stage, admits once, then runs each through its pinned revision with the token", async () => {
    chain = fakeChain();
    const { id } = await chainOf();
    const out = await get(api().dataApi, id);
    expect(out.errors).toEqual([]);
    expect(calls).toEqual([
      ["lookup"],
      ["preflight", "s0", `https://serving-${TASK1.lang}`], ["preflight", "s1", `https://serving-${TASK2.lang}`],
      ["admit", ["s0", "s1"]],
      // Right to left, as always, each at its pinned tag URL.
      ["compile", "s1", "https://tag-s1", "adm.tok.en"], ["compile", "s0", "https://tag-s0", "adm.tok.en"],
    ]);
    // The canonical chain, and the stored tasks' own digests.
    const admitted = chain.admit.mock.calls[0][0];
    expect(admitted.taskIds).toHaveLength(2);
    const sent = chain.preflight.mock.calls.map(([args]) => canonicalDigest(args.code));
    expect(admitted.stages.map(s => s.sourceDigest)).toEqual(sent);
    // The revision a stage reports is the gateway's to check, never the caller's.
    expect(JSON.stringify(out)).not.toContain("rev-");
  });

  it("takes the admission path for a marked invocation even with CHAIN_ADMISSION off", async () => {
    chain = fakeChain();
    const { id } = await chainOf();
    await get(api({ contract: 2, wanted: false }).dataApi, id);
    expect(calls.map(c => c[0])).toEqual(["lookup", "preflight", "preflight", "admit", "compile", "compile"]);
  });

  it("a retry preflights the revisions its plan pins, never what serves now", async () => {
    chain = fakeChain({
      plan: {
        planDigest: hex("d"),
        stages: [
          { stage: "s0", lang: "0001", revision: "rev-1", tagUrl: "https://pinned-s0", available: true },
          { stage: "s1", lang: "0002", revision: "rev-2", tagUrl: "https://pinned-s1", available: true },
        ]
      }
    });
    const { id } = await chainOf();
    await get(api().dataApi, id);
    expect(calls.filter(c => c[0] === "preflight").map(c => c[2])).toEqual(["https://pinned-s0", "https://pinned-s1"]);
    expect(chain.baseUrlFor).not.toHaveBeenCalled();
  });
});

describe("refusals run nothing", () => {
  const expectNothingRan = () => {
    expect(compiles()).toEqual([]);
  };

  it("a pinned revision no longer available", async () => {
    chain = fakeChain({
      plan: {
        stages: [
          { stage: "s0", tagUrl: "https://pinned-s0", available: true },
          { stage: "s1", tagUrl: "https://pinned-s1", available: false },
        ]
      }
    });
    const { id } = await chainOf();
    const out = await get(api().dataApi, id);
    expect(out.errors[0]).toMatchObject({ code: "pinned-revision-unavailable", category: "conflict" });
    expect(out.errors[0].message).toMatch(/new run, which may repeat its writes/);
    expect(chain.admit).not.toHaveBeenCalled();
    expectNothingRan();
  });

  it("a stage that can't be preflighted", async () => {
    chain = fakeChain({ preflightDown: true });
    const { id } = await chainOf();
    const out = await get(api().dataApi, id);
    expect(out.errors[0]).toMatchObject({ code: "preflight-unavailable", category: "unavailable" });
    expect(chain.admit).not.toHaveBeenCalled();
    expectNothingRan();
    expect(records.at(-1)).toMatchObject({ event: "admission", outcome: "failed", reason: "preflight-unavailable", stage: "s0", invocationId: "inv-1" });
  });

  it("a manifest for another program than the stored task", async () => {
    chain = fakeChain({ manifests: { s0: { ...manifestFor(TASK1, "s0"), sourceDigest: hex("e") }, s1: manifestFor(TASK2, "s1") } });
    const { id } = await chainOf();
    const out = await get(api().dataApi, id);
    expect(out.errors[0]).toMatchObject({ code: "plan-binding-mismatch" });
    expectNothingRan();
  });

  it("the compiler's own validation errors", async () => {
    chain = fakeChain();
    chain.preflight = jest.fn(async () => ({ errors: [{ message: "Error: not a program", from: -1, to: -1 }] }));
    const { id } = await chainOf();
    const out = await get(api().dataApi, id);
    expect(out.errors).toEqual([{ message: "Error: not a program", from: -1, to: -1 }]);
    expectNothingRan();
  });

  it("policy's refusal of the chain, and policy unavailable", async () => {
    chain = fakeChain({ refuse: "not-granted" });
    const { id } = await chainOf();
    const refused = await get(api().dataApi, id);
    expect(refused.errors[0]).toMatchObject({ code: "not-granted", category: "permission" });
    expectNothingRan();
    chain = fakeChain();
    chain.lookupPlan = jest.fn(async () => { throw new Error("ECONNRESET"); });
    const down = await get(api().dataApi, id);
    expect(down.errors[0]).toMatchObject({ code: "policy-unavailable" });
    expectNothingRan();
    expect(JSON.stringify(records)).not.toMatch(/0xuser|0xowner|ECONNRESET/);
  });
});

// Review of PR 6.
describe("what the gateway mustn't hide or ignore", () => {
  it("reports a lost compiler response as an uncertain effect, not a revision mismatch", async () => {
    chain = fakeChain({ manifests: { s0: { ...manifestFor(TASK1, "s0") }, s1: { ...manifestFor(TASK2, "s1"), requiredFunctions: ["save-to-itembank"] } } });
    compile = jest.fn(async (/** @type {any} */ req) => {
      calls.push(["compile", req.stage]);
      return { errors: [{ message: "Language server error: socket hang up", from: -1, to: -1 }], responseLost: true };
    });
    const { id } = await chainOf();
    const out = await get(api().dataApi, id);
    expect(out.errors[0]).toMatchObject({ code: "compile-response-lost", category: "unavailable" });
    expect(out.errors[0].message).toMatch(/uncertain.*Check before running it again/);
    expect(out.effects).toEqual([{ status: "uncertain", steps: [], reason: "compile-response-lost", category: "unavailable", stage: "s1" }]);
    expect(JSON.stringify(out)).not.toContain("plan-binding-mismatch");
    // The chain stopped there.
    expect(compiles().map(c => c[1])).toEqual(["s1"]);
  });

  it("reports a lost response from a stage that could do nothing without an effect", async () => {
    chain = fakeChain();
    compile = jest.fn(async () => ({ errors: [{ message: "Language server error: socket hang up", from: -1, to: -1 }], responseLost: true }));
    const { id } = await chainOf();
    const out = await get(api().dataApi, id);
    expect(out.errors[0]).toMatchObject({ code: "compile-response-lost" });
    expect(out.effects).toBeUndefined();
  });

  it("refuses a user's language override for a stage before preflighting anything", async () => {
    chain = fakeChain();
    const { id } = await chainOf();
    const langOverrideStorer = { get: async () => ({ bindings: { L0000: "https://my-branch" } }) };
    const out = await get(api({ langOverrideStorer }).dataApi, id);
    expect(out.errors[0]).toMatchObject({ code: "language-override-refused", category: "permission" });
    expect(out.errors[0].message).toMatch(/L0000/);
    expect(calls).toEqual([]);
  });

  it("refuses an invocation from before the cutover with the new-run warning, running nothing", async () => {
    chain = fakeChain();
    const { id } = await chainOf();
    const { dataApi } = api({ contract: 1, wanted: false });
    const out = await get(buildDataApi(/** @type {any} */ ({
      compile,
      allocateInvocation: async () => ({ invocationToken: "inv.tok.en", invocationId: "inv-old", seq: 1, ownerUid: "0xowner", contract: 1, minContractVersion: 2 }),
      artifactStorer: buildMemoryArtifactStorer(),
      audit: createApiAudit({ sink: r => records.push(r) }),
      chainAdmission: chain,
      admissionWanted: () => false,
    })), id);
    expect(dataApi).toBeTruthy();
    expect(out.errors[0]).toMatchObject({ code: "invocation-incompatible", category: "conflict" });
    expect(out.errors[0].message).toMatch(/new run.*may repeat writes/);
    expect(calls).toEqual([]);
    expect(records.at(-1)).toMatchObject({ event: "admission", outcome: "denied", reason: "invocation-incompatible", invocationId: "inv-old" });
  });
});

describe("execution under the plan (ADMIT-03)", () => {
  it("stops at the first failing stage: later stages never run, and its effects are reported", async () => {
    chain = fakeChain();
    compile = jest.fn(async (/** @type {any} */ req) => {
      calls.push(["compile", req.stage]);
      return req.stage === "s1"
        ? { errors: [{ message: "Item bank save partial" }], effects: [{ fn: "save-to-itembank", status: "partial", steps: ["questions"] }], revision: `rev-${req.lang}` }
        : { data: {}, errors: [], revision: `rev-${req.lang}` };
    });
    const { id } = await chainOf();
    const out = await get(api().dataApi, id);
    expect(compiles().map(c => c[1])).toEqual(["s1"]);
    expect(out.errors[0].message).toMatch(/partial/);
    expect(out.effects).toEqual([{ fn: "save-to-itembank", status: "partial", steps: ["questions"], stage: "s1" }]);
  });

  it("refuses a stage that answered from another revision than the plan pins, and runs nothing after it", async () => {
    chain = fakeChain();
    compile = jest.fn(async (/** @type {any} */ req) => {
      calls.push(["compile", req.stage]);
      return { data: {}, errors: [], revision: "rev-other" };
    });
    const { id } = await chainOf();
    const out = await get(api().dataApi, id);
    expect(out.errors[0]).toMatchObject({ code: "plan-binding-mismatch" });
    expect(compiles().map(c => c[1])).toEqual(["s1"]);
  });
});

describe("the admission client (HTTP)", () => {
  const fetched = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  const client = handler => buildChainAdmission({
    policyUrl: "https://policy.example",
    idToken: async audience => `id-for-${audience}`,
    baseUrlFor: async () => "https://serving",
    fetch: /** @type {any} */ async (url, init) => { fetched.push({ url, init }); return handler(url, init); },
  });

  it("preflights as the gateway, for exactly the stage's language, sending the program and no options", async () => {
    fetched.length = 0;
    const c = client(() => reply(200, { status: "success", data: { manifest: { stage: "s1" } } }));
    expect(await c.preflight({ baseUrl: "https://l0176", lang: "176", stage: "s1", code: { root: 1 } })).toEqual({ manifest: { stage: "s1" } });
    expect(fetched[0].url).toBe("https://l0176/preflight");
    expect(fetched[0].init.headers["X-Caller-Identity"]).toBe("id-for-urn:graffiticode:0176");
    expect(JSON.parse(fetched[0].init.body)).toEqual({ stage: "s1", lang: "0176", code: { root: 1 } });
  });

  it("reports an unreachable or refusing compiler as preflight-unavailable", async () => {
    await expect(client(() => { throw new TypeError("fetch failed"); }).preflight({ baseUrl: "https://x", lang: "0176", stage: "s0", code: {} })).rejects.toBeInstanceOf(PreflightUnavailable);
    await expect(client(() => reply(403, { status: "error", error: { reason: "route-not-allowed-for-caller" } })).preflight({ baseUrl: "https://x", lang: "0176", stage: "s0", code: {} }))
      .rejects.toThrow(/route-not-allowed-for-caller/);
  });

  it("turns any policy answer that names a reason into a refusal (403, 409, 503)", async () => {
    for (const [status, reason] of [[403, "not-granted"], [409, "plan-mismatch"], [503, "maintenance"]]) {
      await expect(client(() => reply(status, { status: "error", error: { reason } })).admit({ authToken: "t", invocationToken: "i", taskIds: [], stages: [] }))
        .rejects.toMatchObject({ reason });
    }
    await expect(client(() => reply(500, null)).lookupPlan({ authToken: "t", invocationToken: "i" })).rejects.toThrow(/failed \(500\)/);
  });
});
