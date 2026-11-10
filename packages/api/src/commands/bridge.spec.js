// The compile-to-command bridge and its one eligibility rule (C6 slice 2,
// docs/c6-l0176-commands-plan.md §4, decisions 5 and 7).
import { buildEligibility, buildCompileEnvelope, buildCommandBridge, isWriteFunction, keyKindOf } from "./bridge.js";
import { PolicyRefused } from "./policy-commands.js";
import { PreflightUnavailable } from "../admission.js";

const SAVE = { lang: "0176", code: { root: "save" } };
const PREVIEW = { lang: "0176", code: { root: "preview" } };
const DATA = { lang: "0000", code: { root: "data" } };
// What each stage's preflight reports it requires.
const REQUIRED = { save: ["init", "save-to-itembank"], preview: ["init"], data: [] };
const preflight = async ({ code }) => ({ manifest: { requiredFunctions: REQUIRED[code.root] } });
const baseUrlFor = async lang => `https://svc-${lang}`;

describe("eligibility", () => {
  const on = buildEligibility({ preflight, baseUrlFor, env: { COMMANDS_L0176: "on" } });
  const off = buildEligibility({ preflight, baseUrlFor, env: {} });

  it("is a flagged stage that writes", async () => {
    expect(await on([SAVE, DATA])).toBe("0176");
    expect(await off([SAVE, DATA])).toBe(false);
  });

  it("keeps a connection preview, with no save, off commands", async () => {
    expect(await on([PREVIEW, DATA])).toBe(false);
  });

  it("is the same for a chain headed by another language", async () => {
    // L0000 head, L0176 save below it: eligible when L0176's flag is on, not otherwise.
    expect(await on([DATA, SAVE])).toBe("0176");
    expect(await off([DATA, SAVE])).toBe(false);
  });

  it("never preflights an unflagged stage, and can't decide when a flagged one can't be preflighted", async () => {
    let asked = 0;
    const counting = buildEligibility({ preflight: async args => { asked++; return preflight(args); }, baseUrlFor, env: {} });
    await counting([SAVE, DATA]);
    expect(asked).toBe(0);
    const down = buildEligibility({ preflight: async () => { throw new PreflightUnavailable("s0 unreachable"); }, baseUrlFor, env: { COMMANDS_L0176: "on" } });
    await expect(down([SAVE])).rejects.toBeInstanceOf(PreflightUnavailable);
  });

  it("reads writes from the registry", () => {
    expect(isWriteFunction("0176", "save-to-itembank")).toBe(true);
    expect(isWriteFunction("L0176", "init")).toBe(false);
    expect(isWriteFunction("0000", "anything")).toBe(false);
  });
});

describe("the compile envelope", () => {
  const records = over => ({
    state: { commandId: "c:1", status: "completed", result: { state: "available" }, admission: { stages: { s0: { intents: [{ id: "save:21", fn: "save-to-itembank", op: "learnosity.write-items" }] } } }, ...over.state },
    occurrences: over.occurrences ?? [{ stage: "s0", occurrenceId: "x:a", intentId: "save:21" }],
    outcomes: over.outcomes ?? [{ stage: "s0", occurrenceId: "x:a", outcome: "completed", steps: ["questions", "items"] }],
    refusals: over.refusals ?? [],
    result: { text: "{\"type\":\"items\",\"data\":{\"itemBank\":{\"saved\":true}}}" },
  });
  const policyOf = r => ({ read: async ({ what }) => (what === "state" ? r.state : { [what]: r[what] }) });

  it("answers a completed command with its result and its writes, as a compile does", async () => {
    const envelope = await buildCompileEnvelope({ policy: policyOf(records({})) })({ state: { commandId: "c:1" }, reused: false });
    expect(envelope).toEqual({
      data: { type: "items", data: { itemBank: { saved: true } } },
      errors: [],
      effects: [{ fn: "save-to-itembank", op: "learnosity.write-items", status: "succeeded", steps: ["questions", "items"], stage: "s0" }],
      command: { commandId: "c:1", outcome: "completed", statusUrl: "/command/c%3A1" },
    });
  });

  it("reports a retry's writes as replayed", async () => {
    const envelope = await buildCompileEnvelope({ policy: policyOf(records({})) })({ state: { commandId: "c:1" }, reused: true });
    expect(envelope.effects[0].replayed).toBe(true);
  });

  it("answers a partial command with an error, its refused save failed, and no data without a result", async () => {
    const r = records({
      state: { status: "partial", result: { state: "unavailable" } },
      refusals: [{ stage: "s0", occurrenceId: "x:b", intentId: "save:21", reason: "bounds-exceeded" }],
    });
    const envelope = await buildCompileEnvelope({ policy: policyOf(r) })({ state: { commandId: "c:1" }, reused: false });
    expect(envelope.data).toBeUndefined();
    expect(envelope.errors[0]).toMatchObject({ code: "command-not-completed" });
    expect(envelope.effects.map(e => [e.status, e.reason])).toEqual([["succeeded", undefined], ["failed", "bounds-exceeded"]]);
  });

  it("answers a refused admission with its reason, as a legacy compile's refusal did", async () => {
    const r = records({
      state: { status: "failed", result: { state: "none" }, admission: null, admissionRefusal: { reason: "not-granted", at: "2026-11-10T00:00:00Z" } },
      occurrences: [],
      outcomes: [],
    });
    const envelope = await buildCompileEnvelope({ policy: policyOf(r) })({ state: { commandId: "c:1" }, reused: false });
    expect(envelope.data).toBeUndefined();
    expect(envelope.effects).toEqual([]);
    expect(envelope.errors).toEqual([expect.objectContaining({ message: "Error: permission denied (not-granted)", code: "not-granted" })]);
    expect(envelope.command).toEqual({ commandId: "c:1", outcome: "failed", statusUrl: "/command/c%3A1" });
  });

  it("maps an uncertain write, and a bound occurrence with no outcome, to uncertain", async () => {
    const r = records({ state: { status: "uncertain", result: { state: "unavailable" } }, outcomes: [] });
    const envelope = await buildCompileEnvelope({ policy: policyOf(r) })({ state: { commandId: "c:1" }, reused: false });
    expect(envelope.effects[0].status).toBe("uncertain");
  });
});

describe("the bridge", () => {
  const runner = over => ({
    policy: { allocate: async () => ({ protocol: "command", commandId: "c:1", generation: 1, owned: true }), lease: async () => ({}), ...over },
    run: async ({ commandId }) => ({ commandId, status: "completed" }),
    worker: "w1",
  });
  const args = { tasks: [SAVE, DATA], id: "chain", authToken: "t", connectionId: "conn-1", options: {}, idempotencyKey: null };
  const compileEnvelope = async ran => ({ errors: [], effects: [], ran });

  it("leaves an ineligible chain, and a legacy key, to compile as today", async () => {
    expect(await buildCommandBridge({ eligible: async () => false, getRunner: () => runner(), compileEnvelope })(args)).toBeNull();
    const legacy = runner({ allocate: async () => ({ protocol: "legacy", invocationId: "inv-1" }) });
    expect(await buildCommandBridge({ eligible: async () => "0176", getRunner: () => legacy, compileEnvelope })(args)).toBeNull();
  });

  it("runs an eligible compile as a command, with the caller's key or a fresh one", async () => {
    const keys = [];
    const r = runner({ allocate: async a => { keys.push([a.idempotencyKey, a.create]); return { protocol: "command", commandId: "c:1", generation: 1, owned: true }; } });
    const bridge = buildCommandBridge({ eligible: async () => "0176", getRunner: () => r, compileEnvelope, newKey: () => "bridge:fresh" });
    expect((await bridge(args)).ran.protocol).toBe("command");
    await bridge({ ...args, idempotencyKey: "save:abc" });
    expect(keys).toEqual([["bridge:fresh", true], ["save:abc", true]]);
  });

  it("logs one telemetry line per bridged compile: language, outcome, key kind and client", async () => {
    const lines = [];
    const bridge = buildCommandBridge({ eligible: async () => "0176", getRunner: () => runner(), compileEnvelope, log: line => lines.push(line), env: {} });
    await bridge({ ...args, idempotencyKey: "save:abc", client: "graffiticode-console" });
    await bridge(args);
    expect(lines.map(l => JSON.parse(l.replace(/^bridge /, "")))).toEqual([
      { lang: "0176", outcome: "completed", keyKind: "save", client: "graffiticode-console" },
      { lang: "0176", outcome: "completed", keyKind: "generated", client: null },
    ]);
    expect(await buildCommandBridge({ eligible: async () => false, getRunner: () => runner(), compileEnvelope, log: line => lines.push(line) })(args)).toBeNull();
    expect(lines).toHaveLength(2);
  });

  it("names the kind of key without the key", () => {
    expect(["save:x", "recompile:y", "canary:r:save", "c6-drive:r:1", "job-1", null].map(keyKindOf))
      .toEqual(["save", "recompile", "canary", "c6-drive", "other", "generated"]);
  });

  describe("retired (BRIDGE_L0176=off)", () => {
    const env = { BRIDGE_L0176: "off" };
    it("starts nothing: a compile that would save is refused, naming POST /command", async () => {
      const calls = [];
      const lines = [];
      const r = runner({ allocate: async a => { calls.push(a.create); return { protocol: "none" }; } });
      const envelope = await buildCommandBridge({ eligible: async () => "0176", getRunner: () => r, compileEnvelope, env, log: line => lines.push(line) })({ ...args, idempotencyKey: "job-1" });
      expect(envelope.errors[0]).toMatchObject({ code: "bridge-retired" });
      expect(envelope.errors[0].message).toMatch(/POST \/command/);
      expect(calls).toEqual([false]);
      const keyless = await buildCommandBridge({ eligible: async () => "0176", getRunner: () => r, compileEnvelope, env, log: line => lines.push(line) })(args);
      expect(keyless.errors[0].code).toBe("bridge-retired");
      expect(calls).toEqual([false]);
      expect(lines.map(l => JSON.parse(l.replace(/^bridge /, "")).outcome)).toEqual(["retired-refused", "retired-refused"]);
    });

    it("answers a key that already holds a command from its record, creating nothing", async () => {
      const calls = [];
      const r = runner({ allocate: async a => { calls.push(a.create); return { protocol: "command", commandId: "c:1", generation: 1, owned: false, status: "completed" }; } });
      const envelope = await buildCommandBridge({ eligible: async () => "0176", getRunner: () => r, compileEnvelope, env, log: () => {} })({ ...args, idempotencyKey: "save:abc" });
      expect(envelope.ran.protocol).toBe("command");
      expect(calls).toEqual([false]);
    });

    it("refuses a key the legacy path holds too: a compile never writes once retired", async () => {
      const r = runner({ allocate: async () => ({ protocol: "legacy", invocationId: "inv-1" }) });
      const envelope = await buildCommandBridge({ eligible: async () => "0176", getRunner: () => r, compileEnvelope, env, log: () => {} })({ ...args, idempotencyKey: "save:abc" });
      expect(envelope.errors[0].code).toBe("bridge-retired");
    });

    it("leaves a chain with no write (a preview) to compile as today", async () => {
      expect(await buildCommandBridge({ eligible: async () => false, getRunner: () => runner(), compileEnvelope, env, log: () => {} })(args)).toBeNull();
    });
  });

  it("answers refusals in the envelope, as a legacy compile does", async () => {
    const refused = runner({ allocate: async () => { throw new PolicyRefused("connection-disabled"); } });
    const envelope = await buildCommandBridge({ eligible: async () => "0176", getRunner: () => refused, compileEnvelope })(args);
    expect(envelope.errors[0]).toMatchObject({ code: "connection-disabled", category: "permission" });
    const down = await buildCommandBridge({ eligible: async () => { throw new PreflightUnavailable("unreachable"); }, getRunner: () => runner(), compileEnvelope })(args);
    expect(down.errors[0].code).toBe("preflight-unavailable");
  });
});
