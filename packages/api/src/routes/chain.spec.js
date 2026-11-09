// One task-chain normalization for POST /compile and POST /command (C6 plan,
// decision 8): one item and key give one taskId on both routes.
import { buildChainWithData, dataTask } from "./chain.js";

const build = () => {
  const ids = new Map();
  const postTasks = async ({ tasks }) => {
    const key = JSON.stringify(tasks);
    if (!ids.has(key)) ids.set(key, `t${ids.size}`);
    return ids.get(key);
  };
  return buildChainWithData({ postTasks });
};

describe("the shared chain normalization", () => {
  it("adds no task for absent or empty data, so /compile's {} and /command's absent data agree", async () => {
    const withData = build();
    expect(await withData({ auth: null, req: null, id: "item", data: undefined })).toEqual({ id: "item", appended: false });
    expect(await withData({ auth: null, req: null, id: "item", data: {} })).toEqual({ id: "item", appended: false });
    expect(await withData({ auth: null, req: null, id: "item", data: null })).toEqual({ id: "item", appended: false });
  });

  it("appends other data's task once", async () => {
    const withData = build();
    const first = await withData({ auth: null, req: null, id: "item", data: { a: 1 } });
    expect(first.appended).toBe(true);
    expect(first.id).toMatch(/^item\+t\d+$/);
    expect(await withData({ auth: null, req: null, id: first.id, data: { a: 1 } })).toEqual({ id: first.id, appended: false });
  });

  it("makes the data task as POST /compile always has", () => {
    expect(dataTask({ a: 1 })).toEqual({ lang: "0000", code: { 1: { elts: ["{\"a\":1}"], tag: "STR" }, 2: { elts: [1], tag: "JSON" }, root: 2 } });
  });
});
