// Repairs and the ledger (B6 slice 3, docs/b6-command-repair-plan.md
// decisions 1–4, 7, 11), against memory stores: a repair is its own command,
// allocated by the original's owner through its connection; its admission
// claims what it selected in one transaction, after both gates; its binds
// claim new occurrences, refuse what it didn't select or other arguments,
// and count bounds across the original and every repair; it mints only while
// it holds the claim; finishing it settles the ledger; reconciliation turns
// an uncertain occurrence completed, never failed.
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
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
  runtimeOccurrenceId,
  repairGate,
  COMMAND_LEASE_MS,
} from "./index.js";

const OWNER = "0xowner";
const OTHER = "0xother";
const GATEWAY = { role: "gateway" };
const L0176 = { role: "compiler", lang: "0176" };
const BROKER = { role: "broker" };
const CONSOLE = { role: "console" };
const hex = c => c.repeat(64);
const IMAGE_176 = `sha256:${hex("1")}`;
const IMAGE_000 = `sha256:${hex("0")}`;
const TASKS = ["task-data", "task-prog"];
const WRITE = "learnosity.write-items";
const ARGD = hex("a");
const ARGS = "{\"items\":[1]}";

const manifests = ({ replay = 1 } = {}) => [
  { stage: "s0", lang: "0000", sourceDigest: hex("b"), programDigest: hex("c"), optionsDigest: hex("d"), revision: "l0000-r1", imageDigest: IMAGE_000, registryVersion: 0, requiredFunctions: [] },
  { stage: "s1", lang: "0176", sourceDigest: hex("e"), programDigest: hex("f"), optionsDigest: hex("d"), revision: "l0176-r1", imageDigest: IMAGE_176, registryVersion: REGISTRY_VERSION, requiredFunctions: ["save-to-itembank", "init"], replay },
];
const approved = (lang, revision, imageDigest, status = "approved"): [string, any] => [`${lang}/${revision}`, {
  lang, revision, imageDigest, tag: `t-${revision}`, tagUrl: `https://t-${revision}---svc.run.app`, status, contractVersions: [1, 2],
}];
// s1 declares one static save and a runtime batch of at most two.
const INTENTS = [
  { id: "save", fn: "save-to-itembank", op: WRITE, occurrences: ["n1.0"] },
  { id: "batch", fn: "save-to-itembank", op: WRITE, runtime: true, bounds: { maxOccurrences: 2 } },
];
const MODEL_S1 = JSON.stringify({ lang: "0176", kind: "plan", carried: { p: 1 }, intents: INTENTS });
const MODEL_S0 = JSON.stringify({ lang: "0000", kind: "value", carried: [1, 2] });
const B = n => runtimeOccurrenceId("batch", `b${n}`);

let policy;
let connections;
let invocationStore;
let commandStore;
let records;
let approvals;
let clock;
let receipts;
let reconciled;
let original;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  clock = Date.now();
  receipts = [];
  reconciled = null;
  const leases = new Map();
  invocationStore = createMemoryInvocationStore({ leases });
  commandStore = createMemoryCommandStore({ invocationStore });
  records = createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }), now: () => clock });
  connections = createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]);
  approvals = createMemoryApprovals(new Map([approved("0000", "l0000-r1", IMAGE_000), approved("0176", "l0176-r1", IMAGE_176)]));
  policy = createPolicy({
    signer,
    jwks,
    connections,
    invocations: invocationStore,
    commands: commandStore,
    commandRecords: records,
    brokerReceipts: async ({ invocationId: inv, operationIds }) => ({
      invocationId: inv,
      operations: receipts.filter(r => r.operationId.startsWith(`${inv}/`) && (!operationIds || operationIds.includes(r.operationId))),
    }),
    brokerReconcile: async ({ invocationId: inv }) => ({ invocationId: inv, operations: reconciled(inv) }),
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals,
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    now: () => clock,
  });
});

const denied = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(PolicyDenied);
  await promise.catch(e => expect(e.reason).toBe(reason));
};
const writeAs = (commandId, generation = 1) => (fn, args) => policy.commandWrite({ caller: GATEWAY, commandId, generation, fn, args });
const settle = (commandId, generation = 1) => policy.settleCommand({ caller: GATEWAY, commandId, generation });
const ledger = async () => Object.fromEntries((await policy.commandRead({ caller: GATEWAY, commandId: original.commandId, what: "ledger" })).ledger.map(e => [e.occurrenceId, e]));

// The original: s1 (L0176) ran its static save and one batch save, then the
// chain stopped, so s0 (L0000) was never reached. `outcomes` says how each
// write went.
const runOriginal = async ({ key = "job-1", recording = 1, replay = 1, save = "succeeded", batch = "failed", finish = true } = {}) => {
  const command = await policy.allocateCommand({
    caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: encodeChainId(TASKS), inputDigest: hex("9"), idempotencyKey: key, lang: "0176", request: "{}", worker: "api-1",
  });
  const write = writeAs(command.commandId);
  await write("installModel", { stage: "s0", text: MODEL_S0 });
  await write("installModel", { stage: "s1", text: MODEL_S1 });
  await policy.admitCommand({ caller: GATEWAY, commandId: command.commandId, generation: 1, taskIds: TASKS, stages: manifests({ replay }), recording });
  await write("installInput", { stage: "s1", text: "{\"data\":{\"items\":[1]}}" });
  await write("bindOccurrence", { stage: "s1", occurrenceId: "n1.0", intentId: "save", args: ARGS, argd: ARGD });
  await write("bindOccurrence", { stage: "s1", occurrenceId: B(1), intentId: "batch", expansionKey: "b1", args: ARGS, argd: ARGD });
  const op = occ => `${command.invocationId}/s1/${occ}`;
  if (save) receipts.push({ operationId: op("n1.0"), status: save, recorded: true, steps: [], result: { saved: true, references: ["i-1"] } });
  if (batch) receipts.push({ operationId: op(B(1)), status: batch, recorded: true, steps: [], ...(batch === "succeeded" ? { result: { saved: true, references: ["i-2"] } } : {}) });
  await settle(command.commandId);
  await write("recordLost", { stage: "s1" });
  await write("closeStage", { stage: "s1", occurrences: { save: ["n1.0"], batch: [B(1)] } });
  await write("installOutput", { stage: "s1", text: "{\"data\":{\"saved\":true}}" });
  await write("markNotReached", { stages: ["s0"] });
  original = finish ? await write("finish", { result: null }) : command;
  return original;
};
const repairOf = (over = {}) => policy.allocateRepair({ caller: GATEWAY, user: { uid: OWNER }, commandId: original.commandId, idempotencyKey: "repair-1", worker: "api-r", ...over });
const admitRepair = (repair, generation = 1) => policy.admitCommand({ caller: GATEWAY, commandId: repair.commandId, generation });
const repairSession = async repair => (await policy.commandSession({ caller: GATEWAY, commandId: repair.commandId, generation: 1, stage: "s1" })).sessionToken;
const repairBind = (repair, occurrenceId, over = {}) => writeAs(repair.commandId)("bindOccurrence", {
  stage: "s1", occurrenceId, intentId: occurrenceId === "n1.0" ? "save" : "batch", ...(occurrenceId === "n1.0" ? {} : { expansionKey: `b${[1, 2, 3].find(n => B(n) === occurrenceId)}` }), args: ARGS, argd: ARGD, ...over,
});

describe("allocating a repair", () => {
  it("is its own command, of kind repair, selecting every failed occurrence and nothing else", async () => {
    await runOriginal();
    expect(original.status).toBe("partial");
    const repair = await repairOf();
    expect(repair).toMatchObject({ kind: "repair", repairOf: original.commandId, selection: [{ stage: "s1", occurrenceId: B(1) }], status: "pending", phase: "allocated", owned: true, generation: 1 });
    expect(repair.invocationId).not.toBe(original.invocationId);
    // A retry with its key is the same repair.
    expect(await repairOf({ worker: "api-2" })).toMatchObject({ commandId: repair.commandId, reused: true, owned: false });
    // The original's own key names the original, not a repair.
    await denied(repairOf({ idempotencyKey: "job-1" }), "idempotency-key-reused");
  });

  it("refuses an occurrence that isn't failed now, or isn't the original's", async () => {
    await runOriginal();
    await denied(repairOf({ occurrences: [{ stage: "s1", occurrenceId: "n1.0" }] }), "not-eligible");
    await denied(repairOf({ occurrences: [{ stage: "s1", occurrenceId: B(2) }] }), "not-eligible");
    await denied(repairOf({ occurrences: [{ stage: "s1", occurrenceId: B(1) }, { stage: "s1", occurrenceId: B(1) }] }), "bad-request");
    expect(await ledger()).toEqual({});
  });

  it("is the original's own user's, through its connection, live", async () => {
    await runOriginal();
    await denied(policy.allocateRepair({ caller: GATEWAY, user: { uid: OTHER }, commandId: original.commandId, idempotencyKey: "r", worker: "w" }), "command-not-found");
    await denied(policy.allocateRepair({ caller: L0176, user: { uid: OWNER }, commandId: original.commandId, idempotencyKey: "r", worker: "w" }), "caller-not-entry-point");
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
    await denied(repairOf(), "connection-disabled");
  });

  it("has nothing to repair when every occurrence completed and every stage was reached", async () => {
    await runOriginal({ batch: "succeeded" });
    expect(original.status).toBe("completed");
    // s0 was marked not-reached; with it reached there is nothing to resume.
    const stored = commandStore.commands.get(original.commandId);
    commandStore.commands.set(original.commandId, { ...stored, stages: { ...stored.stages, s0: { state: "ran", expansion: "closed", output: hex("7") } } });
    await denied(repairOf(), "nothing-to-repair");
  });

  it("resumes, with an empty selection, stages the original never reached once everything below them completed (7b)", async () => {
    await runOriginal({ batch: "succeeded" });
    const repair = await repairOf();
    expect(repair.selection).toEqual([]);
    expect((await admitRepair(repair)).selection).toEqual([]);
  });
});

// Decision 11: both gates, before anything is claimed.
describe("the eligibility gates", () => {
  it("refuses a command admitted on a revision without replay, revision-unsupported, with no ledger entry", async () => {
    await runOriginal({ replay: 0 });
    await denied(repairOf(), "revision-unsupported");
    expect(await ledger()).toEqual({});
  });

  it("refuses a command that wasn't recorded, not-recorded", async () => {
    await runOriginal({ recording: 0 });
    await denied(repairOf(), "not-recorded");
  });

  it("refuses a command still running, and a repair named as the original", async () => {
    await runOriginal({ finish: false });
    await denied(repairOf(), "command-pending");
    await writeAs(original.commandId)("finish", { result: null });
    const repair = await repairOf();
    await denied(policy.allocateRepair({ caller: GATEWAY, user: { uid: OWNER }, commandId: repair.commandId, idempotencyKey: "r2", worker: "w" }), "not-original");
  });

  it("names each gate by itself (store level)", () => {
    const admitted = { kind: "command", status: "partial", phase: "admitted", admission: { recording: 1, stages: { s1: { intents: [{}], replay: 1 }, s0: { intents: [], replay: 0 } } }, stages: { s1: { state: "ran", pinnedInput: hex("1") }, s0: { state: "not-reached" } } };
    expect(repairGate(admitted, [{ stage: "s1" }])).toBeNull();
    expect(repairGate({ ...admitted, admission: { ...admitted.admission, stages: { ...admitted.admission.stages, s1: { intents: [{}], replay: 0 } } } })).toBe("revision-unsupported");
    expect(repairGate({ ...admitted, admission: { ...admitted.admission, recording: 0 } })).toBe("not-recorded");
    // A stage that ran with no intents needs its recorded output.
    expect(repairGate({ ...admitted, stages: { ...admitted.stages, s0: { state: "ran" } } })).toBe("not-recorded");
    expect(repairGate({ ...admitted, stages: { ...admitted.stages, s0: { state: "ran", output: "too-large" } } })).toBe("not-recorded");
    expect(repairGate({ ...admitted, stages: { ...admitted.stages, s0: { state: "ran", output: hex("2") } } })).toBeNull();
    // A repaired stage needs its pinned input.
    expect(repairGate({ ...admitted, stages: { ...admitted.stages, s1: { state: "ran", output: hex("3") } } }, [{ stage: "s1" }])).toBe("not-recorded");
    expect(repairGate({ ...admitted, status: "pending" })).toBe("command-pending");
    expect(repairGate({ ...admitted, kind: "repair" })).toBe("not-original");
    expect(repairGate(null)).toBe("command-not-found");
  });
});

// Decision 4: the claim.
describe("the claim", () => {
  it("claims the selection with the repair's admission, in one transaction, referencing the original's", async () => {
    await runOriginal();
    const repair = await repairOf();
    const out = await admitRepair(repair);
    expect(out).toMatchObject({ planDigest: original.admission?.planDigest ?? expect.any(String), repairOf: original.commandId, selection: [{ stage: "s1", occurrenceId: B(1) }] });
    const stored = commandStore.commands.get(repair.commandId);
    const originalStored = commandStore.commands.get(original.commandId);
    expect(stored.phase).toBe("admitted");
    expect(stored.admission).toEqual({ ...originalStored.admission, repairOf: original.commandId });
    expect((await ledger())[B(1)]).toMatchObject({ status: "pending", repairId: repair.commandId, prior: "failed", claim: "admission", attempts: [] });
    // A retry of the admission is acknowledged.
    await admitRepair(repair);
  });

  it("lets exactly one of two concurrent repairs claim an occurrence; the other claims nothing and says who holds it", async () => {
    await runOriginal();
    const first = await repairOf({ idempotencyKey: "r-a" });
    const second = await repairOf({ idempotencyKey: "r-b" });
    const results = await Promise.allSettled([admitRepair(first), admitRepair(second)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ reason: "occurrence-claimed" });
    const winner = results[0].status === "fulfilled" ? first : second;
    expect(refused.reason.detail).toEqual({ stage: "s1", occurrenceId: B(1), repairId: winner.commandId });
    expect((await ledger())[B(1)].repairId).toBe(winner.commandId);
    // A new repair naming it is refused at allocation, naming the holder; one
    // selecting by default leaves it out, and finds nothing else to repair.
    await expect(repairOf({ idempotencyKey: "r-c", occurrences: [{ stage: "s1", occurrenceId: B(1) }] })).rejects.toMatchObject({ reason: "occurrence-claimed", detail: { repairId: winner.commandId } });
    await denied(repairOf({ idempotencyKey: "r-d" }), "nothing-to-repair");
  });

  it("refuses a repair whose revision is retired, claiming nothing", async () => {
    await runOriginal();
    const repair = await repairOf();
    approvals.records.set("0176/l0176-r1", { ...approvals.records.get("0176/l0176-r1"), status: "retiring" });
    await denied(admitRepair(repair), "revision-retired");
    expect(await ledger()).toEqual({});
    expect(commandStore.commands.get(repair.commandId).admissionRefusal.reason).toBe("revision-retired");
  });

  it("checks the authority again at admission", async () => {
    await runOriginal();
    const repair = await repairOf();
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
    await denied(admitRepair(repair), "connection-disabled");
    expect(await ledger()).toEqual({});
  });
});

// Decision 7a, 7b: a repair's binds.
describe("a repair's binds", () => {
  let repair;
  beforeEach(async () => {
    await runOriginal();
    repair = await repairOf();
    await admitRepair(repair);
  });

  it("binds a selected occurrence with the original binding's arguments, and refuses others", async () => {
    await expect(repairBind(repair, B(1), { args: "{\"items\":[2]}" })).rejects.toMatchObject({ reason: "binding-mismatch" });
    expect(await repairBind(repair, B(1))).toMatchObject({ bound: true });
    // A completed occurrence it didn't select answers from its record, never a bind.
    await expect(repairBind(repair, "n1.0")).rejects.toMatchObject({ reason: "not-selected" });
  });

  it("claims an occurrence new to the stage at bind, and counts bounds across the original and every repair", async () => {
    await repairBind(repair, B(1));
    // b2 is new: claimed at bind, the stage's second batch occurrence.
    expect(await repairBind(repair, B(2))).toMatchObject({ bound: true });
    expect((await ledger())[B(2)]).toMatchObject({ status: "pending", repairId: repair.commandId, claim: "bind", counted: true });
    // b3 would be the third: refused, and recorded as the repair's refusal.
    await expect(repairBind(repair, B(3))).rejects.toMatchObject({ reason: "bounds-exceeded" });
    expect(commandStore.commands.get(original.commandId).repairCounts.byIntent).toEqual({ "s1/batch": 1 });
  });

  it("keeps an occurrence it claimed at bind from any other repair", async () => {
    await repairBind(repair, B(2));
    await expect(repairOf({ idempotencyKey: "r-other", occurrences: [{ stage: "s1", occurrenceId: B(2) }] })).rejects.toMatchObject({ reason: "occurrence-claimed", detail: { repairId: repair.commandId } });
  });

  it("mints only while it holds the claim", async () => {
    await repairBind(repair, B(1));
    const sessionToken = await repairSession(repair);
    const mint = () => policy.mint({ caller: L0176, sessionToken, fn: "save-to-itembank", op: WRITE, occurrenceId: B(1), argsDigest: ARGD });
    const { executionToken, operationId } = await mint();
    expect(operationId).toBe(`${repair.invocationId}/s1/${B(1)}`);
    expect(await policy.authorizeExecution({ caller: BROKER, executionToken, op: WRITE, argsDigest: ARGD, step: "questions", purpose: "dispatch", after: null })).toMatchObject({ decisionId: expect.any(String) });
    // Once the entry is settled, the claim is gone: no mint, no step.
    receipts.push({ operationId, status: "failed", recorded: true, steps: [] });
    await settle(repair.commandId);
    await writeAs(repair.commandId)("closeStage", { stage: "s1", occurrences: { batch: [B(1)] } });
    await writeAs(repair.commandId)("finish", { result: null });
    await expect(mint()).rejects.toMatchObject({ reason: "occurrence-not-claimed" });
    await expect(policy.authorizeExecution({ caller: BROKER, executionToken, op: WRITE, argsDigest: ARGD, step: "questions", purpose: "dispatch", after: null })).rejects.toMatchObject({ reason: "occurrence-not-claimed" });
  });
});

describe("finishing a repair", () => {
  const runRepair = async (key, status) => {
    const repair = await repairOf({ idempotencyKey: key });
    await admitRepair(repair);
    await repairBind(repair, B(1));
    receipts.push({ operationId: `${repair.invocationId}/s1/${B(1)}`, status, recorded: true, steps: [], ...(status === "succeeded" ? { result: { saved: true, references: ["i-9"] } } : {}) });
    await settle(repair.commandId);
    await writeAs(repair.commandId)("closeStage", { stage: "s1", occurrences: { batch: [B(1)] } });
    return { repair, finished: await writeAs(repair.commandId)("finish", { result: null }) };
  };

  it("settles its entries with its outcome and output; a completed one is never claimed again", async () => {
    await runOriginal();
    const { repair, finished } = await runRepair("r-1", "succeeded");
    expect(finished).toMatchObject({ kind: "repair", status: "completed", publication: { state: "none" } });
    const entry = (await ledger())[B(1)];
    expect(entry).toMatchObject({ status: "completed", repairId: repair.commandId, source: "receipt", receipt: `${repair.invocationId}/s1/${B(1)}` });
    expect(JSON.parse(entry.output.text)).toEqual({ saved: true, references: ["i-9"] });
    await denied(repairOf({ idempotencyKey: "r-2", occurrences: [{ stage: "s1", occurrenceId: B(1) }] }), "not-eligible");
    // With every occurrence below it completed now, a repair may only resume
    // the stage the original never reached (7b).
    expect((await repairOf({ idempotencyKey: "r-3" })).selection).toEqual([]);
    // The original's own outcome is frozen.
    expect(commandStore.commands.get(original.commandId).status).toBe("partial");
  });

  it("releases a failed repair's entries, so a later repair may claim them again", async () => {
    await runOriginal();
    const { repair } = await runRepair("r-1", "failed");
    expect((await ledger())[B(1)]).toMatchObject({ status: "failed", repairId: repair.commandId });
    const again = await repairOf({ idempotencyKey: "r-2" });
    await admitRepair(again);
    expect((await ledger())[B(1)]).toMatchObject({ status: "pending", repairId: again.commandId, attempts: [{ repairId: repair.commandId, status: "failed", source: "receipt" }] });
  });

  it("marks a selected occurrence it never reached failed: nothing was written for it", async () => {
    await runOriginal();
    const repair = await repairOf();
    await admitRepair(repair);
    await writeAs(repair.commandId)("finish", { result: null });
    expect((await ledger())[B(1)]).toMatchObject({ status: "failed", source: "not-reached" });
  });
});

// Decision 2: reconciliation feeds the ledger, and never yields failed.
describe("reconciliation", () => {
  const reconcile = () => policy.reconcile({ caller: CONSOLE, user: { uid: OWNER }, connectionId: "conn-1", invocationId: original.invocationId });
  const op = () => `${original.invocationId}/s1/n1.0`;

  it("records an applied, final verdict for an uncertain occurrence as completed, with its output", async () => {
    // n1.0's answer was lost: uncertain.
    await runOriginal({ save: null, batch: "succeeded" });
    expect(original.status).toBe("uncertain");
    reconciled = () => [{ operationId: op(), verdict: "applied", final: true, result: { saved: true, references: ["i-1"] }, resultSource: "evidence" }];
    await reconcile();
    const entry = (await ledger())["n1.0"];
    expect(entry).toMatchObject({ status: "completed", source: "reconciliation", receipt: op() });
    expect(JSON.parse(entry.output.text)).toEqual({ saved: true, references: ["i-1"] });
    // It is no longer a candidate, and the original's outcome is frozen.
    await denied(repairOf({ occurrences: [{ stage: "s1", occurrenceId: "n1.0" }] }), "not-eligible");
    expect(commandStore.commands.get(original.commandId).status).toBe("uncertain");
  });

  it("records completed with output unavailable when the result can't be established", async () => {
    await runOriginal({ save: null, batch: "succeeded" });
    reconciled = () => [{ operationId: op(), verdict: "applied", final: true, result: null, resultSource: "unavailable" }];
    await reconcile();
    expect((await ledger())["n1.0"]).toMatchObject({ status: "completed", output: { unavailable: "unavailable" } });
  });

  it("changes nothing for an unresolved verdict, or a non-final one, and never records failed", async () => {
    await runOriginal({ save: null, batch: "succeeded" });
    reconciled = () => [
      { operationId: op(), verdict: "unresolved", reason: "evidence-format-unknown" },
      { operationId: op(), verdict: "applied", final: false, result: { saved: true }, resultSource: "evidence" },
    ];
    await reconcile();
    expect(await ledger()).toEqual({});
    // Still blocked: neither a candidate nor resumable.
    await denied(repairOf(), "nothing-to-repair");
  });

  it("leaves a failed occurrence failed: a verdict about it changes nothing", async () => {
    await runOriginal();
    reconciled = () => [{ operationId: `${original.invocationId}/s1/${B(1)}`, verdict: "applied", final: true, result: {}, resultSource: "evidence" }];
    await reconcile();
    expect(await ledger()).toEqual({});
  });
});

// Decision 3: repairs reuse B5's ownership, but only a worker that runs them owns one.
describe("who may own a repair", () => {
  it("refuses a worker that doesn't run repairs, at renewal, takeover and in the sweep", async () => {
    await runOriginal();
    const repair = await repairOf();
    await expect(policy.leaseCommand({ caller: GATEWAY, commandId: repair.commandId, worker: "api-r", generation: 1, recording: 1 })).rejects.toMatchObject({ reason: "worker-unsupported" });
    expect(await policy.leaseCommand({ caller: GATEWAY, commandId: repair.commandId, worker: "api-r", generation: 1, recording: 1, repairs: 1 })).toMatchObject({ kind: "repair" });
    clock += 2 * COMMAND_LEASE_MS;
    expect((await policy.dueCommands({ caller: GATEWAY, recording: 1 })).commands.map(c => c.commandId)).not.toContain(repair.commandId);
    expect((await policy.dueCommands({ caller: GATEWAY, recording: 1, repairs: 1 })).commands.map(c => c.commandId)).toContain(repair.commandId);
    await expect(policy.leaseCommand({ caller: GATEWAY, commandId: repair.commandId, worker: "old", generation: 1, takeOver: true, recording: 1 })).rejects.toMatchObject({ reason: "worker-unsupported" });
    expect(await policy.leaseCommand({ caller: GATEWAY, commandId: repair.commandId, worker: "new", generation: 1, takeOver: true, recording: 1, repairs: 1 })).toMatchObject({ generation: 2 });
  });
});

// The owner's review of #386.
describe("a repair's key, retried", () => {
  it("answers the same repair after admission, and after it finished, by default or naming its selection", async () => {
    await runOriginal();
    const repair = await repairOf();
    await admitRepair(repair);
    expect(await repairOf()).toMatchObject({ commandId: repair.commandId, reused: true, owned: false, phase: "admitted" });
    expect(await repairOf({ occurrences: [{ stage: "s1", occurrenceId: B(1) }] })).toMatchObject({ commandId: repair.commandId, reused: true });
    await repairBind(repair, B(1));
    receipts.push({ operationId: `${repair.invocationId}/s1/${B(1)}`, status: "succeeded", recorded: true, steps: [], result: { saved: true } });
    await settle(repair.commandId);
    await writeAs(repair.commandId)("closeStage", { stage: "s1", occurrences: { batch: [B(1)] } });
    await writeAs(repair.commandId)("finish", { result: null });
    expect(await repairOf()).toMatchObject({ commandId: repair.commandId, reused: true, status: "completed" });
  });

  it("refuses the key for another selection or another original, and keeps the owner and access checks first", async () => {
    await runOriginal();
    const repair = await repairOf();
    await admitRepair(repair);
    await denied(repairOf({ occurrences: [{ stage: "s1", occurrenceId: "n1.0" }] }), "idempotency-key-reused");
    await denied(policy.allocateRepair({ caller: GATEWAY, user: { uid: OTHER }, commandId: original.commandId, idempotencyKey: "repair-1", worker: "w" }), "command-not-found");
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
    await denied(repairOf(), "connection-disabled");
  });
});

describe("a stage a repair resumed", () => {
  // Both stages are L0176. The original completes s1 and never reaches s0; a
  // first repair resumes s0, whose save fails.
  const resumedThenFailed = async () => {
    const command = await policy.allocateCommand({
      caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: encodeChainId(TASKS), inputDigest: hex("9"), idempotencyKey: "two-stages", lang: "0176", request: "{}", worker: "api-1",
    });
    const write = writeAs(command.commandId);
    for (const stage of ["s0", "s1"]) await write("installModel", { stage, text: MODEL_S1 });
    const m = manifests()[1];
    await policy.admitCommand({ caller: GATEWAY, commandId: command.commandId, generation: 1, taskIds: TASKS, stages: [{ ...m, stage: "s0" }, m], recording: 1 });
    await write("installInput", { stage: "s1", text: "{\"data\":{\"items\":[1]}}" });
    await write("bindOccurrence", { stage: "s1", occurrenceId: "n1.0", intentId: "save", args: ARGS, argd: ARGD });
    receipts.push({ operationId: `${command.invocationId}/s1/n1.0`, status: "succeeded", recorded: true, steps: [], result: { saved: true, references: ["tail"] } });
    await settle(command.commandId);
    await write("closeStage", { stage: "s1", occurrences: { save: ["n1.0"], batch: [] } });
    await write("installOutput", { stage: "s1", text: "{\"data\":{\"items\":[1]}}" });
    await write("markNotReached", { stages: ["s0"] });
    original = await write("finish", { result: null });
    const first = await repairOf({ idempotencyKey: "resume-head" });
    expect(first.selection).toEqual([]);
    await admitRepair(first);
    await writeAs(first.commandId)("installInput", { stage: "s0", text: "{\"data\":{\"items\":[1]}}" });
    await writeAs(first.commandId)("bindOccurrence", { stage: "s0", occurrenceId: "n1.0", intentId: "save", args: ARGS, argd: ARGD });
    receipts.push({ operationId: `${first.invocationId}/s0/n1.0`, status: "failed", recorded: true, steps: [] });
    await settle(first.commandId);
    await writeAs(first.commandId)("closeStage", { stage: "s0", occurrences: { save: ["n1.0"], batch: [] } });
    await writeAs(first.commandId)("finish", { result: null });
    return first;
  };

  it("keeps the first repair's input as the stage's canonical one, and its failure is repairable by another", async () => {
    const first = await resumedThenFailed();
    const snapshot = commandStore.commands.get(original.commandId).canonical;
    expect(snapshot.s0.pinnedInput).toMatchObject({ commandId: first.commandId });
    const entries = await records.listLedger(original.commandId);
    expect(entries.find(e => e.stage === "s0" && e.occurrenceId === "n1.0").status).toBe("failed");
    const second = await repairOf({ idempotencyKey: "retry-head", occurrences: [{ stage: "s0", occurrenceId: "n1.0" }] });
    expect(second.selection).toEqual([{ stage: "s0", occurrenceId: "n1.0" }]);
    await admitRepair(second);
    // It must pin the canonical input, and nothing else.
    await expect(writeAs(second.commandId)("installInput", { stage: "s0", text: "{\"data\":{\"items\":[2]}}" })).rejects.toMatchObject({ reason: "input-conflict" });
    expect(await writeAs(second.commandId)("installInput", { stage: "s0", text: "{\"data\":{\"items\":[1]}}" })).toMatchObject({ stage: "s0" });
    expect(await repairBind(second, "n1.0", { stage: "s0" })).toMatchObject({ bound: true });
    expect(commandStore.commands.get(original.commandId).canonical.s0.pinnedInput.commandId).toBe(first.commandId);
  });
});

describe("a repair that only resumes a stage with no effects (7b)", () => {
  it("completes with the result it recorded", async () => {
    await runOriginal({ batch: "succeeded" });
    const repair = await repairOf();
    expect(repair.selection).toEqual([]);
    await admitRepair(repair);
    await writeAs(repair.commandId)("installOutput", { stage: "s0", text: "{\"data\":{\"count\":2},\"errors\":[]}" });
    const done = await writeAs(repair.commandId)("finish", { result: "{\"count\":2}" });
    // It leaves the original complete: its result is the original's artifact (slice 4).
    expect(done).toMatchObject({ status: "completed", result: { state: "available" }, publication: { state: "due", artifact: { invocationId: original.invocationId } } });
    // Its output is the stage's, in the original's snapshot.
    expect(commandStore.commands.get(original.commandId).canonical.s0.output).toMatchObject({ commandId: repair.commandId });
  });

  it("fails when it recorded no result, or touched no stage", async () => {
    await runOriginal({ batch: "succeeded" });
    const repair = await repairOf();
    const idle = await repairOf({ idempotencyKey: "idle" });
    await admitRepair(repair);
    await admitRepair(idle);
    expect((await writeAs(idle.commandId)("finish", { result: "{}" })).status).toBe("failed");
    await writeAs(repair.commandId)("installOutput", { stage: "s0", text: "{\"data\":{\"count\":2},\"errors\":[]}" });
    expect((await writeAs(repair.commandId)("finish", { result: null })).status).toBe("failed");
    // Once a repair recorded s0's output, there is nothing left to resume.
    await denied(repairOf({ idempotencyKey: "later" }), "nothing-to-repair");
  });
});

// The owner's review of 8c97a0d9.
describe("the canonical snapshot", () => {
  // Both stages are L0176; the original completes s1 and never reaches s0.
  const unreachedSave = async () => {
    const command = await policy.allocateCommand({
      caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: encodeChainId(TASKS), inputDigest: hex("9"), idempotencyKey: "unreached-save", lang: "0176", request: "{}", worker: "api-1",
    });
    const write = writeAs(command.commandId);
    for (const stage of ["s0", "s1"]) await write("installModel", { stage, text: MODEL_S1 });
    const m = manifests()[1];
    await policy.admitCommand({ caller: GATEWAY, commandId: command.commandId, generation: 1, taskIds: TASKS, stages: [{ ...m, stage: "s0" }, m], recording: 1 });
    await write("installInput", { stage: "s1", text: "{\"data\":{\"items\":[1]}}" });
    await write("bindOccurrence", { stage: "s1", occurrenceId: "n1.0", intentId: "save", args: ARGS, argd: ARGD });
    receipts.push({ operationId: `${command.invocationId}/s1/n1.0`, status: "succeeded", recorded: true, steps: [], result: { saved: true, references: ["tail"] } });
    await settle(command.commandId);
    await write("closeStage", { stage: "s1", occurrences: { save: ["n1.0"], batch: [] } });
    await write("installOutput", { stage: "s1", text: "{\"data\":{\"items\":[1]}}" });
    await write("markNotReached", { stages: ["s0"] });
    original = await write("finish", { result: null });
  };
  const read = (what, stage = null) => policy.commandRead({ caller: GATEWAY, commandId: original.commandId, what, stage });

  it("leaves a stage resumable when a repair only pinned it, and the next repair pins the same input", async () => {
    await unreachedSave();
    const first = await repairOf({ idempotencyKey: "pin-only" });
    await admitRepair(first);
    await writeAs(first.commandId)("installInput", { stage: "s0", text: "{\"data\":{\"items\":[1]}}" });
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
    await denied(policy.commandSession({ caller: GATEWAY, commandId: first.commandId, generation: 1, stage: "s0" }), "connection-disabled");
    expect((await writeAs(first.commandId)("finish", { result: null })).status).toBe("failed");
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" });
    const second = await repairOf({ idempotencyKey: "resume-after-pin" });
    expect(second.selection).toEqual([]);
    await admitRepair(second);
    await expect(writeAs(second.commandId)("installInput", { stage: "s0", text: "{\"data\":{\"items\":[2]}}" })).rejects.toMatchObject({ reason: "input-conflict" });
    // The original's input read resolves to the first repair's pin.
    const { input, from } = await read("input", "s0");
    expect([JSON.parse(input.text), from]).toEqual([{ data: { items: [1] } }, first.commandId]);
  });

  it("is visible through the original's reads: the state names it, and input and output resolve to it", async () => {
    await runOriginal({ batch: "succeeded" });
    const repair = await repairOf();
    await admitRepair(repair);
    await writeAs(repair.commandId)("installOutput", { stage: "s0", text: "{\"data\":{\"count\":2},\"errors\":[]}" });
    await writeAs(repair.commandId)("finish", { result: "{\"count\":2}" });
    const state = await read("state");
    expect(state.canonical.s0.output).toMatchObject({ commandId: repair.commandId, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const { output, from } = await read("output", "s0");
    expect([JSON.parse(output.text), from]).toEqual([{ data: { count: 2 }, errors: [] }, repair.commandId]);
    // A stage only the original recorded reads as before, from the original.
    const own = await read("output", "s1");
    expect([JSON.parse(own.output.text), own.from]).toEqual([{ data: { saved: true } }, original.commandId]);
    expect(await read("input", "s0")).toEqual({ input: null, from: null });
  });
});

// Slice 4 (decision 8): a repair publishes the original's artifact, and only
// when it leaves the original complete.
describe("a repair's publication", () => {
  const finishRepair = async () => {
    const repair = await repairOf();
    await admitRepair(repair);
    await repairBind(repair, B(1));
    receipts.push({ operationId: `${repair.invocationId}/s1/${B(1)}`, status: "succeeded", recorded: true, steps: [], result: { saved: true } });
    await settle(repair.commandId);
    await writeAs(repair.commandId)("closeStage", { stage: "s1", occurrences: { batch: [B(1)] } });
    await writeAs(repair.commandId)("installOutput", { stage: "s0", text: "{\"data\":{\"count\":2},\"errors\":[]}" });
    return { repair, done: await writeAs(repair.commandId)("finish", { result: "{\"count\":2}" }) };
  };

  it("is due, as the original invocation's artifact, when it leaves every occurrence completed and every stage reached", async () => {
    await runOriginal();
    const { done } = await finishRepair();
    expect(done).toMatchObject({ status: "completed", publication: { state: "due", artifact: { invocationId: original.invocationId, seq: original.seq } } });
    // The ledger keeps the occurrence's Broker digest for later repairs.
    expect((await ledger())[B(1)]).toMatchObject({ status: "completed", argd: ARGD });
  });

  it("is none while another occurrence of the original isn't completed", async () => {
    // n1.0's answer was lost: uncertain, and no repair may touch it.
    await runOriginal({ save: null });
    const { done } = await finishRepair();
    expect(done).toMatchObject({ status: "completed", publication: { state: "none" } });
  });
});
