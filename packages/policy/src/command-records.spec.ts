// A command's records (B5 slice 2, docs/b5-commands-plan.md §3–§7), against
// the memory backend, through Policy's command calls: fencing, install-once,
// occurrence binds and bounds, close, settlement from receipts, lost
// responses, the aggregated finish, and publication.
import { generateKeyPair, exportJWK } from "jose";
import { createHash } from "node:crypto";
import {
  createPolicy,
  PolicyDenied,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createMemoryCommandStore,
  createMemoryCommandBackend,
  createCommandRecords,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch,
  runtimeOccurrenceId,
  observationId,
  aggregateStatus,
  COMMAND_LEASE_MS,
} from "./index.js";

const OWNER = "0xowneruid";
const GATEWAY = { role: "gateway" };
const digest = s => createHash("sha256").update(s).digest("hex");
const T0 = Date.parse("2026-11-08T12:00:00Z");

let policy;
let commandStore;
let backend;
let clock;
let receipts;
let commandId;
let invocationId;

// s1 (the tail) has one static save; s0 (the head) a runtime-expanded intent.
const ADMISSION = {
  planDigest: digest("plan"),
  stages: {
    s1: { modelDigest: digest("m1"), intents: [{ id: "save", fn: "save-to-itembank", op: "learnosity.save-items", occurrences: ["SAVE:1.0"], bounds: { maxOccurrences: 1 } }] },
    s0: { modelDigest: digest("m0"), intents: [{ id: "batch", fn: "save-to-itembank", op: "learnosity.save-items", runtime: true, bounds: { maxOccurrences: 3 } }] },
  },
};

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  clock = T0;
  receipts = [];
  const invocationStore = createMemoryInvocationStore();
  commandStore = createMemoryCommandStore({ invocationStore });
  backend = createMemoryCommandBackend({ commandStore });
  policy = createPolicy({
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    signer,
    jwks: { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] },
    connections: createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]),
    invocations: invocationStore,
    commands: commandStore,
    commandRecords: createCommandRecords({ backend, now: () => clock }),
    brokerReceipts: async ({ invocationId: inv }) => ({ invocationId: inv, operations: receipts.filter(r => r.operationId.startsWith(`${inv}/`)) }),
    publications: createMemoryPublicationStore(),
    audit: createAudit({ sink: () => {}, pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) }),
    now: () => clock,
  });
  const allocated = await policy.allocateCommand({
    caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: "task-1", inputDigest: digest("input"), idempotencyKey: "key-1", lang: "0176", request: "{\"id\":\"task-1\"}", worker: "api-1",
  });
  ({ commandId, invocationId } = allocated);
});

// Admission is slice 3; here it is set directly on the record.
const admit = () => {
  const c = commandStore.commands.get(commandId);
  commandStore.commands.set(commandId, { ...c, phase: "admitted", admission: structuredClone(ADMISSION) });
};
const write = (fn, args = {}, generation = 1) => policy.commandWrite({ caller: GATEWAY, commandId, generation, fn, args });
const settle = (generation = 1) => policy.settleCommand({ caller: GATEWAY, commandId, generation });
const denied = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(PolicyDenied);
  await expect(promise).rejects.toMatchObject({ reason });
};
const snapshot = () => JSON.stringify([commandStore.commands.get(commandId), [...backend.docs.entries()]]);
const receipt = (stage, occ, status, recorded = true) => receipts.push({ operationId: `${invocationId}/${stage}/${occ}`, status, recorded, steps: [] });
const bindStatic = () => write("bindOccurrence", { stage: "s1", occurrenceId: "SAVE:1.0", intentId: "save", args: "{\"items\":[1]}" });
const bindBatch = n => write("bindOccurrence", { stage: "s0", occurrenceId: runtimeOccurrenceId("batch", `batch ${n}`), intentId: "batch", expansionKey: `batch ${n}`, args: `{"batch":${n}}` });

describe("fencing", () => {
  it("refuses a stale generation, an expired lease, and another caller, changing nothing", async () => {
    admit();
    const before = snapshot();
    await denied(write("installInput", { stage: "s1", text: "{}" }, 2), "stale-generation");
    clock += COMMAND_LEASE_MS;
    await denied(write("installInput", { stage: "s1", text: "{}" }), "lease-expired");
    await denied(policy.commandWrite({ caller: { role: "compiler", lang: "0176" }, commandId, generation: 1, fn: "installInput", args: {} }), "caller-not-entry-point");
    await denied(write("logIssuance", {}), "bad-request");
    expect(snapshot()).toBe(before);
  });

  it("refuses the old owner after a takeover, at every write", async () => {
    admit();
    clock += COMMAND_LEASE_MS + 1;
    await policy.leaseCommand({ caller: GATEWAY, commandId, worker: "api-2", generation: 1, takeOver: true });
    const before = snapshot();
    for (const [fn, args] of [["installInput", { stage: "s1", text: "{}" }], ["closeStage", { stage: "s1", occurrences: {} }], ["finish", {}], ["published", {}]]) {
      await denied(write(fn, args, 1), "stale-generation");
    }
    await denied(settle(1), "stale-generation");
    expect(snapshot()).toBe(before);
  });
});

describe("install-once records", () => {
  it("installs a model while initializing, and none once admitted", async () => {
    expect(await write("installModel", { stage: "s0", text: "{\"b\":1,\"a\":2}", revision: "r1", tagUrl: "https://t" })).toMatchObject({ digest: digest("{\"b\":1,\"a\":2}") });
    expect(commandStore.commands.get(commandId).phase).toBe("initializing");
    // A second install keeps the first.
    expect(await write("installModel", { stage: "s0", text: "{\"other\":1}" })).toMatchObject({ digest: digest("{\"b\":1,\"a\":2}"), revision: "r1" });
    admit();
    await denied(write("installModel", { stage: "s1", text: "{}" }), "command-admitted");
  });

  it("pins an input once, as exact text, and a later owner reads the first", async () => {
    admit();
    const text = "{\"z\":1,\"a\":[3,2]}";
    expect(await write("installInput", { stage: "s1", text })).toMatchObject({ text, digest: digest(text) });
    clock += COMMAND_LEASE_MS + 1;
    await policy.leaseCommand({ caller: GATEWAY, commandId, worker: "api-2", generation: 1, takeOver: true });
    expect(await write("installInput", { stage: "s1", text: "{\"different\":true}" }, 2)).toMatchObject({ text });
    expect((await policy.commandRead({ caller: GATEWAY, commandId, what: "input", stage: "s1" })).input.text).toBe(text);
  });

  it("finds a recorded observation instead of reading again, and a new key is a new observation", async () => {
    admit();
    expect(await write("observation", { stage: "s0", key: "poll 1" })).toMatchObject({ recorded: false });
    expect(await write("observation", { stage: "s0", key: "poll 1", text: "{\"state\":\"running\"}" })).toMatchObject({ recorded: true, observationId: observationId("s0", "poll 1") });
    expect(await write("observation", { stage: "s0", key: "poll 1", text: "{\"state\":\"done\"}" })).toMatchObject({ text: "{\"state\":\"running\"}" });
    expect(await write("observation", { stage: "s0", key: "poll 2" })).toMatchObject({ recorded: false });
  });

  it("refuses a payload over the cap", async () => {
    await denied(write("installModel", { stage: "s0", text: JSON.stringify({ pad: "x".repeat(512 * 1024) }) }), "input-too-large");
  });
});

describe("occurrences", () => {
  it("binds an admitted static occurrence once, and refuses different arguments for it", async () => {
    admit();
    expect(await bindStatic()).toMatchObject({ bound: true });
    expect(await bindStatic()).toMatchObject({ bound: false });
    await denied(write("bindOccurrence", { stage: "s1", occurrenceId: "SAVE:1.0", intentId: "save", args: "{\"items\":[2]}" }), "operation-id-reused");
  });

  it("refuses an unadmitted intent or occurrence, a static id with an expansion key, and an x: id that doesn't encode its fields", async () => {
    admit();
    await denied(write("bindOccurrence", { stage: "s1", occurrenceId: "SAVE:9.0", intentId: "save", args: "{}" }), "occurrence-mismatch");
    await denied(write("bindOccurrence", { stage: "s1", occurrenceId: "SAVE:7.0", intentId: "other", args: "{}" }), "intent-not-admitted");
    await denied(write("bindOccurrence", { stage: "s1", occurrenceId: "SAVE:1.0", intentId: "save", expansionKey: "k", args: "{}" }), "occurrence-mismatch");
    await denied(write("bindOccurrence", { stage: "s0", occurrenceId: runtimeOccurrenceId("batch", "batch 1"), intentId: "batch", expansionKey: "batch 2", args: "{}" }), "occurrence-mismatch");
  });

  it("enforces bounds atomically under concurrent binds", async () => {
    admit();
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(bindBatch));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter(r => r.status === "rejected").every(r => (r as PromiseRejectedResult).reason.reason === "bounds-exceeded")).toBe(true);
  });

  it("requires every observation an occurrence names to be recorded", async () => {
    admit();
    const oid = observationId("s0", "cohort");
    const args = { stage: "s0", occurrenceId: runtimeOccurrenceId("batch", "batch 1"), intentId: "batch", expansionKey: "batch 1", args: "{}", observations: [oid] };
    await denied(write("bindOccurrence", args), "observation-not-recorded");
    await write("observation", { stage: "s0", key: "cohort", text: "[1,2]" });
    expect(await write("bindOccurrence", args)).toMatchObject({ bound: true });
  });

  it("closes a stage only with exactly what was bound, and binds no runtime occurrence after", async () => {
    admit();
    await bindBatch(1);
    await bindBatch(2);
    await denied(write("closeStage", { stage: "s0", occurrences: { batch: [runtimeOccurrenceId("batch", "batch 1")] } }), "close-mismatch");
    await denied(write("closeStage", { stage: "s0", occurrences: { batch: [1, 2, 3].map(n => runtimeOccurrenceId("batch", `batch ${n}`)) } }), "close-mismatch");
    await write("closeStage", { stage: "s0", occurrences: { batch: [1, 2].map(n => runtimeOccurrenceId("batch", `batch ${n}`)) } });
    await denied(bindBatch(3), "stage-closed");
  });
});

describe("settlement and finish", () => {
  const closeAll = async n => {
    await write("closeStage", { stage: "s1", occurrences: { save: ["SAVE:1.0"] } });
    await write("closeStage", { stage: "s0", occurrences: { batch: Array.from({ length: n }, (_, i) => runtimeOccurrenceId("batch", `batch ${i + 1}`)) } });
  };

  it("completes from receipts when everything completed and every stage closed, with the result due for publication", async () => {
    admit();
    await bindStatic();
    await bindBatch(1);
    receipt("s1", "SAVE:1.0", "succeeded");
    receipt("s0", runtimeOccurrenceId("batch", "batch 1"), "succeeded");
    await closeAll(1);
    expect((await settle()).recorded).toBe(2);
    const done = await write("finish", { result: "{\"saved\":2}" });
    expect(done).toMatchObject({ status: "completed", result: { state: "available", digest: digest("{\"saved\":2}") }, publication: { state: "due", resultDigest: digest("{\"saved\":2}") } });
    expect(await write("published")).toMatchObject({ publication: { state: "published" } });
    await denied(write("finish", {}), "command-finished");
  });

  it("is completed with no result to publish when the head's answer was lost", async () => {
    admit();
    await bindStatic();
    await bindBatch(1);
    receipt("s1", "SAVE:1.0", "succeeded");
    receipt("s0", runtimeOccurrenceId("batch", "batch 1"), "succeeded");
    await closeAll(1);
    await settle();
    expect(await write("finish", {})).toMatchObject({ status: "completed", result: { state: "unavailable" }, publication: { state: "none" } });
    await denied(write("published"), "nothing-to-publish");
  });

  it("is partial when one save completed and one failed", async () => {
    admit();
    await bindStatic();
    await bindBatch(1);
    receipt("s1", "SAVE:1.0", "succeeded");
    receipt("s0", runtimeOccurrenceId("batch", "batch 1"), "failed");
    await closeAll(1);
    await settle();
    expect(await write("finish", {})).toMatchObject({ status: "partial", publication: { state: "none" } });
  });

  it("is uncertain for a receipt claimed with no outcome, and settles it once it records", async () => {
    admit();
    await bindStatic();
    receipt("s1", "SAVE:1.0", "uncertain", false);
    await settle();
    expect((await policy.commandRead({ caller: GATEWAY, commandId, what: "outcomes" })).outcomes[0]).toMatchObject({ outcome: "uncertain", final: false });
    receipts.length = 0;
    receipt("s1", "SAVE:1.0", "succeeded");
    await settle();
    expect((await policy.commandRead({ caller: GATEWAY, commandId, what: "outcomes" })).outcomes[0]).toMatchObject({ outcome: "completed", final: true });
  });

  it("records a lost response as uncertain only for bound occurrences without an outcome", async () => {
    admit();
    await bindStatic();
    await bindBatch(1);
    receipt("s0", runtimeOccurrenceId("batch", "batch 1"), "succeeded");
    await settle();
    expect((await write("recordLost", { stage: "s0" })).recorded).toHaveLength(0);
    expect((await write("recordLost", { stage: "s1" })).recorded).toHaveLength(1);
    expect(await write("finish", {})).toMatchObject({ status: "uncertain" });
  });

  it("refuses to finish while an occurrence is unsettled", async () => {
    admit();
    await bindStatic();
    await denied(write("finish", {}), "occurrences-unsettled");
  });

  it("is failed when nothing was written, even with the head not reached", async () => {
    admit();
    await write("markNotReached", { stages: ["s0"] });
    expect(await write("finish", {})).toMatchObject({ status: "failed" });
  });

  it("is partial, not completed, when the tail wrote and an intent-bearing head was not reached", async () => {
    admit();
    await bindStatic();
    receipt("s1", "SAVE:1.0", "succeeded");
    await write("closeStage", { stage: "s1", occurrences: { save: ["SAVE:1.0"] } });
    await settle();
    await write("markNotReached", { stages: ["s0"] });
    expect(await write("finish", {})).toMatchObject({ status: "partial" });
  });

  it("settles a fully completed static stage without its close (a revoked connection can't re-run it)", async () => {
    const c = commandStore.commands.get(commandId);
    commandStore.commands.set(commandId, { ...c, phase: "admitted", admission: { planDigest: ADMISSION.planDigest, stages: { s0: ADMISSION.stages.s1 } } });
    await write("bindOccurrence", { stage: "s0", occurrenceId: "SAVE:1.0", intentId: "save", args: "{}" });
    receipt("s0", "SAVE:1.0", "succeeded");
    await settle();
    expect(await write("finish", {})).toMatchObject({ status: "completed", result: { state: "unavailable" } });
  });

  it("refuses an open runtime stage's completion from receipts alone", async () => {
    admit();
    await bindStatic();
    await bindBatch(1);
    receipt("s1", "SAVE:1.0", "succeeded");
    receipt("s0", runtimeOccurrenceId("batch", "batch 1"), "succeeded");
    await write("closeStage", { stage: "s1", occurrences: { save: ["SAVE:1.0"] } });
    await settle();
    // s0 never closed: it might have expanded further.
    expect(await write("finish", {})).toMatchObject({ status: "partial" });
  });
});

describe("the transition extension point", () => {
  it("refuses a scheduling intent in B5, and is fenced", async () => {
    await expect(policy.transitionCommand({ caller: GATEWAY, commandId, generation: 1, intent: { nextWakeAt: 1 } })).rejects.toMatchObject({ reason: "not-supported" });
    await expect(policy.transitionCommand({ caller: GATEWAY, commandId, generation: 2 })).rejects.toMatchObject({ reason: "stale-generation" });
    expect(await policy.transitionCommand({ caller: GATEWAY, commandId, generation: 1 })).toMatchObject({ commandId });
  });
});

describe("runtimeOccurrenceId", () => {
  // The same vectors as the kernel's (languages/l0000/crates/core/tests/commands.rs).
  it("encodes {intentId, expansionKey} as the kernel does", () => {
    expect(runtimeOccurrenceId("batch", "batch 3")).toBe("x:f35a77fd3bf9bee5b6545b22e547993efae82e6447c58aeccdea9f053eddd5d0");
    expect(runtimeOccurrenceId("sa\"ve/é", "k\n1")).toBe("x:dcd6ad29865e8912dad4c9a8839841d6b91a7d6443a2f5c6868f221248f133b5");
  });
});

describe("aggregateStatus", () => {
  const ran = { state: "ran", expansion: "closed", hasIntents: true };
  it("follows design §5's rules", () => {
    expect(aggregateStatus({ operations: [{ outcome: "completed" }, { outcome: "uncertain" }], stages: [ran] })).toBe("uncertain");
    expect(aggregateStatus({ operations: [{ outcome: "failed" }], stages: [ran] })).toBe("failed");
    expect(aggregateStatus({ operations: [], stages: [{ state: "not-reached", expansion: "open", hasIntents: true }] })).toBe("failed");
    expect(aggregateStatus({ operations: [{ outcome: "completed" }], stages: [ran] })).toBe("completed");
    expect(aggregateStatus({ operations: [{ outcome: "completed" }, { outcome: "failed" }], stages: [ran] })).toBe("partial");
    expect(aggregateStatus({ operations: [{ outcome: "completed" }], stages: [ran, { state: "not-reached", expansion: "open", hasIntents: false }] })).toBe("completed");
  });
});

describe("resuming a closed stage", () => {
  it("acknowledges a rebind of an already bound runtime occurrence after the close", async () => {
    admit();
    await bindBatch(1);
    await write("closeStage", { stage: "s0", occurrences: { batch: [runtimeOccurrenceId("batch", "batch 1")] } });
    expect(await bindBatch(1)).toMatchObject({ bound: false });
    await denied(bindBatch(2), "stage-closed");
  });

  it("reads the worker's state with the connection's owner and no payloads", async () => {
    admit();
    const state = await policy.commandRead({ caller: GATEWAY, commandId, what: "state" });
    expect(state).toMatchObject({ commandId, phase: "admitted", ownerUid: OWNER, generation: 1 });
    expect(state).not.toHaveProperty("request");
    expect(state.admission.stages.s0.intents[0].id).toBe("batch");
  });
});

// C6 slice 0: a definite refusal of a bind is recorded, and counted failed.
describe("refused binds", () => {
  const closeAll = async n => {
    await write("closeStage", { stage: "s1", occurrences: { save: ["SAVE:1.0"] } });
    await write("closeStage", { stage: "s0", occurrences: { batch: Array.from({ length: n }, (_, i) => runtimeOccurrenceId("batch", `batch ${i + 1}`)) } });
  };

  it("records a bind past the bound, so the command is partial, not completed", async () => {
    admit();
    await bindStatic();
    for (const n of [1, 2, 3]) await bindBatch(n);
    await denied(bindBatch(4), "bounds-exceeded");
    const { refusals } = await policy.commandRead({ caller: GATEWAY, commandId, what: "refusals" });
    expect(refusals).toMatchObject([{ stage: "s0", occurrenceId: runtimeOccurrenceId("batch", "batch 4"), reason: "bounds-exceeded" }]);
    receipt("s1", "SAVE:1.0", "succeeded");
    for (const n of [1, 2, 3]) receipt("s0", runtimeOccurrenceId("batch", `batch ${n}`), "succeeded");
    // The stage closes over what was bound: the refused one isn't in it.
    await closeAll(3);
    await settle();
    expect(await write("finish", {})).toMatchObject({ status: "partial" });
    expect((await policy.commandRead({ caller: GATEWAY, commandId, what: "state" })).counts).toMatchObject({ completed: 4, failed: 1 });
  });

  it("is failed when the only save was refused and nothing was written", async () => {
    admit();
    await denied(write("bindOccurrence", { stage: "s1", occurrenceId: "SAVE:7.0", intentId: "other", args: "{}" }), "intent-not-admitted");
    expect(await write("finish", {})).toMatchObject({ status: "failed" });
  });

  it("answers a resumed run's same bind with the recorded refusal, after a takeover too", async () => {
    admit();
    for (const n of [1, 2, 3]) await bindBatch(n);
    await denied(bindBatch(4), "bounds-exceeded");
    clock += COMMAND_LEASE_MS + 1;
    await policy.leaseCommand({ caller: GATEWAY, commandId, worker: "api-2", generation: 1, takeOver: true });
    // The successful binds are acknowledged; the refused one meets its record.
    for (const n of [1, 2, 3]) expect(await bindBatch(n).catch(() => null)).toBeNull();
    const again = (n, g) => write("bindOccurrence", { stage: "s0", occurrenceId: runtimeOccurrenceId("batch", `batch ${n}`), intentId: "batch", expansionKey: `batch ${n}`, args: `{"batch":${n}}` }, g);
    for (const n of [1, 2, 3]) expect(await again(n, 2)).toMatchObject({ bound: false });
    await denied(again(4, 2), "bounds-exceeded");
    expect((await policy.commandRead({ caller: GATEWAY, commandId, what: "refusals" })).refusals).toHaveLength(1);
  });

  it("records nothing for a stale owner's bind", async () => {
    admit();
    await denied(write("bindOccurrence", { stage: "s1", occurrenceId: "SAVE:7.0", intentId: "other", args: "{}" }, 2), "stale-generation");
    expect((await policy.commandRead({ caller: GATEWAY, commandId, what: "refusals" })).refusals).toEqual([]);
  });
});

// B6 (docs/b6-command-repair-plan.md decision 5): every stage's output, the
// output of every occurrence, and the pinned input tied to the output below.
describe("recorded outputs", () => {
  const recording = () => {
    const c = commandStore.commands.get(commandId);
    commandStore.commands.set(commandId, { ...c, phase: "admitted", admission: { ...structuredClone(ADMISSION), recording: 1 } });
  };
  const output = (stage, text, generation = 1) => write("installOutput", { stage, text }, generation);
  const read = (what, stage = null) => policy.commandRead({ caller: GATEWAY, commandId, what, stage });

  it("installs a stage's output once, by digest, names it on the stage, and refuses another", async () => {
    recording();
    const text = "{\"data\":{\"items\":[1]},\"errors\":[]}";
    expect(await output("s1", text)).toEqual({ stage: "s1", digest: digest(text) });
    // The same output again (a retry) is acknowledged; another is refused.
    expect(await output("s1", text)).toEqual({ stage: "s1", digest: digest(text) });
    await denied(output("s1", "{\"data\":{\"items\":[2]},\"errors\":[]}"), "output-conflict");
    expect((await read("output", "s1")).output).toMatchObject({ stage: "s1", text, digest: digest(text) });
    expect((await read("state")).stages.s1.output).toBe(digest(text));
    expect((await read("output", "s0")).output).toBeNull();
  });

  it("is fenced like every owner write, and only for an admitted stage", async () => {
    recording();
    const before = snapshot();
    await denied(output("s1", "{}", 2), "stale-generation");
    await denied(output("s9", "{}"), "bad-request");
    expect(snapshot()).toBe(before);
  });

  it("records an output over the cap as too large, never truncated", async () => {
    recording();
    expect(await output("s1", JSON.stringify({ big: "x".repeat(1_100_000) }))).toEqual({ stage: "s1", tooLarge: true });
    expect((await read("state")).stages.s1.output).toBe("too-large");
    expect((await read("output", "s1")).output).toBeNull();
  });

  it("pins exactly the output recorded below, and refuses any other input", async () => {
    recording();
    const below = "{\"data\":{\"items\":[1]},\"errors\":[]}";
    await output("s1", below);
    await denied(write("installInput", { stage: "s0", text: "{\"data\":{\"items\":[\"changed\"]},\"errors\":[]}" }), "input-not-output");
    expect(await write("installInput", { stage: "s0", text: below })).toMatchObject({ stage: "s0", digest: digest(below) });
  });

  it("leaves a command admitted before recording as it was", async () => {
    admit();
    await output("s1", "{\"data\":1,\"errors\":[]}");
    expect(await write("installInput", { stage: "s0", text: "{\"data\":2,\"errors\":[]}" })).toMatchObject({ stage: "s0" });
  });

  it("records what each settled occurrence returned, from its receipt", async () => {
    recording();
    await bindStatic();
    await bindBatch(1);
    receipts.push({ operationId: `${invocationId}/s1/SAVE:1.0`, status: "succeeded", recorded: true, steps: ["questions"], result: { saved: true, references: ["r1"] } });
    // A claim with no outcome has no result yet.
    receipts.push({ operationId: `${invocationId}/s0/${runtimeOccurrenceId("batch", "batch 1")}`, status: "uncertain", recorded: false, steps: [] });
    await settle();
    const outcomes = (await read("outcomes")).outcomes;
    const saved = outcomes.find(o => o.stage === "s1");
    const text = JSON.stringify({ saved: true, references: ["r1"] });
    expect(saved.output).toEqual({ text, digest: digest(text) });
    expect("output" in outcomes.find(o => o.stage === "s0")).toBe(false);
  });
});
