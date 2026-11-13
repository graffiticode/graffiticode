// Receipt reads for command settlement (B5): createReceiptReader against the
// memory receipt store. Reads only, and never needs a credential.
import { createMemoryReceiptStore, createReceiptReader, ReceiptReadRefused, MAX_OPERATION_IDS } from "./index.js";

const INV = "inv-0001";
const BINDING = { principal: "0xuser", ownerUid: "0xowner", connectionId: "conn-1", lang: "0176", fn: "save-to-itembank", op: "learnosity.save-items", registryVersion: 9, argsDigest: "d" };

let receipts;
let read;

beforeEach(async () => {
  receipts = createMemoryReceiptStore();
  read = createReceiptReader({ receipts });
  // s0/a.0 completed; s0/a.1 claimed with one step and no outcome; s1/b.0 failed.
  await receipts.claim(`${INV}/s0/a.0`, BINDING);
  await receipts.putStep(`${INV}/s0/a.0`, 0, "questions");
  await receipts.putOutcome(`${INV}/s0/a.0`, { status: "succeeded", steps: ["questions"], result: { saved: true } });
  await receipts.claim(`${INV}/s0/a.1`, BINDING);
  await receipts.putStep(`${INV}/s0/a.1`, 0, "questions");
  await receipts.claim(`${INV}/s1/b.0`, BINDING);
  await receipts.putOutcome(`${INV}/s1/b.0`, { status: "failed", steps: [], reason: "provider-rejected", category: "conflict" });
  // Another invocation's claim is never read.
  await receipts.claim("inv-0002/s0/a.0", BINDING);
});

describe("createReceiptReader", () => {
  it("reads an invocation's claims with their recorded outcomes, and a claim with none as uncertain", async () => {
    const { invocationId, operations } = await read({ invocationId: INV });
    expect(invocationId).toBe(INV);
    expect(operations.map(o => [o.operationId, o.status, o.recorded, o.steps])).toEqual([
      [`${INV}/s0/a.0`, "succeeded", true, ["questions"]],
      [`${INV}/s0/a.1`, "uncertain", false, ["questions"]],
      [`${INV}/s1/b.0`, "failed", true, []],
    ]);
    expect(operations[2]).toMatchObject({ reason: "provider-rejected", category: "conflict", binding: BINDING });
  });

  // B6 (docs/b6-command-repair-plan.md decision 5): what each recorded write
  // returned, so Policy records its output. Only writes have receipts, so this
  // is never a signed preview request.
  it("returns a recorded outcome's result, and nothing for a claim without one", async () => {
    const { operations } = await read({ invocationId: INV });
    expect(operations.map(o => [o.operationId, o.result])).toEqual([
      [`${INV}/s0/a.0`, { saved: true }],
      [`${INV}/s0/a.1`, undefined],
      [`${INV}/s1/b.0`, null],
    ]);
  });

  it("returns a final reconciliation's result beside the claim", async () => {
    await receipts.createResolution(`${INV}/s0/a.1`, { verdict: "applied", attemptId: "a1", decisionId: "d1", result: { saved: true, references: ["r"] }, resultSource: "evidence" });
    // A resolution made before B6 carries no result, and none is reported.
    await receipts.createResolution(`${INV}/s1/b.0`, { verdict: "applied", attemptId: "a2", decisionId: "d2" });
    const { operations } = await read({ invocationId: INV });
    expect(operations[1]).toMatchObject({ recorded: false, status: "uncertain", resolution: { verdict: "applied", result: { saved: true, references: ["r"] }, resultSource: "evidence" } });
    expect("resolution" in operations[2]).toBe(false);
  });

  it("reads only the named operations, skipping ones never claimed", async () => {
    const { operations } = await read({ invocationId: INV, operationIds: [`${INV}/s1/b.0`, `${INV}/s0/never.0`, `${INV}/s1/b.0`] });
    expect(operations.map(o => o.operationId)).toEqual([`${INV}/s1/b.0`]);
  });

  it("refuses an operation outside the invocation, a malformed id, or too many", async () => {
    await expect(read({ invocationId: INV, operationIds: ["inv-0002/s0/a.0"] })).rejects.toMatchObject({ reason: "operation-not-in-invocation" });
    await expect(read({ invocationId: INV, operationIds: [`${INV}/s0`] })).rejects.toMatchObject({ reason: "operation-not-in-invocation" });
    await expect(read({ invocationId: "../x" })).rejects.toBeInstanceOf(ReceiptReadRefused);
    await expect(read({ invocationId: INV, operationIds: Array.from({ length: MAX_OPERATION_IDS + 1 }, (_, i) => `${INV}/s0/a.${i}`) })).rejects.toMatchObject({ reason: "bad-operation-ids" });
  });

  it("writes nothing: no claim, step, outcome or resolution changes", async () => {
    const before = JSON.stringify(await receipts.listClaims(INV));
    await read({ invocationId: INV });
    await read({ invocationId: INV, operationIds: [`${INV}/s0/never.0`] });
    expect(JSON.stringify(await receipts.listClaims(INV))).toBe(before);
    expect(await receipts.getClaim(`${INV}/s0/never.0`)).toBeNull();
    expect(await receipts.getOutcome(`${INV}/s0/a.1`)).toBeNull();
  });
});
