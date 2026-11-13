// The repair run (B6 slice 4, docs/b6-command-repair-plan.md decisions 2, 6–9,
// 11), end to end against an in-process Policy with memory stores, a broker
// that keeps receipts and can reject or drop a write, and a kernel-like L0176
// whose start answers recorded occurrences from their records and whose
// materialize acts on nothing. The provider counts its writes.
import express from "express";
import request from "supertest";
import { generateKeyPair, exportJWK } from "jose";
import { encodeChainId } from "@graffiticode/common/chain";
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
} from "@graffiticode/policy";
import { createMemoryReceiptStore, createReceiptReader, argsDigest } from "@graffiticode/broker";
import { buildCommandWorker } from "./worker.js";
import { materializeCommand } from "./records.js";
import { PolicyRefused } from "./policy-commands.js";
import { buildCommandRouter } from "../routes/command.js";
import { buildMemoryArtifactStorer } from "../storage/artifacts.js";
import { ARTIFACT_RESULT_FORM } from "../read.js";

const OWNER = "0xowner";
const GATEWAY = { role: "gateway" };
const L0176 = { role: "compiler", lang: "0176" };
const BROKER = { role: "broker" };
const CONSOLE = { role: "console" };
const WRITE = "learnosity.write-items";
const hex = c => c.repeat(64);
const IMAGES = { "0000": `sha256:${hex("0")}`, "0176": `sha256:${hex("1")}` };
const REVISIONS = { "0000": "l0000-r1", "0176": "l0176-r1" };
const TAG = lang => `https://t-${lang}`;
// L0176 programs: `ab` saves two occurrences (A, then B), `one`, `lower` and
// `upper` one each. L0000's `data` is a value.
const OCCURRENCES = { ab: ["n1.0", "n1.1"], one: ["n1.0"], lower: ["n1.0"], upper: ["n1.0"] };
const TASKS = {
  "task-ab": { lang: "0176", code: { root: "ab" } },
  "task-one": { lang: "0176", code: { root: "one" } },
  "task-lower": { lang: "0176", code: { root: "lower" } },
  "task-upper": { lang: "0176", code: { root: "upper" } },
  "task-data": { lang: "0000", code: { root: "data" } },
};
const AB = encodeChainId(["task-ab", "task-data"]);
const ONE = encodeChainId(["task-one", "task-data"]);
const STACK = encodeChainId(["task-upper", "task-lower", "task-data"]);
/** @type {(lang: string) => [string, any]} */
const approved = lang => [`${lang}/${REVISIONS[lang]}`, { lang, revision: REVISIONS[lang], imageDigest: IMAGES[lang], tag: `t-${lang}`, tagUrl: TAG(lang), status: "approved", contractVersions: [1, 2] }];

let policy;
let commands;
let clock;
let receipts;
let provider;
let artifacts;
let jwks;
let faults;
let calls;
let reconciled;

const client = () => {
  const as = fn => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof PolicyDenied) throw new PolicyRefused(e.reason, e.detail ?? null);
      throw e;
    }
  };
  const write = fn => as(({ commandId, generation, ...rest }) => policy.commandWrite({ caller: GATEWAY, commandId, generation, fn, args: rest }));
  return {
    read: as(({ commandId, what, stage = null }) => policy.commandRead({ caller: GATEWAY, commandId, what, stage })),
    due: as(({ limit = 20 } = {}) => policy.dueCommands({ caller: GATEWAY, limit, recording: 1, repairs: 1 })),
    get: as(({ commandId }) => policy.getCommand({ caller: GATEWAY, user: { uid: OWNER }, commandId })),
    allocateRepair: as(({ commandId, idempotencyKey, occurrences = null, worker }) => policy.allocateRepair({ caller: GATEWAY, user: { uid: OWNER }, commandId, idempotencyKey, occurrences, worker })),
    lease: as(({ commandId, worker, generation, takeOver = false }) => policy.leaseCommand({ caller: GATEWAY, commandId, worker, generation, takeOver, recording: 1, repairs: 1 })),
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

// The broker: Policy authorizes the step; the first token for an operation
// claims it. A rejected write records a failed outcome and writes nothing; a
// dropped one writes and records no outcome.
const execute = async ({ executionToken, payload, ref }) => {
  const { claims } = await verifyToken(jwks, "execution", executionToken);
  await policy.authorizeExecution({ caller: BROKER, executionToken, op: WRITE, argsDigest: argsDigest(payload), step: "questions", purpose: "dispatch", after: null });
  const claimed = await receipts.claim(claims.opid, { principal: claims.sub, ownerUid: claims.own, connectionId: claims.conn, lang: claims.lang, fn: claims.fn, op: WRITE, registryVersion: claims.rv, argsDigest: claims.argd });
  if (!claimed.created) {
    const outcome = await receipts.getOutcome(claims.opid);
    return outcome ? { ...outcome, replayed: true } : { status: "uncertain", replayed: true };
  }
  if (faults.reject?.has(ref)) {
    await receipts.putOutcome(claims.opid, { status: "failed", steps: [], reason: "provider-rejected" });
    return { status: "failed" };
  }
  provider.push(payload);
  const result = { saved: payload, ref };
  if (faults.drop?.has(ref)) return { lost: true, result };
  await receipts.putOutcome(claims.opid, { status: "succeeded", steps: ["questions"], result });
  return { status: "succeeded", result };
};

// Each occurrence's payload and the stage's answer, from the program and its
// input: the same for a first run, a repair and a materialization.
const payloadOf = (model, input, occ) => ({ items: input?.data?.items ?? [], at: `${model.program.root}:${occ}` });
const answerOf = (input, results) => ({ items: input?.data?.items ?? [], refs: results.map(r => r.ref) });

const language = {
  baseUrlFor: async lang => `https://svc-${lang}`,
  model: async ({ lang, code }) => ({
    model: lang === "0176"
      ? { lang, kind: "plan", digest: hex("a"), program: code, intents: [{ id: "save", fn: "save-to-itembank", op: WRITE, occurrences: OCCURRENCES[code.root] }] }
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
      // A revision from before slice 1 says nothing about replay.
      ...(lang === "0176" && !faults.noReplay ? { replay: 1 } : {}),
    },
  }),
  interpret: async ({ model }) => ({ data: model.value, errors: [] }),
  // Like the kernel's start: a recorded completed occurrence answers from its
  // record (its arguments must be the recorded ones); a blocked one stops the
  // stage; any other is bound, minted and executed.
  start: async ({ model, input, commandSession, recorded = null, baseUrl }) => {
    calls.push({ op: "start", root: model.program.root, baseUrl, recorded });
    const results = [];
    const performed = [];
    const stop = code => ({ data: null, errors: [{ message: code, code }], occurrences: { save: performed } });
    for (const occ of model.intents[0].occurrences) {
      const payload = payloadOf(model, input, occ);
      const argd = argsDigest(payload);
      const record = recorded?.completed?.[occ];
      if (record) {
        if (record.argd !== argd) return stop("args-mismatch");
        results.push(record.result);
        continue;
      }
      if (recorded?.blocked?.includes(occ)) return stop("not-selected");
      try {
        await policy.commandBind({ caller: L0176, sessionToken: commandSession, occurrenceId: occ, intentId: "save", args: JSON.stringify(payload), argd });
      } catch (e) {
        if (e instanceof PolicyDenied) return stop(e.reason);
        throw e;
      }
      performed.push(occ);
      const { executionToken } = await policy.mint({ caller: L0176, sessionToken: commandSession, fn: "save-to-itembank", op: WRITE, occurrenceId: occ, argsDigest: argd });
      const outcome = await execute({ executionToken, payload, ref: `${model.program.root}-${occ}` });
      if (faults.crashAfterWrite) {
        faults.crashAfterWrite = false;
        throw new Error("the worker's process died");
      }
      if (outcome.lost) return { errors: [{ message: "lost" }], responseLost: true };
      if (outcome.status !== "succeeded") return stop("save-failed");
      results.push(outcome.result);
    }
    return { data: answerOf(input, results), errors: [], occurrences: { save: performed } };
  },
  // Like the kernel's replay: every occurrence from its record, nothing live.
  materialize: async ({ model, input, recorded, baseUrl }) => {
    calls.push({ op: "materialize", root: model.program.root, baseUrl });
    const results = [];
    for (const occ of model.intents[0].occurrences) {
      const record = recorded.completed[occ];
      if (!record) return { data: null, errors: [{ code: "not-recorded" }] };
      if (record.argd !== argsDigest(payloadOf(model, input, occ))) return { data: null, errors: [{ code: "args-mismatch" }] };
      results.push(record.result);
    }
    return { data: answerOf(input, results), errors: [], replayed: { save: model.intents[0].occurrences } };
  },
};

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  clock = Date.now();
  provider = [];
  faults = {};
  calls = [];
  reconciled = () => [];
  receipts = createMemoryReceiptStore();
  const leases = new Map();
  const invocations = createMemoryInvocationStore({ leases });
  commands = createMemoryCommandStore({ invocationStore: invocations });
  artifacts = buildMemoryArtifactStorer();
  policy = createPolicy({
    signer,
    jwks,
    connections: createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]),
    invocations,
    commands,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore: commands }), now: () => clock }),
    brokerReceipts: createReceiptReader({ receipts }),
    brokerReconcile: async ({ invocationId }) => ({ invocationId, operations: reconciled(invocationId) }),
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals: createMemoryApprovals(new Map([approved("0000"), approved("0176")])),
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    now: () => clock,
  });
});

const chainTasks = { [AB]: ["task-ab", "task-data"], [ONE]: ["task-one", "task-data"], [STACK]: ["task-upper", "task-lower", "task-data"] };
const tasksOf = { get: async ({ id }) => chainTasks[id].map(k => TASKS[k]) };
/** @type {(name: string) => any} */
const workerAs = name => buildCommandWorker({ policy: client(), taskStorer: tasksOf, language, artifactStorer: artifacts, worker: name, setInterval: () => null, clearInterval: () => {}, log: () => {} });
const run = async (chain, key = "job-1") => {
  const command = await policy.allocateCommand({
    caller: GATEWAY,
    user: { uid: OWNER },
    connectionId: "conn-1",
    taskId: chain,
    inputDigest: hex("9"),
    idempotencyKey: key,
    lang: "0176",
    request: JSON.stringify({ id: chain, connectionId: "conn-1", options: {} }),
    worker: "w1",
  });
  return { command, done: await workerAs("w1")({ commandId: command.commandId, generation: 1 }) };
};
const repairOf = async (commandId, key = "repair-1", occurrences = null) => {
  const repair = await client().allocateRepair({ commandId, idempotencyKey: key, occurrences, worker: "w-repair" });
  return { repair, done: await workerAs("w-repair")({ commandId: repair.commandId, generation: repair.generation }) };
};
const artifactOf = async invocationId => (await artifacts.getByInvocation(invocationId))?.content ?? null;
const current = chain => artifacts.getCurrent({ uid: OWNER, taskId: chain, connectionId: "conn-1", registryVersion: REGISTRY_VERSION });
const materialize = commandId => materializeCommand({ policy: client(), language, artifactStorer: artifacts, commandId, registryVersion: REGISTRY_VERSION, form: ARTIFACT_RESULT_FORM });
const ledgerOf = async commandId => (await policy.commandRead({ caller: GATEWAY, commandId, what: "ledger" })).ledger;
// What a clean run of AB produces: both saves' references.
const CLEAN_AB = { items: [1, 2], refs: ["ab-n1.0", "ab-n1.1"] };

describe("a partly completed stage (7a)", () => {
  it("executes only the failed occurrence: one provider write, A answered from its record, published as the original's artifact", async () => {
    faults.reject = new Set(["ab-n1.1"]);
    const { command, done } = await run(AB);
    expect(done).toMatchObject({ status: "partial", publication: { state: "none" } });
    expect(provider).toHaveLength(1);
    expect(await artifactOf(command.invocationId)).toBeNull();
    faults.reject = new Set();
    const { repair, done: repaired } = await repairOf(command.commandId);
    expect(repair.selection).toEqual([{ stage: "s0", occurrenceId: "n1.1" }]);
    expect(repaired).toMatchObject({ kind: "repair", status: "completed", publication: { state: "published", artifact: { invocationId: command.invocationId, seq: command.seq } } });
    // One more write, B's; A answered from its record.
    expect(provider).toHaveLength(2);
    expect(provider[1].at).toBe("ab:n1.1");
    const start = calls.filter(c => c.op === "start").at(-1);
    expect(Object.keys(start.recorded.completed)).toEqual(["n1.0"]);
    expect(start.recorded.blocked).toEqual([]);
    // A's receipt is untouched: one claim, one outcome, under the original.
    const ledger = await ledgerOf(command.commandId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ occurrenceId: "n1.1", status: "completed", repairId: repair.commandId });
    // The artifact is the original invocation's, equal to a clean run's.
    expect(await artifactOf(command.invocationId)).toEqual(CLEAN_AB);
    expect(await artifactOf(repair.invocationId)).toBeNull();
    // A second repair finds nothing to do, and repeats nothing.
    await expect(repairOf(command.commandId, "repair-2", [{ stage: "s0", occurrenceId: "n1.1" }])).rejects.toMatchObject({ reason: "not-eligible" });
    expect(provider).toHaveLength(2);
  });

  it("runs at the original's pinned revision (its tagUrl), never the language's current URL (decision 11)", async () => {
    faults.reject = new Set(["ab-n1.1"]);
    const { command } = await run(AB);
    faults.reject = new Set();
    await repairOf(command.commandId);
    expect(calls.filter(c => c.op === "start").map(c => c.baseUrl)).toEqual([TAG("0176"), TAG("0176")]);
  });

  it("refuses a command admitted on a revision without replay, revision-unsupported, and runs nothing", async () => {
    faults.reject = new Set(["ab-n1.1"]);
    faults.noReplay = true;
    const { command } = await run(AB);
    faults.reject = new Set();
    await expect(repairOf(command.commandId)).rejects.toMatchObject({ reason: "revision-unsupported" });
    expect(provider).toHaveLength(1);
    expect(await ledgerOf(command.commandId)).toEqual([]);
  });

  it("recovers a repair whose worker died after its write: taken over, no repeated write", async () => {
    faults.reject = new Set(["ab-n1.1"]);
    const { command } = await run(AB);
    faults.reject = new Set();
    faults.crashAfterWrite = true;
    const repair = await client().allocateRepair({ commandId: command.commandId, idempotencyKey: "repair-1", worker: "w-repair" });
    await expect(workerAs("w-repair")({ commandId: repair.commandId, generation: 1 })).rejects.toThrow("died");
    clock += COMMAND_LEASE_MS + 1;
    const taken = await client().lease({ commandId: repair.commandId, worker: "w-2", generation: 1, takeOver: true });
    const done = await workerAs("w-2")({ commandId: repair.commandId, generation: taken.generation });
    expect(done).toMatchObject({ status: "completed", publication: { state: "published" } });
    expect(provider).toHaveLength(2);
    expect(await artifactOf(command.invocationId)).toEqual(CLEAN_AB);
  });
});

describe("resumption (7b)", () => {
  it("repairs the lower save of an L0176 → L0176 chain, then runs the stage the original never reached", async () => {
    faults.reject = new Set(["lower-n1.0"]);
    const { command, done } = await run(STACK);
    expect(done.status).toBe("failed");
    expect(done.stages.s0.state).toBe("not-reached");
    faults.reject = new Set();
    const { repair, done: repaired } = await repairOf(command.commandId);
    expect(repaired).toMatchObject({ status: "completed", publication: { state: "published" } });
    expect(provider.map(p => p.at)).toEqual(["lower:n1.0", "upper:n1.0"]);
    // The head's save was new to its stage: claimed at bind, by the repair.
    const ledger = await ledgerOf(command.commandId);
    expect(ledger.find(e => e.stage === "s0")).toMatchObject({ status: "completed", claim: "bind", repairId: repair.commandId });
    expect(await artifactOf(command.invocationId)).toEqual({ items: [1, 2], refs: ["upper-n1.0"] });
  });
});

describe("a dropped outcome (decision 2)", () => {
  const dropped = async () => {
    faults.drop = new Set(["one-n1.0"]);
    const { command, done } = await run(ONE);
    expect(done.status).toBe("uncertain");
    expect(provider).toHaveLength(1);
    return command;
  };
  const reconcile = command => policy.reconcile({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", invocationId: command.invocationId });
  const op = command => `${command.invocationId}/s0/n1.0`;

  it("reconciled applied, then materialized from records: equal to a clean run, with no further write", async () => {
    const command = await dropped();
    reconciled = () => [{ operationId: op(command), verdict: "applied", final: true, result: { saved: provider[0], ref: "one-n1.0" }, resultSource: "evidence" }];
    await reconcile(command);
    expect(await materialize(command.commandId)).toEqual({ ok: true, published: "current" });
    expect(provider).toHaveLength(1);
    expect(calls.filter(c => c.op === "materialize").map(c => c.baseUrl)).toEqual([TAG("0176")]);
    expect(await artifactOf(command.invocationId)).toEqual({ items: [1, 2], refs: ["one-n1.0"] });
    // Again: the stored artifact is the answer, never rebuilt.
    expect(await materialize(command.commandId)).toEqual({ ok: true, published: "already" });
    expect(calls.filter(c => c.op === "materialize")).toHaveLength(1);
  });

  it("leaves a write whose result can't be reconstructed unmaterializable: output-unavailable", async () => {
    const command = await dropped();
    reconciled = () => [{ operationId: op(command), verdict: "applied", final: true, result: null, resultSource: "unavailable" }];
    await reconcile(command);
    expect(await materialize(command.commandId)).toMatchObject({ ok: false, reason: "output-unavailable", stage: "s0", occurrenceId: "n1.0" });
    expect(await artifactOf(command.invocationId)).toBeNull();
  });

  it("permits neither completion nor resumption on unknown-format evidence", async () => {
    const command = await dropped();
    reconciled = () => [{ operationId: op(command), verdict: "unresolved", reason: "evidence-format-unknown" }];
    await reconcile(command);
    expect(await ledgerOf(command.commandId)).toEqual([]);
    expect(await materialize(command.commandId)).toMatchObject({ ok: false, reason: "not-complete", occurrenceId: "n1.0" });
    await expect(repairOf(command.commandId)).rejects.toMatchObject({ reason: "nothing-to-repair" });
    expect(provider).toHaveLength(1);
  });
});

// Decision 8: the original invocation's artifact, under its sequence.
describe("newer work", () => {
  it("never overwrites a newer command's published artifact", async () => {
    faults.reject = new Set(["ab-n1.1"]);
    const { command } = await run(AB);
    faults.reject = new Set();
    const { command: newer } = await run(AB, "job-2");
    expect((await current(AB)).artifact.invocationId).toBe(newer.invocationId);
    await repairOf(command.commandId);
    expect(await artifactOf(command.invocationId)).toEqual(CLEAN_AB);
    expect((await current(AB)).artifact.invocationId).toBe(newer.invocationId);
  });

  it("lets a newer pending command win when it publishes", async () => {
    faults.reject = new Set(["ab-n1.1"]);
    const { command } = await run(AB);
    faults.reject = new Set();
    const newer = await policy.allocateCommand({
      caller: GATEWAY,
      user: { uid: OWNER },
      connectionId: "conn-1",
      taskId: AB,
      inputDigest: hex("9"),
      idempotencyKey: "job-2",
      lang: "0176",
      request: JSON.stringify({ id: AB, connectionId: "conn-1", options: {} }),
      worker: "w1",
    });
    await repairOf(command.commandId);
    expect((await current(AB)).artifact.invocationId).toBe(command.invocationId);
    await workerAs("w1")({ commandId: newer.commandId, generation: 1 });
    expect((await current(AB)).artifact.invocationId).toBe(newer.invocationId);
  });
});

// Decision 10, and the routes' answers.
describe("the routes", () => {
  const build = env => {
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
      req.auth = { context: { uid: OWNER } };
      next();
    });
    app.use("/command", buildCommandRouter({ taskStorer: tasksOf, policy: client(), run: workerAs("w-route"), worker: "w-route", env, materialize: ({ commandId }) => materialize(commandId) }));
    return app;
  };
  const post = (app, path, body = {}) => request(app).post(path).set({ authorization: "Bearer t" }).send(body);

  it("answers repair-unavailable for both while REPAIR_LNNNN is off, and runs nothing", async () => {
    faults.reject = new Set(["ab-n1.1"]);
    const { command } = await run(AB);
    const app = build({});
    for (const path of ["repair", "materialize"]) {
      const res = await post(app, `/command/${encodeURIComponent(command.commandId)}/${path}`, { idempotencyKey: "repair-1" });
      expect([res.status, res.body.error.reason]).toEqual([409, "repair-unavailable"]);
    }
    expect(await ledgerOf(command.commandId)).toEqual([]);
  });

  it("runs a repair with it on, and answers a refusal with its holder", async () => {
    faults.reject = new Set(["ab-n1.1"]);
    const { command } = await run(AB);
    faults.reject = new Set();
    const app = build({ REPAIR_L0176: "on" });
    const path = `/command/${encodeURIComponent(command.commandId)}/repair`;
    const res = await post(app, path, { idempotencyKey: "repair-1" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ outcome: "completed", result: "available", repairOf: command.commandId });
    // The same key answers the same repair; another finds nothing eligible.
    expect((await post(app, path, { idempotencyKey: "repair-1" })).body.data.commandId).toBe(res.body.data.commandId);
    const again = await post(app, path, { idempotencyKey: "repair-2", occurrences: [{ stage: "s0", occurrenceId: "n1.1" }] });
    expect([again.status, again.body.error.reason]).toEqual([409, "not-eligible"]);
  });

  it("materializes with it on, naming what blocks it otherwise", async () => {
    faults.drop = new Set(["one-n1.0"]);
    const { command } = await run(ONE);
    const app = build({ REPAIR_L0176: "on" });
    const path = `/command/${encodeURIComponent(command.commandId)}/materialize`;
    const blocked = await post(app, path);
    expect([blocked.status, blocked.body.error.reason, blocked.body.error.detail]).toEqual([409, "not-complete", { stage: "s0", occurrenceId: "n1.0" }]);
    reconciled = () => [{ operationId: `${command.invocationId}/s0/n1.0`, verdict: "applied", final: true, result: { saved: provider[0], ref: "one-n1.0" }, resultSource: "evidence" }];
    await policy.reconcile({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", invocationId: command.invocationId });
    const res = await post(app, path);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ commandId: command.commandId, result: "available", published: "current" });
  });
});

// The owner's review of #387.
describe("a lower stage rebuilt from its records", () => {
  it("resumes the head once the lower write's lost answer is reconciled: both writes once, completed and published", async () => {
    faults.drop = new Set(["lower-n1.0"]);
    const { command, done } = await run(STACK);
    expect(done.status).toBe("uncertain");
    expect(provider).toHaveLength(1);
    reconciled = () => [{ operationId: `${command.invocationId}/s1/n1.0`, verdict: "applied", final: true, result: { saved: provider[0], ref: "lower-n1.0" }, resultSource: "evidence" }];
    await policy.reconcile({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", invocationId: command.invocationId });
    faults.drop = new Set();
    const { repair, done: repaired } = await repairOf(command.commandId);
    expect(repair.selection).toEqual([]);
    expect(provider.map(p => p.at)).toEqual(["lower:n1.0", "upper:n1.0"]);
    // The lower stage was rebuilt by replay, never started.
    expect(calls.filter(c => c.op === "materialize").map(c => c.root)).toEqual(["lower"]);
    expect(calls.filter(c => c.op === "start").map(c => c.root)).toEqual(["lower", "upper"]);
    expect(repaired).toMatchObject({ status: "completed", publication: { state: "published" } });
    expect(await artifactOf(command.invocationId)).toEqual({ items: [1, 2], refs: ["upper-n1.0"] });
  });
});

describe("the repair flag for a composed command", () => {
  const composed = async () => {
    const chain = encodeChainId(["task-data", "task-one", "task-data"]);
    chainTasks[chain] = ["task-data", "task-one", "task-data"];
    faults.reject = new Set(["one-n1.0"]);
    // As /command allocates it: the command's lang is its head's.
    const command = await policy.allocateCommand({
      caller: GATEWAY,
      user: { uid: OWNER },
      connectionId: "conn-1",
      taskId: chain,
      inputDigest: hex("9"),
      idempotencyKey: "composed-1",
      lang: "0000",
      request: JSON.stringify({ id: chain, connectionId: "conn-1", options: {} }),
      worker: "w1",
    });
    expect((await workerAs("w1")({ commandId: command.commandId, generation: 1 })).status).toBe("failed");
    faults.reject = new Set();
    return command;
  };
  const repairWith = (command, env) => {
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
      req.auth = { context: { uid: OWNER } };
      next();
    });
    app.use("/command", buildCommandRouter({ taskStorer: tasksOf, policy: client(), run: workerAs("w-route"), worker: "w-route", env, materialize: ({ commandId }) => materialize(commandId) }));
    return request(app).post(`/command/${encodeURIComponent(command.commandId)}/repair`).set({ authorization: "Bearer t" }).send({ idempotencyKey: "repair-1" });
  };

  it("follows the stages with effects, not the head: an L0176 save under an L0000 head repairs with REPAIR_L0176 on", async () => {
    const command = await composed();
    const res = await repairWith(command, { REPAIR_L0176: "on" });
    expect([res.status, res.body.error]).toEqual([200, null]);
    expect(res.body.data.outcome).toBe("completed");
    expect(provider.map(p => p.at)).toEqual(["one:n1.0"]);
  });

  it("stays off unless every language with effects is on: the head's flag alone is not enough", async () => {
    const command = await composed();
    for (const env of [{}, { REPAIR_L0000: "on" }]) {
      const res = await repairWith(command, env);
      expect([res.status, res.body.error.reason]).toEqual([409, "repair-unavailable"]);
    }
    expect(await ledgerOf(command.commandId)).toEqual([]);
    expect(provider).toHaveLength(0);
  });
});
