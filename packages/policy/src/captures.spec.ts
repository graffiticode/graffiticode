// C5a slice 3c (docs/c5-l0013-commands-plan.md decisions 4, 8 and 9): a
// capture's reservation, staging and bind, the public-capture rate limit, and
// bound items authorized at reservation, against memory stores.
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { encodeChainId } from "@graffiticode/common/chain";
import {
  createPolicy,
  PolicyDenied,
  PolicyUnavailable,
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
  createMemoryStagingStore,
  buildStagingStore,
  stagedName,
  verifyToken,
  COMMAND_LEASE_MS,
  PUBLIC_CAPTURE_LIMIT,
} from "./index.js";
import { createHash } from "node:crypto";

const OWNER = "0xowner";
const OTHER = "0xother";
const GATEWAY = { role: "gateway" };
const L0013 = { role: "compiler", lang: "0013" };
const BROKER = { role: "broker" };
const PRIVATE = "privateItem00000001";
const PUBLIC = "publicItem000000001";
const hex = c => c.repeat(64);
const IMAGE = `sha256:${hex("3")}`;
const PUT = "gcs.put-thumbnail";
const pngOf = (label: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(label)]);
const b64 = (label: string) => pngOf(label).toString("base64");
const sha = (label: string) => createHash("sha256").update(pngOf(label)).digest("hex");
const snapIntent = (scope: unknown = { kind: "item", id: PRIVATE }, occurrences = ["n0.0"]) => ({ id: "snap", fn: "snap", op: PUT, occurrences, scope });

let policy;
let deps;
let commandStore;
let records;
let items;
let staging;
let clock;
let keys = 0;

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
  const invocations = createMemoryInvocationStore({ leases });
  commandStore = createMemoryCommandStore({ invocationStore: invocations });
  records = createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }), now: () => clock });
  items = createMemoryItemAuthority({ [PRIVATE]: { ownerUid: OWNER, isPublic: false }, [PUBLIC]: { ownerUid: OWNER, isPublic: true } });
  staging = createMemoryStagingStore();
  deps = {
    signer,
    jwks,
    connections: createMemoryConnectionStore([]),
    invocations,
    commands: commandStore,
    commandRecords: records,
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals: createMemoryApprovals(new Map([["0013/l0013r-r1", { lang: "0013", revision: "l0013r-r1", imageDigest: IMAGE, tag: "t", tagUrl: "https://t", status: "approved", contractVersions: [3] }]])),
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    itemAuthority: items,
    staging,
    now: () => clock,
  };
  build();
});

const denied = async (promise, reason) => {
  const e = await promise.catch(err => err);
  expect(e).toBeInstanceOf(PolicyDenied);
  expect(e.reason).toBe(reason);
  return e;
};

// An admitted L0013 command over `stages` (one snap intent each), with a
// session per stage.
const capture = async ({ uid = OWNER, anonymous = false, intents = [snapIntent()], stages = 1 } = {}) => {
  const taskIds = Array.from({ length: stages }, (_x, i) => `task-${i}`);
  const { commandId, invocationId } = await policy.allocateCommand({
    caller: GATEWAY, user: anonymous ? null : { uid }, anonymous, taskId: encodeChainId(taskIds), inputDigest: hex("9"), idempotencyKey: `job-${++keys}`, lang: "0013", request: "{}", worker: "api-1", scopes: 1,
  });
  for (let i = 0; i < stages; i++) {
    await policy.commandWrite({ caller: GATEWAY, commandId, generation: 1, fn: "installModel", args: { stage: `s${i}`, text: JSON.stringify({ lang: "0013", kind: "plan", carried: {}, intents }) } });
  }
  await policy.admitCommand({
    caller: GATEWAY,
    commandId,
    generation: 1,
    taskIds,
    scopes: 1,
    stages: taskIds.map((_t, i) => ({ stage: `s${i}`, lang: "0013", sourceDigest: hex("b"), programDigest: hex(String(i)), optionsDigest: hex("d"), revision: "l0013r-r1", imageDigest: IMAGE, registryVersion: REGISTRY_VERSION, requiredFunctions: ["snap"] })),
  });
  const session = async (stage = "s0", generation = 1) => (await policy.commandSession({ caller: GATEWAY, commandId, generation, stage })).sessionToken;
  return { commandId, invocationId, session };
};
const reserve = (sessionToken, over = {}) => policy.commandReserve({ caller: L0013, sessionToken, occurrenceId: "n0.0", intentId: "snap", ...over });
const stage = (sessionToken, label, over = {}) => policy.commandStage({ caller: L0013, sessionToken, occurrenceId: "n0.0", png: b64(label), ...over });
const bind = (c, args, { stage: stg = "s0", generation = 1 } = {}) => policy.commandWrite({ caller: GATEWAY, commandId: c.commandId, generation, fn: "bindOccurrence", args: { stage: stg, occurrenceId: "n0.0", intentId: "snap", args: JSON.stringify(args), argd: hex("a") } });
const outcomes = async c => (await policy.commandRead({ caller: GATEWAY, commandId: c.commandId, what: "outcomes" })).outcomes;

describe("reserve, stage and bind (decision 9)", () => {
  it("run in order, each once: a repeat answers what is recorded", async () => {
    const c = await capture();
    const s = await c.session();
    const reserved = await reserve(s);
    expect(reserved).toEqual({ item: PRIVATE, captureSequence: 1, publicCapture: false, staged: null });
    expect(await reserve(s)).toEqual(reserved);
    const staged = await stage(s, "first");
    expect(staged).toEqual({ item: PRIVATE, captureSequence: 1, sha256: sha("first"), size: pngOf("first").length });
    expect([...staging.state.objects.keys()]).toEqual([stagedName({ commandId: c.commandId, stage: "s0", occurrenceId: "n0.0" })]);
    // After staging, a retry renders nothing: reserve answers the staged digest.
    expect(await reserve(s)).toEqual({ ...reserved, staged: { sha256: sha("first"), size: pngOf("first").length } });
    expect(await stage(s, "second")).toEqual(staged);
    expect(staging.state.creates).toHaveLength(1);
    const args = { item: PRIVATE, sha256: sha("first"), captureSequence: 1 };
    expect(await bind(c, args)).toMatchObject({ bound: true });
    // The occurrence names its item, which its token selects.
    const { executionToken } = await policy.mint({ caller: L0013, sessionToken: s, fn: "snap", op: PUT, occurrenceId: "n0.0", argsDigest: hex("a") });
    expect((await verifyToken(deps.jwks, "execution", executionToken)).claims.scp).toEqual({ kind: "item", id: PRIVATE });
  });

  it("takes each capture of an item the next sequence, across commands", async () => {
    for (const expected of [1, 2, 3]) {
      const c = await capture();
      expect((await reserve(await c.session())).captureSequence).toBe(expected);
    }
    expect((await records.getItemCaptures(PRIVATE)).nextCaptureSequence).toBe(4);
  });

  it("binds only exactly the reserved and staged arguments", async () => {
    const c = await capture();
    const s = await c.session();
    await reserve(s);
    // Not staged yet.
    await denied(bind(c, { item: PRIVATE, sha256: sha("x"), captureSequence: 1 }), "binding-mismatch");
    expect((await outcomes(c)).map(o => [o.occurrenceId, o.outcome])).toEqual([]);
    const other = await capture();
    const t = await other.session();
    await reserve(t);
    await stage(t, "x");
    for (const args of [
      { item: PRIVATE, sha256: sha("y"), captureSequence: 2 },
      { item: PRIVATE, sha256: sha("x"), captureSequence: 3 },
      { item: PUBLIC, sha256: sha("x"), captureSequence: 2 },
      { item: PRIVATE, sha256: sha("x"), captureSequence: 2, extra: 1 },
    ]) {
      const fresh = await capture();
      const u = await fresh.session();
      await reserve(u);
      await stage(u, "x");
      await denied(bind(fresh, args), "binding-mismatch");
    }
  });

  it("refuses a bind with no reservation", async () => {
    const c = await capture();
    await denied(bind(c, { item: PRIVATE, sha256: sha("x"), captureSequence: 1 }), "occurrence-not-reserved");
  });

  it("refuses staging without a reservation, and anything but a PNG", async () => {
    const c = await capture();
    const s = await c.session();
    await denied(stage(s, "x"), "occurrence-not-reserved");
    await reserve(s);
    await denied(stage(s, "x", { png: Buffer.from("GIF89a").toString("base64") }), "payload-rejected");
    await denied(stage(s, "x", { png: "" }), "payload-rejected");
  });

  it("stages two stages with the same occurrence id separately", async () => {
    const c = await capture({ stages: 2 });
    const [s0, s1] = [await c.session("s0"), await c.session("s1")];
    const r0 = await reserve(s0);
    const r1 = await reserve(s1);
    expect([r0.captureSequence, r1.captureSequence]).toEqual([1, 2]);
    expect((await stage(s0, "zero")).sha256).toBe(sha("zero"));
    expect((await stage(s1, "one")).sha256).toBe(sha("one"));
    expect([...staging.state.objects.keys()].sort()).toEqual([`${c.commandId}/s0/n0.0.png`, `${c.commandId}/s1/n0.0.png`]);
    await bind(c, { item: PRIVATE, sha256: sha("zero"), captureSequence: 1 }, { stage: "s0" });
    await bind(c, { item: PRIVATE, sha256: sha("one"), captureSequence: 2 }, { stage: "s1" });
  });

  describe("crashes at each boundary", () => {
    it("after the staging object is written, before the record: the retry adopts the bytes staged first", async () => {
      const c = await capture();
      const s = await c.session();
      await reserve(s);
      staging.state.loseCreateAck = true;
      // The acknowledgment is lost; the object stands. The record moves.
      expect((await stage(s, "first")).sha256).toBe(sha("first"));
      staging.state.loseCreateAck = false;
      // Or the record write fails after the object: the retry's own render
      // is discarded, and the first bytes are staged.
      const d = await capture();
      const t = await d.session();
      await reserve(t);
      const markStaged = records.markStaged;
      records.markStaged = async () => { throw new Error("crash"); };
      await expect(stage(t, "first")).rejects.toThrow(/crash/);
      records.markStaged = markStaged;
      expect(await stage(t, "second")).toMatchObject({ sha256: sha("first") });
    });

    it("refuses a stale worker at reserve, stage and bind; its staging object, if it won, is adopted", async () => {
      const c = await capture();
      const stale = await c.session();
      await reserve(stale);
      const takeOver = async () => {
        clock += COMMAND_LEASE_MS + 1;
        await policy.leaseCommand({ caller: GATEWAY, commandId: c.commandId, worker: "api-2", generation: 1, takeOver: true, recording: 1, repairs: 1, scopes: 1 });
      };
      // The stale worker's lease ends while it is writing the object: it wins
      // the race to create it, then its record write is fenced.
      const create = staging.create;
      staging.create = async (name, bytes) => {
        const out = await create(name, bytes);
        staging.create = create;
        await takeOver();
        return out;
      };
      await denied(stage(stale, "stale"), "stale-generation");
      expect((await records.getReservation(c.commandId, "s0", "n0.0")).state).toBe("reserved");
      // Every later call of the stale worker is fenced, a repeat included.
      await denied(reserve(stale), "stale-generation");
      await denied(stage(stale, "stale"), "stale-generation");
      const fresh = await c.session("s0", 2);
      // The new owner continues from the recorded state and adopts those bytes.
      expect(await reserve(fresh)).toMatchObject({ captureSequence: 1, staged: null });
      expect(await stage(fresh, "fresh")).toMatchObject({ sha256: sha("stale") });
      await denied(bind(c, { item: PRIVATE, sha256: sha("stale"), captureSequence: 1 }, { generation: 1 }), "stale-generation");
      expect(await bind(c, { item: PRIVATE, sha256: sha("stale"), captureSequence: 1 }, { generation: 2 })).toMatchObject({ bound: true });
    });
  });

  it("answers staging that can't be reached as temporary, staging nothing", async () => {
    const c = await capture();
    const s = await c.session();
    await reserve(s);
    staging.state.fail = true;
    const e = await stage(s, "x").catch(err => err);
    expect(e).toBeInstanceOf(PolicyUnavailable);
    expect((await records.getReservation(c.commandId, "s0", "n0.0")).state).toBe("reserved");
    build({ staging: null });
    expect(await stage(s, "x").catch(err => err)).toBeInstanceOf(PolicyUnavailable);
  });
});

describe("bound items, authorized at reservation (decision 1)", () => {
  it("refuses a non-owner's private item at reservation, recorded on the occurrence", async () => {
    const c = await capture({ uid: OTHER, intents: [snapIntent({ kind: "item" })] });
    const s = await c.session();
    await denied(reserve(s, { item: PRIVATE }), "not-owner");
    expect((await outcomes(c)).map(o => [o.occurrenceId, o.outcome, o.reason])).toEqual([["n0.0", "failed", "not-owner"]]);
    expect(await records.getReservation(c.commandId, "s0", "n0.0")).toBeNull();
  });

  it("reserves a non-owner's public item under the exception, and the owner's own", async () => {
    const c = await capture({ uid: OTHER, intents: [snapIntent({ kind: "item" })] });
    expect(await reserve(await c.session(), { item: PUBLIC })).toMatchObject({ item: PUBLIC, publicCapture: true });
    const own = await capture({ intents: [snapIntent({ kind: "item" })] });
    expect(await reserve(await own.session(), { item: PRIVATE })).toMatchObject({ item: PRIVATE, publicCapture: false });
  });

  it("needs the item for a bound intent, and the intent's own for a static one", async () => {
    const bound = await capture({ intents: [snapIntent({ kind: "item" })] });
    await denied(reserve(await bound.session()), "bad-request");
    const c = await capture();
    await denied(reserve(await c.session(), { item: PUBLIC }), "intent-mismatch");
  });

  it("answers an item-authority outage as temporary, recording nothing", async () => {
    const c = await capture({ intents: [snapIntent({ kind: "item" })] });
    items.state.unavailable = true;
    expect(await reserve(await c.session(), { item: PRIVATE }).catch(e => e)).toBeInstanceOf(PolicyUnavailable);
    expect(await outcomes(c)).toEqual([]);
  });
});

describe("the public-capture rate limit (decision 4)", () => {
  const publicCapture = async ({ uid = OTHER, anonymous = false } = {}) => {
    const c = await capture({ uid, anonymous, intents: [snapIntent({ kind: "item", id: PUBLIC })] });
    return reserve(await c.session());
  };

  it("allows 12 public captures of an item an hour, across signed-in non-owners and anonymous callers, and refuses the 13th", async () => {
    for (let i = 0; i < PUBLIC_CAPTURE_LIMIT.perWindow; i++) await publicCapture(i % 2 ? { anonymous: true } : { uid: `0xuser${i}` });
    const e = await denied(publicCapture({ anonymous: true }), "rate-limited");
    expect(e.retryAfter).toBe(3600);
    await denied(publicCapture(), "rate-limited");
    // Owners have no per-item limit, and aren't counted.
    expect(await publicCapture({ uid: OWNER })).toMatchObject({ publicCapture: false });
    // An hour after the first, there is room again.
    clock += PUBLIC_CAPTURE_LIMIT.windowMs + 1;
    expect(await publicCapture()).toMatchObject({ publicCapture: true });
  });

  it("counts a reservation once, however often it is repeated", async () => {
    const c = await capture({ uid: OTHER, intents: [snapIntent({ kind: "item", id: PUBLIC })] });
    const s = await c.session();
    for (let i = 0; i < 20; i++) await reserve(s);
    expect((await records.getItemCaptures(PUBLIC)).publicCaptures).toHaveLength(1);
  });
});

describe("the live check against the reservation (decision 9)", () => {
  it("refuses a capture reserved as the owner's once only the exception would allow it", async () => {
    const c = await capture({ intents: [snapIntent({ kind: "item", id: PUBLIC })] });
    const s = await c.session();
    await reserve(s);
    await stage(s, "x");
    await bind(c, { item: PUBLIC, sha256: sha("x"), captureSequence: 1 });
    const { executionToken } = await policy.mint({ caller: L0013, sessionToken: s, fn: "snap", op: PUT, occurrenceId: "n0.0", argsDigest: hex("a") });
    const authorize = () => policy.authorizeExecution({ caller: BROKER, executionToken, op: PUT, argsDigest: hex("a"), step: "publish", purpose: "dispatch", after: null, attempt: 1 });
    await authorize();
    // The item changes owner; it is still public, but this capture was never
    // counted under the exception.
    items.state.items.set(PUBLIC, { ownerUid: OTHER, isPublic: true });
    await denied(authorize(), "not-owner");
  });
});

describe("the staging client", () => {
  it("creates once, adopts nothing itself, and reads back", async () => {
    const calls = [];
    let status = 200;
    const store = buildStagingStore({
      bucket: "graffiticode-command-staging",
      accessToken: async () => "access-token",
      fetch: (async (url, init) => { calls.push({ url: String(url), init }); return new Response(status === 404 ? "" : "png", { status }); }) as any,
    });
    expect(await store.create("c:1/s0/n0.0.png", pngOf("x"))).toEqual({ created: true });
    expect(calls[0].url).toContain("ifGenerationMatch=0");
    expect(calls[0].url).toContain(`name=${encodeURIComponent("c:1/s0/n0.0.png")}`);
    expect(calls[0].init.headers.Authorization).toBe("Bearer access-token");
    status = 412;
    expect(await store.create("c:1/s0/n0.0.png", pngOf("x"))).toEqual({ created: false });
    status = 503;
    await expect(store.create("c:1/s0/n0.0.png", pngOf("x"))).rejects.toThrow(/503/);
    status = 404;
    expect(await store.read("c:1/s0/n0.0.png")).toBeNull();
    status = 200;
    expect(Buffer.from(await store.read("c:1/s0/n0.0.png")).toString()).toBe("png");
  });
});
