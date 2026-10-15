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

// A compile with no connection the server has permitted to sign on the
// system path (its caller verified as the api, or SYSTEM_PREVIEW_DIRECT=1):
// what every no-connection compile here was before gateway-only. The
// default unless a test says otherwise.
const SYSTEM = { systemPreview: true };

async function compile(src: string, identity: any = SYSTEM, data: any = {}) {
  const code = await parser.parse(176, src, lexicon);
  return new Promise<{ err: any[]; val: any; effects: any[] }>((resolve) =>
    compiler.compile(code, data, {}, (err: any, val: any, meta?: any) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      resolve({ err: errors, val, effects: meta?.effects ?? [] });
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
        (e: any, v: any) => resolve({ err: e ?? [], val: v }), SYSTEM));
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

  // Gateway-only (plan system-preview-rate-limit): the system path signs only
  // when the server permitted it (`systemPreview: true`, from a verified api
  // identity or SYSTEM_PREVIEW_DIRECT=1). Anything else is unsigned, and
  // policy is never asked for a session.
  test.each([
    ["no identity at all", null],
    ["an identity without the permission", { uid: null, connectionId: null }],
    ["a permission that isn't exactly true", { systemPreview: "true" }],
  ])("without the server's permission (%s), a preview is unsigned `gateway-only`", async (_, identity) => {
    for (const src of [`set-var "lrn-id" "t" items [${ITEM}] {}..`, `set-var "lrn-id" "t" init questions [mcq []] {}..`]) {
      const code = await parser.parse(176, src, lexicon);
      const { err, val } = await new Promise<{ err: any[]; val: any }>((resolve) =>
        compiler.compile(code, {}, {}, (e: any, v: any) => resolve({ err: e ?? [], val: v }), identity ?? undefined));
      expect(err).toEqual([]);
      expect(val.request).toBeUndefined();
      expect(val.type).toBe("questions");
      expect(val.signing).toEqual({
        unsigned: "gateway-only",
        message: expect.stringMatching(/^Preview not signed: .*only through the Graffiticode api/),
      });
    }
    expect(previewSessions).toEqual([]);
    expect(invocations).toEqual([]);
  });

  test("`init data {}` of an activity without the permission comes back unsigned `gateway-only`", async () => {
    const activity = { type: "questions", data: { questions: [{ response_id: "r-0", type: "mcq" }] } };
    const code = await parser.parse(176, "init data {}..", lexicon);
    const { err, val } = await new Promise<{ err: any[]; val: any }>((resolve) =>
      compiler.compile(code, activity, {}, (e: any, v: any) => resolve({ err: e ?? [], val: v })));
    expect(err).toEqual([]);
    expect(val).toMatchObject({ ...activity, signing: { unsigned: "gateway-only" } });
    expect(previewSessions).toEqual([]);
  });

  test("a connection compile is unaffected by the permission", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err).toEqual([]);
    expect(val.request).toBe("signed:learnosity.sign-questions-preview");
    expect(sessionsUsed).toEqual(["session-1"]);
    expect(previewSessions).toEqual([]);
  });

  // The system signing limits: Policy refuses the execution token's mint
  // `rate-limited`; Broker refuses the execution `session-exhausted`. Each is
  // the unsigned busy result, never a compile error.
  const BUSY = "Previews are busy right now; try again in a moment.";
  const refusedCall = (path: string, status: number, reason: string) =>
    Object.assign(new Error(`${path} failed (${status})`), { status, reason, category: "unavailable", effectUnknown: false });
  test.each([
    ["Policy's mint refuses rate-limited", () => { throw refusedCall("/v1/mint", 429, "rate-limited"); }, "rate-limited"],
    ["Broker refuses session-exhausted", () => { throw refusedCall("/v1/execute", 429, "session-exhausted"); }, "session-exhausted"],
    ["Broker's outcome is session-exhausted", () => ({ status: "failed", reason: "session-exhausted", category: "unavailable" }), "session-exhausted"],
  ])("when %s, the preview is unsigned with the busy message", async (_, reply, reason) => {
    brokerReply = reply;
    for (const src of [`set-var "lrn-id" "t" items [${ITEM}] {}..`, `set-var "lrn-id" "t" init questions [mcq []] {}..`]) {
      const { err, val } = await compile(src);
      expect(err).toEqual([]);
      expect(val.type).toBe("questions");
      expect(val.request).toBeUndefined();
      expect(val.signing).toEqual({ unsigned: reason, message: BUSY });
    }
  });

  test("`init data {}` of an activity when the limits are reached is the activity, unsigned and busy", async () => {
    brokerReply = () => { throw refusedCall("/v1/mint", 429, "rate-limited"); };
    const activity = { type: "items", data: { questions: [{ response_id: "r-0", type: "mcq" }] } };
    const { err, val } = await compile("init data {}..", SYSTEM, activity);
    expect(err).toEqual([]);
    expect(val).toEqual({ ...activity, signing: { unsigned: "rate-limited", message: BUSY } });
  });

  test("a rate-limited preview session is busy too", async () => {
    previewReply = () => refusal("rate-limited");
    const { err, val } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(val.signing).toEqual({ unsigned: "rate-limited", message: BUSY });
    expect(invocations).toEqual([]);
  });

  test("any other refused system signing is still `signing-failed`, with its reason", async () => {
    brokerReply = () => { throw refusedCall("/v1/execute", 403, "payload-rejected"); };
    const { err, val } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(val.signing).toMatchObject({ unsigned: "signing-failed", message: expect.stringMatching(/\(payload-rejected\)$/) });
  });

  test("a system session never writes", async () => {
    const saved = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`);
    expect(saved.err).toEqual([]);
    expect(saved.val.data.itemBank).toMatchObject({ skipped: "no-connection" });
    expect(invocations.map((c) => c.op)).toEqual(["learnosity.sign-questions-preview"]);
  });

  // Registry v7 (AUTHOR-01, closed by removal): L0176 has no `author`, and an
  // Author activity arriving as data, from an older program upstream, is
  // refused on every path with a pointer to L0177. Nothing is signed.
  const AUTHOR_DATA = { type: "author", data: { mode: "item_edit", reference: "r" } };
  test.each([
    ["as the program's value, without a connection", "data {}..", undefined],
    ["through init, without a connection", "init data {}..", undefined],
    ["as the program's value, through a connection", "data {}..", WITH_CONNECTION],
    ["through init, through a connection", "init data {}..", WITH_CONNECTION],
  ])("an Author activity arriving as data is refused (%s), unsigned", async (_, src, identity) => {
    const { err, val } = await compile(src, identity, AUTHOR_DATA);
    expect(err).toHaveLength(1);
    expect(String(err[0]?.message ?? err[0])).toMatch(/doesn't open the Learnosity Author Site.*L0177/);
    expect(val?.request).toBeUndefined();
    expect(invocations).toEqual([]);
  });

  test("author is not an L0176 function", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" author {}..`);
    expect(String(err[0]?.message ?? err[0])).toMatch(/author/);
    expect(val?.request).toBeUndefined();
    expect(invocations).toEqual([]);
  });

  test("a system session that claims more than preview is still used for preview only", async () => {
    previewReply = () => ({ allowed: ["init", "save-to-itembank"], sessionToken: "wide" });
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
});

// Spec FAIL-01 (W3b): a failed protected call is a structured compile error
// (its message unchanged), and every save's effects reach the caller,
// cumulatively, from current and older policy/broker bodies alike.
describe("structured failures and effects", () => {
  beforeEach(() => {
    if (!(compiler as any).__configured) {
      (compiler as any).setPolicyClient(fakeClient);
      (compiler as any).__configured = true;
    }
  });
  const SAVE = `set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`;
  const TWO_SAVES = `set-var "lrn-id" "t" [save-to-itembank items [${ITEM}] {} save-to-itembank items [${ITEM}] {}]..`;
  const writes = (...outcomes: any[]) => (call: any) =>
    call.op === "learnosity.write-items" ? outcomes.shift() : { status: "succeeded", result: { request: "r" } };
  const refused = (reason: string, category?: string, extra: any = {}) =>
    Object.assign(new Error("/v1/execute failed (403)"), { status: 403, reason, category, effectUnknown: false, ...extra });

  test("a partial save names its code, category, stage, function and failed step", async () => {
    brokerReply = writes({ status: "partial", steps: ["questions"], failedStep: "items", reason: "authorization-denied:not-granted", category: "permission", error: "items write failed" });
    const { err, effects } = await compile(SAVE, WITH_CONNECTION);
    expect(err).toEqual([{
      message: "Error: Item bank save partial: items write failed",
      from: -1, to: -1,
      code: "authorization-denied:not-granted", category: "permission", stage: "s0", fn: "save-to-itembank", step: "items",
    }]);
    expect(effects).toEqual([{ fn: "save-to-itembank", op: "learnosity.write-items", status: "partial", steps: ["questions"], failedStep: "items", reason: "authorization-denied:not-granted", category: "permission" }]);
  });

  test("an earlier save is still reported when a later one fails", async () => {
    brokerReply = writes(
      { status: "succeeded", steps: ["questions", "items"], result: { saved: true } },
      { status: "failed", steps: [], failedStep: "questions", reason: "authorization-denied:not-granted", category: "permission", error: "denied" },
    );
    const { err, effects } = await compile(TWO_SAVES, WITH_CONNECTION);
    expect(err.map((e) => e.message)).toEqual(["Error: Item bank save failed: denied"]);
    expect(effects.map((e) => [e.status, e.steps])).toEqual([["succeeded", ["questions", "items"]], ["failed", []]]);
  });

  test("an uncertain save keeps its guidance in the message, with no completed step", async () => {
    brokerReply = writes({ status: "uncertain", steps: [], failedStep: "questions", error: "no response" });
    const { err, effects } = await compile(SAVE, WITH_CONNECTION);
    expect(err[0]).toMatchObject({ fn: "save-to-itembank", step: "questions", stage: "s0" });
    expect(err[0].message).toMatch(/Item bank save uncertain: no response — it may or may not have been written.*new idempotency key/);
    expect(effects).toEqual([{ fn: "save-to-itembank", op: "learnosity.write-items", status: "uncertain", steps: [], failedStep: "questions" }]);
  });

  test("a lost broker answer is an uncertain save, said the same way", async () => {
    brokerReply = (call: any) => {
      if (call.op === "learnosity.write-items") throw Object.assign(new Error("/v1/execute unreachable"), { status: 0, effectUnknown: true });
      return { status: "succeeded", result: { request: "r" } };
    };
    const { err, effects } = await compile(SAVE, WITH_CONNECTION);
    expect(err[0]).toMatchObject({ fn: "save-to-itembank", stage: "s0" });
    expect(err[0].message).toMatch(/Item bank save uncertain: \/v1\/execute unreachable — it may or may not have been written/);
    expect(effects).toEqual([{ fn: "save-to-itembank", op: "learnosity.write-items", status: "uncertain", steps: [] }]);
  });

  test("a refusal carries policy's or the broker's reason and category", async () => {
    brokerReply = (call: any) => {
      if (call.op === "learnosity.write-items") throw refused("authorization-denied:not-granted", "permission");
      return { status: "succeeded", result: { request: "r" } };
    };
    const { err, effects } = await compile(SAVE, WITH_CONNECTION);
    expect(err).toEqual([{ message: "Error: /v1/execute failed (403)", from: -1, to: -1, code: "authorization-denied:not-granted", category: "permission", stage: "s0", fn: "save-to-itembank" }]);
    expect(effects).toEqual([{ fn: "save-to-itembank", op: "learnosity.write-items", status: "failed", steps: [], reason: "authorization-denied:not-granted", category: "permission" }]);
  });

  test("a refused signing is structured too", async () => {
    brokerReply = () => {
      throw refused("maintenance", "unavailable", { message: "/v1/execute failed (503)", status: 503 });
    };
    const { err, effects } = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(err[0]).toMatchObject({ code: "maintenance", category: "unavailable", fn: "init", stage: "s0" });
    // A signature is not an effect.
    expect(effects).toEqual([]);
  });

  test("older policy and broker bodies, without category or failedStep, still give the same messages", async () => {
    brokerReply = writes({ status: "partial", steps: ["questions"], error: "items write failed" });
    const partial = await compile(SAVE, WITH_CONNECTION);
    expect(partial.err).toEqual([{ message: "Error: Item bank save partial: items write failed", from: -1, to: -1, stage: "s0", fn: "save-to-itembank" }]);
    expect(partial.effects).toEqual([{ fn: "save-to-itembank", op: "learnosity.write-items", status: "partial", steps: ["questions"] }]);
    brokerReply = (call: any) => {
      if (call.op === "learnosity.write-items") throw Object.assign(new Error("/v1/execute failed (403)"), { status: 403, reason: "not-granted" });
      return { status: "succeeded", result: { request: "r" } };
    };
    const refusal = await compile(SAVE, WITH_CONNECTION);
    expect(refusal.err).toEqual([{ message: "Error: /v1/execute failed (403)", from: -1, to: -1, code: "not-granted", stage: "s0", fn: "save-to-itembank" }]);
  });

  test("a compile with no save reports no effects, and other errors stay plain messages", async () => {
    const ok = await compile(`set-var "lrn-id" "t" items [${ITEM}] {}..`, WITH_CONNECTION);
    expect(ok.err).toEqual([]);
    expect(ok.effects).toEqual([]);
  });
});

// L0158 renders through L0176 (plan l0158-via-l0176, step 2). L0158's compile
// output is an unsigned activity whose questions are inline
// `{ response_id, type, ...data }`; L0176's View resolves its dynamic data and
// sends it as data to `init data {}`, which signs it. Old L0158 outputs
// (cached in Firestore, Redis, CDNs) come in shapes that must never be
// signed or passed through: they are compile errors, never adapted.
describe("an L0158 activity arriving as data", () => {
  beforeEach(() => {
    if (!(compiler as any).__configured) {
      (compiler as any).setPolicyClient(fakeClient);
      (compiler as any).__configured = true;
    }
  });

  const L0158_ACTIVITY = {
    type: "questions",
    data: {
      id: "act-1",
      name: "L0158 item",
      session_id: "3f2a9d1e-0000-4000-8000-000000000001",
      questions: [
        { response_id: "artcompiler-mcq-x-0", type: "mcq", stimulus: "What is 7 + 5?", options: [{ label: "12", value: "0" }] },
        { response_id: "artcompiler-custom-x-1", type: "custom", js: { question: "https://example.org/q.js" }, data: { cells: { A1: { text: "7" } } } },
      ],
      dynamic_content_data: { cols: ["A1"], rows: { r1: { values: ["7"] } } },
    },
  };

  test.each([
    ["without a connection (system preview session)", undefined, "system-session"],
    ["through a connection", WITH_CONNECTION, "session-1"],
  ])("is signed by init %s, with only preview fields sent", async (_, identity, session) => {
    const { err, val } = await compile("init data {}..", identity, L0158_ACTIVITY);
    expect(err).toEqual([]);
    expect(val).toBe("signed:learnosity.sign-questions-preview");
    expect(invocations).toHaveLength(1);
    expect(invocations[0].fn).toBe("init");
    expect(invocations[0].payload).toEqual(L0158_ACTIVITY.data);
    expect(sessionsUsed).toEqual([session]);
    expect(fetched).toEqual([]);
  });

  test("an activity that arrives with a request is signed afresh; its request is never sent or returned", async () => {
    const cached = { ...L0158_ACTIVITY, request: { consumer_key: "old", signature: "$02$old-for-l0158", questions: [] } };
    const { err, val } = await compile("init data {}..", undefined, cached);
    expect(err).toEqual([]);
    expect(val).toBe("signed:learnosity.sign-questions-preview");
    expect(JSON.stringify(invocations)).not.toMatch(/old-for-l0158/);
  });

  test("when signing is unavailable, the incoming request is not passed through either", async () => {
    previewReply = () => refusal("no-system-connection");
    const cached = { type: "items", data: L0158_ACTIVITY.data, request: { security: { signature: "$02$old-for-l0158" } } };
    const { err, val } = await compile("init data {}..", undefined, cached);
    expect(err).toEqual([]);
    expect(val.request).toBeUndefined();
    expect(val.signing).toMatchObject({ unsigned: "unavailable" });
    expect(JSON.stringify(val)).not.toMatch(/old-for-l0158/);
  });

  test("as the program's value (`data {}`), an activity with a request is re-signed too", async () => {
    const cached = { ...L0158_ACTIVITY, request: "signed-for-l0158", signing: { unsigned: "stale", message: "stale" } };
    const { err, val } = await compile("data {}..", undefined, cached);
    expect(err).toEqual([]);
    expect(val.request).toBe("signed:learnosity.sign-questions-preview");
    expect(val.signing).toBeUndefined();
    expect(invocations).toHaveLength(1);
  });

  // Cached old shapes.
  const LEGACY_QUESTIONS = {
    type: "questions",
    data: {
      id: "act-1", name: "legacy", session_id: "s",
      questions: [{ type: "mcq", reference: "artcompiler-mcq-x-0", data: { type: "mcq", stimulus: "?" } }],
    },
  };
  const BARE_REQUEST = {
    consumer_key: "K", timestamp: "20261015-1200", signature: "$02$abc", user_id: "u",
    questions: [{ response_id: "r-0", type: "mcq" }],
  };
  const CACHED_ITEMS_WITH_LEGACY = { type: "items", data: { questions: [{ reference: "q" }] }, request: { security: {} } };

  test.each([
    ["a legacy { type, reference, data } question record", LEGACY_QUESTIONS, /questions\[0\] needs a type and response_id/],
    ["an old explicit init's bare signed request", BARE_REQUEST, /init signs a Learnosity activity.*a record with no type/],
    ["an Items request carrying a request, with legacy questions", CACHED_ITEMS_WITH_LEGACY, /questions\[0\] needs a type and response_id/],
    ["a list of activities", [LEGACY_QUESTIONS], /init signs a Learnosity activity/],
    ["an empty record", {}, /init signs a Learnosity activity/],
    ["a record of another type", { type: "other", data: {} }, /init signs a Learnosity activity.*"other" record/],
    ["an activity with no data", { type: "items" }, /init signs a Learnosity activity/],
  ])("%s is a compile error on both paths, never signed", async (_, data, message) => {
    for (const identity of [undefined, WITH_CONNECTION]) {
      invocations.length = 0;
      const { err, val } = await compile("init data {}..", identity, data);
      expect(err).toHaveLength(1);
      expect(String(err[0]?.message ?? err[0])).toMatch(message);
      expect(val?.request).toBeUndefined();
      expect(invocations).toEqual([]);
    }
  });

  test.each([
    ["a number", "init 5.."],
    ["a string", `init "questions"..`],
    ["a list", "init [1, 2].."],
    ["nothing (an unset variable)", `init get-var "unset"..`],
  ])("init of %s is a compile error, not a silent undefined", async (_, src) => {
    const { err } = await compile(src);
    expect(err).toHaveLength(1);
    expect(String(err[0]?.message ?? err[0])).toMatch(/init signs a Learnosity activity/);
    expect(invocations).toEqual([]);
  });

  test.each([
    ["questions is not a list", { type: "questions", data: { questions: "q" } }, /data.questions must be a list/],
    ["a question with no type", { type: "questions", data: { questions: [{ response_id: "r-0" }] } }, /questions\[0\] needs/],
    ["a response_id Broker would refuse", { type: "questions", data: { questions: [{ type: "mcq", response_id: "r 0/../x" }] } }, /questions\[0\] needs/],
    ["a question that is not a record", { type: "questions", data: { questions: [L0158_ACTIVITY.data.questions[0], "mcq"] } }, /questions\[1\] needs/],
  ])("a malformed activity (%s) is refused", async (_, data, message) => {
    const { err } = await compile("init data {}..", undefined, data);
    expect(String(err[0]?.message ?? err[0])).toMatch(message);
    expect(invocations).toEqual([]);
  });

  test("an Author activity is still refused, even with a request", async () => {
    const { err } = await compile("init data {}..", undefined, { type: "author", data: { mode: "item_edit" }, request: "r" });
    expect(String(err[0]?.message ?? err[0])).toMatch(/L0177/);
    expect(invocations).toEqual([]);
  });
});
