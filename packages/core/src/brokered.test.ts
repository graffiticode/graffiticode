// SPDX-License-Identifier: MIT
// The brokered path: a compile that selects a connection signs and saves
// through policy + broker (faked here at the client boundary), never with a
// credential of its own.
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";

const ITEM = "item [questions [mcq []] {}]";

let snapshots: any[];
let invocations: any[];
let snapshotReply: (args: any) => any;
let brokerReply: (call: any) => any;
let fetched: string[];

const fakeClient = {
  async getSnapshot(args: any) {
    snapshots.push({ fns: args.fns, langID: args.langID, connectionId: args.exec.connectionId });
    const reply = snapshotReply(args);
    if (reply instanceof Error) throw reply;
    args.exec.setSessionToken("session-1");
    return reply;
  },
  async invoke(_exec: any, call: any) {
    invocations.push(call);
    return brokerReply(call);
  },
};

beforeEach(() => {
  snapshots = [];
  invocations = [];
  fetched = [];
  snapshotReply = (args) => ({ allowed: args.fns, mode: "render" });
  brokerReply = (call) =>
    call.op === "learnosity.write-items"
      ? { status: "succeeded", result: { saved: true, references: ["graffiticode-t-0"] } }
      : { status: "succeeded", result: { request: `signed:${call.op}` } };
  // No provider call may leave the compiler on the brokered path.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
    fetched.push(String(url));
    return new Response("{}", { status: 500 });
  });
});

afterEach(() => vi.restoreAllMocks());

async function compile(src: string, identity?: any) {
  const code = await parser.parse(176, src, lexicon);
  return new Promise<{ err: any[]; val: any }>((resolve) =>
    compiler.compile(code, {}, {}, (err: any, val: any) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      resolve({ err: errors, val });
    }, identity),
  );
}

const WITH_CONNECTION = { uid: "u1", connectionId: "conn-1", userToken: "user", intentToken: null };

describe("before a policy client is configured", () => {
  test("a selected connection is refused, not silently run on server credentials", async () => {
    const { err } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err[0].message).toMatch(/connections are not available/);
  });
});

describe("brokered compiles", () => {
  beforeEach(() => {
    if (!(compiler as any).__configured) {
      (compiler as any).setPolicyClient(fakeClient);
      (compiler as any).__configured = true;
    }
  });

  test("without a connection the legacy path is untouched", async () => {
    const { err } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(invocations).toEqual([]);
  });

  test("a render is signed by the broker, with only preview fields sent", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err).toEqual([]);
    expect(snapshots).toEqual([{ fns: ["preview-itembank"], langID: "0176", connectionId: "conn-1" }]);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].op).toBe("learnosity.sign-questions-preview");
    expect(Object.keys(invocations[0].payload).sort()).toEqual(["id", "name", "questions", "session_id"]);
    expect(val.request).toBe("signed:learnosity.sign-questions-preview");
    expect(fetched).toEqual([]);
  });

  test("a save in a save session writes through the broker with no program credentials", async () => {
    snapshotReply = (args) => ({ allowed: args.fns, mode: "save" });
    const { err, val } = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err).toEqual([]);
    expect(invocations.map((c) => c.op)).toEqual(["learnosity.write-items", "learnosity.sign-questions-preview"]);
    const write = invocations[0];
    expect(write.fn).toBe("save-to-itembank");
    expect(write.payload.itemRecords[0]).toMatchObject({ reference: "graffiticode-t-0", status: "unpublished" });
    expect(write.occurrenceId).toMatch(/^SAVE_TO_ITEMBANK:\d+\.0$/);
    expect(val.data.itemBank).toMatchObject({ saved: true });
    expect(fetched).toEqual([]);
  });

  // The read path (graffiticode packages/api/src/read.js, signProgram): a
  // view of a stored result sends this fixed program, the unsigned activity
  // as a data literal, never the source. Keep the two shapes in step.
  test("a stored result is signed on read by a data-only program, with nothing else run", async () => {
    const built = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`);
    const { request: _unsigned, ...activity } = built.val;
    const signProgram = {
      1: { tag: "STR", elts: [JSON.stringify(activity)] },
      2: { tag: "JSON", elts: [1] },
      3: { tag: "EXPRS", elts: [2] },
      4: { tag: "PROG", elts: [3] },
      root: 4,
    };
    const { err, val } = await new Promise<{ err: any[]; val: any }>((resolve) =>
      compiler.compile(signProgram, {}, {}, (e: any, v: any) => resolve({ err: e ?? [], val: v }), WITH_CONNECTION),
    );
    expect(err).toEqual([]);
    expect(snapshots).toEqual([{ fns: ["preview-itembank"], langID: "0176", connectionId: "conn-1" }]);
    expect(invocations.map((c) => c.op)).toEqual(["learnosity.sign-questions-preview"]);
    expect(val.request).toBe("signed:learnosity.sign-questions-preview");
    expect(val.data.itemBank).toMatchObject({ skipped: "no-connection" });
    expect(fetched).toEqual([]);
  });

  // Policy refuses an occurrence id outside this pattern (ID_RE in
  // graffiticode packages/policy/src/policy.js); keep the two in step.
  test("every occurrence id the compiler sends is one policy accepts", async () => {
    snapshotReply = (args) => ({ allowed: args.fns, mode: "save" });
    const { err } = await compile(
      `set-var "lrn-id" "t" init save-to-itembank items [${ITEM}] {}..`,
      WITH_CONNECTION,
    );
    expect(err).toEqual([]);
    expect(invocations.length).toBeGreaterThan(1);
    for (const { occurrenceId } of invocations) {
      expect(occurrenceId).toMatch(/^[A-Za-z0-9_:.-]{1,200}$/);
    }
  });

  test("the legacy member form saves the same way", async () => {
    snapshotReply = (args) => ({ allowed: args.fns, mode: "save" });
    const { err } = await compile(`set-var "lrn-id" "t" items [save-to-itembank true, ${ITEM}] {}..`, WITH_CONNECTION);
    expect(err).toEqual([]);
    expect(invocations[0].op).toBe("learnosity.write-items");
  });

  test("a save in a render session is disabled and nothing is written", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err).toEqual([]);
    expect(val).toEqual({ skipped: "write-disabled", fn: "save-to-itembank" });
    expect(invocations.some((c) => c.op === "learnosity.write-items")).toBe(false);
  });

  test("an uncertain or partial save is an error, never a silent retry", async () => {
    snapshotReply = (args) => ({ allowed: args.fns, mode: "save" });
    brokerReply = (call) =>
      call.op === "learnosity.write-items"
        ? { status: "partial", steps: ["questions"], error: "items write failed" }
        : { status: "succeeded", result: { request: "r" } };
    const { err } = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err.map((e) => e.message ?? e).join()).toMatch(/Item bank save partial: items write failed/);
    expect(invocations.filter((c) => c.op === "learnosity.write-items")).toHaveLength(1);
  });

  test("an uncertain save tells the caller how to run it again deliberately", async () => {
    snapshotReply = (args) => ({ allowed: args.fns, mode: "save" });
    brokerReply = (call) =>
      call.op === "learnosity.write-items"
        ? { status: "uncertain", replayed: true }
        : { status: "succeeded", result: { request: "r" } };
    const { err } = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`, WITH_CONNECTION);
    const message = err.map((e) => e.message ?? e).join();
    expect(message).toMatch(/Item bank save uncertain/);
    expect(message).toMatch(/new idempotency key/);
  });

  test("a policy refusal stops the compile before anything runs", async () => {
    snapshotReply = () => new Error("403");
    const { err } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err[0].message).toMatch(/Permission check is unavailable/);
    expect(invocations).toEqual([]);
  });

  test("a snapshot without preview refuses every render", async () => {
    snapshotReply = () => ({ allowed: [], mode: "render" });
    const { err } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err[0].message).toMatch(/preview-itembank is not permitted/);
    expect(invocations).toEqual([]);
  });

  test("Author activities are disabled outside author mode", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" author {}..`, WITH_CONNECTION);
    expect(err).toEqual([]);
    expect(val).toEqual({ skipped: "mode-disabled", fn: "author-itembank" });
    expect(invocations).toEqual([]);
  });
});
