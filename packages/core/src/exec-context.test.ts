import { describe, test, expect } from "vitest";
import { parser } from "@graffiticode/parser";
import { Compiler, Checker, Transformer, Renderer, lexicon, ExecContext } from "@graffiticode/l0000";

// A Transformer that records the ExecContext it saw at the start and at the end
// of PROG, with an async gap in between so concurrent compiles interleave.
function recordingTransformer(seen: any[], delayMs = 0) {
  return class RecordingTransformer extends Transformer {
    PROG(node, options, resume) {
      const before = this.execContext;
      setTimeout(() => {
        super.PROG(node, options, (err, val) => {
          seen.push({ before, after: this.execContext, val });
          resume(err, val);
        });
      }, delayMs);
    }
  };
}

async function compile(src, { identity, config = {}, TransformerClass = Transformer, compiler }: any = {}) {
  const code = await parser.parse(0, src, lexicon);
  const c = compiler ?? new Compiler({ langID: "0", version: "v0.0.0", Checker, Transformer: TransformerClass, Renderer });
  return new Promise<any>((resolve, reject) => {
    c.compile(code, {}, config, (err, val) => (err && err.length ? reject(err) : resolve(val)), identity);
  });
}

describe("ExecContext", () => {
  test("defaults to least privilege", () => {
    const ctx = new ExecContext();
    expect(ctx.uid).toBeNull();
    expect(ctx.connectionId).toBeNull();
    expect(ctx.mode).toBe("read");
    expect(ctx.stage).toBeNull();
    expect(typeof ctx.compileId).toBe("string");
  });

  test("an unknown mode falls back to read, never save", () => {
    expect(new ExecContext({ mode: "admin" as any }).mode).toBe("read");
  });

  test("identity fields are immutable", () => {
    const ctx = new ExecContext({ uid: "u1", mode: "save" });
    expect(() => {
      (ctx as any).uid = "u2";
    }).toThrow();
    expect(ctx.uid).toBe("u1");
  });

  test("the snapshot can be set once per invocation", () => {
    const ctx = new ExecContext({ uid: "u1" });
    ctx.setSnapshot({ fns: [] });
    expect(() => ctx.setSnapshot({ fns: ["x"] })).toThrow();
    expect(ctx.snapshot).toEqual({ fns: [] });
  });
});

describe("programs cannot reach the ExecContext", () => {
  const identity = { uid: "owner-uid", connectionId: "conn-1", mode: "save" };

  test('get-var "config" returns config only, with no context fields', async () => {
    const result = await compile('get-var "config"..', { identity, config: { a: 1 } });
    expect(result).toEqual({ a: 1 });
    expect(JSON.stringify(result)).not.toContain("owner-uid");
    expect(JSON.stringify(result)).not.toContain("conn-1");
  });

  test.each(["execContext", "uid", "connectionId", "mode", "compileId", "stage", "invocationToken", "snapshot", "exec"])(
    'get-var "%s" does not expose the context',
    async (name) => {
      const result = await compile(`get-var "${name}"..`, { identity });
      expect(JSON.stringify(result ?? null)).not.toMatch(/owner-uid|conn-1/);
    },
  );

  test("set-var cannot overwrite the context", async () => {
    const seen = [];
    await compile('set-var "execContext" "attacker"..', {
      identity,
      TransformerClass: recordingTransformer(seen),
    });
    await compile('set-var "uid" "attacker"..', { identity, TransformerClass: recordingTransformer(seen) });
    for (const { after } of seen) {
      expect(after.uid).toBe("owner-uid");
      expect(after.connectionId).toBe("conn-1");
      expect(after.mode).toBe("save");
    }
  });

  test("the context never appears in options", async () => {
    let observed;
    class OptionsSpy extends Transformer {
      PROG(node, options, resume) {
        observed = options;
        super.PROG(node, options, resume);
      }
    }
    await compile("1..", { identity, TransformerClass: OptionsSpy });
    expect(JSON.stringify(observed)).not.toMatch(/owner-uid|conn-1/);
  });
});

describe("ExecContext isolation across concurrent invocations", () => {
  test("two users on one shared compiler never see each other's context", async () => {
    const seen = [];
    // One Compiler instance, as language servers use it.
    const shared = new Compiler({
      langID: "0",
      version: "v0.0.0",
      Checker,
      Transformer: recordingTransformer(seen, 5),
      Renderer,
    });
    const runs = [];
    for (let i = 0; i < 10; i++) {
      const user = i % 2 === 0 ? "user-a" : "user-b";
      const conn = i % 2 === 0 ? "conn-a" : "conn-b";
      runs.push(compile(`"${user}"..`, { identity: { uid: user, connectionId: conn }, compiler: shared }));
    }
    await Promise.all(runs);
    expect(seen).toHaveLength(10);
    const invocations = new Set();
    for (const { before, after, val } of seen) {
      // The program's value names the user it was compiled for.
      expect(before).toBe(after);
      expect(before.uid).toBe(val);
      expect(before.connectionId).toBe(val === "user-a" ? "conn-a" : "conn-b");
      invocations.add(before.compileId);
    }
    expect(invocations.size).toBe(10);
  });

  test("checker and transformer of one compile share its context", async () => {
    const pairs = [];
    let checkerCtx;
    class SpyChecker extends Checker {
      PROG(node, options, resume) {
        checkerCtx = this.execContext;
        super.PROG(node, options, resume);
      }
    }
    class SpyTransformer extends Transformer {
      PROG(node, options, resume) {
        pairs.push([checkerCtx, this.execContext]);
        super.PROG(node, options, resume);
      }
    }
    const c = new Compiler({ langID: "0", version: "v0.0.0", Checker: SpyChecker, Transformer: SpyTransformer, Renderer });
    await compile("1..", { identity: { uid: "u1" }, compiler: c });
    await compile("1..", { identity: { uid: "u2" }, compiler: c });
    expect(pairs[0][0]).toBe(pairs[0][1]);
    expect(pairs[1][0]).toBe(pairs[1][1]);
    expect(pairs[0][0]).not.toBe(pairs[1][0]);
    expect(pairs[0][0].uid).toBe("u1");
    expect(pairs[1][0].uid).toBe("u2");
  });
});
