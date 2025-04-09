import { Folder } from "./folder.js";
import { Ast } from "./ast.js";

describe("folder", () => {
  it("should fold 'add 2 3' to 5", () => {
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

    // Assert
    expect(resultNode.tag).toBe("NUM");
    expect(resultNode.elts[0]).toBe("5");
  });
});
