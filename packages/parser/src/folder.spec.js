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
});
