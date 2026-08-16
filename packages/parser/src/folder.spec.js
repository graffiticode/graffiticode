import { Folder } from "./folder.js";
import { Ast } from "./ast.js";

describe("folder", () => {
  it("should pass 'add 2 3' through as ADD node", () => {
    // Arrange
    const ctx = {
      state: {
        nodePool: ["unused"],
        nodeStack: [],
        nodeStackStack: [],
        nodeMap: {},
        env: [{ name: "global", lexicon: {} }]
      }
    };

    // Create nodes for "add 2 3"
    const n1Id = Ast.intern(ctx, {
      tag: "NUM",
      elts: ["2"]
    });

    const n2Id = Ast.intern(ctx, {
      tag: "NUM",
      elts: ["3"]
    });

    const addNodeId = Ast.intern(ctx, {
      tag: "ADD",
      elts: [n1Id, n2Id]
    });

    // Act
    Folder.fold(ctx, addNodeId);
    const resultId = ctx.state.nodeStack.pop();
    const resultNode = ctx.state.nodePool[resultId];

    // Assert - arithmetic is deferred to compiler, not folded
    expect(resultNode.tag).toBe("ADD");
    expect(resultNode.elts.length).toBe(2);
    // elts are nids (intern recursively interns object elts)
    const n1 = Ast.node(ctx, resultNode.elts[0]);
    const n2 = Ast.node(ctx, resultNode.elts[1]);
    expect(n1.tag).toBe("NUM");
    expect(n1.elts[0]).toBe("2");
    expect(n2.tag).toBe("NUM");
    expect(n2.elts[0]).toBe("3");
  });

  it("should fold a BINDING to a key and its single value", () => {
    const ctx = {
      state: {
        nodePool: ["unused"],
        nodeStack: [],
        nodeStackStack: [],
        nodeMap: {},
        env: [{ name: "global", lexicon: {} }]
      }
    };

    const keyId = Ast.intern(ctx, { tag: "TAG", elts: ["a"] });
    const valId = Ast.intern(ctx, { tag: "EXPRS", elts: [Ast.intern(ctx, { tag: "NUM", elts: ["1"] })] });
    const bindingId = Ast.intern(ctx, { tag: "BINDING", elts: [keyId, valId] });

    Folder.fold(ctx, bindingId);

    // One node produced, and it is the binding itself -- not a node named after
    // one of the value's expressions.
    expect(ctx.state.nodeStack.length).toBe(1);
    const resultNode = ctx.state.nodePool[ctx.state.nodeStack.pop()];
    expect(resultNode.tag).toBe("BINDING");
    expect(Ast.node(ctx, resultNode.elts[0]).tag).toBe("TAG");
    expect(Ast.node(ctx, resultNode.elts[1]).elts[0]).toBe("1");
  });

  it("should reject a BINDING whose value is more than one expression", () => {
    const ctx = {
      state: {
        nodePool: ["unused"],
        nodeStack: [],
        nodeStackStack: [],
        nodeMap: {},
        errors: [],
        env: [{ name: "global", lexicon: {} }]
      }
    };

    const keyId = Ast.intern(ctx, { tag: "TAG", elts: ["a"] });
    const valId = Ast.intern(ctx, {
      tag: "EXPRS",
      elts: [
        Ast.intern(ctx, { tag: "NUM", elts: ["1"] }),
        Ast.intern(ctx, { tag: "NUM", elts: ["2"] }),
      ]
    });
    const bindingId = Ast.intern(ctx, { tag: "BINDING", elts: [keyId, valId] });

    expect(() => Folder.fold(ctx, bindingId))
      .toThrow("A record field value must be a single expression.");
  });

  it("should not let an unsaturated field value take nodes from outside it", () => {
    const ctx = {
      state: {
        nodePool: ["unused"],
        nodeStack: [],
        nodeStackStack: [],
        nodeMap: {},
        errors: [],
        env: [{
          name: "global",
          lexicon: { length: { tk: 1, name: "LENGTH", cls: "function", length: 1, arity: 1 } }
        }]
      }
    };

    const keyId = Ast.intern(ctx, { tag: "TAG", elts: ["a"] });
    // `length` with no argument: it must report the shortfall rather than reach
    // past the field for one.
    const valId = Ast.intern(ctx, { tag: "EXPRS", elts: [Ast.intern(ctx, { tag: "IDENT", elts: ["length"] })] });
    const bindingId = Ast.intern(ctx, { tag: "BINDING", elts: [keyId, valId] });

    expect(() => Folder.fold(ctx, bindingId))
      .toThrow("Too few arguments for LENGTH. Expected 1.");
  });

  it("should pass 'pow 2 3' through as POW node", () => {
    const ctx = {
      state: {
        nodePool: ["unused"],
        nodeStack: [],
        nodeStackStack: [],
        nodeMap: {},
        env: [{ name: "global", lexicon: {} }]
      }
    };

    const n1Id = Ast.intern(ctx, { tag: "NUM", elts: ["2"] });
    const n2Id = Ast.intern(ctx, { tag: "NUM", elts: ["3"] });
    const powNodeId = Ast.intern(ctx, { tag: "POW", elts: [n1Id, n2Id] });

    Folder.fold(ctx, powNodeId);
    const resultId = ctx.state.nodeStack.pop();
    const resultNode = ctx.state.nodePool[resultId];

    expect(resultNode.tag).toBe("POW");
    expect(resultNode.elts.length).toBe(2);
    const n1 = Ast.node(ctx, resultNode.elts[0]);
    const n2 = Ast.node(ctx, resultNode.elts[1]);
    expect(n1.tag).toBe("NUM");
    expect(n1.elts[0]).toBe("2");
    expect(n2.tag).toBe("NUM");
    expect(n2.elts[0]).toBe("3");
  });

  it("should fold get-val-public to the resolved string literal", () => {
    const ctx = {
      state: {
        nodePool: ["unused"],
        nodeStack: [],
        nodeStackStack: [],
        nodeMap: {},
        env: [{ name: "global", lexicon: {} }],
        callbacks: { GET_VAL_PUBLIC: (name) => `plain:${name}` },
      }
    };
    const nameId = Ast.intern(ctx, { tag: "STR", elts: ["my-id"] });
    const nodeId = Ast.intern(ctx, { tag: "GET_VAL_PUBLIC", elts: [nameId] });

    Folder.fold(ctx, nodeId);
    const resultNode = ctx.state.nodePool[ctx.state.nodeStack.pop()];

    // Public values are plaintext — collapse to a STR literal.
    expect(resultNode.tag).toBe("STR");
    expect(resultNode.elts[0]).toBe("plain:my-id");
  });

  it("should preserve get-val-private as a node so the compiler can decrypt it", () => {
    const ctx = {
      state: {
        nodePool: ["unused"],
        nodeStack: [],
        nodeStackStack: [],
        nodeMap: {},
        env: [{ name: "global", lexicon: {} }],
        callbacks: { GET_VAL_PRIVATE: (name) => `cipher:${name}` },
      }
    };
    const nameId = Ast.intern(ctx, { tag: "STR", elts: ["my-secret"] });
    const nodeId = Ast.intern(ctx, { tag: "GET_VAL_PRIVATE", elts: [nameId] });

    Folder.fold(ctx, nodeId);
    const resultNode = ctx.state.nodePool[ctx.state.nodeStack.pop()];

    // Private values are ciphertext — keep the GET_VAL_PRIVATE node with the
    // name in elts[0] and the ciphertext in elts[1] so compile-time decrypt runs.
    expect(resultNode.tag).toBe("GET_VAL_PRIVATE");
    expect(resultNode.elts.length).toBe(2);
    const e0 = Ast.node(ctx, resultNode.elts[0]);
    const e1 = Ast.node(ctx, resultNode.elts[1]);
    expect(e0.tag).toBe("STR");
    expect(e0.elts[0]).toBe("my-secret");
    expect(e1.tag).toBe("STR");
    expect(e1.elts[0]).toBe("cipher:my-secret");
  });
});
