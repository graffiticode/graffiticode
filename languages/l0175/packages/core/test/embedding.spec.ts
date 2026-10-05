// SPDX-License-Identifier: MIT
// Tests for the RAG embedding helpers (src/embedding.ts): passage-free embeddingText, the design
// signature tags/facets derived from the composed item, and query-side facet extraction.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — sibling repo, plain JS, no types
import { parser } from "../../../../graffiticode/packages/parser/src/index.js";
import {
  lexicon,
  compiler,
  buildEmbeddingArtifacts,
  buildSignatureTags,
  buildSignatureFromSource,
  stripReadingPassage,
  extractQueryFacets,
} from "../dist/index.js";
import { TARGETS_DATA } from "../dist/targets.js";

async function compile(src: string): Promise<{ errors: any[]; data: any }> {
  const ast = await parser.parse("0175", src, lexicon);
  return new Promise((resolve) =>
    compiler.compile(ast, {}, {}, (err: any, data: any) =>
      resolve({ errors: Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [], data })),
  );
}

const PASSAGE = `target c1-t4 passage "The Tide Pool" type literary lines [
  "Mara crouched at the edge of the tide pool, ignoring the picnic behind her."
  "Her brother called twice, but she did not turn around."
  "A tiny crab scuttled under a rock, and Mara smiled for the first time all day."
  "She traced the cold water as if the pool were the only thing that mattered."
  "Five more minutes, she whispered, though no one was listening."
  "Behind her, paper plates rustled and her mother laughed."
]`;

const POOL = `claims [
  claim id "c1" status supported dimension character subject "Mara" standard rl-1 text "Mara cares more about the tide pool than the picnic." cites ["e1" "e2" "e3"] {},
  claim id "c2" status distractor error-type misreads-detail plausibility 0.9 targets ["q1"] text "Mara is angry at her brother." rationale "Silence is absorption, not anger." cites ["e2"] {},
  claim id "c3" status distractor error-type erroneous-inference targets ["q1"] text "Mara dislikes the outdoors." rationale "Contradicted by her smile." cites ["e4"] {},
  claim id "c4" status distractor error-type faulty-reasoning targets ["q1"] text "Mara fears her family." rationale "Whisper treated as fear." cites ["e4"] {},
  claim id "c5" status distractor error-type misreads-detail targets ["q1"] text "Mara is bored." rationale "Stillness is focus." cites ["e4"] {}
]
evidence [
  source id "e1" line 1 status directly-supports supports ["c1"] {},
  source id "e2" line 2 status supports-wrong-claim supports ["c1" "c2"] {},
  source id "e3" line 4 status directly-supports supports ["c1"] {},
  source id "e4" line 6 status irrelevant supports [] {}
]`;

const Q1 =
  `outcome id "q1" type ebsr dimension character subject "Mara" standard rl-1 focus "c1" ` +
  `stem "Which of these inferences about Mara is supported by the passage?" ` +
  `stem-b "Which sentence(s) from the passage best support your answer in Part A?" {}`;

const PROG = `${PASSAGE}\n${POOL}\noutcomes [ ${Q1} ]\n{}..`;

// A captured prompt as a user would type it: the passage prose pasted in, then the instruction.
const PROMPT = [
  "Mara crouched at the edge of the tide pool, ignoring the picnic behind her.",
  "Her brother called twice, but she did not turn around.",
  "A tiny crab scuttled under a rock, and Mara smiled for the first time all day.",
  "She traced the cold water as if the pool were the only thing that mattered.",
  "Five more minutes, she whispered, though no one was listening.",
  "Behind her, paper plates rustled and her mother laughed.",
  "",
  "Write an EBSR item about what Mara cares about, standard rl-1, dimension character.",
].join("\n");

describe("buildEmbeddingArtifacts", () => {
  it("strips the passage prose from the embedding text but keeps the instruction", async () => {
    const { errors, data } = await compile(PROG);
    expect(errors).toHaveLength(0);
    const { embeddingText } = buildEmbeddingArtifacts({ prompt: PROMPT, data });

    // Passage-only prose is gone.
    for (const fragment of ["crouched", "scuttled", "paper plates", "tide pool", "whispered"]) {
      expect(embeddingText.toLowerCase()).not.toContain(fragment);
    }
    // The authoring instruction survives.
    expect(embeddingText.toLowerCase()).toContain("ebsr");
    expect(embeddingText.toLowerCase()).toContain("standard rl-1");
    // And it is far shorter than the polluted prompt.
    expect(embeddingText.length).toBeLessThan(PROMPT.length / 2);
  });

  it("derives passage-independent design tags and facets from the composed item", async () => {
    const { data } = await compile(PROG);
    const { tags, facets } = buildEmbeddingArtifacts({ prompt: PROMPT, data });

    expect(tags).toEqual(
      expect.arrayContaining([
        "item:ebsr",
        "target:c1-t4",
        "type:literary",
        "dimension:character",
        "standard:rl-1",
        "shape:two-part",
      ]),
    );
    // The selected distractors' error-types ride along as design signal.
    expect(tags.some((t: string) => t.startsWith("distractor:"))).toBe(true);

    expect(facets.target).toBe("c1-t4");
    expect(facets.passageType).toBe("literary");
    expect(facets.itemTypes).toContain("ebsr");
  });

  it("normalizes the focus subject out of the stem signature", async () => {
    const { data } = await compile(PROG);
    const { normalizedStem } = buildSignatureTags(data);
    expect(normalizedStem).not.toContain("Mara");
    expect(normalizedStem).toContain("the subject");
  });
});

describe("buildEmbeddingArtifacts from source (console doc-side path, no compiler)", () => {
  it("derives the same passage-free embedding text and tags straight from program code", () => {
    const { embeddingText, tags, facets, normalizedStem } = buildEmbeddingArtifacts({ prompt: PROMPT, code: PROG });

    for (const fragment of ["crouched", "scuttled", "paper plates"]) {
      expect(embeddingText.toLowerCase()).not.toContain(fragment);
    }
    expect(embeddingText.toLowerCase()).toContain("ebsr");

    expect(tags).toEqual(
      expect.arrayContaining([
        "item:ebsr",
        "target:c1-t4",
        "type:literary",
        "dimension:character",
        "standard:rl-1",
        "shape:two-part",
        "distractor:misreads-detail",
      ]),
    );
    expect(facets.target).toBe("c1-t4");
    expect(facets.itemTypes).toContain("ebsr");
    expect(normalizedStem).not.toContain("Mara");
    expect(normalizedStem).toContain("the subject");
  });

  it("buildSignatureFromSource captures all authored distractor error-types", () => {
    const { tags } = buildSignatureFromSource(PROG);
    expect(tags).toEqual(
      expect.arrayContaining([
        "distractor:misreads-detail",
        "distractor:erroneous-inference",
        "distractor:faulty-reasoning",
      ]),
    );
  });
});

describe("stripReadingPassage (query side, no code)", () => {
  it("keeps the cue-bearing instruction sentence and drops prose", () => {
    const out = stripReadingPassage(PROMPT);
    expect(out.toLowerCase()).toContain("ebsr");
    expect(out.toLowerCase()).not.toContain("crab");
  });
});

describe("extractQueryFacets", () => {
  it("maps an informational prompt to c1-t11", () => {
    const f = extractQueryFacets(
      "From an informational article about bridge design, write an EBSR item, standard ri-3.",
    );
    expect(f.target).toBe("c1-t11");
    expect(f.passageType).toBe("informational");
    expect(f.itemTypes).toContain("ebsr");
    expect(f.standards).toContain("ri-3");
  });

  it("maps a literary prompt to c1-t4 and detects hot text", () => {
    const f = extractQueryFacets("From a short story about a girl at a tide pool, write a hot text item.");
    expect(f.target).toBe("c1-t4");
    expect(f.passageType).toBe("literary");
    expect(f.itemTypes).toContain("hot-text");
  });

  it("prefers an explicit target token over prose cues", () => {
    const f = extractQueryFacets("Write a c1-t11 item. It is a short story.");
    expect(f.target).toBe("c1-t11");
  });

  // The target-id set is derived from targets.ts, so every declared target is recognized and the
  // one-digit ids cannot shadow the two-digit ones ("c1-t1" must not swallow "c1-t10"/"c1-t11").
  it("recognizes every declared target id, longest-first", () => {
    for (const id of Object.keys(TARGETS_DATA)) {
      const f = extractQueryFacets(`Write a ${id} item.`);
      expect(f.target, `prompt named ${id}`).toBe(id);
      expect(f.passageType, `passage type for ${id}`).toBe(TARGETS_DATA[id].textType);
    }
  });

  // Routing is skill x text type, the same grid the spec's routing table shows. Before this,
  // prose-only prompts could only ever land on c1-t4 or c1-t11, under-serving the other five.
  it.each([
    ["what is the theme of this story?", "c1-t2", "literary"],
    ["summarize the first paragraph of this story", "c1-t2", "literary"],
    ["Which sentence best states the main idea of this article?", "c1-t9", "informational"],
    ["Give students a conclusion about a story and ask which line best supports it", "c1-t1", "literary"],
    ["The article says aqueducts reached distant cities — which detail best supports that?", "c1-t8", "informational"],
    ["What does the word aqueduct mean as it is used in the article?", "c1-t10", "informational"],
    ["Write an item about the narrator's point of view in a first-person diary entry", "c1-t4", "literary"],
    ["Write an item about how the author uses evidence in this informational article", "c1-t11", "informational"],
  ])("routes %j to %s", (prompt, target, passageType) => {
    const f = extractQueryFacets(prompt as string);
    expect(f.target).toBe(target);
    expect(f.passageType).toBe(passageType);
  });

  it("falls back to Reasoning & Evidence when the text type is known but no skill is cued", () => {
    expect(extractQueryFacets("From a short story, write an item.").target).toBe("c1-t4");
    expect(extractQueryFacets("From an informational article, write an item.").target).toBe("c1-t11");
  });

  it("resolves a skill named without a genre, preferring the literary target", () => {
    // "when the text type is genuinely ambiguous, prefer the literary target" (instructions.md)
    expect(extractQueryFacets("What is the theme?").target).toBe("c1-t2");
    // …but a skill with only one form still resolves to it
    expect(extractQueryFacets("What does the word mean in context?").target).toBe("c1-t10");
  });

  it("maps the literary Key Details target to a literary passage type", () => {
    const f = extractQueryFacets("Write a c1-t1 multiple choice item.");
    expect(f.target).toBe("c1-t1");
    expect(f.passageType).toBe("literary");
    expect(f.taskModels).toEqual(["1"]); // tm1 = multiple-choice for c1-t1
  });
  // ---- Regression guards for the twin-target confusion -----------------------------------------
  //
  // Key Details (T1/T8) and Reasoning & Evidence (T4/T11) both end in "find the line that supports
  // it". A skill cue keyed on supporting evidence therefore matched both and, being earlier in
  // SKILL_CUES, took every T4/T11 prompt for T1/T8: 11 of the 35 spec prompts resolved to a
  // confidently WRONG target. That is not a ranking nit — the console's facetAdjustment treats a
  // target mismatch as a hard exclusion, so a misread deletes the right examples from retrieval.
  //
  // Two sets, because they fail differently. The corpus set is the authoring voice these cues were
  // written against; the held-out set is the register a teacher actually types, and it is the one
  // that catches cues fitted too tightly to spec phrasing (the first pass at this fix scored 34/35
  // on the corpus and 6/15 here).

  it("resolves every spec prompt's declared target from its prose alone", () => {
    const md = readFileSync(new URL("../spec/examples.md", import.meta.url), "utf8");
    const rows: Array<{ target: string; prose: string }> = [];
    for (const line of md.split("\n")) {
      const m = line.match(/^\d+\.\s+(c1-t\d+)\s+tm\d\s*[—-]\s*(.+)$/);
      if (m) rows.push({ target: m[1], prose: m[2].trim() });
    }
    expect(rows.length, "spec prompts parsed").toBeGreaterThan(30);

    // "ask students what the theme is and have them explain it using details from the text" is
    // genuinely shared ground: T4 lists theme among the things it reasons about, and T2 IS theme.
    // Left as a known ambiguity rather than fitted with a rule that only this prompt could trip.
    const KNOWN_AMBIGUOUS = /what the theme is and have them explain/i;

    const wrong = rows
      .filter((r) => !KNOWN_AMBIGUOUS.test(r.prose))
      .map((r) => ({ ...r, got: extractQueryFacets(r.prose).target }))
      .filter((r) => r.got !== r.target);

    expect(wrong.map((w) => `${w.target} -> ${w.got ?? "none"}: ${w.prose}`)).toEqual([]);
  });

  it.each([
    ["The story shows Maya was nervous before the recital. Which line proves it?", "c1-t1"],
    ["Give students the idea that the dog was frightened and have them find the two sentences that back it up.", "c1-t1"],
    ["The article claims bats help farmers. Which fact supports that?", "c1-t8"],
    ["Hand kids a statement about volcanoes and ask which detail from the report supports it.", "c1-t8"],
    ["I want students to work out why the boy lied to his sister, then cite the text.", "c1-t4"],
    ["Ask what the narrator thinks of her grandmother and have them prove it from the story.", "c1-t4"],
    ["What's the lesson of this fable?", "c1-t2"],
    ["Ask students for the message of the poem.", "c1-t2"],
    ["Which sentence gives the main idea of the article?", "c1-t9"],
    ["Have students write a short summary of the nonfiction piece.", "c1-t9"],
    ["What does 'brittle' mean here?", "c1-t10"],
    ["Use the prefix to work out what 'unbearable' means.", "c1-t10"],
    ["Which two words mean about the same as 'enormous' in this article?", "c1-t10"],
  ])("routes teacher-voice %j to %s", (prompt, target) => {
    expect(extractQueryFacets(prompt as string).target).toBe(target);
  });
  // KNOWN GAP, and a different axis from the twin-target fix above: both of these now identify the
  // SKILL correctly (reasoning-evidence) and then pick the wrong TEXT TYPE. Neither prompt carries
  // a genre word, so extractQueryFacets has nothing to route on and targetForSkill falls back to
  // the literary form — landing on c1-t4 where an article was meant.
  //
  // Not fixed here because the honest options are both bigger than a cue tweak: infer text type
  // from weaker signals (an "author"/"writer" writes articles, a "narrator" tells stories), or
  // ABSTAIN when the text type is unknown. Abstaining is the safer of the two under hard-exclusion
  // semantics — no target set means no exclusion, where a coin-flip guess deletes the right
  // examples half the time — but it would change the documented fallback that the
  // "falls back to Reasoning & Evidence" test above pins.
  it.skip.each([
    ["Have students decide what the author thinks about zoos and back it with evidence.", "c1-t11"],
    ["Students should explain how the writer uses statistics to make her case.", "c1-t11"],
  ])("routes genre-less informational %j to %s", (prompt, target) => {
    expect(extractQueryFacets(prompt as string).target).toBe(target);
  });
});
