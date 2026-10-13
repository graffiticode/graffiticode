// api's part of W3 (spec FAIL-01, AUDIT-01): structured compile errors,
// cumulative effects across stages, an audit without user identifiers, and
// the two FAIL-01 rules api already keeps, proven: a compile through a
// connection never touches the shared cache, and a refused or failed
// invocation is never replaced by a new one.
import { jest } from "@jest/globals";
import { buildDataApi } from "./data.js";
import { createApiAudit, AuditIdentifierRefused } from "./audit.js";
import { InvocationRefused } from "./invocations.js";
import { buildMemoryArtifactStorer } from "./storage/artifacts.js";
import { createStorers } from "./storage/index.js";
import { clearFirestore } from "./testing/firestore.js";
import { TASK1, TASK2 } from "./testing/fixture.js";

const INVOCATION = { invocationToken: "inv.tok.en", invocationId: "inv-1", seq: 1, ownerUid: "0xowner" };
// Test doubles: jest's mocks don't carry the real dependencies' types.
const resolving = value => /** @type {any} */ (jest.fn()).mockResolvedValue(value);
const rejecting = err => /** @type {any} */ (jest.fn()).mockRejectedValue(err);

let taskStorer;
let compileStorer;
let compile;
let records;
let audit;

beforeEach(async () => {
  await clearFirestore();
  ({ taskStorer, compileStorer } = createStorers());
  compile = jest.fn();
  records = [];
  audit = createApiAudit({ sink: r => records.push(r) });
});

const api = (over = {}) => buildDataApi(/** @type {any} */ ({
  compile,
  allocateInvocation: resolving(INVOCATION),
  artifactStorer: buildMemoryArtifactStorer(),
  audit,
  ...over,
}));
const get = (dataApi, id, extra = {}) => dataApi.get({ taskStorer, compileStorer, id, auth: { uid: "0xuser" }, connectionId: "conn-1", ...extra });

describe("api's audit has no user identifiers (decision: enforced)", () => {
  it("refuses a record carrying uid or ownerUid", () => {
    expect(() => audit({ event: "artifact", outcome: "succeeded", uid: "0xuser" })).toThrow(AuditIdentifierRefused);
    expect(() => audit({ event: "artifact", outcome: "succeeded", ownerUid: "0xowner" })).toThrow(AuditIdentifierRefused);
    expect(records).toEqual([]);
  });

  it("never writes a user or owner field, even for a compile by a user on someone's connection", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    compile.mockResolvedValueOnce({ data: { ok: true }, errors: [] });
    await get(api(), id);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(r => !("user" in r) && !("owner" in r) && !("uid" in r) && !("ownerUid" in r))).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/0xuser|0xowner/);
  });
});

describe("structured failures (spec FAIL-01)", () => {
  it("names a refused allocation's reason and category, keeping the message", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    const out = await get(api({ allocateInvocation: rejecting(new InvocationRefused("not-granted")) }), id);
    expect(out.errors).toEqual([{ message: "Error: permission denied (not-granted)", from: -1, to: -1, code: "not-granted", category: "permission" }]);
    expect(records).toEqual([expect.objectContaining({ event: "gateway-invocation", outcome: "denied", reason: "not-granted", category: "permission", connectionId: "conn-1" })]);
    expect(records[0].attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("classifies a wrapped refusal by the reason it wraps", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    const out = await get(api({ allocateInvocation: rejecting(new InvocationRefused("maintenance")) }), id);
    expect(out.errors[0]).toMatchObject({ code: "maintenance", category: "unavailable" });
  });

  it("reports Policy unreachable as unavailable", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    const out = await get(api({ allocateInvocation: rejecting(new Error("ECONNRESET")) }), id);
    expect(out.errors[0]).toMatchObject({ code: "policy-unavailable", category: "unavailable" });
    expect(records[0]).toMatchObject({ event: "gateway-invocation", outcome: "failed", reason: "policy-unavailable" });
    expect(JSON.stringify(records)).not.toContain("ECONNRESET");
  });

  it("audits an allocated invocation and its stored artifact, by trusted ids", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    compile.mockResolvedValueOnce({ data: { ok: true }, errors: [] });
    await get(api(), id);
    expect(records.map(r => [r.event, r.outcome, r.invocationId])).toEqual([["gateway-invocation", "allowed", "inv-1"], ["artifact", "succeeded", "inv-1"]]);
    expect(new Set(records.map(r => r.attemptId)).size).toBe(1);
  });

  it("audits an artifact that couldn't be stored, with its category, beside the result", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    compile.mockResolvedValueOnce({ data: { ok: true }, errors: [] });
    const failing = { put: async () => { throw new Error("firestore unavailable"); } };
    jest.useFakeTimers({ advanceTimers: true });
    const out = await get(api({ artifactStorer: failing }), id, { idempotencyKey: "job-1" });
    jest.useRealTimers();
    expect(out.artifact).toMatchObject({ stored: false, error: "artifact-storage-unavailable", category: "unavailable", retryable: true });
    expect(records.at(-1)).toMatchObject({ event: "artifact", outcome: "failed", reason: "artifact-storage-unavailable", category: "unavailable", invocationId: "inv-1" });
  });
});

describe("cumulative effects across a chain (spec FAIL-01)", () => {
  it("reports every stage's effects, keeps an earlier save when a later stage fails, and keeps them out of stage inputs", async () => {
    const id1 = await taskStorer.create({ task: TASK1 });
    const id2 = await taskStorer.create({ task: TASK2 });
    const id = taskStorer.appendIds(id1, id2);
    // Right to left: s1 (TASK2) saves; s0 (TASK1) fails.
    compile
      .mockResolvedValueOnce({ data: { saved: true }, errors: [], effects: [{ fn: "save-to-itembank", op: "learnosity.write-items", status: "succeeded", steps: ["questions", "items"] }] })
      .mockResolvedValueOnce({ errors: [{ message: "Item bank save partial" }], effects: [{ fn: "save-to-itembank", op: "learnosity.write-items", status: "partial", steps: ["questions"], failedStep: "items", reason: "authorization-denied:not-granted", category: "permission" }] });
    const out = await get(api(), id);
    expect(out.effects).toEqual([
      { fn: "save-to-itembank", op: "learnosity.write-items", status: "succeeded", steps: ["questions", "items"], stage: "s1" },
      { fn: "save-to-itembank", op: "learnosity.write-items", status: "partial", steps: ["questions"], failedStep: "items", reason: "authorization-denied:not-granted", category: "permission", stage: "s0" },
    ]);
    // The second stage's input carried no effects.
    expect(compile.mock.calls[1][0].data).toEqual({ data: { saved: true }, errors: [] });
  });

  it("keeps uncertain with no completed steps", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    compile.mockResolvedValueOnce({ errors: [{ message: "Item bank save uncertain" }], effects: [{ status: "uncertain", steps: [], failedStep: "questions" }] });
    expect((await get(api(), id)).effects).toEqual([{ status: "uncertain", steps: [], failedStep: "questions", stage: "s0" }]);
  });

  // Languages that predate W3b return no effects: nothing changes for them.
  it("adds nothing for a language that reports no effects", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    compile.mockResolvedValueOnce({ data: { ok: true }, errors: [] });
    expect(await get(api(), id)).not.toHaveProperty("effects");
  });
});

describe("FAIL-01 rules api already keeps", () => {
  it("never answers a compile through a connection from the shared cache, or writes it there, even after a denial", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    const getCached = jest.spyOn(compileStorer, "get");
    const create = jest.spyOn(compileStorer, "create");
    await get(api({ allocateInvocation: rejecting(new InvocationRefused("not-granted")) }), id);
    compile.mockResolvedValueOnce({ data: { ok: true }, errors: [] });
    await get(api(), id);
    expect(getCached).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("never replaces a refused or failed invocation with a new one", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    const refusing = rejecting(new InvocationRefused("not-granted"));
    await get(api({ allocateInvocation: refusing }), id);
    expect(refusing).toHaveBeenCalledTimes(1);
    const allocate = resolving(INVOCATION);
    compile.mockResolvedValueOnce({ errors: [{ message: "Item bank save uncertain" }], effects: [{ status: "uncertain", steps: [] }] });
    await get(api({ allocateInvocation: allocate }), id, { idempotencyKey: "job-1" });
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
  });
});
