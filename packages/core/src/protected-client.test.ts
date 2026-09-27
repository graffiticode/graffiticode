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

const fakeFetch = async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  requests.push({ url, headers: init.headers, body });
  const ok = (data: any) => new Response(JSON.stringify({ status: "success", data }), { status: 200 });
  if (url === `${POLICY}/v1/snapshot`) return ok(snapshotReply);
  if (url === `${POLICY}/v1/mint`) {
    if (failMint) {
      return new Response(JSON.stringify({ status: "error", error: { code: 403, reason: "operation-not-allowed" } }), { status: 403 });
    }
    return ok({ executionToken: `exec-for-${body.fn}`, operationId: `op/${body.occurrenceId}` });
  }
  if (url === `${BROKER}/v1/execute`) return ok(brokerReply);
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
  snapshotReply = { allowed: ["save-it"], mode: "save", sessionToken: "session-1" };
  brokerReply = { status: "succeeded", result: { saved: true } };
  failMint = false;
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

async function compile(src: string, identity: any) {
  const code = await parser.parse(0, src, lex);
  const compiler = new Compiler({
    langID: "9999",
    Checker,
    Transformer: ToyTransformer,
    Renderer,
    protectedFunctions: { SAVE_IT: { fn: "save-it", kind: "write" } },
    policy: client(),
  });
  return new Promise<{ err: any[]; val: any }>((resolve) =>
    compiler.compile(code, {}, {}, (err, val) => resolve({ err: err ?? [], val }), identity),
  );
}

const IDENTITY = {
  uid: "u1",
  connectionId: "conn-1",
  userToken: "user-token",
  intentToken: "intent-token",
  invocationToken: "invocation-token",
  stage: "s0",
};

describe("protection client", () => {
  test("the snapshot carries the user, the intent and both service identities", async () => {
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
      intentToken: "intent-token",
      invocationToken: "invocation-token",
      stage: "s0",
    });
  });

  test("a published view asks policy with no user, on the invocation token alone", async () => {
    snapshotReply = { allowed: [], mode: "render", sessionToken: "session-1" };
    const { err } = await compile("save-it 1..", { connectionId: "conn-1", invocationToken: "publication-token", stage: "view" });
    const snap = requests[0];
    expect(snap.url).toBe(`${POLICY}/v1/snapshot`);
    expect(snap.headers.Authorization).toBeUndefined();
    expect(snap.body).toMatchObject({ connectionId: "conn-1", invocationToken: "publication-token", stage: "view" });
    // Policy allowed nothing but a write was asked for: disabled in render mode, never minted.
    expect(err).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  test("with neither a user nor an invocation token, policy is never asked", async () => {
    const { err, val } = await compile("save-it 1..", { connectionId: "conn-1" });
    expect(requests).toEqual([]);
    expect(err).toEqual([]);
    expect(val).toEqual({ skipped: "write-disabled", fn: "save-it" });
  });

  test("a write runs when policy resolves save mode, minted for exactly its payload", async () => {
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

  test("the same write is disabled when policy resolves a non-save mode", async () => {
    snapshotReply = { allowed: ["save-it"], mode: "render", sessionToken: "session-1" };
    const { val } = await compile("save-it 1..", IDENTITY);
    expect(val).toEqual({ skipped: "write-disabled", fn: "save-it" });
    expect(requests.map((r) => r.url)).toEqual([`${POLICY}/v1/snapshot`]);
  });

  test("a privileged mode in the request is not trusted when policy returns none", async () => {
    snapshotReply = { allowed: ["save-it"], sessionToken: "session-1" };
    const { val } = await compile("save-it 1..", { ...IDENTITY, mode: "save" });
    expect(val).toEqual({ skipped: "write-disabled", fn: "save-it" });
    expect(requests).toHaveLength(1);
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
    const exec = new ExecContext({ uid: "u1", userToken: "user-token", intentToken: "intent-token" });
    expect(JSON.stringify(exec)).not.toMatch(/user-token|intent-token/);
    expect(Object.values(exec)).not.toContain("user-token");
  });
});
