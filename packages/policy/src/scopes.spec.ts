// C5a slice 3a (docs/c5-l0013-commands-plan.md decisions 1, 3, 4, 6, 10 and
// §3): commands without a connection, the `scopes` worker capability,
// intents' scopes, item authority, and v3 admission with its per-stage
// contract rule.
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { planDigest } from "@graffiticode/common/contract";
import { encodeChainId } from "@graffiticode/common/chain";
import {
  createPolicy,
  PolicyDenied,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryLeaseFence,
  createMemoryApprovals,
  createMemoryPublicationStore,
  createMemoryCommandStore,
  createMemoryCommandBackend,
  createCommandRecords,
  createProtectedSwitch,
  createMemoryItemAuthority,
  buildItemAuthority,
  PolicyUnavailable,
  declaresItemScope,
  ItemAuthorityUnavailable,
  intentScope,
  modelIntents,
  validateAuditRecord,
  ANONYMOUS_SUBJECT,
  COMMAND_LEASE_MS,
} from "./index.js";

const OWNER = "0xowner";
const OTHER = "0xother";
const GATEWAY = { role: "gateway" };
const hex = c => c.repeat(64);
const PRIVATE = "privateItem00000001";
const PUBLIC = "publicItem000000001";
const RV = REGISTRY_VERSION;
const IMAGES = { "0000": `sha256:${hex("0")}`, "0013": `sha256:${hex("3")}`, "0176": `sha256:${hex("1")}`, "0185": `sha256:${hex("5")}` };
const REVISION = { "0000": "l0000r-r1", "0013": "l0013r-r1", "0176": "l0176r-r1", "0185": "l0185r-r1" };
const FNS = { "0000": [], "0013": ["snap"], "0176": ["save-to-itembank", "init"], "0185": [] };
const PROTECTED = new Set(["0013", "0176"]);

const manifest = (lang, i, over = {}) => ({
  stage: `s${i}`,
  lang,
  sourceDigest: hex("b"),
  programDigest: hex(String(i)),
  optionsDigest: hex("d"),
  revision: REVISION[lang],
  imageDigest: IMAGES[lang],
  registryVersion: PROTECTED.has(lang) ? RV : 0,
  requiredFunctions: FNS[lang],
  ...over,
});
const approved = (lang, contractVersions): [string, any] => [`${lang}/${REVISION[lang]}`, {
  lang, revision: REVISION[lang], imageDigest: IMAGES[lang], tag: `t-${lang}`, tagUrl: `https://t-${lang}---svc.run.app`, status: "approved", contractVersions,
}];
const snapIntent = (scope: unknown = { kind: "item", id: PRIVATE }) => ({ id: "snap", fn: "snap", op: "gcs.put-thumbnail", occurrences: ["n0.0"], scope });
const SAVE_INTENT = { id: "save", fn: "save-to-itembank", op: "learnosity.write-items", occurrences: ["n1.0"] };
const model = (lang, intents = []) => JSON.stringify({ lang, kind: "plan", carried: {}, intents });

let policy;
let deps;
let invocationStore;
let commandStore;
let approvals;
let items;
let audits;
let clock;

const build = (over = {}) => {
  policy = createPolicy({ ...deps, ...over });
  return policy;
};

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  clock = Date.now();
  const leases = new Map();
  invocationStore = createMemoryInvocationStore({ leases });
  commandStore = createMemoryCommandStore({ invocationStore });
  approvals = createMemoryApprovals(new Map([approved("0000", [1, 2]), approved("0013", [3]), approved("0176", [1, 2]), approved("0185", [1, 2])]));
  items = createMemoryItemAuthority({ [PRIVATE]: { ownerUid: OWNER, isPublic: false }, [PUBLIC]: { ownerUid: OWNER, isPublic: true }, twice: "ambiguous" });
  audits = [];
  deps = {
    signer,
    jwks,
    connections: createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]),
    invocations: invocationStore,
    commands: commandStore,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }), now: () => clock }),
    publications: createMemoryPublicationStore(),
    audit: async r => { audits.push(r); },
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals,
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    itemAuthority: items,
    now: () => clock,
  };
  build();
});

const denied = async (promise, reason) => {
  const e = await promise.catch(err => err);
  expect(e).toBeInstanceOf(PolicyDenied);
  expect(e.reason).toBe(reason);
};

let keys = 0;
// A command over `langs` (s0 is the head), its models installed, ready to admit.
const command = async ({ langs, intents = {}, uid = OWNER, anonymous = false, connectionId = null, scopes = 1 }: { langs: string[], intents?: Record<string, unknown[]>, uid?: string, anonymous?: boolean, connectionId?: string | null, scopes?: number }) => {
  const taskIds = langs.map((_l, i) => `task-${i}`);
  const allocated = await policy.allocateCommand({
    caller: GATEWAY,
    user: anonymous ? null : { uid },
    anonymous,
    connectionId,
    taskId: encodeChainId(taskIds),
    inputDigest: hex("9"),
    idempotencyKey: `job-${++keys}`,
    lang: langs[0],
    request: "{}",
    worker: "api-1",
    scopes,
  });
  for (const [i, lang] of langs.entries()) {
    await policy.commandWrite({ caller: GATEWAY, commandId: allocated.commandId, generation: 1, fn: "installModel", args: { stage: `s${i}`, text: model(lang, intents[`s${i}`] ?? []) } });
  }
  const stages = langs.map((lang, i) => manifest(lang, i));
  return {
    ...allocated,
    taskIds,
    stages,
    admit: ({ stages: over = stages, scopes: s = 1 }: { stages?: any[], scopes?: number } = {}) =>
      policy.admitCommand({ caller: GATEWAY, commandId: allocated.commandId, generation: 1, taskIds, stages: over, scopes: s }),
  };
};
const plans = () => [...invocationStore.plans.values()].map(p => p.plan);

describe("intent scopes (decision 1)", () => {
  it("reads a bare string as a connection, and objects as connection, static item or bound item", () => {
    expect(intentScope(undefined)).toBeNull();
    expect(intentScope("conn-1")).toEqual({ kind: "connection", id: "conn-1" });
    expect(intentScope({ kind: "connection", id: "conn-1" })).toEqual({ kind: "connection", id: "conn-1" });
    expect(intentScope({ kind: "item", id: PRIVATE })).toEqual({ kind: "item", id: PRIVATE });
    expect(intentScope({ kind: "item" })).toEqual({ kind: "item" });
    for (const bad of [{ kind: "connection" }, { kind: "item", id: "" }, { kind: "item", id: "a/b" }, { kind: "item", id: "x", extra: 1 }, { kind: "other", id: "x" }, [], 7, null]) {
      expect(intentScope(bad)).toBe("bad");
    }
  });

  it("requires an item scope of a service function, and refuses one on a connection function", () => {
    const check = (lang, intents, backend = "learnosity") => modelIntents({ modelText: model(lang, intents), lang, requiredFunctions: FNS[lang], backend });
    expect(check("0013", [snapIntent()], null).intents[0].scope).toEqual({ kind: "item", id: PRIVATE });
    expect(check("0013", [snapIntent({ kind: "item" })], null).intents[0].scope).toEqual({ kind: "item" });
    expect(check("0013", [{ ...snapIntent(), scope: undefined }], null)).toEqual({ refusal: "intent-not-registered" });
    expect(check("0013", [snapIntent("conn-1")], null)).toEqual({ refusal: "intent-not-registered" });
    expect(check("0176", [{ ...SAVE_INTENT, scope: { kind: "item", id: PRIVATE } }])).toEqual({ refusal: "intent-not-registered" });
    expect(check("0176", [SAVE_INTENT], null)).toEqual({ refusal: "connection-required" });
    expect(check("0176", [{ ...SAVE_INTENT, scope: { kind: "item", id: "" } }])).toEqual({ refusal: "bad-request" });
    // A connection intent's scope is kept as it was declared.
    expect(check("0176", [{ ...SAVE_INTENT, scope: "conn-1" }]).intents[0].scope).toBe("conn-1");
  });
});

describe("allocation without a connection (decisions 1 and 4)", () => {
  it("allocates a connectionless command only for a worker that runs v3 commands, and marks it so", async () => {
    const args = { caller: GATEWAY, user: { uid: OWNER }, taskId: encodeChainId(["t"]), inputDigest: hex("9"), lang: "0013", request: "{}", worker: "api-1" };
    await denied(policy.allocateCommand({ ...args, idempotencyKey: "k-1" }), "worker-unsupported");
    const out = await policy.allocateCommand({ ...args, idempotencyKey: "k-2", scopes: 1 });
    expect(out).toMatchObject({ connectionId: null, ownerUid: null, owned: true });
    expect(commandStore.commands.get(out.commandId)).toMatchObject({ connectionId: null, scopes: 1, binding: { connectionId: null } });
    expect((await invocationStore.get(out.invocationId)).connectionId).toBeNull();
    // A retry of the same key is the same command.
    expect((await policy.allocateCommand({ ...args, idempotencyKey: "k-2", scopes: 1 })).commandId).toBe(out.commandId);
    // A connection command's record is as it was.
    const connected = await policy.allocateCommand({ ...args, idempotencyKey: "k-3", connectionId: "conn-1" });
    expect(commandStore.commands.get(connected.commandId)).not.toHaveProperty("scopes");
  });

  it("allocates an anonymous command with the anonymous subject and no connection, and nothing else anonymous", async () => {
    const args = { caller: GATEWAY, taskId: encodeChainId(["t"]), inputDigest: hex("9"), lang: "0013", request: "{}", worker: "api-1", scopes: 1 };
    const out = await policy.allocateCommand({ ...args, user: null, anonymous: true, idempotencyKey: "anon-1" });
    expect(commandStore.commands.get(out.commandId)).toMatchObject({ uid: ANONYMOUS_SUBJECT, connectionId: null });
    await denied(policy.allocateCommand({ ...args, user: null, anonymous: true, connectionId: "conn-1", idempotencyKey: "anon-2" }), "bad-request");
    await denied(policy.allocateCommand({ ...args, user: { uid: OWNER }, anonymous: true, idempotencyKey: "anon-3" }), "bad-request");
    await denied(policy.allocateCommand({ ...args, user: null, idempotencyKey: "anon-4" }), "no-user");
  });

  it("refuses a repair of a v3 command", async () => {
    const c = await command({ langs: ["0013"], intents: { s0: [snapIntent()] } });
    await denied(policy.allocateRepair({ caller: GATEWAY, user: { uid: OWNER }, commandId: c.commandId, idempotencyKey: "r-1", worker: "api-1" }), "not-supported");
  });
});

describe("the scopes worker capability (§3)", () => {
  it("hands a v3 command only to a worker that declares scopes: listed, renewed, taken over", async () => {
    const c = await command({ langs: ["0013"], intents: { s0: [snapIntent()] } });
    const connected = await command({ langs: ["0176"], connectionId: "conn-1", scopes: 0 });
    clock += COMMAND_LEASE_MS + 1;
    const due = async scopes => (await policy.dueCommands({ caller: GATEWAY, scopes })).commands.map(d => d.commandId);
    expect(await due(0)).toEqual([connected.commandId]);
    expect(new Set(await due(1))).toEqual(new Set([c.commandId, connected.commandId]));
    await denied(policy.leaseCommand({ caller: GATEWAY, commandId: c.commandId, worker: "api-old", generation: 1, takeOver: true }), "worker-unsupported");
    expect(await policy.leaseCommand({ caller: GATEWAY, commandId: c.commandId, worker: "api-new", generation: 1, takeOver: true, scopes: 1 })).toMatchObject({ generation: 2 });
    await denied(policy.leaseCommand({ caller: GATEWAY, commandId: c.commandId, worker: "api-new", generation: 2 }), "worker-unsupported");
    expect(await policy.leaseCommand({ caller: GATEWAY, commandId: c.commandId, worker: "api-new", generation: 2, scopes: 1 })).toMatchObject({ generation: 2 });
  });

  // The owner's review of #402: the capability is persisted before any
  // recovery window, so no older sweeper ever lists or leases a command it
  // would fail at admission.
  it("marks a connection command when an installed model declares an item-scoped intent, before admission", async () => {
    const c = await command({ langs: ["0013", "0176"], connectionId: "conn-1", intents: { s0: [snapIntent()], s1: [SAVE_INTENT] }, scopes: 0 });
    expect(commandStore.commands.get(c.commandId)).toMatchObject({ scopes: 1, phase: "initializing" });
    // Its worker dies before admission: an older sweeper neither lists nor takes it.
    clock += COMMAND_LEASE_MS + 1;
    expect((await policy.dueCommands({ caller: GATEWAY, recording: 1, repairs: 1 })).commands.map(d => d.commandId)).not.toContain(c.commandId);
    await denied(policy.leaseCommand({ caller: GATEWAY, commandId: c.commandId, worker: "old-api", generation: 1, takeOver: true, recording: 1, repairs: 1 }), "worker-unsupported");
    await policy.leaseCommand({ caller: GATEWAY, commandId: c.commandId, worker: "new-api", generation: 1, takeOver: true, recording: 1, repairs: 1, scopes: 1 });
    await policy.admitCommand({ caller: GATEWAY, commandId: c.commandId, generation: 2, taskIds: c.taskIds, stages: c.stages, scopes: 1 });
    expect(commandStore.commands.get(c.commandId).phase).toBe("admitted");
  });

  it("leaves a connection command whose models declare no item scope to any worker", async () => {
    const c = await command({ langs: ["0176"], connectionId: "conn-1", intents: { s0: [SAVE_INTENT] }, scopes: 0 });
    expect(commandStore.commands.get(c.commandId)).not.toHaveProperty("scopes");
    clock += COMMAND_LEASE_MS + 1;
    expect((await policy.dueCommands({ caller: GATEWAY, recording: 1, repairs: 1 })).commands.map(d => d.commandId)).toContain(c.commandId);
  });

  it("answers an older worker's v3 admission as temporary, records no refusal, and marks the command", async () => {
    // An older worker owned it from before its models: it installs them
    // itself (which marks the command), then asks to admit.
    const c = await command({ langs: ["0013"], connectionId: "conn-1", intents: {}, scopes: 0 });
    expect(commandStore.commands.get(c.commandId)).not.toHaveProperty("scopes");
    // A manifest needing `snap` over a model that declares no intent for it:
    // only admission can tell.
    const e = await c.admit({ scopes: 0 }).catch(err => err);
    expect(e).toBeInstanceOf(PolicyUnavailable);
    expect(e.reason).toBe("worker-unsupported");
    const state = commandStore.commands.get(c.commandId);
    expect(state).toMatchObject({ status: "pending", scopes: 1 });
    expect(state).not.toHaveProperty("admissionRefusal");
    expect(plans()).toEqual([]);
  });

  it("reads a model's item-scoped intents for the mark", () => {
    expect(declaresItemScope(model("0013", [snapIntent()]))).toBe(true);
    expect(declaresItemScope(model("0013", [snapIntent({ kind: "item" })]))).toBe(true);
    expect(declaresItemScope(model("0013", [{ ...snapIntent(), scope: undefined }]))).toBe(true);
    expect(declaresItemScope(model("0176", [SAVE_INTENT]))).toBe(false);
    expect(declaresItemScope(model("0176", [{ ...SAVE_INTENT, scope: "conn-1" }]))).toBe(false);
    expect(declaresItemScope("not json")).toBe(false);
  });
});

describe("v3 admission (decisions 1, 3, 6, 10)", () => {
  it("admits an L0000 head over an L0013 capture of the owner's private item, with no connection", async () => {
    const c = await command({ langs: ["0000", "0013"], intents: { s1: [snapIntent()] } });
    const out = await c.admit();
    const [plan] = plans();
    const { stages, ...rest } = plan;
    expect(rest).toEqual({ contractVersion: 3, invocationId: c.invocationId, taskIds: c.taskIds, inputDigest: hex("9"), registryVersion: RV, scopes: [{ kind: "item", id: PRIVATE }] });
    expect(stages.map(m => [m.stage, m.lang, m.requiredFunctions])).toEqual([["s0", "0000", []], ["s1", "0013", ["snap"]]]);
    expect(out.planDigest).toBe(planDigest(plan));
    const admission = commandStore.commands.get(c.commandId).admission;
    expect(admission).toMatchObject({ contractVersion: 3, items: { [PRIVATE]: { publicCapture: false } } });
    expect(admission.stages.s1.intents[0].scope).toEqual({ kind: "item", id: PRIVATE });
    expect(items.state.lookups).toEqual([PRIVATE]);
    // A retry is acknowledged with the same plan.
    expect((await c.admit()).planDigest).toBe(out.planDigest);
  });

  it("refuses a non-owner's capture of a private item, and admits a public one under the exception", async () => {
    await denied((await command({ langs: ["0013"], uid: OTHER, intents: { s0: [snapIntent()] } })).admit(), "not-owner");
    const c = await command({ langs: ["0013"], uid: OTHER, intents: { s0: [snapIntent({ kind: "item", id: PUBLIC })] } });
    await c.admit();
    expect(commandStore.commands.get(c.commandId).admission.items).toEqual({ [PUBLIC]: { publicCapture: true } });
    // The owner's own capture of a public item isn't the exception.
    const own = await command({ langs: ["0013"], intents: { s0: [snapIntent({ kind: "item", id: PUBLIC })] } });
    await own.admit();
    expect(commandStore.commands.get(own.commandId).admission.items).toEqual({ [PUBLIC]: { publicCapture: false } });
  });

  it("admits an anonymous capture only of a public item", async () => {
    const pub = await command({ langs: ["0013"], anonymous: true, intents: { s0: [snapIntent({ kind: "item", id: PUBLIC })] } });
    await pub.admit();
    expect(commandStore.commands.get(pub.commandId).admission.items).toEqual({ [PUBLIC]: { publicCapture: true } });
    await denied((await command({ langs: ["0013"], anonymous: true, intents: { s0: [snapIntent()] } })).admit(), "not-owner");
  });

  it("refuses an item it can't establish, and never allows without item authority", async () => {
    await denied((await command({ langs: ["0013"], intents: { s0: [snapIntent({ kind: "item", id: "missing" })] } })).admit(), "item-not-found");
    await denied((await command({ langs: ["0013"], intents: { s0: [snapIntent({ kind: "item", id: "twice" })] } })).admit(), "item-ambiguous");
    items.state.unavailable = true;
    await denied((await command({ langs: ["0013"], intents: { s0: [snapIntent()] } })).admit(), "item-authority-unavailable");
    build({ itemAuthority: null });
    await denied((await command({ langs: ["0013"], intents: { s0: [snapIntent()] } })).admit(), "item-authority-unavailable");
    expect(plans()).toEqual([]);
  });

  // The owner's review of #402: an outage is temporary, never the command's
  // refusal, so the command stays pending and a later admission succeeds.
  it("answers an item-authority outage as temporary, and admits once it is back", async () => {
    const c = await command({ langs: ["0013"], intents: { s0: [snapIntent()] } });
    items.state.unavailable = true;
    const e = await c.admit().catch(err => err);
    expect(e).toBeInstanceOf(PolicyUnavailable);
    expect(e.reason).toBe("item-authority-unavailable");
    const state = commandStore.commands.get(c.commandId);
    expect(state).toMatchObject({ status: "pending", phase: "initializing" });
    expect(state).not.toHaveProperty("admissionRefusal");
    items.state.unavailable = false;
    await c.admit();
    expect(commandStore.commands.get(c.commandId).phase).toBe("admitted");
    // A definite refusal is still recorded.
    await denied((await command({ langs: ["0013"], uid: OTHER, intents: { s0: [snapIntent()] } })).admit(), "not-owner");
    expect([...commandStore.commands.values()].find(x => x.uid === OTHER).admissionRefusal).toMatchObject({ reason: "not-owner" });
  });

  it("refuses a connectionless chain with a connection-scoped stage, `connection-required`", async () => {
    const c = await command({ langs: ["0176", "0013"], intents: { s0: [SAVE_INTENT], s1: [snapIntent()] } });
    await denied(c.admit(), "connection-required");
    // And a connectionless chain with no item scope at all.
    const plain = await command({ langs: ["0000"] });
    await denied(plain.admit(), "connection-required");
  });

  it("admits a mixed chain as one v3 plan holding the connection and the item", async () => {
    const c = await command({ langs: ["0176", "0013"], connectionId: "conn-1", intents: { s0: [SAVE_INTENT], s1: [snapIntent()] } });
    await c.admit();
    const [plan] = plans();
    expect(plan).toMatchObject({ contractVersion: 3, connectionId: "conn-1", scopes: [{ kind: "connection", id: "conn-1" }, { kind: "item", id: PRIVATE }] });
    // The L0176 stage pins today's [1, 2] revision, under the per-stage rule.
    expect(plan.stages.map(s => s.revision)).toEqual([REVISION["0176"], REVISION["0013"]]);
  });

  it("refuses a connection scope that names another connection", async () => {
    const c = await command({ langs: ["0176", "0013"], connectionId: "conn-1", intents: { s0: [{ ...SAVE_INTENT, scope: { kind: "connection", id: "conn-2" } }], s1: [snapIntent()] } });
    await denied(c.admit(), "intent-mismatch");
  });

  it("puts a bound item in no plan, and still requires contract 3 of its stage", async () => {
    const c = await command({ langs: ["0013"], intents: { s0: [snapIntent({ kind: "item" })] } });
    await c.admit();
    expect(plans()[0].scopes).toEqual([]);
    expect(items.state.lookups).toEqual([]);
  });

  describe("the per-stage contract rule (decision 10)", () => {
    const pin = (lang, versions) => approvals.records.set(`${lang}/${REVISION[lang]}`, approved(lang, versions)[1]);

    it("needs 3 of a stage with an item-scoped intent", async () => {
      pin("0013", [1, 2]);
      await denied((await command({ langs: ["0013"], intents: { s0: [snapIntent()] } })).admit(), "contract-version-unsupported");
      pin("0013", [2, 3]);
      await (await command({ langs: ["0013"], intents: { s0: [snapIntent()] } })).admit();
    });

    it("takes 2 or 3 of a v3 plan's other stages", async () => {
      for (const versions of [[1, 2], [3], [2, 3]]) {
        pin("0176", versions);
        pin("0000", versions);
        await (await command({ langs: ["0176", "0013"], connectionId: "conn-1", intents: { s0: [SAVE_INTENT], s1: [snapIntent()] } })).admit();
        await (await command({ langs: ["0000", "0013"], intents: { s1: [snapIntent()] } })).admit();
      }
      pin("0176", [1]);
      await denied((await command({ langs: ["0176", "0013"], connectionId: "conn-1", intents: { s0: [SAVE_INTENT], s1: [snapIntent()] } })).admit(), "contract-version-unsupported");
    });

    it("checks a connection-only plan exactly as before: v2, the same digest, and 2 required", async () => {
      const c = await command({ langs: ["0000", "0176"], connectionId: "conn-1", intents: { s1: [SAVE_INTENT] }, scopes: 0 });
      const out = await c.admit({ scopes: 0 });
      const expected = { contractVersion: 2, invocationId: c.invocationId, taskIds: c.taskIds, connectionId: "conn-1", inputDigest: hex("9"), registryVersion: RV, stages: plans()[0].stages };
      expect(plans()[0]).toEqual(expected);
      expect(out.planDigest).toBe(planDigest(expected as any));
      expect(commandStore.commands.get(c.commandId).admission).not.toHaveProperty("contractVersion");
      expect(commandStore.commands.get(c.commandId)).not.toHaveProperty("scopes");
      pin("0176", [3]);
      await denied((await command({ langs: ["0000", "0176"], connectionId: "conn-1", intents: { s1: [SAVE_INTENT] }, scopes: 0 })).admit({ scopes: 0 }), "contract-version-unsupported");
    });
  });

  describe("mixed registry versions, with Policy at registry 9 (decision 10)", () => {
    beforeEach(() => build({ registryVersion: 9, registryWindow: [8] }));
    const at = (c, versions) => c.stages.map((m, i) => ({ ...m, registryVersion: versions[i] }));

    it("admits L0185 at 0 beside L0176 at 9, and refuses L0185 at 9", async () => {
      const c = await command({ langs: ["0176", "0185"], connectionId: "conn-1", intents: { s0: [SAVE_INTENT] }, scopes: 0 });
      await denied(c.admit({ stages: at(c, [9, 9]), scopes: 0 }), "registry-version-mismatch");
      await c.admit({ stages: at(c, [9, 0]), scopes: 0 });
      expect(plans()[0].registryVersion).toBe(9);
    });

    it("admits L0000 at 0 over L0013 at 9, and refuses L0013 at 8 beside L0176 at 9", async () => {
      const composed = await command({ langs: ["0000", "0013"], intents: { s1: [snapIntent()] } });
      await composed.admit({ stages: at(composed, [0, 9]) });
      const mixed = await command({ langs: ["0176", "0013"], connectionId: "conn-1", intents: { s0: [SAVE_INTENT], s1: [snapIntent()] } });
      await denied(mixed.admit({ stages: at(mixed, [9, 8]) }), "registry-version-mismatch");
    });
  });

  it("never admits an item-scoped function outside a command", async () => {
    const { invocationToken } = await policy.allocateInvocation({ caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: encodeChainId(["task-0"]), inputDigest: hex("9"), admission: true });
    await denied(policy.admit({ caller: GATEWAY, user: { uid: OWNER }, invocationToken, taskIds: ["task-0"], stages: [manifest("0013", 0)] }), "not-supported");
  });
});

describe("item authority (decision 3)", () => {
  const respond = (status, body) => new Response(JSON.stringify(body), { status });
  const client = handler => {
    const calls = [];
    const lookup = buildItemAuthority({ url: "https://console.example/api/internal/item-authority", idToken: async audience => `token-for:${audience}`, fetch: (async (url, init) => { calls.push({ url: String(url), init }); return handler(); }) as any });
    return { lookup, calls };
  };

  it("asks the console's route as Policy, for one item, and reads its answers", async () => {
    let body: any = { exists: true, ownerUid: OWNER, isPublic: false, taskId: "t", lang: "0002" };
    const { lookup, calls } = client(() => respond(200, body));
    expect(await lookup(PRIVATE)).toEqual({ exists: true, ownerUid: OWNER, isPublic: false, taskId: "t", lang: "0002" });
    expect(calls[0].url).toBe("https://console.example/api/internal/item-authority");
    expect(calls[0].init.headers.Authorization).toBe("Bearer token-for:https://console.example/api/internal/item-authority");
    expect(JSON.parse(calls[0].init.body)).toEqual({ itemId: PRIVATE });
    body = { status: "success", data: { exists: false } };
    expect(await lookup(PRIVATE)).toEqual({ exists: false });
    body = { ambiguous: true };
    expect(await lookup(PRIVATE)).toEqual({ ambiguous: true });
  });

  it("is unavailable, never allowing, on anything but an answer", async () => {
    for (const handler of [() => respond(500, {}), () => respond(200, { exists: true }), () => respond(200, { what: 1 }), () => { throw new Error("down"); }]) {
      await expect(client(handler).lookup(PRIVATE)).rejects.toBeInstanceOf(ItemAuthorityUnavailable);
    }
    await expect(client(() => respond(200, {})).lookup("a/b")).rejects.toThrow(/not an item id/);
  });
});

describe("audit (§3 records)", () => {
  it("records no connection for a command without one, and a capture's exception", () => {
    expect(validateAuditRecord({ event: "command", connectionId: null, outcome: "allowed" })).toEqual({ event: "command", outcome: "allowed" });
    expect(validateAuditRecord({ event: "admission", itemId: PUBLIC, publicCapture: true, provenance: "anonymous" })).toEqual({ event: "admission", itemId: PUBLIC, publicCapture: true, provenance: "anonymous" });
    expect(validateAuditRecord({ publicCapture: "yes" }).publicCapture).toBe("invalid");
  });

  it("names the item an admission refused", async () => {
    await denied((await command({ langs: ["0013"], uid: OTHER, intents: { s0: [snapIntent()] } })).admit(), "not-owner");
    expect(audits.find(r => r.outcome === "denied" && r.reason === "not-owner")).toMatchObject({ itemId: PRIVATE, connectionId: null });
  });
});
