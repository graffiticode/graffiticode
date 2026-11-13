// The command worker (B5 slice 5, docs/b5-commands-plan.md §6–§7), end to end
// against an in-process Policy with memory stores, a broker that keeps
// receipts (claim once, replay after) and asks Policy before each step, and a
// kernel-like language that binds each occurrence before it mints. The
// provider counts its writes: no test may see a write repeated.
import { generateKeyPair, exportJWK } from "jose";
import { decodeChainId, encodeChainId } from "@graffiticode/common/chain";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import {
  createPolicy,
  PolicyDenied,
  createLocalSigner,
  verifyToken,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryLeaseFence,
  createMemoryApprovals,
  createMemoryPublicationStore,
  createMemoryCommandStore,
  createMemoryCommandBackend,
  createCommandRecords,
  createProtectedSwitch,
  COMMAND_LEASE_MS,
  runtimeOccurrenceId
} from "@graffiticode/policy";
import { createMemoryReceiptStore, createReceiptReader, argsDigest } from "@graffiticode/broker";
import { buildCommandWorker } from "./worker.js";
import { parseCommandFaults } from "./faults.js";
import { buildSweep } from "./sweep.js";
import { buildCommandBridge, buildCompileEnvelope } from "./bridge.js";
import { PolicyRefused } from "./policy-commands.js";
import { buildMemoryArtifactStorer } from "../storage/artifacts.js";

const OWNER = "0xowner";
const GATEWAY = { role: "gateway" };
const L0176 = { role: "compiler", lang: "0176" };
const BROKER = { role: "broker" };
const WRITE = "learnosity.write-items";
const hex = c => c.repeat(64);
const IMAGES = { "0000": `sha256:${hex("0")}`, "0176": `sha256:${hex("1")}` };
const REVISIONS = { "0000": "l0000-r1", "0176": "l0176-r1" };
// The chain: s0 the L0176 head (one static save), s1 the L0000 data tail.
const TASKS = { "task-save": { lang: "0176", code: { root: "save" } }, "task-data": { lang: "0000", code: { root: "data" } } };
const CHAIN = encodeChainId(["task-save", "task-data"]);
/** @type {(lang: string) => [string, any]} */
const approved = lang => [`${lang}/${REVISIONS[lang]}`, { lang, revision: REVISIONS[lang], imageDigest: IMAGES[lang], tag: `t-${lang}`, tagUrl: `https://t-${lang}`, status: "approved", contractVersions: [1, 2] }];

let policy;
let connections;
let commands;
let clock;
let receipts;
let provider;
let artifacts;
let jwks;
let faults;

// The gateway's Policy client, in process: each call as the gateway, each
// refusal as the HTTP client throws it.
const client = () => {
  const as = fn => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof PolicyDenied) throw new PolicyRefused(e.reason);
      throw e;
    }
  };
  const write = (fn, argsOf = a => a) => as(({ commandId, generation, ...rest }) => policy.commandWrite({ caller: GATEWAY, commandId, generation, fn, args: argsOf(rest) }));
  return {
    read: as(({ commandId, what, stage = null }) => policy.commandRead({ caller: GATEWAY, commandId, what, stage })),
    due: as(({ limit = 20 } = {}) => policy.dueCommands({ caller: GATEWAY, limit, recording: 1 })),
    allocate: as(({ connectionId, taskId, inputDigest, idempotencyKey, lang, request, worker, create = true }) =>
      policy.allocateCommand({ caller: GATEWAY, user: { uid: OWNER }, connectionId, taskId, inputDigest, idempotencyKey, lang, request, worker, create })),
    // As the HTTP client does: this worker records outputs, and says so.
    lease: as(({ commandId, worker, generation, takeOver = false }) => policy.leaseCommand({ caller: GATEWAY, commandId, worker, generation, takeOver, recording: 1 })),
    installModel: write("installModel"),
    admit: as(({ commandId, generation, taskIds, stages, recording }) => policy.admitCommand({ caller: GATEWAY, commandId, generation, taskIds, stages, recording })),
    session: as(({ commandId, generation, stage }) => policy.commandSession({ caller: GATEWAY, commandId, generation, stage })),
    installInput: write("installInput"),
    installOutput: write("installOutput"),
    closeStage: write("closeStage"),
    notReached: write("markNotReached"),
    settle: as(({ commandId, generation }) => policy.settleCommand({ caller: GATEWAY, commandId, generation })),
    lost: write("recordLost"),
    finish: write("finish"),
    published: write("published"),
  };
};

// A broker that keeps receipts: Policy authorizes the step; the first token
// for an operation claims it and writes once; any later one replays.
const execute = async ({ executionToken, payload }) => {
  const { claims } = await verifyToken(jwks, "execution", executionToken);
  await policy.authorizeExecution({ caller: BROKER, executionToken, op: WRITE, argsDigest: argsDigest(payload), step: "questions", purpose: "dispatch", after: null });
  const claimed = await receipts.claim(claims.opid, { principal: claims.sub, ownerUid: claims.own, connectionId: claims.conn, lang: claims.lang, fn: claims.fn, op: WRITE, registryVersion: claims.rv, argsDigest: claims.argd });
  if (!claimed.created) {
    const outcome = await receipts.getOutcome(claims.opid);
    return outcome ? { ...outcome, replayed: true } : { status: "uncertain", replayed: true };
  }
  provider.push(payload);
  if (faults.loseAfterWrite) return { lost: true };
  await receipts.putOutcome(claims.opid, { status: "succeeded", steps: ["questions"], result: { saved: payload } });
  return { status: "succeeded", result: { saved: payload } };
};

// The stages' language services, like the kernel: L0176's start binds its
// occurrence under the session, mints, and executes at the broker.
const language = {
  baseUrlFor: async lang => `https://svc-${lang}`,
  model: async ({ lang, code }) => ({
    model: lang === "0176"
      ? { lang, kind: "plan", digest: hex("a"), program: code, intents: [{ id: "save", fn: "save-to-itembank", op: WRITE, occurrences: ["n1.0"] }] }
      : { lang, kind: "value", digest: hex("b"), value: { items: [1, 2] } },
    errors: [],
    revision: REVISIONS[lang],
  }),
  preflight: async ({ lang, stage, code }) => ({
    manifest: {
      stage,
      lang,
      sourceDigest: canonicalDigest(code),
      programDigest: hex("c"),
      optionsDigest: hex("d"),
      revision: REVISIONS[lang],
      imageDigest: IMAGES[lang],
      registryVersion: lang === "0176" ? REGISTRY_VERSION : 0,
      requiredFunctions: lang === "0176" ? ["save-to-itembank"] : [],
    },
  }),
  interpret: async ({ model }) => ({ data: model.value, errors: [] }),
  start: async ({ input, commandSession }) => {
    const payload = input.data;
    await policy.commandBind({ caller: L0176, sessionToken: commandSession, occurrenceId: "n1.0", intentId: "save", args: JSON.stringify(payload), argd: argsDigest(payload) });
    const { executionToken } = await policy.mint({ caller: L0176, sessionToken: commandSession, fn: "save-to-itembank", op: WRITE, occurrenceId: "n1.0", argsDigest: argsDigest(payload) });
    const outcome = await execute({ executionToken, payload });
    if (faults.crashAfterWrite) {
      faults.crashAfterWrite = false;
      throw new Error("the worker's process died");
    }
    if (outcome.lost || faults.loseAnswer) return { errors: [{ message: "lost" }], responseLost: true };
    // The program's final expression transforms what the save returned.
    return { data: { count: outcome.result.saved.items.length }, errors: [], occurrences: { save: ["n1.0"] } };
  },
};

const taskStorer = { get: async ({ id }) => decodeChainId(id).map(key => TASKS[key]) };

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  clock = Date.now();
  provider = [];
  faults = {};
  receipts = createMemoryReceiptStore();
  const readReceipts = createReceiptReader({ receipts });
  const leases = new Map();
  const invocations = createMemoryInvocationStore({ leases });
  commands = createMemoryCommandStore({ invocationStore: invocations });
  connections = createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]);
  artifacts = buildMemoryArtifactStorer();
  policy = createPolicy({
    signer,
    jwks,
    connections,
    invocations,
    commands,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore: commands }), now: () => clock }),
    brokerReceipts: readReceipts,
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals: createMemoryApprovals(new Map([approved("0000"), approved("0176")])),
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    now: () => clock,
  });
});

const allocate = (key = "job-1", worker = "w1") => policy.allocateCommand({
  caller: GATEWAY,
  user: { uid: OWNER },
  connectionId: "conn-1",
  taskId: CHAIN,
  inputDigest: hex("9"),
  idempotencyKey: key,
  lang: "0176",
  request: JSON.stringify({ id: CHAIN, connectionId: "conn-1", options: {} }),
  worker,
});
// No timers in tests: the lease is renewed by the tests' own clock moves.
/** @type {(name: string, lang?: any) => any} */
const workerAs = (name, lang = language) => buildCommandWorker({ policy: client(), taskStorer, language: lang, artifactStorer: artifacts, worker: name, setInterval: () => null, clearInterval: () => {}, log: () => {} });
// A takeover by a worker of this version, which records outputs.
const takeOver = async (commandId, generation, name, recording = 1) => {
  clock += COMMAND_LEASE_MS + 1;
  return policy.leaseCommand({ caller: GATEWAY, commandId, worker: name, generation, takeOver: true, recording });
};
const current = query => artifacts.getCurrent({ uid: OWNER, taskId: CHAIN, connectionId: "conn-1", registryVersion: REGISTRY_VERSION, ...query });

describe("a command, start to finish", () => {
  it("admits, pins, starts, settles from receipts, finishes and publishes the head's own result", async () => {
    const { commandId, generation } = await allocate();
    const state = await workerAs("w1")({ commandId, generation });
    expect(state).toMatchObject({ status: "completed", result: { state: "available" }, publication: { state: "published" } });
    expect(provider).toHaveLength(1);
    const published = await current();
    expect(published).toMatchObject({ status: "ok", artifact: { form: "result", content: { count: 2 } } });
  });

  it("returns the recorded outcome to a second run, with no new write", async () => {
    const { commandId, generation } = await allocate();
    await workerAs("w1")({ commandId, generation });
    const again = await workerAs("w1")({ commandId, generation });
    expect(again.status).toBe("completed");
    expect(provider).toHaveLength(1);
  });
});

describe("recovery", () => {
  it("resumes a worker that died after its write, replaying the receipt instead of writing again", async () => {
    const { commandId, generation } = await allocate();
    faults.crashAfterWrite = true;
    await expect(workerAs("w1")({ commandId, generation })).rejects.toThrow("died");
    const taken = await takeOver(commandId, generation, "w2");
    const state = await workerAs("w2")({ commandId, generation: taken.generation });
    expect(state).toMatchObject({ status: "completed", publication: { state: "published" } });
    expect(provider).toHaveLength(1);
  });

  it("fences out the old worker once another has taken over", async () => {
    const { commandId, generation } = await allocate();
    faults.crashAfterWrite = true;
    await expect(workerAs("w1")({ commandId, generation })).rejects.toThrow();
    await takeOver(commandId, generation, "w2");
    // The old worker, resuming with its generation, writes nothing.
    const stale = await workerAs("w1")({ commandId, generation });
    expect(stale).toMatchObject({ status: "pending", lost: "stale-generation" });
    expect(provider).toHaveLength(1);
  });

  it("finishes initialization for a command that died before admission", async () => {
    const { commandId, generation } = await allocate();
    // Only allocated: the next owner admits it, with no user token.
    const taken = await takeOver(commandId, generation, "w2");
    expect((await workerAs("w2")({ commandId, generation: taken.generation })).status).toBe("completed");
  });

  it("delivers a publication that finish committed before the worker died", async () => {
    const { commandId, generation } = await allocate();
    const real = artifacts.put;
    artifacts.put = async () => { throw new Error("the worker's process died"); };
    await expect(workerAs("w1")({ commandId, generation })).rejects.toThrow("died");
    artifacts.put = real;
    expect((await policy.commandRead({ caller: GATEWAY, commandId, what: "state" })).publication.state).toBe("due");
    const taken = await takeOver(commandId, generation, "w2");
    expect(await workerAs("w2")({ commandId, generation: taken.generation })).toMatchObject({ status: "completed", publication: { state: "published" } });
    expect((await current()).artifact.content).toEqual({ count: 2 });
  });
});

// The activation drive's faults (faults.js), as api-drive sets them: they act
// only for their principals, and recovery is the ordinary path.
// C3, plan decision 5: recovery starts at the furthest pinned boundary. A
// fetching stage (like L0185, no effects) feeds a save (like L0176 under
// start: a runtime expansion, so a lost answer leaves the command pending for
// recovery). Recovery must not fetch again once a save's input is pinned.
describe("recovery from the furthest pinned boundary (C3)", () => {
  let sources;
  let fetches;
  let lose;
  const fetchTask = name => ({ lang: "0000", code: { root: `fetch-${name}` } });
  const saveTask = name => ({ lang: "0176", code: { root: `save-${name}` } });
  const chainOf = (...tasks) => {
    const ids = tasks.map((task, i) => {
      const key = `c3-${i}-${task.code.root}`;
      TASKS[key] = task;
      return key;
    });
    return encodeChainId(ids);
  };
  // Stages are named by position: in `[save B, fetch B, save A, fetch A]`,
  // s0 is save B and s3 is fetch A, which runs first.
  const fetching = {
    ...language,
    model: async ({ lang, code }) => ({
      model: lang === "0176"
        ? { lang, kind: "plan", digest: hex("a"), program: code, intents: [{ id: "save:1", fn: "save-to-itembank", op: WRITE, runtime: true, bounds: { maxOccurrences: 4 } }] }
        : { lang, kind: "plan", digest: hex("b"), program: code },
      errors: [],
      revision: REVISIONS[lang],
    }),
    interpret: async ({ model }) => {
      const name = model.program.root.slice("fetch-".length);
      fetches.push(name);
      if (lose.fetch === name) {
        lose.fetch = null;
        return { errors: [{ message: "lost" }], responseLost: true };
      }
      return name in sources
        ? { data: sources[name], errors: [] }
        : { errors: [{ message: `fetch ${name}: the source is unavailable` }] };
    },
    start: async ({ input, commandSession, stage }) => {
      const key = `1#${stage}`;
      const occurrenceId = runtimeOccurrenceId("save:1", key);
      const payload = input.data;
      await policy.commandBind({ caller: L0176, sessionToken: commandSession, occurrenceId, intentId: "save:1", expansionKey: key, args: JSON.stringify(payload), argd: argsDigest(payload) });
      const { executionToken } = await policy.mint({ caller: L0176, sessionToken: commandSession, fn: "save-to-itembank", op: WRITE, occurrenceId, argsDigest: argsDigest(payload) });
      const outcome = await execute({ executionToken, payload });
      if (lose.save === stage) {
        lose.save = null;
        return { errors: [{ message: "lost" }], responseLost: true };
      }
      return { data: { saved: outcome.result.saved }, errors: [], occurrences: { "save:1": [occurrenceId] } };
    },
  };
  const allocateChain = (taskId, key = "c3") => policy.allocateCommand({
    caller: GATEWAY,
    user: { uid: OWNER },
    connectionId: "conn-1",
    taskId,
    inputDigest: hex("9"),
    idempotencyKey: key,
    lang: "0176",
    request: JSON.stringify({ id: taskId, connectionId: "conn-1", options: {} }),
    worker: "w1",
  });
  const head = taskId => current({ taskId });

  beforeEach(() => {
    sources = { A: { items: ["a1"] }, B: { items: ["b1"] } };
    fetches = [];
    lose = {};
  });

  it("a save's lost answer, then its source unavailable: resumes at the save with its pinned input, no fetch, no repeated write", async () => {
    const taskId = chainOf(saveTask("A"), fetchTask("A"));
    const { commandId, generation } = await allocateChain(taskId);
    lose.save = "s0";
    expect(await workerAs("w1", fetching)({ commandId, generation })).toMatchObject({ status: "pending", resume: true });
    expect(fetches).toEqual(["A"]);
    expect(provider).toEqual([{ items: ["a1"] }]);
    delete sources.A;
    fetches.length = 0;
    const taken = await takeOver(commandId, generation, "w2");
    const state = await workerAs("w2", fetching)({ commandId, generation: taken.generation });
    expect(state).toMatchObject({ status: "completed", result: { state: "available" }, publication: { state: "published" } });
    expect(fetches).toEqual([]);
    expect(provider).toHaveLength(1);
    expect((await head(taskId)).artifact.content).toEqual({ saved: { items: ["a1"] } });
  });

  it("a source that changed since the pin: the save replays with its original data", async () => {
    const taskId = chainOf(saveTask("A"), fetchTask("A"));
    const { commandId, generation } = await allocateChain(taskId);
    lose.save = "s0";
    await workerAs("w1", fetching)({ commandId, generation });
    sources.A = { items: ["changed"] };
    const taken = await takeOver(commandId, generation, "w2");
    expect((await workerAs("w2", fetching)({ commandId, generation: taken.generation })).status).toBe("completed");
    expect(provider).toEqual([{ items: ["a1"] }]);
    expect((await head(taskId)).artifact.content).toEqual({ saved: { items: ["a1"] } });
  });

  it("multiple saves: fetch A → save A → fetch B → save B, save B lost and fetch B down, resumes at save B", async () => {
    const taskId = chainOf(saveTask("B"), fetchTask("B"), saveTask("A"), fetchTask("A"));
    const { commandId, generation } = await allocateChain(taskId);
    lose.save = "s0";
    expect(await workerAs("w1", fetching)({ commandId, generation })).toMatchObject({ status: "pending", resume: true });
    expect(fetches).toEqual(["A", "B"]);
    expect(provider).toEqual([{ items: ["a1"] }, { items: ["b1"] }]);
    delete sources.A;
    delete sources.B;
    fetches.length = 0;
    const taken = await takeOver(commandId, generation, "w2");
    const state = await workerAs("w2", fetching)({ commandId, generation: taken.generation });
    expect(state).toMatchObject({ status: "completed", result: { state: "available" } });
    // Neither fetch ran, save A wasn't repeated, and save B replayed its receipt.
    expect(fetches).toEqual([]);
    expect(provider).toHaveLength(2);
    expect((await head(taskId)).artifact.content).toEqual({ saved: { items: ["b1"] } });
  });

  it("still checks authorization: a connection revoked before recovery stops the resumed stage at its session", async () => {
    const taskId = chainOf(saveTask("A"), fetchTask("A"));
    const { commandId, generation } = await allocateChain(taskId);
    lose.save = "s0";
    await workerAs("w1", fetching)({ commandId, generation });
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
    fetches.length = 0;
    const taken = await takeOver(commandId, generation, "w2");
    const state = await workerAs("w2", fetching)({ commandId, generation: taken.generation });
    // Recorded from the receipt; no new write, no fetch, no result.
    expect(state.status).not.toBe("pending");
    expect(state.result).toMatchObject({ state: "unavailable" });
    expect(fetches).toEqual([]);
    expect(provider).toHaveLength(1);
  });

  it("still fences: the old worker, resuming with a stale generation, writes nothing", async () => {
    const taskId = chainOf(saveTask("A"), fetchTask("A"));
    const { commandId, generation } = await allocateChain(taskId);
    lose.save = "s0";
    await workerAs("w1", fetching)({ commandId, generation });
    await takeOver(commandId, generation, "w2");
    fetches.length = 0;
    expect(await workerAs("w1", fetching)({ commandId, generation })).toMatchObject({ status: "pending", lost: "stale-generation" });
    expect(fetches).toEqual([]);
    expect(provider).toHaveLength(1);
  });

  // B6 (docs/b6-command-repair-plan.md decision 5): every stage's output is
  // recorded before the stage above pins its input, and recovery consumes it.
  describe("recorded outputs", () => {
    const exited = () => { throw new Error("the process exited"); };
    const exitingAfterOutput = name => buildCommandWorker({
      policy: client(),
      taskStorer,
      language: fetching,
      artifactStorer: artifacts,
      worker: name,
      faults: parseCommandFaults({ K_SERVICE: "api-drive", API_COMMAND_FAULTS: "exit-after-output", API_COMMAND_FAULT_PRINCIPALS: OWNER }, { exit: exited }),
      setInterval: () => null,
      clearInterval: () => {},
      log: () => {},
    });
    const read = (commandId, what, stage = null) => policy.commandRead({ caller: GATEWAY, commandId, what, stage });
    const argsOfSaves = async commandId => (await read(commandId, "occurrences")).occurrences.map(o => JSON.parse(o.args));

    // The owner's review of #384: a worker from before B6 must never own a
    // command that records outputs. It would fetch again what was recorded
    // (and fail the command if the source is gone).
    it("refuses a worker that doesn't record outputs, at takeover and at renewal, and the command waits for one that does", async () => {
      const taskId = chainOf(saveTask("A"), fetchTask("A"));
      const { commandId, generation } = await allocateChain(taskId);
      await expect(exitingAfterOutput("w1")({ commandId, generation })).rejects.toThrow("exited");
      delete sources.A;
      fetches.length = 0;
      // While its lease is live, a renewal without the capability is refused.
      await expect(policy.leaseCommand({ caller: GATEWAY, commandId, worker: "w1", generation, takeOver: false })).rejects.toMatchObject({ reason: "worker-unsupported" });
      await expect(takeOver(commandId, generation, "old-worker", 0)).rejects.toMatchObject({ reason: "worker-unsupported" });
      expect((await read(commandId, "state")).generation).toBe(generation);
      const taken = await takeOver(commandId, generation, "w2");
      expect((await workerAs("w2", fetching)({ commandId, generation: taken.generation })).status).toBe("completed");
      expect(fetches).toEqual([]);
      expect(provider).toEqual([{ items: ["a1"] }]);
    });

    // The owner's review of 9c61320f: after an api rollback, recording
    // commands an older sweeper can't own must not fill its sweeps and hide
    // the legacy commands it can.
    it("never lets recording commands it can't own crowd an older sweeper's legacy commands out", async () => {
      const taskId = chainOf(saveTask("A"), fetchTask("A"));
      for (let i = 0; i < 20; i++) {
        const { commandId, generation } = await allocateChain(taskId, `recording-${i}`);
        await expect(exitingAfterOutput("w1")({ commandId, generation })).rejects.toThrow("exited");
      }
      const legacy = await allocateChain(taskId, "legacy-pending");
      clock += COMMAND_LEASE_MS + 1;
      // An api from before this slice: it neither records nor says so.
      const old = client();
      const oldClient = {
        ...old,
        due: ({ limit = 20 } = {}) => policy.dueCommands({ caller: GATEWAY, limit }),
        lease: async args => {
          try {
            return await policy.leaseCommand({ caller: GATEWAY, ...args, recording: 0 });
          } catch (e) {
            if (e instanceof PolicyDenied) throw new PolicyRefused(e.reason);
            throw e;
          }
        },
        admit: args => old.admit({ ...args, recording: 0 }),
      };
      const run = buildCommandWorker({ policy: oldClient, taskStorer, language: fetching, artifactStorer: artifacts, worker: "old-worker", setInterval: () => null, clearInterval: () => {}, log: () => {} });
      const sweep = buildSweep({ policy: oldClient, run, worker: "old-worker", log: () => {} });
      expect(await sweep()).toMatchObject({ due: 1, taken: 1, skipped: 0 });
      expect((await read(legacy.commandId, "state")).status).toBe("completed");
      // The recording commands are listed only to a recording sweeper.
      expect((await oldClient.due()).commands).toEqual([]);
      expect((await client().due()).commands).toHaveLength(20);
    });

    it("lets any worker own a command admitted without recording, as before", async () => {
      const taskId = chainOf(saveTask("A"), fetchTask("A"));
      const { commandId, generation } = await allocateChain(taskId);
      const c = commands.commands.get(commandId);
      commands.commands.set(commandId, { ...c, owner: { ...c.owner, leaseExpiresAt: 0 } });
      expect(await takeOver(commandId, generation, "old-worker", 0)).toMatchObject({ commandId });
    });

    // The owner's review of #384: an output too large to record, below a
    // save whose output was recorded, must not send recovery back below it.
    describe("an earlier output too large to record", () => {
      const special = () => {
        const counted = { saveStarts: 0 };
        const language = {
          ...fetching,
          interpret: async ({ model, input }) => {
            const name = model.program.root.slice("fetch-".length);
            if (name === "large") return { data: { items: ["a1"], big: "x".repeat(600_000) }, errors: [] };
            if (name === "trim") return { data: { items: input.data.items }, errors: [] };
            return { data: input.data, errors: [] };
          },
          start: async args => {
            counted.saveStarts++;
            return fetching.start(args);
          },
        };
        return { counted, language };
      };
      // Execution order: fetch large (s3, too large to record), trim (s2),
      // save A (s1), finish (s0, the head). The worker dies right after save
      // A's output is recorded.
      const crashAfterSave = async () => {
        const taskId = chainOf(fetchTask("finish"), saveTask("A"), fetchTask("trim"), fetchTask("large"));
        const { counted, language: lang } = special();
        const { commandId, generation } = await allocateChain(taskId);
        const dying = client();
        const install = dying.installOutput;
        dying.installOutput = async args => {
          const out = await install(args);
          if (args.stage === "s1") throw new Error("crash after the save's output");
          return out;
        };
        const first = buildCommandWorker({ policy: dying, taskStorer, language: lang, artifactStorer: artifacts, worker: "w1", setInterval: () => null, clearInterval: () => {}, log: () => {} });
        await expect(first({ commandId, generation })).rejects.toThrow("crash after the save's output");
        const stages = (await read(commandId, "state")).stages;
        expect(stages.s3.output).toBe("too-large");
        expect(stages.s1.output).toBeTruthy();
        counted.saveStarts = 0;
        return { taskId, commandId, generation, counted, lang };
      };

      it("resumes above the recorded save, never restarting it", async () => {
        const { commandId, generation, counted, lang } = await crashAfterSave();
        const taken = await takeOver(commandId, generation, "w2");
        expect((await workerAs("w2", lang)({ commandId, generation: taken.generation })).status).toBe("completed");
        expect(counted.saveStarts).toBe(0);
        expect(provider).toHaveLength(1);
      });

      it("completes and publishes from the recorded save after the connection is revoked", async () => {
        const { taskId, commandId, generation, counted, lang } = await crashAfterSave();
        await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
        const taken = await takeOver(commandId, generation, "w2");
        const done = await workerAs("w2", lang)({ commandId, generation: taken.generation });
        expect(done).toMatchObject({ status: "completed", result: { state: "available" }, publication: { state: "published" } });
        expect(counted.saveStarts).toBe(0);
        expect((await head(taskId)).artifact.content).toEqual({ saved: { items: ["a1"] } });
      });
    });

    it("records each stage's output once, and the head's is the result", async () => {
      const taskId = chainOf(saveTask("A"), fetchTask("A"));
      const { commandId, generation } = await allocateChain(taskId);
      expect((await workerAs("w1", fetching)({ commandId, generation })).status).toBe("completed");
      const state = await read(commandId, "state");
      expect(state.admission.recording).toBe(1);
      const fetched = (await read(commandId, "output", "s1")).output;
      expect(JSON.parse(fetched.text)).toEqual({ data: { items: ["a1"] }, errors: [] });
      // The save pinned exactly the fetch's output.
      expect(state.stages.s0.pinnedInput).toBe(state.stages.s1.output);
      const head = (await read(commandId, "output", "s0")).output;
      expect(JSON.parse(head.text).data).toEqual(JSON.parse((await read(commandId, "result")).result.text));
    });

    /** @type {[string, () => void][]} */
    const changes = [
      ["changed", () => { sources.A = { items: ["changed"] }; }],
      ["unavailable", () => { delete sources.A; }],
    ];
    for (const [what, change] of changes) {
      it(`a crash after the fetch's output is recorded, before the save pins it, then the source ${what}: recovery uses the recorded output and never fetches`, async () => {
        const taskId = chainOf(saveTask("A"), fetchTask("A"));
        const { commandId, generation } = await allocateChain(taskId);
        await expect(exitingAfterOutput("w1")({ commandId, generation })).rejects.toThrow("exited");
        const crashed = await read(commandId, "state");
        expect(crashed.stages.s1.output).toBeTruthy();
        expect(crashed.stages.s0.pinnedInput).toBeNull();
        expect(provider).toHaveLength(0);
        change();
        fetches.length = 0;
        const taken = await takeOver(commandId, generation, "w2");
        expect((await workerAs("w2", fetching)({ commandId, generation: taken.generation })).status).toBe("completed");
        expect(fetches).toEqual([]);
        // The save ran once, with what the fetch produced before the crash.
        expect(provider).toEqual([{ items: ["a1"] }]);
        expect(await argsOfSaves(commandId)).toEqual([{ items: ["a1"] }]);
        expect((await head(taskId)).artifact.content).toEqual({ saved: { items: ["a1"] } });
      });
    }

    it("never starts a save again once its output is recorded", async () => {
      // Execution order: fetch A, save A, fetch B, save B (the head).
      const taskId = chainOf(saveTask("B"), fetchTask("B"), saveTask("A"), fetchTask("A"));
      const { commandId, generation } = await allocateChain(taskId);
      // The first exit comes after fetch A's output; recover past it, then
      // exit again after save A's.
      await expect(exitingAfterOutput("w1")({ commandId, generation })).rejects.toThrow("exited");
      let taken = await takeOver(commandId, generation, "w2");
      await expect(exitingAfterOutput("w2")({ commandId, generation: taken.generation })).rejects.toThrow("exited");
      // Save A is s2: its output is recorded, fetch B's (s1) isn't yet.
      const crashed = (await read(commandId, "state")).stages;
      expect([Boolean(crashed.s2.output), crashed.s1.output]).toEqual([true, undefined]);
      expect(provider).toEqual([{ items: ["a1"] }]);
      let starts = 0;
      const counting = { ...fetching, start: async args => { starts++; return fetching.start(args); } };
      fetches.length = 0;
      taken = await takeOver(commandId, taken.generation, "w3");
      expect((await workerAs("w3", counting)({ commandId, generation: taken.generation })).status).toBe("completed");
      // Only fetch B and save B ran; save A answered from its recorded output.
      expect(fetches).toEqual(["B"]);
      expect(starts).toBe(1);
      expect(provider).toEqual([{ items: ["a1"] }, { items: ["b1"] }]);
    });
  });

  it("with no pinned input yet, recovery runs every stage, as before", async () => {
    const taskId = chainOf(saveTask("A"), fetchTask("A"));
    const { commandId, generation } = await allocateChain(taskId);
    lose.fetch = "A";
    expect(await workerAs("w1", fetching)({ commandId, generation })).toMatchObject({ status: "pending", resume: true });
    expect(provider).toHaveLength(0);
    const taken = await takeOver(commandId, generation, "w2");
    expect((await workerAs("w2", fetching)({ commandId, generation: taken.generation })).status).toBe("completed");
    expect(fetches).toEqual(["A", "A"]);
    expect(provider).toEqual([{ items: ["a1"] }]);
  });
});

describe("the drive's worker faults", () => {
  const exited = () => { throw new Error("the process exited"); };
  const withFaults = (name, env) => buildCommandWorker({
    policy: client(),
    taskStorer,
    language,
    artifactStorer: artifacts,
    worker: name,
    faults: parseCommandFaults({ K_SERVICE: "api-drive", ...env }, { exit: exited }),
    setInterval: () => null,
    clearInterval: () => {},
    log: () => {},
  });

  it("exit-after-write: the worker dies after its write, and the next owner completes it with no repeated write", async () => {
    const { commandId, generation } = await allocate();
    await expect(withFaults("w1", { API_COMMAND_FAULTS: "exit-after-write", API_COMMAND_FAULT_PRINCIPALS: OWNER })({ commandId, generation })).rejects.toThrow("exited");
    expect(provider).toHaveLength(1);
    expect((await policy.commandRead({ caller: GATEWAY, commandId, what: "state" })).status).toBe("pending");
    const taken = await takeOver(commandId, generation, "w2");
    expect(await workerAs("w2")({ commandId, generation: taken.generation })).toMatchObject({ status: "completed", publication: { state: "published" } });
    expect(provider).toHaveLength(1);
  });

  it("lose-head-answer: completed from the receipt, with no result and nothing published", async () => {
    const { commandId, generation } = await allocate();
    const state = await withFaults("w1", { API_COMMAND_FAULTS: "lose-head-answer", API_COMMAND_FAULT_PRINCIPALS: OWNER })({ commandId, generation });
    expect(state).toMatchObject({ status: "completed", result: { state: "unavailable" }, publication: { state: "none" } });
    expect(provider).toHaveLength(1);
  });

  it("acts on no other principal", async () => {
    const { commandId, generation } = await allocate();
    const state = await withFaults("w1", { API_COMMAND_FAULTS: "exit-after-write,lose-head-answer", API_COMMAND_FAULT_PRINCIPALS: "0xsomeone-else" })({ commandId, generation });
    expect(state).toMatchObject({ status: "completed", result: { state: "available" } });
  });

  it("is refused on the production service, unknown, or without principals, and absent when unset", () => {
    expect(() => parseCommandFaults({ K_SERVICE: "api", API_COMMAND_FAULTS: "exit-after-write", API_COMMAND_FAULT_PRINCIPALS: OWNER })).toThrow("production");
    expect(() => parseCommandFaults({ K_SERVICE: "api-drive", API_COMMAND_FAULTS: "drop-everything", API_COMMAND_FAULT_PRINCIPALS: OWNER })).toThrow("unknown");
    expect(() => parseCommandFaults({ K_SERVICE: "api-drive", API_COMMAND_FAULTS: "exit-after-write" })).toThrow("PRINCIPALS");
    expect(() => parseCommandFaults({ K_SERVICE: "api", API_COMMAND_FAULTS: "exit-after-output", API_COMMAND_FAULT_PRINCIPALS: OWNER })).toThrow("production");
    expect(parseCommandFaults({ K_SERVICE: "api" })).toBeNull();
  });
});

describe("outcomes", () => {
  it("is completed with no result, and publishes nothing, when the head's answer was lost after its write", async () => {
    const { commandId, generation } = await allocate();
    faults.loseAnswer = true;
    const state = await workerAs("w1")({ commandId, generation });
    expect(state).toMatchObject({ status: "completed", result: { state: "unavailable" }, publication: { state: "none" } });
    expect((await current()).status).toBe("missing");
  });

  it("is uncertain when the write's receipt was claimed with no outcome and the answer was lost", async () => {
    const { commandId, generation } = await allocate();
    faults.loseAfterWrite = true;
    expect((await workerAs("w1")({ commandId, generation })).status).toBe("uncertain");
  });

  it("is failed, with nothing written, when the connection is revoked before admission", async () => {
    const { commandId, generation } = await allocate();
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
    expect((await workerAs("w1")({ commandId, generation })).status).toBe("failed");
    expect(provider).toHaveLength(0);
  });

  it("stays completed when the connection is revoked after the write, before finish", async () => {
    const { commandId, generation } = await allocate();
    faults.crashAfterWrite = true;
    await expect(workerAs("w1")({ commandId, generation })).rejects.toThrow();
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
    const taken = await takeOver(commandId, generation, "w2");
    const state = await workerAs("w2")({ commandId, generation: taken.generation });
    // Settled from the receipt; the head's own answer is gone, so no result.
    expect(state).toMatchObject({ status: "completed", result: { state: "unavailable" } });
    expect(provider).toHaveLength(1);
  });
});

describe("the sweeper", () => {
  it("recovers a command whose worker died, with no caller retry and no repeated write", async () => {
    const { commandId, generation } = await allocate();
    faults.crashAfterWrite = true;
    await expect(workerAs("w1")({ commandId, generation })).rejects.toThrow("died");
    // Nothing is due while the dead worker's lease runs.
    const sweep = buildSweep({ policy: client(), run: workerAs("sweeper"), worker: "sweeper", log: () => {} });
    expect(await sweep()).toMatchObject({ due: 0 });
    clock += COMMAND_LEASE_MS + 1;
    expect(await sweep()).toMatchObject({ due: 1, taken: 1, failed: 0 });
    const state = await policy.commandRead({ caller: GATEWAY, commandId, what: "state" });
    expect(state).toMatchObject({ status: "completed", publication: { state: "published" }, generation: 2 });
    expect(provider).toHaveLength(1);
    // Done: nothing is due any more.
    clock += COMMAND_LEASE_MS + 1;
    expect(await sweep()).toMatchObject({ due: 0 });
  });
});

// C6 slice 0: a save past its intent's bound is refused and recorded, so the
// command is partial, through the complete worker and through recovery.
describe("a save past the bound", () => {
  const BOUND = 2;
  // Like L0176 under start: one runtime intent; each save is an expansion,
  // bound under the session before it mints. A refused bind makes the stage
  // report an error, and that save isn't in the stage's occurrence list.
  const expanding = {
    ...language,
    model: async ({ lang, code }) => ({
      model: lang === "0176"
        ? { lang, kind: "plan", digest: hex("a"), program: code, intents: [{ id: "save:1", fn: "save-to-itembank", op: WRITE, runtime: true, bounds: { maxOccurrences: BOUND } }] }
        : { lang, kind: "value", digest: hex("b"), value: { items: [1, 2, 3] } },
      errors: [],
      revision: REVISIONS[lang],
    }),
    start: async ({ input, commandSession }) => {
      const performed = [];
      const errors = [];
      for (const item of input.data.items) {
        const key = `1#${item}`;
        const occurrenceId = runtimeOccurrenceId("save:1", key);
        const payload = { item };
        try {
          await policy.commandBind({ caller: L0176, sessionToken: commandSession, occurrenceId, intentId: "save:1", expansionKey: key, args: JSON.stringify(payload), argd: argsDigest(payload) });
        } catch (e) {
          errors.push({ message: `save ${item} refused (${e.reason})` });
          continue;
        }
        const { executionToken } = await policy.mint({ caller: L0176, sessionToken: commandSession, fn: "save-to-itembank", op: WRITE, occurrenceId, argsDigest: argsDigest(payload) });
        await execute({ executionToken, payload });
        performed.push(occurrenceId);
        if (faults.crashAfterSecondWrite && performed.length === 2) {
          faults.crashAfterSecondWrite = false;
          throw new Error("the worker's process died");
        }
      }
      return { data: { saved: performed.length }, errors, occurrences: { "save:1": performed } };
    },
  };

  // The same expansion within its bound, whose answer can be lost once.
  const roomy = {
    ...expanding,
    model: async args => {
      const out = await expanding.model(args);
      if (args.lang === "0176") out.model.intents[0].bounds.maxOccurrences = 10;
      return out;
    },
    start: async args => {
      const answer = await expanding.start(args);
      if (faults.loseExpandingAnswer) {
        faults.loseExpandingAnswer = false;
        return { errors: [{ message: "lost" }], responseLost: true };
      }
      return answer;
    },
  };

  it("leaves a lost answer with its expansion open pending, and recovery resumes the stage to completed with no repeated write", async () => {
    const { commandId, generation } = await allocate();
    faults.loseExpandingAnswer = true;
    // Every save ran; only the answer, which closes the expansion, was lost.
    expect(await workerAs("w1", roomy)({ commandId, generation })).toMatchObject({ status: "pending", resume: true });
    expect(provider).toHaveLength(3);
    const taken = await takeOver(commandId, generation, "w2");
    const state = await workerAs("w2", roomy)({ commandId, generation: taken.generation });
    expect(state).toMatchObject({ status: "completed", result: { state: "available" }, publication: { state: "published" } });
    expect(provider).toHaveLength(3);
    expect((await current()).artifact.content).toEqual({ saved: 3 });
  });

  it("the sweeper resumes it with no caller retry", async () => {
    const { commandId, generation } = await allocate();
    faults.loseExpandingAnswer = true;
    await workerAs("w1", roomy)({ commandId, generation });
    clock += COMMAND_LEASE_MS + 1;
    const sweep = buildSweep({ policy: client(), run: workerAs("sweeper", roomy), worker: "sweeper", log: () => {} });
    await sweep();
    expect((await policy.commandRead({ caller: GATEWAY, commandId, what: "state" })).status).toBe("completed");
    expect(provider).toHaveLength(3);
  });

  it("the drive's lose-head-answer fault leaves it pending too, and an unfaulted owner completes it", async () => {
    const { commandId, generation } = await allocate();
    const faulted = buildCommandWorker({
      policy: client(),
      taskStorer,
      language: roomy,
      artifactStorer: artifacts,
      worker: "w1",
      faults: parseCommandFaults({ K_SERVICE: "api-drive", API_COMMAND_FAULTS: "lose-head-answer", API_COMMAND_FAULT_PRINCIPALS: OWNER }),
      setInterval: () => null,
      clearInterval: () => {},
      log: () => {},
    });
    expect(await faulted({ commandId, generation })).toMatchObject({ status: "pending", resume: true });
    const taken = await takeOver(commandId, generation, "w2");
    expect(await workerAs("w2", roomy)({ commandId, generation: taken.generation })).toMatchObject({ status: "completed", result: { state: "available" } });
    expect(provider).toHaveLength(3);
  });

  it("ends partial: the saves within the bound written once, the extra one recorded failed", async () => {
    const { commandId, generation } = await allocate();
    const state = await workerAs("w1", expanding)({ commandId, generation });
    expect(state).toMatchObject({ status: "partial", counts: { completed: BOUND, failed: 1 }, publication: { state: "none" } });
    expect(provider).toHaveLength(BOUND);
    const { refusals } = await policy.commandRead({ caller: GATEWAY, commandId, what: "refusals" });
    expect(refusals.map(r => r.reason)).toEqual(["bounds-exceeded"]);
    // A retry with the same key writes nothing more.
    expect((await workerAs("w1", expanding)({ commandId, generation })).status).toBe("partial");
    expect(provider).toHaveLength(BOUND);
  });

  it("ends partial after a crash too: the sweeper replays the writes and meets the refusal", async () => {
    const { commandId, generation } = await allocate();
    faults.crashAfterSecondWrite = true;
    await expect(workerAs("w1", expanding)({ commandId, generation })).rejects.toThrow("died");
    clock += COMMAND_LEASE_MS + 1;
    const sweep = buildSweep({ policy: client(), run: workerAs("sweeper", expanding), worker: "sweeper", log: () => {} });
    expect(await sweep()).toMatchObject({ taken: 1, failed: 0 });
    const state = await policy.commandRead({ caller: GATEWAY, commandId, what: "state" });
    expect(state).toMatchObject({ status: "partial", counts: { completed: BOUND, failed: 1 } });
    expect(provider).toHaveLength(BOUND);
  });

  it("completes at exactly the bound", async () => {
    const atBound = {
      ...expanding,
      model: async args => {
        const out = await expanding.model(args);
        return args.lang === "0176" ? out : { ...out, model: { ...out.model, value: { items: [1, 2] } } };
      }
    };
    const { commandId, generation } = await allocate();
    expect(await workerAs("w1", atBound)({ commandId, generation })).toMatchObject({ status: "completed", publication: { state: "published" } });
    expect(provider).toHaveLength(BOUND);
  });
});

// C6 slice 2: a compile through a connection whose chain is eligible runs as
// a command and answers in today's compile envelope.
describe("the compile-to-command bridge", () => {
  const bridgeAs = name => buildCommandBridge({
    eligible: async () => true,
    getRunner: () => ({ policy: client(), run: workerAs(name), worker: name }),
    compileEnvelope: buildCompileEnvelope({ policy: client() }),
  });
  const compile = (key = "save:item-1") => bridgeAs("w1")({ tasks: [TASKS["task-save"], TASKS["task-data"]], id: CHAIN, authToken: "t", connectionId: "conn-1", options: {}, idempotencyKey: key });

  it("answers as a compile does: the head's result, and the save as an effect", async () => {
    const envelope = await compile();
    expect(envelope).toMatchObject({
      data: { count: 2 },
      errors: [],
      effects: [{ fn: "save-to-itembank", op: WRITE, status: "succeeded", steps: ["questions"], stage: "s0" }],
    });
    expect(envelope.effects[0].replayed).toBeUndefined();
    expect(provider).toHaveLength(1);
  });

  it("answers a retry with the same key from the record, its write replayed and not repeated", async () => {
    await compile();
    const again = await compile();
    expect(again).toMatchObject({ data: { count: 2 }, errors: [], effects: [{ status: "succeeded", replayed: true }] });
    expect(provider).toHaveLength(1);
  });

  it("reports a lost answer as a compile would: no data, an error, the write uncertain", async () => {
    faults.loseAfterWrite = true;
    const envelope = await compile();
    expect(envelope.data).toBeUndefined();
    expect(envelope.errors[0]).toMatchObject({ code: "command-not-completed" });
    expect(envelope.effects[0].status).toBe("uncertain");
  });
});
