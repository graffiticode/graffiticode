import { describe, test, expect } from "vitest";
import { buildCreateItems } from "./items.js";

// An item record references its widgets rather than carrying them, so the
// questions must be in the bank before the item that points at them. Learnosity
// reports the violation as 30001 "Widget ... was not found. Create widget
// first." Rendering never exposed it, because the preview inlines question data.
// The broker writes questionRecords, then itemRecords; this checks the plan it
// is given.
describe("the save plan for an item", () => {
  const plan = async () => (await buildCreateItems()({
    items: [{ data: { questions: [
      { response_id: "ignored", type: "clozeformulaV2", stimulus: "Q1" },
      { response_id: "ignored", type: "mcq", stimulus: "Q2" },
    ] } }],
    id: "batch",
  })).savePlan;

  test("every widget the item references is among its questions", async () => {
    const { questionRecords, itemRecords } = await plan();
    const written = new Set(questionRecords.map((q: any) => q.reference));
    const referenced = itemRecords.flatMap((i: any) =>
      i.definition.widgets.map((w: any) => w.reference));
    expect(referenced.length).toBeGreaterThan(0);
    for (const ref of referenced) expect(written, `${ref} is not a question`).toContain(ref);
  });

  test("a question is stored as {type, reference, data} with no response_id", async () => {
    const q = (await plan()).questionRecords[0];
    expect(Object.keys(q).sort()).toEqual(["data", "reference", "type"]);
    expect(q.reference).toBe("artcompiler-clozeformulaV2-batch-0-0");
    expect(q.data.response_id).toBeUndefined();
    expect(q.data.stimulus).toBe("Q1");
  });
});

describe("building never writes", () => {
  test("createItems returns a plan and makes no provider call", async () => {
    const built = await buildCreateItems()({
      items: [{ data: { questions: [{ response_id: "x", type: "mcq", stimulus: "Q" }] } }],
      id: "b",
    });
    expect(built.activity.type).toBe("questions");
    expect(built.activity.data.itemBank).toBeUndefined();
    expect(built.savePlan.itemRecords).toHaveLength(1);
    expect(built.savePlan.itemRecords[0].status).toBe("unpublished");
  });
});
