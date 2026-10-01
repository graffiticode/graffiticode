// SPDX-License-Identifier: MIT
// The brokered path: a compile that selects a connection signs and saves
// through policy + broker (faked here at the client boundary), never with a
// credential of its own. A compile without one signs its preview through a
// system preview session (policy POST /v1/preview-session), the same way.
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";

const ITEM = "item [questions [mcq []] {}]";

let snapshots: any[];
let invocations: any[];
let snapshotReply: (args: any) => any;
let brokerReply: (call: any) => any;
let fetched: string[];
let previewSessions: any[];
let previewReply: () => any;
let sessionsUsed: (string | null)[];

const fakeClient = {
  async getSnapshot(args: any) {
    snapshots.push({ fns: args.fns, langID: args.langID, connectionId: args.exec.connectionId });
    const reply = snapshotReply(args);
    if (reply instanceof Error) throw reply;
    args.exec.setSessionToken("session-1");
    return reply;
  },
  async invoke(exec: any, call: any) {
    invocations.push(call);
    sessionsUsed.push(exec.sessionToken);
    return brokerReply(call);
  },
  async getPreviewSession(args: any) {
    previewSessions.push(args);
    const reply = previewReply();
    if (reply instanceof Error) throw reply;
    return reply;
  },
};

const refusal = (reason: string) => Object.assign(new Error("/v1/preview-session failed (403)"), { status: 403, reason });

beforeEach(() => {
  snapshots = [];
  invocations = [];
  fetched = [];
  previewSessions = [];
  sessionsUsed = [];
  previewReply = () => ({ allowed: ["init"], sessionToken: "system-session" });
  snapshotReply = (args) => ({ allowed: args.fns });
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

const WITH_CONNECTION = { uid: "u1", connectionId: "conn-1", userToken: "user", invocationToken: "inv", stage: "s0" };

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

  test("without a connection a preview is signed by the broker under a system preview session", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(previewSessions).toEqual([{ langID: "0176" }]);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ fn: "init", op: "learnosity.sign-questions-preview", occurrenceId: "prog.0" });
    expect(Object.keys(invocations[0].payload).sort()).toEqual(["id", "name", "questions", "session_id"]);
    expect(sessionsUsed).toEqual(["system-session"]);
    expect(val.request).toBe("signed:learnosity.sign-questions-preview");
    expect(val.signing).toBeUndefined();
    expect(fetched).toEqual([]);
  });

  test("a connection compile never asks for a system preview session", async () => {
    const { err } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err).toEqual([]);
    expect(previewSessions).toEqual([]);
    expect(sessionsUsed).toEqual(["session-1"]);
  });

  test("`init` without a connection signs through the system session too", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" init questions [mcq []] {}..`);
    expect(err).toEqual([]);
    expect(previewSessions).toHaveLength(1);
    expect(invocations.map((c) => c.op)).toEqual(["learnosity.sign-questions-preview"]);
    expect(invocations[0].occurrenceId).toMatch(/^INIT:\d+\.0$/);
    expect(val).toBe("signed:learnosity.sign-questions-preview");
  });

  test.each([
    ["both", 'set-var "learnosity-key" "own-key" set-var "learnosity-secret" "own-secret-0123456789"'],
    ["only the key", 'set-var "learnosity-key" "own-key"'],
    ["only the secret", 'set-var "learnosity-secret" "own-secret-0123456789"'],
  ])("program-supplied credentials (%s) are ignored: no error, and they sign nothing", async (_, creds) => {
    const { err, val } = await compile(`set-var "lrn-id" "t" ${creds} items [${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(sessionsUsed).toEqual(["system-session"]);
    expect(val.request).toBe("signed:learnosity.sign-questions-preview");
    expect(JSON.stringify({ invocations, val })).not.toMatch(/own-key|own-secret/);
  });

  test("config-supplied credentials are ignored too", async () => {
    const code = await parser.parse(176, `set-var "lrn-id" "t" items [${ITEM}] {}..`, lexicon);
    const { err, val } = await new Promise<{ err: any[]; val: any }>((resolve) =>
      compiler.compile(code, {}, { learnosity: { key: "cfg-key", secret: "cfg-secret-0123456789" } },
        (e: any, v: any) => resolve({ err: e ?? [], val: v })));
    expect(err).toEqual([]);
    expect(val.request).toBe("signed:learnosity.sign-questions-preview");
    expect(JSON.stringify({ invocations, val })).not.toMatch(/cfg-key|cfg-secret/);
  });

  test.each([
    ["policy refuses", () => refusal("no-system-connection"), "unavailable", /no-system-connection/],
    ["policy is unreachable", () => new Error("fetch failed"), "unavailable", /no system preview session/],
    ["the session lacks preview", () => ({ allowed: [], sessionToken: "s" }), "unavailable", /no-preview-permission/],
    ["the reply is malformed", () => ({ allowed: ["init"] }), "unavailable", /no-preview-permission/],
  ])("when %s, the preview compiles unsigned with a message", async (_, reply, unsigned, message) => {
    previewReply = reply;
    const { err, val } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(val.type).toBe("questions");
    expect(val.request).toBeUndefined();
    expect(val.signing).toMatchObject({ unsigned, message: expect.stringMatching(message) });
    expect(val.signing.message).toMatch(/^Preview not signed/);
    expect(invocations).toEqual([]);
  });

  test("a failed system signing leaves the preview unsigned with a message, not an error", async () => {
    brokerReply = () => ({ status: "failed", error: "provider down" });
    const { err, val } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(val.request).toBeUndefined();
    expect(val.signing).toMatchObject({ unsigned: "signing-failed" });
  });

  test("a system session never writes or signs an Author session", async () => {
    const saved = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`);
    expect(saved.err).toEqual([]);
    expect(saved.val.data.itemBank).toMatchObject({ skipped: "no-connection" });
    const author = await compile(`set-var "lrn-id" "t" author {}..`);
    expect(author.err).toEqual([]);
    expect(author.val.request).toBeUndefined();
    expect(invocations.map((c) => c.op)).toEqual(["learnosity.sign-questions-preview"]);
  });

  test("a system session that claims more than preview is still used for preview only", async () => {
    previewReply = () => ({ allowed: ["init", "save-to-itembank", "author"], sessionToken: "wide" });
    const { err, val } = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(val.data.itemBank).toMatchObject({ skipped: "no-connection" });
    expect(invocations.map((c) => c.op)).toEqual(["learnosity.sign-questions-preview"]);
  });

  test("a render is signed by the broker, with only preview fields sent", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err).toEqual([]);
    expect(snapshots).toEqual([{ fns: ["init"], langID: "0176", connectionId: "conn-1" }]);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].op).toBe("learnosity.sign-questions-preview");
    expect(Object.keys(invocations[0].payload).sort()).toEqual(["id", "name", "questions", "session_id"]);
    expect(val.request).toBe("signed:learnosity.sign-questions-preview");
    expect(fetched).toEqual([]);
  });

  test("a save in a save session writes through the broker with no program credentials", async () => {
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
    // Building it (no connection) signed through the system session; count
    // only the read.
    invocations.length = 0;
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
    expect(snapshots).toEqual([{ fns: ["init"], langID: "0176", connectionId: "conn-1" }]);
    expect(invocations.map((c) => c.op)).toEqual(["learnosity.sign-questions-preview"]);
    expect(val.request).toBe("signed:learnosity.sign-questions-preview");
    expect(val.data.itemBank).toMatchObject({ skipped: "no-connection" });
    expect(fetched).toEqual([]);
  });

  // Policy refuses an occurrence id outside this pattern (ID_RE in
  // graffiticode packages/policy/src/policy.js); keep the two in step.
  test("every occurrence id the compiler sends is one policy accepts", async () => {
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
    const { err } = await compile(`set-var "lrn-id" "t" items [save-to-itembank true, ${ITEM}] {}..`, WITH_CONNECTION);
    expect(err).toEqual([]);
    expect(invocations[0].op).toBe("learnosity.write-items");
  });

  test("a save the connection does not grant is refused before anything runs", async () => {
    snapshotReply = () => ({ allowed: ["init"] });
    const { err } = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err[0].message).toMatch(/save-to-itembank is not permitted/);
    expect(invocations).toEqual([]);
  });

  test("an uncertain or partial save is an error, never a silent retry", async () => {
    brokerReply = (call) =>
      call.op === "learnosity.write-items"
        ? { status: "partial", steps: ["questions"], error: "items write failed" }
        : { status: "succeeded", result: { request: "r" } };
    const { err } = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err.map((e) => e.message ?? e).join()).toMatch(/Item bank save partial: items write failed/);
    expect(invocations.filter((c) => c.op === "learnosity.write-items")).toHaveLength(1);
  });

  test("an uncertain save tells the caller how to run it again deliberately", async () => {
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
    snapshotReply = () => ({ allowed: [] });
    const { err } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err[0].message).toMatch(/init is not permitted/);
    expect(invocations).toEqual([]);
  });

  test("an Author activity is signed through the broker when the connection grants it", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" author {}..`, WITH_CONNECTION);
    expect(err).toEqual([]);
    expect(invocations.map((c) => c.op)).toEqual(["learnosity.sign-author"]);
    expect(val.request).toBe("signed:learnosity.sign-author");
  });

  test("an Author activity is refused when the connection does not grant it", async () => {
    snapshotReply = () => ({ allowed: ["init"] });
    const { err } = await compile(`set-var "lrn-id" "t" author {}..`, WITH_CONNECTION);
    expect(err[0].message).toMatch(/author is not permitted/);
    expect(invocations).toEqual([]);
  });
});
