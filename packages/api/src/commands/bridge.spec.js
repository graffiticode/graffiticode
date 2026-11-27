// The compile-to-command bridge and its one eligibility rule (C6 slice 2,
// docs/c6-l0176-commands-plan.md §4, decisions 5 and 7).
import { buildEligibility, buildChainEligibility, buildCompileEnvelope, buildCommandBridge, commandOnlyChain, connectionRequired, isWriteFunction, keyKindOf } from "./bridge.js";
import { PolicyRefused } from "./policy-commands.js";
import { PreflightRefused, PreflightUnavailable } from "../admission.js";

const SAVE = { lang: "0176", code: { root: "save" } };
const PREVIEW = { lang: "0176", code: { root: "preview" } };
const DATA = { lang: "0000", code: { root: "data" } };
// What each stage's preflight reports it requires.
const REQUIRED = { save: ["init", "save-to-itembank"], preview: ["init"], data: [], snap: ["snap"], render: [] };
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

  // Error handling proposal, PR 1c: a compiler's refusal keeps its reason and
  // the category read from its answer.
  it.each([
    [{ reason: "not-granted", category: "permission", status: 403 }],
    [{ reason: "preflight-refused", category: "malformed", status: 400 }],
    [{ reason: "preflight-refused", category: "authentication", status: 401 }],
    [{ reason: "preflight-refused", category: "unavailable", status: 429 }],
    [{ reason: "some-unknown-reason", category: "unavailable", status: 403 }],
  ])("answers a compiler's preflight refusal in the envelope with its reason and category (%j)", async refusal => {
    const refusing = async () => { throw new PreflightRefused("refused", refusal); };
    const envelope = await buildCommandBridge({ eligible: refusing, getRunner: () => runner(), compileEnvelope })(args);
    expect(envelope.errors[0]).toMatchObject({ code: refusal.reason, category: refusal.category });
  });
});

// C5 (COMMAND_SCOPES=on; docs/c5-l0013-commands-plan.md): the whole chain
// decides, a chain may run with no connection or no user, and a command-only
// chain never falls back to the legacy compile.
const SNAP = { lang: "0013", code: { root: "snap" } };
const RENDER = { lang: "0013", code: { root: "render" } };
const C5_ENV = { COMMANDS_L0013: "on", COMMANDS_L0176: "on", COMMAND_SCOPES: "on" };

describe("whole-chain eligibility (C5)", () => {
  const chain = env => buildChainEligibility({ preflight, baseUrlFor, env });

  it("is a command for an L0013 capture, alone or under an L0000 head, needing no connection", async () => {
    for (const tasks of [[SNAP], [DATA, SNAP]]) {
      const verdict = await chain(C5_ENV)(tasks);
      expect(verdict).toEqual({ lang: "0013", writes: [{ stage: tasks.length === 1 ? "s0" : "s1", lang: "0013", fn: "snap", credential: "service" }] });
      expect(connectionRequired(verdict)).toBe(false);
    }
  });

  it("needs a connection for a mixed chain with an L0176 save", async () => {
    const verdict = /** @type {any} */ (await chain(C5_ENV)([SNAP, SAVE]));
    expect(verdict.writes.map(w => [w.lang, w.fn, w.credential])).toEqual([["0013", "snap", "service"], ["0176", "save-to-itembank", "connection"]]);
    expect(connectionRequired(verdict)).toBe(true);
  });

  it("refuses a chain whose writes are only partly allowed, and leaves one with none allowed to compile", async () => {
    expect(await chain({ COMMANDS_L0013: "on" })([SNAP, SAVE])).toMatchObject({ lang: "0013", refusal: "commands-not-enabled" });
    expect(await chain({ COMMANDS_L0176: "on" })([SNAP])).toBe(false);
    expect(await chain(C5_ENV)([RENDER, DATA])).toBe(false);
  });

  it("preflights only stages in languages with a write function", async () => {
    const asked = [];
    await buildChainEligibility({ preflight: async a => { asked.push(a.stage); return preflight(a); }, baseUrlFor, env: C5_ENV })([DATA, SNAP, PREVIEW]);
    expect(asked).toEqual(["s1", "s2"]);
  });

  it("names a command-only chain: one with a stage whose language writes outside commands, with its commands on", () => {
    expect(commandOnlyChain([DATA, SNAP], C5_ENV)).toBe(true);
    expect(commandOnlyChain([DATA, SNAP], {})).toBe(false);
    expect(commandOnlyChain([SAVE], C5_ENV)).toBe(false);
  });
});

describe("the bridge (C5)", () => {
  const allocations = [];
  const runner = over => ({
    // A lookup (create: false) finds nothing held by default; a create allocates.
    policy: { allocate: async a => { allocations.push(a); return a.create ? { protocol: "command", commandId: "c:1", generation: 1, owned: true } : { protocol: "none" }; }, lease: async () => ({}), ...over },
    run: async ({ commandId }) => ({ commandId, status: "completed" }),
    worker: "w1",
  });
  const compileEnvelope = async ran => ({ errors: [], effects: [], ran });
  const eligible = buildChainEligibility({ preflight, baseUrlFor, env: C5_ENV });
  const bridge = (over = {}) => buildCommandBridge({ eligible, getRunner: () => runner(), compileEnvelope, env: C5_ENV, newKey: () => "bridge:fresh", log: () => {}, ...over });
  const OWNER = { uid: "0xowner" };
  beforeEach(() => { allocations.length = 0; });

  it("runs an L0000 head over an L0013 capture with no connection, as its signed-in user", async () => {
    const envelope = await bridge()({ tasks: [DATA, SNAP], id: "chain", auth: OWNER, authToken: "t", connectionId: null, options: {}, idempotencyKey: "snap:1" });
    expect(envelope.ran.protocol).toBe("command");
    // The key is looked up first, then the command created.
    expect(allocations.map(a => a.create)).toEqual([false, true]);
    expect(allocations[1]).toEqual(expect.objectContaining({ connectionId: null, authToken: "t", idempotencyKey: "snap:1", create: true }));
    expect(allocations[1]).not.toHaveProperty("anonymous");
    expect(JSON.parse(allocations[1].request)).toEqual({ id: "chain", connectionId: null, options: {} });
  });

  it("refuses a mixed chain with no connection, allocating nothing", async () => {
    const envelope = await bridge()({ tasks: [SNAP, SAVE], id: "chain", auth: OWNER, authToken: "t", connectionId: null, options: {}, idempotencyKey: null });
    expect(envelope.errors[0]).toMatchObject({ code: "connection-required", category: "malformed" });
    expect(allocations).toEqual([]);
  });

  it("still runs a mixed chain through its connection", async () => {
    const envelope = await bridge()({ tasks: [SNAP, SAVE], id: "chain", auth: OWNER, authToken: "t", connectionId: "conn-1", options: {}, idempotencyKey: null });
    expect(envelope.ran.protocol).toBe("command");
    expect(allocations[0]).toMatchObject({ connectionId: "conn-1" });
  });

  it("refuses a chain whose writes are only partly allowed", async () => {
    const partial = bridge({ eligible: buildChainEligibility({ preflight, baseUrlFor, env: { COMMANDS_L0013: "on", COMMAND_SCOPES: "on" } }) });
    const envelope = await partial({ tasks: [SNAP, SAVE], id: "chain", auth: OWNER, authToken: "t", connectionId: "conn-1", options: {}, idempotencyKey: null });
    expect(envelope.errors[0].code).toBe("commands-not-enabled");
    expect(allocations).toEqual([]);
  });

  // The owner's review of #417: a key that already holds a command is served
  // from its record even when today's eligibility would refuse new work.
  it("serves a held key's retry when today's eligibility refuses new work, and refuses a new key", async () => {
    const held = { protocol: "command", commandId: "c:mixed", generation: 1, owned: false, reused: true, status: "completed" };
    const offNow = buildChainEligibility({ preflight, baseUrlFor, env: { COMMANDS_L0176: "on", COMMAND_SCOPES: "on" } });
    const args = { tasks: [SNAP, SAVE], id: "chain", auth: OWNER, authToken: "t", connectionId: "conn-1", options: {}, idempotencyKey: "save:1" };
    const served = await bridge({ eligible: offNow, getRunner: () => runner({ allocate: async a => { allocations.push(a); return held; } }) })(args);
    expect(served.ran.state).toMatchObject({ commandId: "c:mixed" });
    expect(allocations.map(a => a.create)).toEqual([false]);
    allocations.length = 0;
    const fresh = await bridge({ eligible: offNow, getRunner: () => runner({ allocate: async a => { allocations.push(a); return { protocol: "none" }; } }) })(args);
    expect(fresh.errors[0].code).toBe("commands-not-enabled");
    expect(allocations.map(a => a.create)).toEqual([false]);
  });

  it("serves a held key's retry before any preflight, so a compiler outage can't strand it", async () => {
    const held = { protocol: "command", commandId: "c:held", generation: 1, owned: false, reused: true, status: "completed" };
    let preflights = 0;
    const down = buildChainEligibility({ preflight: async () => { preflights++; throw new PreflightUnavailable("s0 unreachable"); }, baseUrlFor, env: C5_ENV });
    const served = await bridge({ eligible: down, getRunner: () => runner({ allocate: async a => { allocations.push(a); return held; } }) })({ tasks: [SNAP, SAVE], id: "chain", auth: OWNER, authToken: "t", connectionId: "conn-1", options: {}, idempotencyKey: "save:1" });
    expect(served.ran.state).toMatchObject({ commandId: "c:held" });
    expect(allocations.map(a => a.create)).toEqual([false]);
    expect(preflights).toBe(0);
    // A new key still needs its preflight.
    allocations.length = 0;
    const fresh = await bridge({ eligible: down })({ tasks: [SNAP, SAVE], id: "chain", auth: OWNER, authToken: "t", connectionId: "conn-1", options: {}, idempotencyKey: "save:2" });
    expect(fresh.errors[0].code).toBe("preflight-unavailable");
    expect(allocations.map(a => a.create)).toEqual([false]);
  });

  it("runs an anonymous capture as an anonymous command, with no token and never the caller's key", async () => {
    await bridge()({ tasks: [SNAP], id: "chain", auth: null, authToken: "ignored", connectionId: null, options: {}, idempotencyKey: "theirs" });
    expect(allocations).toEqual([expect.objectContaining({ anonymous: true, authToken: null, connectionId: null, idempotencyKey: "bridge:fresh" })]);
  });

  it("never lets a command-only chain fall back to the legacy compile", async () => {
    const args = { tasks: [SNAP], id: "chain", auth: OWNER, authToken: "t", connectionId: "conn-1", options: {}, idempotencyKey: "save:1" };
    // A key the legacy path holds.
    const legacy = await bridge({ getRunner: () => runner({ allocate: async () => ({ protocol: "legacy", invocationId: "inv-1" }) }) })(args);
    expect(legacy.errors[0].code).toBe("legacy-protocol");
    // A refused allocation answers its refusal, as always.
    const refused = await bridge({ getRunner: () => runner({ allocate: async () => { throw new PolicyRefused("not-owner"); } }) })(args);
    expect(refused.errors[0].code).toBe("not-owner");
    // No worker yet.
    expect((await bridge({ getRunner: () => null })(args)).errors[0].code).toBe("policy-unavailable");
    // An api that doesn't run v3 commands, asked with no connection.
    const unscoped = buildCommandBridge({ eligible, getRunner: () => runner(), compileEnvelope, env: { COMMANDS_L0013: "on" }, log: () => {} });
    expect((await unscoped({ ...args, connectionId: null })).errors[0].code).toBe("worker-unsupported");
    expect(allocations.filter(a => a.connectionId === null)).toEqual([]);
  });

  it("leaves an L0013 chain that captures nothing to compile as today", async () => {
    expect(await bridge()({ tasks: [RENDER], id: "chain", auth: null, authToken: null, connectionId: null, options: {}, idempotencyKey: null })).toBeNull();
    expect(allocations).toEqual([]);
  });

  it("keeps the C6 bridge's legacy fallback for an L0176 chain", async () => {
    const legacy = await bridge({ getRunner: () => runner({ allocate: async () => ({ protocol: "legacy", invocationId: "inv-1" }) }) })({ tasks: [SAVE, DATA], id: "chain", auth: OWNER, authToken: "t", connectionId: "conn-1", options: {}, idempotencyKey: "save:1" });
    expect(legacy).toBeNull();
  });
});
