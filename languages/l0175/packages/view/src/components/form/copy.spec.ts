// SPDX-License-Identifier: MIT
// Unit tests for the rich-text serializer behind the Copy button. Pure functions over the item
// data model — no DOM. Run via the root `npm test` (vitest).
import { describe, it, expect } from "vitest";
import { itemToHtml, itemToText, itemsToHtml, itemsToText, passagesToHtml, passagesToText, answersToHtml, answersToText } from "./copy";
import { answerRows } from "./answers";

const EBSR: any = {
  type: "ebsr",
  id: "q1",
  standards: ["ri-1", "ri-3"],
  dok: "r-dok3",
  dimension: "relationships-interactions",
  passage: { heading: "The Story of Bridges", lines: [{ id: 1, text: "Logs spanned streams." }, { id: 2, text: "Then came stone arches." }] },
  stem: { leadIn: "This question has two parts.", partA: "Which inference about the designs is supported?", partB: "Which sentence best supports your answer?" },
  partA: { options: [{ key: "A", text: "Each design solved a limit of the last.", correct: true }, { key: "B", text: "Stone replaced steel.", correct: false }] },
  partB: { options: [{ key: "A", text: "Logs spanned streams.", correct: false }, { key: "B", text: "Then came stone arches.", correct: true }] },
  distractorAnalysis: [{ part: "A", key: "B", errorType: "misreads-detail", plausibility: 0.8, rationale: "reverses the order" }],
  answerKey: { partA: "A", partB: "B", rationale: "each solved a limit" },
  review: { correctClaim: { id: "c1", text: "Each new design solved a limitation." }, scoring: "1 point", alternativeClaims: 0 },
  warnings: ["Part B options do not overlap the correct Part A option."],
};

const HOTTEXT: any = {
  type: "hot-text",
  id: "q2",
  passage: { heading: "Bridges", lines: [{ id: 1, text: "A." }, { id: 2, text: "B." }, { id: 3, text: "C." }] },
  stem: { partA: "Click the best inference.", partB: "Click the supporting sentence(s)." },
  partA: { options: [{ key: "A", text: "right", correct: true }, { key: "B", text: "wrong", correct: false }] },
  selectCount: 2,
  selectable: [
    { id: "1.1", lineId: 1, sentence: 1, text: "A.", correct: true },
    { id: "1.2", lineId: 1, sentence: 2, text: "B.", correct: false },
    { id: "2.1", lineId: 2, sentence: 1, text: "C.", correct: true },
  ],
  distractorAnalysis: [],
  answerKey: { partA: "A" },
  review: { correctClaim: { id: "c1", text: "the inference" } },
  warnings: [],
};

const WORDSELECT: any = {
  type: "hot-text",
  id: "q6",
  passage: { heading: "Aqueducts", lines: [{ id: 1, text: "They built aqueducts, which carried water." }] },
  stem: { partA: "Read the paragraph below. Click the word that means a channel that carries water." },
  selectCount: 1,
  wordSelect: {
    excerpt: "They built aqueducts, which carried water.",
    tokens: [
      { idx: 0, pre: "", text: "They", post: "", selectable: false, correct: false },
      { idx: 1, pre: "", text: "built", post: "", selectable: false, correct: false },
      { idx: 2, pre: "", text: "aqueducts", post: ",", selectable: true, correct: true },
      { idx: 3, pre: "", text: "which", post: "", selectable: false, correct: false },
      { idx: 4, pre: "", text: "carried", post: "", selectable: true, correct: false },
      { idx: 5, pre: "", text: "water", post: ".", selectable: false, correct: false },
    ],
  },
  distractorAnalysis: [],
  answerKey: { word: "aqueducts", rationale: "" },
  review: { correctClaim: { id: "w1", text: "aqueducts" } },
  warnings: [],
};

const MC: any = {
  type: "multiple-choice",
  id: "q4",
  passage: { heading: "Bees", lines: [{ id: 1, text: "A." }] },
  stem: { partA: "Which sentence best shows the main idea?" },
  choice: { options: [{ key: "A", text: "Bees work together.", correct: true }, { key: "B", text: "The queen lays eggs.", correct: false }] },
  distractorAnalysis: [],
  answerKey: { choice: "A" },
  review: { correctClaim: { id: "c1", text: "Bees work together." } },
  warnings: [],
};

const MULTISELECT: any = {
  type: "multi-select",
  id: "q5",
  passage: { heading: "Bees", lines: [{ id: 1, text: "A." }] },
  stem: { partA: "Choose two sentences that belong in a summary." },
  selectCount: 2,
  choice: { options: [
    { key: "A", text: "Workers gather nectar.", correct: true },
    { key: "B", text: "The queen lays eggs.", correct: true },
    { key: "C", text: "Bees are insects.", correct: false },
  ] },
  distractorAnalysis: [],
  answerKey: { choices: ["A", "B"] },
  review: { correctClaim: { id: "s1", text: "Workers gather nectar." } },
  warnings: [],
};

const SHORTTEXT: any = {
  type: "short-text",
  id: "q3",
  passage: { heading: "Bridges", lines: [{ id: 1, text: "A." }] },
  prompt: "What inference can be made about the author's purpose? Explain.",
  rubric: [{ score: 2, descriptor: "Full and specific." }, { score: 0, descriptor: "None." }],
  answerKey: { rationale: "The author shows that designs improve." },
  review: { correctClaim: { id: "c1", text: "designs improve" } },
  warnings: [],
};

describe("copy serializer — metadata header", () => {
  it("prepends the view's pill metadata (type, standards, DoK, dimension) in both modes", () => {
    for (const mode of ["preview", "review"] as const) {
      const html = itemToHtml(EBSR, mode);
      expect(html).toContain("EBSR");
      expect(html).toContain("ri-1");
      expect(html).toContain("ri-3");
      expect(html).toContain("r-dok3");
      expect(html).toContain("relationships-interactions");
      const text = itemToText(EBSR, mode);
      expect(text).toContain("EBSR · ri-1 · ri-3 · r-dok3 · relationships-interactions");
    }
  });
  it("omits absent metadata fields without leaving stray separators", () => {
    const text = itemToText(MC, "preview"); // no standards/dok/dimension
    expect(text.split("\n")[0]).toBe("Multiple Choice");
  });
});

describe("copy serializer — Claim/Target/Task Model pills", () => {
  const CLASSIFIED: any = { ...EBSR, target: "c1-t9", taskModel: "3" };
  const HEADER = "C1 · T9 · TM3 · EBSR · ri-1 · ri-3 · r-dok3 · relationships-interactions";

  it("leads the metadata header with C · T · TM in question and answer-key copy", () => {
    for (const mode of ["preview", "review"] as const) {
      expect(itemToText(CLASSIFIED, mode).split("\n")[0]).toBe(HEADER);
      expect(itemToHtml(CLASSIFIED, mode)).toContain("C1 &middot; T9 &middot; TM3 &middot; EBSR");
    }
  });

  it("includes the pills at the head of the copied passage text", () => {
    expect(passagesToText([CLASSIFIED]).split("\n")[0]).toBe(HEADER);
    expect(passagesToHtml([CLASSIFIED])).toContain("C1 &middot; T9 &middot; TM3");
  });

  it("omits a pill whose value is absent (no task-model → no TM)", () => {
    const noTm: any = { ...EBSR, target: "c1-t4" }; // target only, no taskModel
    expect(itemToText(noTm, "preview").split("\n")[0]).toBe(
      "C1 · T4 · EBSR · ri-1 · ri-3 · r-dok3 · relationships-interactions",
    );
  });
});

describe("copy serializer — question (Questions view)", () => {
  const html = itemToHtml(EBSR, "preview");
  it("includes the lead-in, both parts and options but NOT the passage", () => {
    expect(html).not.toContain("The Story of Bridges"); // passage lives in its own view + copy
    expect(html).toContain("This question has two parts.");
    expect(html).toContain("Part A.");
    expect(html).toContain("A. Each design solved a limit of the last.");
    expect(html).toContain("Part B.");
  });
  it("does NOT reveal the answer in the Questions view", () => {
    expect(html).not.toContain("Answer key");
    expect(html).not.toContain("✓");
    expect(html).not.toContain("Correct inference");
  });
});

describe("copy serializer — answer key (review)", () => {
  const html = itemToHtml(EBSR, "review");
  it("omits the passage (it has its own view + Copy passage)", () => {
    expect(html).not.toContain("The Story of Bridges");
  });
  it("marks the correct option and emits the answer key + correct inference", () => {
    expect(html).toContain("✓");
    expect(html).toContain("<strong>A. Each design solved a limit of the last.</strong>");
    expect(html).toMatch(/<strong style="color:#15803d">✓<\/strong>/); // green check, dark enough for grayscale print
    expect(html).toContain("Answer key:");
    expect(html).toContain("Part A");
    expect(html).toContain("Part B");
    expect(html).toContain("Correct inference:");
    expect(html).toContain("Each new design solved a limitation.");
  });
  it("interleaves the amber distractor annotation under each wrong option, as in the Review view", () => {
    expect(html).toContain("misreads-detail"); // error type (bold)
    expect(html).toContain("p=0.8"); // plausibility, matching the on-screen annotation
    expect(html).toContain("reverses the order"); // the rationale
    expect(html).toContain("#b45309"); // text-amber-700 color
    expect(html).not.toContain("do not overlap"); // composition warnings still omitted
  });
  it("emits clean inline-styled HTML — no class names, balanced strong/p tags", () => {
    expect(html).not.toContain("class=");
    expect((html.match(/<strong[ >]/g) ?? []).length).toBe((html.match(/<\/strong>/g) ?? []).length);
    expect((html.match(/<p[ >]/g) ?? []).length).toBe((html.match(/<\/p>/g) ?? []).length);
  });
});

describe("copy serializer — hot text & short text", () => {
  it("hot text review marks correct sentences and lists them in the key", () => {
    const html = itemToHtml(HOTTEXT, "review");
    expect(html).toContain("Part B");
    expect(html).toContain("any 2 of: 1.1, 2.1");
    expect(html).toContain("✓");
  });
  it("word-select (T10) underlines candidate words and brackets them in plain text", () => {
    const preview = itemToHtml(WORDSELECT, "preview");
    // every candidate (clickable) word is underlined (survives Google Docs) AND bracketed (survives
    // plain-text stripping), in both modes
    expect(preview).toMatch(/\[<u style="text-decoration:underline[^"]*">aqueducts<\/u>\]/);
    expect(preview).toMatch(/\[<u style="text-decoration:underline[^"]*">carried<\/u>\]/);
    expect(preview).not.toContain("✓"); // questions view hides the answer
    // non-candidate words stay plain
    expect(preview).not.toMatch(/<u[^>]*>They/);
    expect(preview).not.toContain("[They");

    const review = itemToHtml(WORDSELECT, "review");
    expect(review).toMatch(
      /<strong>\[<u style="text-decoration:underline[^"]*">aqueducts<\/u> <strong style="color:#15803d">✓<\/strong>\]<\/strong>/,
    );
    expect(review).toContain("Answer &mdash; aqueducts");

    const text = itemToText(WORDSELECT, "review");
    expect(text).toContain("[aqueducts ✓],"); // correct candidate, punctuation preserved
    expect(text).toContain("[carried]"); // distractor candidate bracketed
    expect(text).toContain("They built"); // non-candidates plain
    expect(itemToText(WORDSELECT, "preview")).toContain("[aqueducts]"); // no ✓ in questions view
  });
  it("short text review emits the prompt, rubric and exemplar; preview shows a blank", () => {
    const review = itemToHtml(SHORTTEXT, "review");
    expect(review).toContain("Scoring rubric:");
    expect(review).toContain("Full and specific.");
    expect(review).toContain("Exemplar inference:");
    expect(review).toContain("The author shows that designs improve.");
    const preview = itemToHtml(SHORTTEXT, "preview");
    expect(preview).toContain("Answer:");
    expect(preview).not.toContain("Scoring rubric");
  });
});

describe("copy serializer — multiple choice & multi-select", () => {
  it("multiple choice emits the stem, options, and the single-key answer", () => {
    const html = itemToHtml(MC, "review");
    expect(html).toContain("Which sentence best shows the main idea?");
    expect(html).toContain("Bees work together.");
    expect(html).toContain("Answer &mdash; A");
    expect(html).toContain("✓");
    expect(itemToText(MC, "review")).toContain("Answer — A");
  });
  it("multi-select lists the correct set in the key", () => {
    const html = itemToHtml(MULTISELECT, "review");
    expect(html).toContain("Choose two sentences");
    expect(html).toContain("Answer &mdash; A, B");
    expect(itemToText(MULTISELECT, "review")).toContain("Answer — A, B");
  });
});

describe("copy serializer — plain text & multi-item", () => {
  it("plain text mirrors content, interleaves the distractor annotation, omits warnings", () => {
    const text = itemToText(EBSR, "review");
    expect(text).toContain("Answer key:");
    expect(text).toContain("A. Each design solved a limit of the last. ✓");
    expect(text).toContain("misreads-detail · p=0.8 — reverses the order");
    expect(text).not.toContain("do not overlap"); // composition warnings omitted
  });
  it("itemsToHtml wraps items in a base-font container and joins them", () => {
    const html = itemsToHtml([EBSR, SHORTTEXT], "preview", "My Assessment");
    expect(html).toContain("font-family:Arial");
    expect(html).toContain("My Assessment");
    expect(html).toContain("Each design solved a limit of the last."); // question content
    expect(html).toContain("author's purpose");
    expect(html).toContain("The Story of Bridges"); // passage now leads the Questions copy
  });

  it("leads the Questions and Review copy with the reading passage, then the question(s)", () => {
    for (const mode of ["preview", "review"] as const) {
      const text = itemsToText([EBSR], mode);
      expect(text).toContain("The Story of Bridges"); // passage included
      expect(text).toContain("1 Logs spanned streams."); // numbered passage lines
      expect(text.indexOf("The Story of Bridges")).toBeLessThan(text.indexOf("Part A.")); // passage first
      const html = itemsToHtml([EBSR], mode);
      expect(html.indexOf("The Story of Bridges")).toBeLessThan(html.indexOf("Part A."));
    }
  });

  it("dedupes a shared passage to a single leading block", () => {
    const text = itemsToText([EBSR, EBSR], "preview"); // same passage twice
    expect((text.match(/The Story of Bridges/g) ?? []).length).toBe(1);
  });
});

describe("passage serializer — Copy passage", () => {
  it("serializes the deduped passage(s) as rich text, without any question content", () => {
    const html = passagesToHtml([EBSR, EBSR], "My Assessment"); // shared passage → collapsed to one
    expect(html).toContain("My Assessment");
    expect(html).toContain("The Story of Bridges");
    expect(html).toContain("Logs spanned streams.");
    expect((html.match(/The Story of Bridges/g) ?? []).length).toBe(1); // deduped
    expect(html).not.toContain("Part A"); // no question, no options, no answer key
    expect(html).not.toContain("Each design solved a limit");
  });
  it("plain text mirrors the passage with numbered lines", () => {
    const text = passagesToText([EBSR]);
    expect(text).toContain("The Story of Bridges");
    expect(text).toContain("1 Logs spanned streams.");
    expect(text).toContain("2 Then came stone arches.");
  });
});

describe("answers — the stem plus just the correct answer(s)", () => {
  it("EBSR yields both parts, with the Part B option quoted", () => {
    const rows = answerRows(EBSR);
    expect(rows.map((r) => r.label)).toEqual(["Part A", "Part B"]);
    expect(rows[0].values).toEqual(["A — Each design solved a limit of the last."]);
    expect(rows[1].values).toEqual(["B — “Then came stone arches.”"]);
  });
  it("hot text names its sentences (with the choose-N rule), word-select its word", () => {
    const ht = answerRows(HOTTEXT);
    expect(ht[1].values).toEqual(["1.1 — “A.”", "2.1 — “C.”"]);
    expect(ht[1].note).toBeUndefined(); // 2 valid, selectCount 2 → nothing to choose between
    expect(answerRows({ ...HOTTEXT, selectCount: 1 })[1].note).toBe("any 1 of these");
    expect(answerRows(WORDSELECT)[0].values).toEqual(["aqueducts"]);
  });
  it("multiple-choice and multi-select give the correct option(s)", () => {
    expect(answerRows(MC)[0].values).toEqual(["A — Bees work together."]);
    const ms = answerRows(MULTISELECT)[0];
    expect(ms.values).toEqual(["A — Workers gather nectar.", "B — The queen lays eggs."]);
    expect(ms.note).toBe("select all 2");
  });
  it("short text — a constructed response — gives a sample correct answer", () => {
    expect(answerRows(SHORTTEXT)).toEqual([
      { label: "Sample correct answer", values: ["The author shows that designs improve."], note: undefined },
    ]);
  });

  it("copies the stem and the correct answer, and nothing else", () => {
    const html = answersToHtml([EBSR], "My Assessment");
    expect(html).toContain("My Assessment");
    expect(html).toContain("EBSR"); // metadata header
    expect(html).toContain("Which inference about the designs is supported?"); // the stem
    expect(html).toContain("Each design solved a limit of the last."); // the correct option
    expect(html).not.toContain("Stone replaced steel."); // no distractors
    expect(html).not.toContain("misreads-detail"); // no distractor analysis
    expect(html).not.toContain("The Story of Bridges"); // no passage
  });
  it("plain text lists each part's answer under its label", () => {
    const text = answersToText([EBSR]);
    expect(text).toContain("Part A:");
    expect(text).toContain("  ✓ A — Each design solved a limit of the last.");
    expect(text).toContain("Part B:");
    expect(text).toContain("  ✓ B — “Then came stone arches.”");
  });
  it("numbers the sections in the Copy All answer key", () => {
    const text = answersToText([EBSR, MC], undefined, true, true);
    expect(text).toContain("Answers #1");
    expect(text).toContain("Answers #2");
  });
  it("says so when an item has no answer key", () => {
    expect(answersToText([{ type: "short-text", id: "x" }])).toContain("No answer key for this item.");
  });

  it("Questions mode still hides every answer; Rationale still marks and analyses them", () => {
    const preview = itemToText(EBSR, "preview");
    expect(preview).not.toContain("✓");
    expect(preview).not.toContain("Answer key");
    const review = itemToText(EBSR, "review");
    expect(review).toContain("A. Each design solved a limit of the last. ✓");
    expect(review).toContain("Answer key: Part A — A; Part B — B");
    expect(review).toContain("misreads-detail");
  });
  it("titles the copied section by the view it came from", () => {
    expect(itemsToText([EBSR], "review", undefined, true)).toContain("Rationale");
    expect(itemsToText([EBSR], "preview", undefined, true)).toContain("Question");
    expect(answersToText([EBSR], undefined, true)).toContain("Answers");
  });
});
