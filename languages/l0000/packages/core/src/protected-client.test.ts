import { describe, test, expect, beforeEach } from "vitest";
import { parser } from "@graffiticode/parser";
import {
  Compiler,
  Checker,
  Transformer,
  Renderer,
  lexicon,
  createProtectionClient,
  argsDigest,
  ExecContext,
} from "@graffiticode/l0000";

const POLICY = "https://policy.example";
const BROKER = "https://broker.example";

// A fake policy + broker behind fetch, recording every request.
let requests: { url: string; headers: Record<string, string>; body: any }[];
let snapshotReply: any;
let brokerReply: any;
let failMint: boolean;
let mintRefusal: any;
// Broker answers in order, one per execute; a function throws (no answer).
let brokerReplies: any[];

const fakeFetch = async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  requests.push({ url, headers: init.headers, body });
  const ok = (data: any) => new Response(JSON.stringify({ status: "success", data }), { status: 200 });
  if (url === `${POLICY}/v1/snapshot`) return ok(snapshotReply);
  if (url === `${POLICY}/v1/mint`) {
    if (failMint) {
      return new Response(JSON.stringify({ status: "error", error: mintRefusal }), { status: 403 });
    }
    return ok({ executionToken: `exec-for-${body.fn}`, operationId: `op/${body.occurrenceId}` });
  }
  if (url === `${BROKER}/v1/execute`) {
    const next = brokerReplies.length > 0 ? brokerReplies.shift() : { data: brokerReply };
    if (typeof next === "function") return next();
    return next.response ?? ok(next.data);
  }
  return new Response("{}", { status: 404 });
};

const client = () =>
  createProtectionClient({
    policyUrl: POLICY,
    brokerUrl: BROKER,
    idToken: async (aud) => `idtoken-for-${aud}`,
    fetch: fakeFetch as any,
  });

beforeEach(() => {
  requests = [];
  snapshotReply = { allowed: ["save-it"], sessionToken: "session-1" };
  brokerReply = { status: "succeeded", result: { saved: true } };
  failMint = false;
  mintRefusal = { code: 403, reason: "operation-not-allowed", category: "permission" };
  brokerReplies = [];
});

// A toy language whose one protected write goes through the broker.
const lex = { ...lexicon, "save-it": { tk: 1, name: "SAVE_IT", cls: "function", length: 1, arity: 1 } };
class ToyTransformer extends Transformer {
  SAVE_IT(node, options, resume) {
    this.visit(node.elts[0], options, async (e0, v0) => {
      try {
        const exec = this.execContext;
        const out = await exec.invoke({
          fn: "save-it",
          op: "toy.write",
          payload: { value: v0 },
          occurrenceId: exec.nextOccurrence(`n${node.coord?.from ?? 0}`),
        });
        resume([].concat(e0), out);
      } catch (e: any) {
        resume([String(e.message)], null);
      }
    });
  }
}

async function compile(src: string, identity: any, protectedFunctions: any = { SAVE_IT: { fn: "save-it", kind: "write" } }) {
  const code = await parser.parse(0, src, lex);
  const compiler = new Compiler({
    langID: "9999",
    Checker,
    Transformer: ToyTransformer,
    Renderer,
    protectedFunctions,
    policy: client(),
  });
  return new Promise<{ err: any[]; val: any; effects: any[] }>((resolve) =>
    compiler.compile(code, {}, {}, (err, val, meta) => resolve({ err: err ?? [], val, effects: meta?.effects }), identity),
  );
}

const IDENTITY = {
  uid: "u1",
  connectionId: "conn-1",
  userToken: "user-token",
  invocationToken: "invocation-token",
  stage: "s0",
};

describe("protection client", () => {
  test("the snapshot carries the user, the invocation and both service identities", async () => {
    await compile("save-it 1..", IDENTITY);
    const snap = requests[0];
    expect(snap.url).toBe(`${POLICY}/v1/snapshot`);
    expect(snap.headers.Authorization).toBe("Bearer user-token");
    expect(snap.headers["X-Caller-Identity"]).toBe("idtoken-for-urn:graffiticode:policy");
    expect(snap.headers["X-Serverless-Authorization"]).toBe(`Bearer idtoken-for-${POLICY}`);
    expect(snap.body).toMatchObject({
      lang: "9999",
      connectionId: "conn-1",
      fns: ["save-it"],
      invocationToken: "invocation-token",
      stage: "s0",
    });
  });

  test("a published view asks policy with no user, on the invocation token alone", async () => {
    snapshotReply = { allowed: [], sessionToken: "session-1" };
    const { err } = await compile("save-it 1..", { connectionId: "conn-1", invocationToken: "publication-token", stage: "view" });
    const snap = requests[0];
    expect(snap.url).toBe(`${POLICY}/v1/snapshot`);
    expect(snap.headers.Authorization).toBeUndefined();
    expect(snap.body).toMatchObject({ connectionId: "conn-1", invocationToken: "publication-token", stage: "view" });
    // Policy allowed nothing, so the write is refused before anything runs.
    expect(err[0].message).toMatch(/save-it is not permitted/);
    expect(requests).toHaveLength(1);
  });

  test("with neither a user nor an invocation token, policy is never asked", async () => {
    const { err } = await compile("save-it 1..", { connectionId: "conn-1" });
    expect(requests).toEqual([]);
    expect(err[0].message).toMatch(/save-it is not permitted/);
  });

  test("a granted write runs, minted for exactly its payload", async () => {
    const { err, val } = await compile("save-it 1..", IDENTITY);
    expect(err).toEqual([]);
    expect(val).toEqual({ status: "succeeded", result: { saved: true } });
    const [, mint, execute] = requests;
    expect(mint.body).toMatchObject({ sessionToken: "session-1", fn: "save-it", op: "toy.write", argsDigest: argsDigest({ value: 1 }) });
    expect(mint.headers.Authorization).toBeUndefined();
    expect(execute.url).toBe(`${BROKER}/v1/execute`);
    expect(execute.headers.Authorization).toBe("Bearer exec-for-save-it");
    expect(execute.headers["X-Caller-Identity"]).toBe("idtoken-for-urn:graffiticode:broker");
    expect(execute.body).toEqual({ op: "toy.write", payload: { value: 1 } });
  });

  test("a loop gets one occurrence id per call", async () => {
    await compile("map (<x: save-it x>) [1 2]..", IDENTITY);
    const mints = requests.filter((r) => r.url.endsWith("/v1/mint")).map((r) => r.body.occurrenceId);
    expect(mints).toHaveLength(2);
    expect(new Set(mints).size).toBe(2);
  });

  test("an ungranted write is refused and never minted", async () => {
    snapshotReply = { allowed: [], sessionToken: "session-1" };
    const { err } = await compile("save-it 1..", IDENTITY);
    expect(err[0].message).toMatch(/save-it is not permitted/);
    expect(requests.map((r) => r.url)).toEqual([`${POLICY}/v1/snapshot`]);
  });

  test("a mint refusal surfaces as a compile error and never reaches the broker", async () => {
    failMint = true;
    const { err } = await compile("save-it 1..", IDENTITY);
    expect(err[0].message).toMatch(/\/v1\/mint failed \(403\)/);
    expect(requests.some((r) => r.url.startsWith(BROKER))).toBe(false);
  });

  test("invoke refuses a function admission did not allow, before any request", async () => {
    const exec = new ExecContext({ uid: "u1", connectionId: "c" });
    exec.setSnapshot({ allowed: ["peek-it"] });
    exec.bindInvoker(client().invoke!);
    await expect(exec.invoke({ fn: "save-it", op: "toy.write", payload: {}, occurrenceId: "n.0" })).rejects.toThrow(/not admitted/);
    expect(requests).toEqual([]);
  });

  test("tokens are not exposed as context properties", () => {
    const exec = new ExecContext({ uid: "u1", userToken: "user-token", invocationToken: "invocation-token" });
    expect(JSON.stringify(exec)).not.toMatch(/user-token|invocation-token/);
    expect(Object.values(exec)).not.toContain("user-token");
  });
});

// Spec FAIL-01: every protected write's effects reach the caller, cumulatively;
// refusals carry policy's or the broker's category.
describe("protected-write effects", () => {
  const refusal = (status: number, error: any) => ({ response: new Response(JSON.stringify({ status: "error", error }), { status }) });

  test("a write's outcome is the compile's effect", async () => {
    brokerReply = { status: "succeeded", steps: ["questions", "items"], result: { saved: true } };
    const { effects } = await compile("save-it 1..", IDENTITY);
    expect(effects).toEqual([{ fn: "save-it", op: "toy.write", status: "succeeded", steps: ["questions", "items"] }]);
  });

  test("an earlier save is still reported when a later one fails, with the broker's detail", async () => {
    brokerReplies = [
      { data: { status: "succeeded", steps: ["questions", "items"], result: {} } },
      { data: { status: "partial", steps: ["questions"], failedStep: "items", reason: "authorization-denied:not-granted", category: "permission", error: "denied" } },
    ];
    const { effects } = await compile("[save-it 1 save-it 2]..", IDENTITY);
    expect(effects).toEqual([
      { fn: "save-it", op: "toy.write", status: "succeeded", steps: ["questions", "items"] },
      { fn: "save-it", op: "toy.write", status: "partial", steps: ["questions"], failedStep: "items", reason: "authorization-denied:not-granted", category: "permission" },
    ]);
  });

  test("a replay says so", async () => {
    brokerReply = { status: "succeeded", steps: ["questions", "items"], result: {}, replayed: true };
    expect((await compile("save-it 1..", IDENTITY)).effects).toEqual([{ fn: "save-it", op: "toy.write", status: "succeeded", steps: ["questions", "items"], replayed: true }]);
  });

  test("an uncertain outcome keeps no completed step", async () => {
    brokerReply = { status: "uncertain", steps: [], failedStep: "questions", error: "no response" };
    expect((await compile("save-it 1..", IDENTITY)).effects).toEqual([{ fn: "save-it", op: "toy.write", status: "uncertain", steps: [], failedStep: "questions" }]);
  });

  test("a refused write did nothing, and says why, with policy's category", async () => {
    failMint = true;
    const { effects, err } = await compile("save-it 1..", IDENTITY);
    expect(effects).toEqual([{ fn: "save-it", op: "toy.write", status: "failed", steps: [], reason: "operation-not-allowed", category: "permission" }]);
    expect(err[0].message).toMatch(/\/v1\/mint failed \(403\)/);
  });

  test("a broker refusal is definite: failed, nothing done", async () => {
    brokerReplies = [refusal(403, { code: 403, reason: "authorization-denied:not-granted", category: "permission" })];
    expect((await compile("save-it 1..", IDENTITY)).effects).toEqual([{ fn: "save-it", op: "toy.write", status: "failed", steps: [], reason: "authorization-denied:not-granted", category: "permission" }]);
  });

  test("an older policy or broker body, without a category, still works", async () => {
    failMint = true;
    mintRefusal = { code: 403, reason: "not-granted" };
    expect((await compile("save-it 1..", IDENTITY)).effects).toEqual([{ fn: "save-it", op: "toy.write", status: "failed", steps: [], reason: "not-granted" }]);
    brokerReply = { status: "partial", steps: ["questions"], error: "provider refused" };
    failMint = false;
    expect((await compile("save-it 1..", IDENTITY)).effects).toEqual([{ fn: "save-it", op: "toy.write", status: "partial", steps: ["questions"] }]);
  });

  test("a lost broker answer is uncertain, never a refusal", async () => {
    brokerReplies = [() => { throw new TypeError("fetch failed"); }];
    const lost = await compile("save-it 1..", IDENTITY);
    expect(lost.effects).toEqual([{ fn: "save-it", op: "toy.write", status: "uncertain", steps: [] }]);
    expect(lost.err[0].message).toMatch(/\/v1\/execute unreachable/);
    brokerReplies = [{ response: new Response("Bad Gateway", { status: 502 }) }];
    expect((await compile("save-it 1..", IDENTITY)).effects).toEqual([{ fn: "save-it", op: "toy.write", status: "uncertain", steps: [] }]);
    // An unrecognized outcome was sent, and nothing says how it went.
    brokerReply = { status: "mystery" };
    expect((await compile("save-it 1..", IDENTITY)).effects).toEqual([{ fn: "save-it", op: "toy.write", status: "uncertain", steps: [] }]);
  });

  test("an unreachable policy at mint is a definite failure: nothing was asked of the broker", async () => {
    const real = fakeFetch;
    const exec = new ExecContext({ uid: "u1", connectionId: "c", userToken: "t" });
    exec.setSessionToken("session-1");
    exec.declareWrites(["save-it"]);
    exec.setSnapshot({ allowed: ["save-it"] });
    exec.bindInvoker(createProtectionClient({
      policyUrl: POLICY, brokerUrl: BROKER, idToken: async (aud) => aud,
      fetch: (async (url: string, init: any) => { if (url.endsWith("/v1/mint")) throw new TypeError("fetch failed"); return real(url, init); }) as any,
    }).invoke!);
    await expect(exec.invoke({ fn: "save-it", op: "toy.write", payload: {}, occurrenceId: "n.0" })).rejects.toMatchObject({ effectUnknown: false, status: 0 });
    expect(exec.effects).toEqual([{ fn: "save-it", op: "toy.write", status: "failed", steps: [] }]);
  });

  test("signs and reads are not effects; a compile without writes reports none", async () => {
    brokerReply = { status: "succeeded", result: { request: "signed" } };
    const { effects } = await compile("save-it 1..", IDENTITY, { SAVE_IT: { fn: "save-it", kind: "sign" } });
    expect(effects).toEqual([]);
  });

  test("effects are a copy, and writes are declared once", () => {
    const exec = new ExecContext({});
    exec.declareWrites(["save-it"]);
    expect(() => exec.declareWrites(["other"])).toThrow(/already declared/);
    exec.effects.push({ fn: "x", op: "y", status: "failed", steps: [] });
    expect(exec.effects).toEqual([]);
  });
});

describe("structured compile errors", () => {
  class FailingTransformer extends Transformer {
    SAVE_IT(node, options, resume) {
      resume([{ message: "Error: Item bank save partial", code: "authorization-denied:not-granted", category: "permission", stage: "s0", fn: "save-it", step: "items", secret: "dropped", from: 3 }], null);
    }
  }

  test("keep their message and add code, category, stage, fn and step, nothing else", async () => {
    const code = await parser.parse(0, "save-it 1..", lex);
    const compiler = new Compiler({ langID: "9999", Checker, Transformer: FailingTransformer, Renderer });
    const err: any[] = await new Promise((resolve) => compiler.compile(code, {}, {}, (e) => resolve(e)));
    expect(err).toEqual([{ message: "Error: Item bank save partial", from: 3, to: -1, code: "authorization-denied:not-granted", category: "permission", stage: "s0", fn: "save-it", step: "items" }]);
  });
});

// A lambda that waits on a protected call: map, filter, reduce and a sequence
// of expressions wait for each in turn, in order.
describe("iterators over protected calls", () => {
  const later = (ms: number, data: any) => () =>
    new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ status: "success", data }), { status: 200 })), ms));
  const saved = (n: number) => ({ status: "succeeded", steps: ["questions", "items"], result: { n } });
  const order = () => requests.map((r) => r.url.replace(/^https:\/\/(policy|broker)\.example\/v1\//, ""));

  test("map waits for each write, keeps results and effects in order, and never overlaps them", async () => {
    // The first answer is the slowest: concurrent writes would finish out of order.
    brokerReplies = [later(30, saved(1)), later(10, saved(2)), later(0, saved(3))];
    const { err, val, effects } = await compile("map (<x: save-it x>) [1 2 3]..", IDENTITY);
    expect(err).toEqual([]);
    expect(val.map((out: any) => out.result.n)).toEqual([1, 2, 3]);
    expect(effects).toHaveLength(3);
    expect(order()).toEqual(["snapshot", "mint", "execute", "mint", "execute", "mint", "execute"]);
    expect(requests.filter((r) => r.url.endsWith("/v1/mint")).map((r) => r.body.argsDigest)).toEqual([1, 2, 3].map((value) => argsDigest({ value })));
  });

  test("filter and reduce wait for each call too", async () => {
    brokerReplies = [later(20, saved(1)), later(0, saved(2))];
    const filtered = await compile("filter (<x: save-it x>) [1 2]..", IDENTITY);
    expect(filtered.val).toEqual([1, 2]);
    expect(filtered.effects).toHaveLength(2);
    brokerReplies = [later(20, saved(1)), later(0, saved(2))];
    const reduced = await compile("reduce (<a x: save-it x>) 0 [1 2]..", IDENTITY);
    expect(reduced.val.result).toEqual({ n: 2 });
    expect(order().slice(-4)).toEqual(["mint", "execute", "mint", "execute"]);
  });

  test("records and lists wait for every value, and may run them concurrently", async () => {
    brokerReplies = [later(20, saved(1)), later(0, saved(2))];
    const rec = await compile("{a: save-it 1 b: save-it 2}..", IDENTITY);
    expect(rec.err).toEqual([]);
    expect([rec.val.a.result.n, rec.val.b.result.n]).toEqual([1, 2]);
    expect(rec.effects).toHaveLength(2);
    brokerReplies = [later(20, saved(1)), later(0, saved(2))];
    const list = await compile("[save-it 1 save-it 2]..", IDENTITY);
    expect(list.val.map((out: any) => out.result.n)).toEqual([1, 2]);
    expect(list.effects).toHaveLength(2);
  });

  test("an empty list resolves at once", async () => {
    const { err, val, effects } = await compile("map (<x: save-it x>) []..", IDENTITY);
    expect(err).toEqual([]);
    expect(val).toEqual([]);
    expect(effects).toEqual([]);
  });

  test("a long list of synchronous work doesn't overflow the stack", async () => {
    const n = 20000;
    const code = await parser.parse(0, `map (<x: add x 1>) [${Array.from({ length: n }, (_, i) => i).join(" ")}]..`, lexicon);
    const compiler = new Compiler({ langID: "9999", Checker, Transformer, Renderer });
    const { err, val }: any = await new Promise((resolve) => compiler.compile(code, {}, {}, (e, v) => resolve({ err: e, val: v })));
    expect(err).toEqual([]);
    expect(val).toHaveLength(n);
    expect(val[n - 1]).toBe(n);
  }, 60000);
});
