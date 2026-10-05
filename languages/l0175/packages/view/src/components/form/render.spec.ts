// SPDX-License-Identifier: MIT
// Render smoke tests for the Form: every item type, in every view mode, before AND after a
// student answers. The "after" half is the regression guard for the blank-view bug — the shared
// View's reducer merges a response's args into the top level of `data`, and for a single-item
// program `data` IS the item, so an un-namespaced answer ({choice: "A"}) used to overwrite the
// item's own `choice` field and the next render threw, blanking the whole form.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Form } from "./Form";
import { OptionRow } from "./itemKit";

// One minimal item per task-model renderer, shaped like the compiler's output.
const EBSR: any = {
  kind: "item", id: "q1", type: "ebsr", target: "c1-t11", taskModel: "1",
  passage: { heading: "P", lines: [{ id: 1, text: "One." }] },
  stem: { leadIn: "Two parts.", partA: "Which inference?", partB: "Which sentence?" },
  partA: { options: [{ key: "A", text: "right", correct: true }, { key: "B", text: "wrong", correct: false }] },
  partB: { options: [{ key: "A", text: "One.", correct: true }, { key: "B", text: "Two.", correct: false }] },
  distractorAnalysis: [{ part: "A", key: "B", errorType: "misreads-detail", plausibility: 0.8, rationale: "misreads" }],
  answerKey: { partA: "A", partB: "A" },
  review: { scoring: "1 point", correctClaim: { id: "c1", text: "the inference" }, alternativeClaims: 0 },
  warnings: [],
};
const HOTTEXT: any = {
  kind: "item", id: "q2", type: "hot-text", target: "c1-t4", taskModel: "2",
  passage: { heading: "P", lines: [{ id: 1, text: "A. B." }] },
  stem: { partA: "Which inference?", partB: "Click the sentences." },
  partA: { options: [{ key: "A", text: "right", correct: true }, { key: "B", text: "wrong", correct: false }] },
  selectCount: 1,
  selectable: [
    { id: "1.1", lineId: 1, sentence: 1, text: "A.", correct: true },
    { id: "1.2", lineId: 1, sentence: 2, text: "B.", correct: false },
  ],
  distractorAnalysis: [], answerKey: { partA: "A", partB: "1.1" },
  review: { correctClaim: { id: "c1", text: "the inference" } }, warnings: [],
};
const WORDSELECT: any = {
  kind: "item", id: "q3", type: "hot-text", target: "c1-t10", taskModel: "3",
  passage: { heading: "P", lines: [{ id: 1, text: "The aqueduct carried water." }] },
  stem: { partA: "Click the word that means a channel." },
  selectCount: 1,
  wordSelect: { excerpt: "The aqueduct carried water.", tokens: [
    { idx: 0, pre: "", text: "The", post: "", selectable: false, correct: false },
    { idx: 1, pre: "", text: "aqueduct", post: "", selectable: true, correct: true },
    { idx: 2, pre: "", text: "water", post: ".", selectable: true, correct: false },
  ] },
  distractorAnalysis: [], answerKey: { word: "aqueduct" },
  review: { correctClaim: { id: "w1", text: "aqueduct" } }, warnings: [],
};
const MC: any = {
  kind: "item", id: "q4", type: "multiple-choice", target: "c1-t9", taskModel: "1",
  passage: { heading: "P", lines: [{ id: 1, text: "One." }] },
  stem: { partA: "Which sentence shows the main idea?" },
  choice: { options: [{ key: "A", text: "right", correct: true }, { key: "B", text: "wrong", correct: false }] },
  distractorAnalysis: [], answerKey: { choice: "A" },
  review: { correctClaim: { id: "c1", text: "the idea" } }, warnings: [],
};
const MULTISELECT: any = {
  ...MC, id: "q5", type: "multi-select", selectCount: 2,
  choice: { options: [
    { key: "A", text: "one", correct: true },
    { key: "B", text: "two", correct: true },
    { key: "C", text: "three", correct: false },
  ] },
  answerKey: { choices: ["A", "B"] },
};
const SHORTTEXT: any = {
  kind: "item", id: "q6", type: "short-text", target: "c1-t4", taskModel: "3",
  passage: { heading: "P", lines: [{ id: 1, text: "One." }] },
  prompt: "What inference can be made? Explain.",
  rubric: [{ score: 2, descriptor: "Full." }, { score: 0, descriptor: "None." }],
  distractorAnalysis: [], answerKey: { rationale: "The exemplar." },
  review: { correctClaim: { id: "c1", text: "the inference" } }, warnings: [],
};

const ITEMS: Record<string, any> = { EBSR, HOTTEXT, WORDSELECT, MC, MULTISELECT, SHORTTEXT };
const MODES = ["preview", "answers", "review", "passage"] as const;

function render(data: any, mode: string): string {
  // usePersistedMode reads window.localStorage; stub it to pin the mode under test.
  (globalThis as any).window = { localStorage: { getItem: () => mode, setItem: () => {} } };
  return renderToString(createElement(Form as any, { state: { data, errors: [], apply: () => {} } }));
}

// The Answers view answers the question instead of asking it: the stem, then the correct
// answer(s) — no distractors to pick from.
describe("Answers view shows only the correct answer", () => {
  it("multiple-choice shows the correct option and drops the distractors", () => {
    const html = render(MC, "answers");
    expect(html).toContain("Which sentence shows the main idea?"); // the stem
    expect(html).toContain("A — right");
    expect(html).not.toContain("wrong"); // no distractors
  });
  it("EBSR shows both parts' answers", () => {
    const html = render(EBSR, "answers");
    expect(html).toContain("Part A");
    expect(html).toContain("Part B");
    expect(html).toContain("A — right");
  });
  it("short text shows a sample correct answer", () => {
    const html = render(SHORTTEXT, "answers");
    expect(html).toContain("Sample correct answer");
    expect(html).toContain("The exemplar.");
    expect(html).not.toContain("Scoring rubric"); // scoring belongs to Rationale
  });
  it("word-select shows the word; hot text the supporting sentences", () => {
    expect(render(WORDSELECT, "answers")).toContain("aqueduct");
    expect(render(HOTTEXT, "answers")).toContain("1.1");
  });
});

describe("Form renders every item type in every mode", () => {
  for (const [name, item] of Object.entries(ITEMS)) {
    for (const mode of MODES) {
      it(`${name} / ${mode}`, () => {
        const html = render(item, mode);
        expect(html).toContain("Questions"); // the toggle rendered
        expect(html.length).toBeGreaterThan(800); // and a body under it
      });
    }
  }
});

describe("answering an item does not blank the view", () => {
  // What the reducer produces: {...data, ...args} for the args ItemView now sends.
  const answered = (item: any, answer: any) => ({ ...item, response: { itemId: item.id, ...answer } });
  const CASES: [string, any, any][] = [
    ["multiple-choice", MC, { choice: "A" }],
    ["multi-select", MULTISELECT, { choices: ["A", "B"] }],
    ["ebsr", EBSR, { partA: "A", partB: "A" }],
    ["hot-text", HOTTEXT, { partA: "A", selected: ["1.1"] }],
    ["word-select", WORDSELECT, { selected: 1 }],
    ["short-text", SHORTTEXT, { text: "an answer" }],
  ];
  for (const [name, item, answer] of CASES) {
    it(`${name} still renders after a response is merged into data`, () => {
      const html = render(answered(item, answer), "preview");
      expect(html.length).toBeGreaterThan(800);
      expect(html).not.toContain("could not be displayed"); // the item boundary did not trip
    });
  }
  it("an item whose options were destroyed degrades to a message, not a blank form", () => {
    // Belt and braces: even if something does clobber the item, the boundary and the defensive
    // reads keep the toggle and the rest of the form on screen.
    const html = render({ ...MC, choice: "A" }, "preview");
    expect(html).toContain("Questions");
    expect(html).toContain("Which sentence shows the main idea?");
  });
});

// Preview feedback is about the student's OWN pick: answering must never point at the right
// answer. (The Answers and Rationale views are where every correct option is marked.)
describe("Questions mode marks only the clicked response", () => {
  const row = (props: any) =>
    renderToString(
      createElement(OptionRow as any, {
        name: "q", optKey: "A", onSelect: () => {}, mode: "preview", children: "an option",
        ...props,
      }),
    );
  const marksCorrect = (html: string) => html.includes("✓") || html.includes("green");
  const marksWrong = (html: string) => html.includes("✗") || html.includes("red");

  it("leaves the unpicked correct option unmarked after a wrong answer", () => {
    const html = row({ correct: true, selected: false, feedback: true });
    expect(marksCorrect(html)).toBe(false);
  });
  it("marks the picked option right when it is right", () => {
    expect(marksCorrect(row({ correct: true, selected: true, feedback: true }))).toBe(true);
  });
  it("marks the picked option wrong when it is wrong", () => {
    const html = row({ correct: false, selected: true, feedback: true });
    expect(marksWrong(html)).toBe(true);
    expect(html).not.toContain("✓");
  });
  it("marks nothing before the student answers", () => {
    const html = row({ correct: true, selected: false, feedback: false });
    expect(marksCorrect(html)).toBe(false);
  });
  it("still marks every correct option in the Rationale view", () => {
    expect(marksCorrect(row({ mode: "review", correct: true, selected: false }))).toBe(true);
  });
});
