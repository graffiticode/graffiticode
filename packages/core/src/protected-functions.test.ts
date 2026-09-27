import { describe, test, expect, beforeEach } from "vitest";
import { parser } from "@graffiticode/parser";
import { Compiler, Checker, Transformer, Renderer, lexicon } from "@graffiticode/l0000";

// A toy language with one protected write and one protected read.
const lex = {
  ...lexicon,
  "save-it": { tk: 1, name: "SAVE_IT", cls: "function", length: 1, arity: 1 },
  "peek-it": { tk: 1, name: "PEEK_IT", cls: "function", length: 1, arity: 1 },
  "edit-it": { tk: 1, name: "EDIT_IT", cls: "function", length: 1, arity: 1 },
};
const protectedFunctions = {
  SAVE_IT: { fn: "save-it", kind: "write" as const },
  PEEK_IT: { fn: "peek-it", kind: "read" as const },
  // Like Author API signing: authority beyond an ordinary render, which policy
  // grants only where it should (L0176: the connection's owner, never a view).
  EDIT_IT: { fn: "edit-it", kind: "sign" as const },
};

let calls: { fn: string; arg: any }[];
let transformerRuns: number;

class ToyTransformer extends Transformer {
  PROG(node, options, resume) {
    transformerRuns++;
    super.PROG(node, options, resume);
  }
  SAVE_IT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      calls.push({ fn: "save-it", arg: v0 });
      resume([].concat(e0), { saved: v0 });
    });
  }
  EDIT_IT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      calls.push({ fn: "edit-it", arg: v0 });
      resume([].concat(e0), { edited: v0 });
    });
  }
  PEEK_IT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      calls.push({ fn: "peek-it", arg: v0 });
      resume([].concat(e0), { peeked: v0 });
    });
  }
}

function policyAllowing(allowed: string[]) {
  const policy = {
    requests: [] as any[],
    async getSnapshot(args) {
      policy.requests.push(args);
      return { allowed };
    },
  };
  return policy;
}

async function run(src: string, { allowed = [], policy = undefined, connectionId = "conn-1" }: any = {}) {
  const code = await parser.parse(0, src, lex);
  const compiler = new Compiler({
    langID: "9999",
    version: "v0",
    Checker,
    Transformer: ToyTransformer,
    Renderer,
    protectedFunctions,
    policy: policy ?? policyAllowing(allowed),
  });
  return new Promise<{ err: any[]; val: any }>((resolve) =>
    compiler.compile(code, {}, {}, (err, val) => resolve({ err: err ?? [], val }), {
      uid: "u1",
      connectionId,
    }),
  );
}

beforeEach(() => {
  calls = [];
  transformerRuns = 0;
});

// Every placement a protected call can take in source.
const PLACEMENTS = [
  ["direct", "save-it 1.."],
  ["parenthesized", "(save-it 1).."],
  ["if branch", "if true then save-it 1 else 2.."],
  ["untaken branch", "if false then save-it 1 else 2.."],
  ["map lambda", "map (<x: save-it x>) [1 2].."],
  ["reduce lambda", "reduce (<x acc: save-it x>) 0 [1 2].."],
  ["let binding / first-class", "let f = save-it..f 1.."],
];

describe("the grant is the authority", () => {
  test.each(PLACEMENTS)("ungranted protected call (%s) is refused before transformation", async (_, src) => {
    const { err } = await run(src, { allowed: [] });
    expect(err.length).toBeGreaterThan(0);
    expect(err[0].message).toMatch(/save-it is not permitted/);
    expect(transformerRuns).toBe(0);
    expect(calls).toEqual([]);
  });

  test("a granted write runs", async () => {
    const { err, val } = await run("save-it 1..", { allowed: ["save-it"] });
    expect(err).toEqual([]);
    expect(val).toEqual({ saved: 1 });
    expect(calls).toEqual([{ fn: "save-it", arg: 1 }]);
  });

  test("a granted write inside a lambda runs once per element", async () => {
    const { err } = await run("map (<x: save-it x>) [1 2]..", { allowed: ["save-it"] });
    expect(err).toEqual([]);
    expect(calls.map((c) => c.arg)).toEqual([1, 2]);
  });

  test("one ungranted call refuses the whole program, even after granted ones", async () => {
    const { err } = await run("[peek-it 1 save-it 2]..", { allowed: ["peek-it"] });
    expect(err.map((e) => e.message)).toEqual(["save-it is not permitted through the selected connection."]);
    expect(transformerRuns).toBe(0);
    expect(calls).toEqual([]);
  });

  test("the error points at the call", async () => {
    const { err } = await run("[1 save-it 2]..");
    expect(err[0].message).toMatch(/save-it is not permitted/);
    expect(err[0].from).toBeGreaterThan(0);
    expect(err[0].to).toBeGreaterThan(err[0].from);
  });
});

describe("no execution modes", () => {
  test.each(PLACEMENTS)("a granted write (%s) runs wherever the program calls it", async (_, src) => {
    const { err } = await run(src, { allowed: ["save-it"] });
    expect(err).toEqual([]);
    expect(transformerRuns).toBe(1);
  });

  test("a write's arguments are evaluated like any call's", async () => {
    const { err, val } = await run("save-it (peek-it 1)..", { allowed: ["peek-it", "save-it"] });
    expect(err).toEqual([]);
    expect(val).toEqual({ saved: { peeked: 1 } });
    expect(calls.map((c) => c.fn)).toEqual(["peek-it", "save-it"]);
  });

  test("a function with authority beyond a render runs when granted, and only then", async () => {
    expect((await run("edit-it 1..", { allowed: ["edit-it"] })).val).toEqual({ edited: 1 });
    const { err } = await run("edit-it 1..", { allowed: ["peek-it"] });
    expect(err[0].message).toMatch(/edit-it is not permitted/);
  });

  test("an ungranted read is refused", async () => {
    const { err } = await run("peek-it 1..", { allowed: [] });
    expect(err[0].message).toMatch(/peek-it is not permitted/);
    expect(transformerRuns).toBe(0);
  });
});

describe("policy snapshot", () => {
  test("is fetched once per compile with the protected functions it needs", async () => {
    const policy = policyAllowing(["peek-it"]);
    await run("[peek-it 1 peek-it 2 map (<x: peek-it x>) [3]]..", { policy });
    expect(policy.requests).toHaveLength(1);
    expect(policy.requests[0].fns).toEqual(["peek-it"]);
    expect(policy.requests[0].langID).toBe("9999");
    expect(policy.requests[0].exec.uid).toBe("u1");
    expect(policy.requests[0].exec.connectionId).toBe("conn-1");
  });

  test("is not fetched for a program with no protected calls", async () => {
    const policy = policyAllowing([]);
    const { err, val } = await run("add 1 2..", { policy });
    expect(err).toEqual([]);
    expect(val).toBe(3);
    expect(policy.requests).toEqual([]);
  });

  test("fails closed when the policy fetch fails", async () => {
    const policy = {
      async getSnapshot() {
        throw new Error("down");
      },
    };
    const { err } = await run("peek-it 1..", { policy });
    expect(err[0].message).toMatch(/unavailable/);
    expect(transformerRuns).toBe(0);
  });

  test("without a selected connection nothing is allowed and policy is not asked", async () => {
    const policy = policyAllowing(["peek-it"]);
    const { err } = await run("peek-it 1..", { policy, connectionId: null });
    expect(err[0].message).toMatch(/requires a connection/);
    expect(policy.requests).toEqual([]);
  });

  test("a malformed snapshot allows nothing", async () => {
    const policy = {
      async getSnapshot() {
        return { allowed: "peek-it" } as any;
      },
    };
    const { err } = await run("peek-it 1..", { policy });
    expect(err[0].message).toMatch(/not permitted/);
  });
});

describe("malformed snapshots allow nothing", () => {
  test.each([
    ["a valid name next to a non-string", { allowed: ["peek-it", 123] }],
    ["a valid name next to an empty string", { allowed: ["peek-it", ""] }],
    ["allowed as an object", { allowed: { 0: "peek-it" } }],
    ["no allowed field", {}],
    ["an array response", ["peek-it"]],
    ["null", null],
  ])("%s", async (_, response) => {
    const policy = {
      async getSnapshot() {
        return response as any;
      },
    };
    const { err } = await run("peek-it 1..", { policy });
    expect(err[0].message).toMatch(/peek-it is not permitted/);
    expect(transformerRuns).toBe(0);
  });
});

describe("implicit protected functions", () => {
  async function runImplicit(src, { implicit, allowed = [] }: any) {
    const code = await parser.parse(0, src, lex);
    const policy = policyAllowing(allowed);
    const compiler = new Compiler({
      langID: "9999",
      Checker,
      Transformer: ToyTransformer,
      Renderer,
      protectedFunctions,
      implicitProtectedFunctions: implicit,
      policy,
    });
    const result = await new Promise<{ err: any[]; val: any }>((resolve) =>
      compiler.compile(code, {}, {}, (err, val) => resolve({ err: err ?? [], val }), { uid: "u1", connectionId: "c" }),
    );
    return { ...result, policy };
  }

  test("are required even when no protected call appears in the source", async () => {
    const { err, policy } = await runImplicit("add 1 2..", { implicit: [{ fn: "peek-it", kind: "sign" }] });
    expect(err[0].message).toMatch(/peek-it is not permitted/);
    expect(err[0].from).toBe(-1);
    expect(policy.requests[0].fns).toEqual(["peek-it"]);
    expect(transformerRuns).toBe(0);
  });

  test("run when granted", async () => {
    const { err, val } = await runImplicit("add 1 2..", { implicit: [{ fn: "peek-it", kind: "sign" }], allowed: ["peek-it"] });
    expect(err).toEqual([]);
    expect(val).toBe(3);
  });

  test("share one snapshot with explicit calls", async () => {
    const { err, policy } = await runImplicit("save-it 1..", {
      implicit: [{ fn: "peek-it", kind: "sign" }],
      allowed: ["peek-it", "save-it"],
    });
    expect(err).toEqual([]);
    expect(policy.requests).toHaveLength(1);
    expect(policy.requests[0].fns.sort()).toEqual(["peek-it", "save-it"]);
  });

  test("cannot be writes", async () => {
    const { err } = await runImplicit("add 1 2..", { implicit: [{ fn: "save-it", kind: "write" }], allowed: ["save-it"] });
    expect(err[0].message).toMatch(/cannot be a write/);
    expect(transformerRuns).toBe(0);
  });
});

describe("languages without protected functions", () => {
  test("compile exactly as before", async () => {
    const code = await parser.parse(0, "add 1 2..", lexicon);
    const compiler = new Compiler({ langID: "0", Checker, Transformer, Renderer });
    const val = await new Promise((resolve) => compiler.compile(code, {}, {}, (_e, v) => resolve(v)));
    expect(val).toBe(3);
  });
});
