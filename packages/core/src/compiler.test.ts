// SPDX-License-Identifier: MIT
// Unit tests for the L0176 compiler. These assert the shape of the compiled
// Learnosity output directly.
import { describe, test, expect } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon, deprecatedWords } from "./index.js";

async function compile(src: string, data: any = {}, config: any = {}): Promise<any> {
  const code = await parser.parse(176, src, lexicon);
  return await new Promise((resolve, reject) => {
    compiler.compile(code, data, config, (err: any, val: any) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      if (errors.length > 0) reject(errors);
      else resolve(val);
    });
  });
}

describe("questions path", () => {
  test("mcq with defaults produces a Learnosity questions envelope", async () => {
    const out = await compile('set-var "lrn-id" "t" questions [mcq []] {}..');
    expect(out.type).toBe("questions");
    // The Questions API renders from inline question data keyed by response_id.
    // The item-bank record shape ({type, reference, data}) is built separately
    // for the Data API write — handed to the renderer it is rejected outright.
    const q = out.data.questions[0];
    expect(q.type).toBe("mcq");
    expect(q.response_id).toBe("artcompiler-mcq-t-0");
    expect(q.options).toHaveLength(4);
  });

  test("mcq options are the {label, value} objects Learnosity documents", async () => {
    // The builder used to invent `value` from the array index. It is what a
    // response records, so it is the author's to choose.
    const out = await compile(`set-var "lrn-id" "t" questions [
      mcq [
        stimulus "Which has the smallest wavelength?"
        options [[label "Red" value "red"] [label "Violet" value "violet"]]
        validation [valid-response [score 1 value ["violet"]]]
      ]] {}..`);
    const d = out.data.questions[0];
    expect(d.options).toEqual([
      { label: "Red", value: "red" },
      { label: "Violet", value: "violet" },
    ]);
    // scoring_type comes from mcq's default and survives an authored validation:
    // `withDefaults` merges one level deep precisely so that it does. A flat
    // spread dropped it, and a question with no scoring_type cannot be scored —
    // `getScore()` returns null, so `instant-feedback` draws a Check Answer
    // button that does nothing.
    expect(d.validation).toEqual({
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: ["violet"] },
    });
  });

  test("scoring-type replaces the partial-credit boolean", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [
      mcq [
        options [[label "a" value "0"] [label "b" value "1"]]
        multiple-responses true
        validation [scoring-type "partialMatch" valid-response [score 1 value ["0", "1"]]]
      ]] {}..`);
    expect(out.data.questions[0].validation.scoring_type).toBe("partialMatch");
  });

  test("partial-credit is gone from the language, not merely from a type", async () => {
    expect(lexicon["partial-credit"]).toBeUndefined();
    expect(lexicon["alternative-response"]).toBeUndefined();
    expect(lexicon["max-word-count"]).toBeUndefined();
  });

  test("token-highlight takes its own lrn_token markup and span indices", async () => {
    // markTokens used to wrap the spans and compute the indices from a plain
    // passage plus token strings. The author writes both now.
    const out = await compile(`set-var "lrn-id" "t" questions [
      token-highlight [
        stimulus "Highlight the verbs."
        template "The <span class=\\"lrn_token\\">cat</span> <span class=\\"lrn_token\\">runs</span>."
        tokenization "custom"
        validation [valid-response [score 1 value [1]]]
      ]] {}..`);
    const d = out.data.questions[0];
    expect(d.type).toBe("tokenhighlight");
    expect(d.template).toContain('<span class="lrn_token">runs</span>');
    expect(d.validation.valid_response.value).toEqual([1]);
  });

  // `hot-text` was renamed to `token-highlight` and dropped from every public surface,
  // but sources saved under the old spelling must keep compiling identically.
  test("the deprecated hot-text alias still compiles as token-highlight", async () => {
    const out = await compile('set-var "lrn-id" "t" questions [hot-text [stimulus "x"]] {}..');
    expect(out.data.questions[0].type).toBe("tokenhighlight");
  });

  test("the deprecated alias is absent from the published lexicon", async () => {
    expect(lexicon["hot-text"]).toBeDefined(); // still lexes
    expect(deprecatedWords).toContain("hot-text"); // but is stripped from lexicon.json
  });
});

describe("clozeformula (the deepest nesting)", () => {
  // response_id is the render envelope's key for the question, not part of the
  // question object being transcribed — drop it so these compare the Learnosity
  // object itself.
  const q = async (src: string) => {
    const out = await compile(`set-var "lrn-id" "t" questions [${src}] {}..`);
    const { response_id: _id, ...question } = out.data.questions[0];
    return question;
  };

  test("valid_response.value is an array per blank of arrays of rule objects", async () => {
    // The builder used to take flat answer strings and build the rule objects,
    // taking the cartesian product across blanks to fill alt_responses. The
    // author writes the rules now.
    const d = await q(`clozeformula [
      template "{{response}} minutes = {{response}} hour"
      is-math true
      validation [
        scoring-type "exactMatch"
        valid-response [
          score 1
          value [ [[method "equivLiteral" value "60"]]
                  [[method "equivValue" value "1" options [decimal-places 2]]] ]
        ]
      ]
    ]`);
    expect(d.type).toBe("clozeformulaV2");
    expect(d.validation.valid_response).toEqual({
      score: 1,
      value: [
        [{ method: "equivLiteral", value: "60" }],
        [{ method: "equivValue", value: "1", options: { decimalPlaces: 2 } }],
      ],
    });
  });

  test("a rule may carry a method and no value", async () => {
    // isExpanded and friends are predicates on the response. The old builder
    // always emitted a `value`, so this shape was unwritable.
    const d = await q(`clozeformula [
      template "{{response}}"
      validation [valid-response [value [[[method "isExpanded"]]]]]
    ]`);
    expect(d.validation.valid_response.value).toEqual([[{ method: "isExpanded" }]]);
  });

  test("alternates are whole answer sets, one per entry", async () => {
    const d = await q(`clozeformula [
      template "{{response}}"
      validation [
        valid-response [value [[[method "equivLiteral" value "1/2"]]]]
        alt-responses [[value [[[method "equivLiteral" value "0.5"]]]]
                       [value [[[method "equivLiteral" value "2/4"]]]]]
      ]
    ]`);
    expect(d.validation.alt_responses).toEqual([
      { value: [[{ method: "equivLiteral", value: "0.5" }]] },
      { value: [[{ method: "equivLiteral", value: "2/4" }]] },
    ]);
  });

  test("nothing constrains the method or the options keys", async () => {
    // C1 and C2 are open: which methods exist, and which options they honour,
    // is not settled by the documentation. The compiler does not guess.
    const d = await q(`clozeformula [
      template "{{response}}"
      validation [valid-response [value [[[method "equivSyntax" value "x" options [ignore-order true]]]]]]
    ]`);
    expect(d.validation.valid_response.value[0][0]).toEqual({
      method: "equivSyntax", value: "x", options: { ignoreOrder: true },
    });
  });
});

describe("items path", () => {
  test("items renders inline questions under a questions envelope", async () => {
    const out = await compile('set-var "lrn-id" "item-1" items [item [questions [mcq []] {}]] {}..');
    expect(out.type).toBe("questions");
    expect(out.data.id).toBe("item-1");
    expect(out.data.questions[0].response_id).toBe("artcompiler-mcq-item-1-0-0");
    expect(out.data.questions[0].type).toBe("mcq");
  });
});

describe("error paths", () => {
  test("questions without lrn-id yields an empty record (no error)", async () => {
    const out = await compile('questions [mcq []] {}..');
    expect(out).toEqual({});
  });

  test("bowtie with wrong 2-1-2 counts errors", async () => {
    await expect(
      compile('set-var "lrn-id" "t" questions [bowtie [column-titles ["A", "C", "P"] possible-responses [["a1", "a2"], ["c1"], ["p1", "p2"]] valid-response [["a1"], ["c1"], ["p1"]]]] {}..'),
    ).rejects.toBeTruthy();
  });

  test("partial-credit on a single-response mcq errors", async () => {
    await expect(
      compile('set-var "lrn-id" "t" questions [mcq [valid-response [0] partial-credit true]] {}..'),
    ).rejects.toBeTruthy();
  });

  test("partial-credit on an all-or-nothing type errors", async () => {
    await expect(
      compile('set-var "lrn-id" "t" questions [shorttext [valid-response "a" partial-credit true]] {}..'),
    ).rejects.toBeTruthy();
  });

  test("save-to-itembank without a connection is skipped, not an error", async () => {
    const out = await compile('set-var "lrn-id" "t" questions [save-to-itembank true, mcq []] {}..');
    expect(out.data.itemBank).toMatchObject({ skipped: "no-connection", fn: "save-to-itembank" });
  });
});

// clozetext is the first question type converted to the aligned vocabulary:
// every attribute is named for the Learnosity field it emits, and the program
// nests the way the object nests. These tests pin that correspondence.
describe("clozetext (aligned vocabulary)", () => {
  const program = `set-var "lrn-id" "t" questions [
    clozetext [
      stimulus "Fill in the blanks."
      template "The {{response}} is the {{response}}."
      case-sensitive false
      max-length 20
      response-container [placeholder "type here" width "80px"]
      validation [
        scoring-type "partialMatch"
        valid-response [score 1 value ["cat", "mat"]]
        alt-responses [[score 1 value ["feline", "mat"]]
                       [value ["cat", "rug"]]]
      ]
    ]
  ] {}..`;

  test("the program transcribes to the Learnosity object", async () => {
    const out = await compile(program);
    const { response_id: _id, ...question } = out.data.questions[0];
    expect(question).toEqual({
      type: "clozetext",
      stimulus: "Fill in the blanks.",
      template: "The {{response}} is the {{response}}.",
      case_sensitive: false,
      max_length: 20,
      response_container: { placeholder: "type here", width: "80px" },
      validation: {
        scoring_type: "partialMatch",
        valid_response: { score: 1, value: ["cat", "mat"] },
        alt_responses: [
          { score: 1, value: ["feline", "mat"] },
          { value: ["cat", "rug"] },
        ],
      },
    });
  });

  test("stimulus is the prompt and template carries the blanks", async () => {
    // The pre-alignment builder wrote `stimulus` into `template` and emitted no
    // `stimulus` at all, so a cloze could not carry a prompt of its own.
    const d = (await compile(program)).data.questions[0];
    expect(d.stimulus).toBe("Fill in the blanks.");
    expect(d.template).toContain("{{response}}");
  });

  test("score and value merge into one object per member list", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [
      clozetext [template "A {{response}}."
        validation [valid-response [value ["x"] score 3]]]] {}..`);
    expect(out.data.questions[0].validation.valid_response).toEqual({
      value: ["x"], score: 3,
    });
  });

  test("a member list may omit score", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [
      clozetext [template "A {{response}}."
        validation [alt-responses [[value ["x"]]]]]] {}..`);
    expect(out.data.questions[0].validation.alt_responses).toEqual([{ value: ["x"] }]);
  });

  test("defaults produce a complete question in the aligned shape", async () => {
    const out = await compile('set-var "lrn-id" "t" questions [clozetext []] {}..');
    const { response_id: _id, ...question } = out.data.questions[0];
    expect(question).toEqual({
      type: "clozetext",
      template: "The {{response}} is the answer.",
      validation: {
        scoring_type: "exactMatch",
        valid_response: { score: 1, value: ["answer"] },
      },
    });
  });

  test("an attribute belonging to another type is rejected", async () => {
    // Before per-type validation this compiled and emitted the stray field.
    await expect(
      compile('set-var "lrn-id" "t" questions [clozetext [template "A {{response}}." options ["x"]]] {}..')
    ).rejects.toContainEqual(expect.objectContaining({
      message: expect.stringContaining("`options` is not an attribute of clozetext"),
    }));
  });

  test("the pre-alignment flat spelling is rejected", async () => {
    await expect(
      compile('set-var "lrn-id" "t" questions [clozetext [valid-response ["x"]]] {}..')
    ).rejects.toContainEqual(expect.objectContaining({
      message: expect.stringContaining("`valid-response` belongs inside `validation`"),
    }));
  });

  test("an unsupported scoring-type is rejected rather than silently ignored", async () => {
    // Learnosity falls back to exactMatch on an unrecognized value, which turns
    // a typo into a silently mis-scored question.
    await expect(
      compile('set-var "lrn-id" "t" questions [clozetext [template "A {{response}}." validation [scoring-type "partialMatchElement"]]] {}..')
    ).rejects.toContainEqual(expect.objectContaining({
      message: expect.stringContaining("use one of exactMatch, partialMatchV2, partialMatch"),
    }));
  });

  test("alt-responses rejects a bare list of answers", async () => {
    await expect(
      compile('set-var "lrn-id" "t" questions [clozetext [template "A {{response}}." validation [alt-responses ["x"]]]] {}..')
    ).rejects.toContainEqual(expect.objectContaining({
      message: expect.stringContaining("validation.alt-responses takes a list of member lists"),
    }));
  });

});

// The seven types whose builders did nothing but rename and lift. Each is now a
// transcription of the Learnosity object, so the test for each is that the
// program and the emitted JSON have the same shape.
describe("the mechanical types (aligned vocabulary)", () => {
  // response_id is the render envelope's key for the question, not part of the
  // question object being transcribed — drop it so these compare the Learnosity
  // object itself.
  const q = async (src: string) => {
    const out = await compile(`set-var "lrn-id" "t" questions [${src}] {}..`);
    const { response_id: _id, ...question } = out.data.questions[0];
    return question;
  };

  test("shorttext: valid_response.value is a bare string, not an array", async () => {
    expect(await q(`shorttext [
      stimulus "What is the capital of Ireland?"
      case-sensitive true
      validation [
        valid-response [value "Dublin"]
        alt-responses [[score 2 value "Baile Atha Cliath"]]
      ]
    ]`)).toEqual({
      type: "shorttext",
      stimulus: "What is the capital of Ireland?",
      case_sensitive: true,
      validation: {
        // From shorttext's default, kept by the one-level-deep merge.
        scoring_type: "exactMatch",
        valid_response: { value: "Dublin" },
        alt_responses: [{ score: 2, value: "Baile Atha Cliath" }],
      },
    });
  });

  test("longtext emits longtextV2, the current type for the bare slug's widget", async () => {
    const d = await q('longtext [stimulus "Write about your hobbies." max-length 400]');
    expect(d.type).toBe("longtextV2");
    expect(d.max_length).toBe(400);
  });

  test("plaintext carries its own clipboard controls", async () => {
    const d = await q('plaintext [stimulus "Write." show-copy true show-paste false]');
    expect(d).toMatchObject({ type: "plaintext", show_copy: true, show_paste: false });
  });

  test("orderlist reaches partialMatchPairwise, which no other type documents", async () => {
    const d = await q(`orderlist [
      stimulus "Order them."
      list ["a", "b", "c"]
      validation [scoring-type "partialMatchPairwise" valid-response [score 1 value [2, 0, 1]]]
    ]`);
    expect(d.validation).toEqual({
      scoring_type: "partialMatchPairwise",
      valid_response: { score: 1, value: [2, 0, 1] },
    });
  });

  test("clozeassociation carries a prompt and a passage as separate fields", async () => {
    const d = await q(`clozeassociation [
      stimulus "Drag each word into place."
      template "The {{response}} sat on the {{response}}."
      possible-responses ["cat", "mat", "hat"]
      validation [valid-response [value ["cat", "mat"]]]
    ]`);
    expect(d.stimulus).toBe("Drag each word into place.");
    expect(d.template).toContain("{{response}}");
    expect(d.possible_responses).toEqual(["cat", "mat", "hat"]);
  });

  test("clozedropdown takes one list of options per drop-down", async () => {
    const d = await q(`clozedropdown [
      template "The {{response}} sat on the {{response}}."
      possible-responses [["cat", "dog"], ["mat", "rug"]]
      validation [valid-response [value ["cat", "mat"]]]
    ]`);
    expect(d.possible_responses).toEqual([["cat", "dog"], ["mat", "rug"]]);
  });

  test("choicematrix uses Learnosity's stems and options, not rows and columns", async () => {
    const d = await q(`choicematrix [
      stimulus "True or false?"
      stems ["Sydney is the capital of Australia." "Darwin is in the NT."]
      options ["True", "False"]
      multiple-responses false
      validation [valid-response [score 1 value [[1], [0]]]]
    ]`);
    expect(d).toMatchObject({
      type: "choicematrix",
      stems: ["Sydney is the capital of Australia.", "Darwin is in the NT."],
      options: ["True", "False"],
    });
    expect(d.rows).toBeUndefined();
    expect(d.columns).toBeUndefined();
  });

  test("each rejects an attribute that belongs to another type", async () => {
    await expect(q('shorttext [stimulus "x" template "y"]'))
      .rejects.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("`template` is not an attribute of shorttext"),
      }));
    await expect(q('choicematrix [stimulus "x" list ["a"]]'))
      .rejects.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("`list` is not an attribute of choicematrix"),
      }));
  });

  test("an unsupported scoring-type is rejected per type", async () => {
    // partialMatchPairwise is orderlist's alone.
    await expect(q('clozedropdown [template "a {{response}}" validation [scoring-type "partialMatchPairwise"]]'))
      .rejects.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("use one of exactMatch, partialMatchV2, partialMatch"),
      }));
    // shorttext documents only one mode.
    await expect(q('shorttext [stimulus "x" validation [scoring-type "partialMatch"]]'))
      .rejects.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("use one of exactMatch"),
      }));
  });

  test("defaults still produce a complete question for each", async () => {
    for (const [kw, type] of [["shorttext", "shorttext"], ["longtext", "longtextV2"],
                              ["plaintext", "plaintext"], ["orderlist", "orderlist"],
                              ["clozeassociation", "clozeassociation"],
                              ["clozedropdown", "clozedropdown"], ["choicematrix", "choicematrix"]]) {
      const d = await q(`${kw} []`);
      expect(d.type, kw).toBe(type);
    }
  });
});

// metadata is a member at both question and item level, and the two levels do
// different things with it: a question emits the object as written, an item
// routes its members to several destinations in the item record.
describe("metadata", () => {
  test("question metadata emits the object Learnosity documents", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [
      clozetext [
        template "A {{response}}."
        metadata [
          acknowledgements "Source X"
          sample-answer "ans"
          distractor-rationale-response-level ["wrong for this reason", "and this"]
        ]
      ]] {}..`);
    // Until the members were folded into the member registry, the raw tagged
    // entries ([{kind, value}, ...]) reached the emitted JSON instead.
    expect(out.data.questions[0].metadata).toEqual({
      acknowledgements: "Source X",
      sample_answer: "ans",
      distractor_rationale_response_level: ["wrong for this reason", "and this"],
    });
  });

  test("a rationale list is no longer flattened into one numbered string", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [
      clozetext [template "A {{response}}." metadata [distractor-rationale "just the one"]]] {}..`);
    expect(out.data.questions[0].metadata.distractor_rationale).toBe("just the one");
  });

  test("item metadata routes to the item record's several fields", async () => {
    const { translateItemMetadata } = await import("./items.js");
    expect(translateItemMetadata({
      tags: { Difficulty: "medium", DOK: 2 },
      notes: "a note",
      description: "a description",
      source: "a source",
      difficulty_level: 3,
      acknowledgements: "thanks",
    })).toEqual({
      tags: { Difficulty: ["medium"], DOK: ["2"] },
      note: "a note",
      description: "a description",
      source: "a source",
      adaptive: { difficulty: 3 },
      metadata: { acknowledgements: "thanks" },
    });
  });
});

// `items` holds two kinds of thing: `item` entries, and members belonging to the
// program as a whole. Before this, `items.ts` opened with `const [item] = items`
// and every entry after the first was silently discarded.
describe("items", () => {
  const program = `set-var "lrn-id" "t" items [
    params [ { A1: "50" } { A1: "100" } ]
    item [ questions [ mcq [stimulus "Q1"] ] {} ]
    item [ questions [ shorttext [stimulus "Q2"], mcq [stimulus "Q3"] ] {} ]
  ] {v: 1}..`;

  test("every item's questions are rendered, not just the first item's", async () => {
    const out = await compile(program);
    expect(out.data.questions.map((q: any) => q.stimulus)).toEqual(["Q1", "Q2", "Q3"]);
  });

  test("references carry the item ordinal so they cannot collide", async () => {
    // Two items each opening with an mcq both produced `artcompiler-mcq-t-0`.
    const out = await compile(program);
    const ids = out.data.questions.map((q: any) => q.response_id);
    expect(ids).toEqual([
      "artcompiler-mcq-t-0-0",
      "artcompiler-shorttext-t-1-0",
      "artcompiler-mcq-t-1-1",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("params is declared once for the list, not per item", async () => {
    const out = await compile(program);
    expect(out.data.dynamic_content_data.cols).toEqual(["A1"]);
  });

  test("the continuation carries program metadata onto the envelope", async () => {
    const out = await compile(program);
    expect(out.v).toBe(1);
    expect(out.type).toBe("questions");
  });

  test("an item whose only member looks like a member still reads as an item", async () => {
    // `item [metadata [...]]` merges to a single-key {metadata: ...}. It is only
    // an items-level member if its key is one, which `metadata` is not.
    const out = await compile(`set-var "lrn-id" "t" items [
      item [ metadata [notes "n"] questions [ mcq [stimulus "Q"] ] {} ]
    ] {}..`);
    expect(out.data.questions).toHaveLength(1);
  });

  test("a list with no item is an error rather than an empty render", async () => {
    await expect(compile('set-var "lrn-id" "t" items [save-to-itembank false] {}..'))
      .rejects.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("no `item` entries"),
      }));
  });

  test("save-to-itembank never writes without a connection", async () => {
    const out = await compile('set-var "lrn-id" "t" items [save-to-itembank true, item [questions [mcq []] {}]] {}..');
    expect(out.data.itemBank).toMatchObject({ skipped: "no-connection", fn: "save-to-itembank" });
  });

  test("learnosity, features and layout are gone from the language", async () => {
    for (const word of ["learnosity", "features", "layout"]) {
      expect(lexicon[word], word).toBeUndefined();
    }
  });
});

// C1: Learnosity rejects an unknown method at render time and scores every
// response 0, which reads as a learner getting the question wrong rather than
// as a broken item. The compile error is the only place it is visible.
test("an unknown scoring method is rejected", async () => {
  await expect(compile(`set-var "lrn-id" "t" questions [clozeformula [
      stimulus "Solve."
      template "{{response}}"
      validation [valid-response [score 1 value [[[method "equivalent" value "1/2"]]]]]
    ]] {}..`)).rejects.toContainEqual(expect.objectContaining({
    message: expect.stringContaining('"equivalent" is not a scoring method'),
  }));
});

test("every documented scoring method is accepted", async () => {
  // One Author Guide article each; anything outside this set is rejected.
  for (const method of ["equivLiteral", "equivSymbolic", "equivValue", "equivSyntax",
    "stringMatch", "isSimplified", "isFactorised", "isExpanded", "isUnit", "isTrue"]) {
    await expect(compile(`set-var "lrn-id" "t" questions [clozeformula [
        stimulus "Solve."
        template "{{response}}"
        validation [valid-response [score 1 value [[[method "${method}" value "1/2"]]]]]
      ]] {}..`)).resolves.toBeTruthy();
  }
});

// The check has to reach alt-responses too — an author enumerating accepted
// expressions writes the method once per alternative, and a typo in the fourth
// one is exactly as fatal as a typo in the first.
test("the method check reaches alt-responses", async () => {
  await expect(compile(`set-var "lrn-id" "t" questions [clozeformula [
      stimulus "Solve."
      template "{{response}}"
      validation [
        valid-response [score 1 value [[[method "equivLiteral" value "1/2"]]]]
        alt-responses [[value [[[method "equivLiterally" value "0.5"]]]]]
      ]
    ]] {}..`)).rejects.toContainEqual(expect.objectContaining({
    message: expect.stringContaining('"equivLiterally" is not a scoring method'),
  }));
});

// C2: Learnosity ignores an unrecognised options key in silence — no error, no
// effect — so there is no authority for the compiler to check against. What
// guards options here is the lexicon: an unknown key has no keyword, so it
// cannot be written at all. `decimal-places` is the one that governs equivValue,
// and it must survive camelCased into the rule.
test("options keys reach the rule, since Learnosity validates none of them", async () => {
  const out = await compile(`set-var "lrn-id" "t" questions [clozeformula [
      stimulus "Solve."
      template "{{response}}"
      validation [valid-response [score 1 value
        [[[method "equivValue" value "1/2" options [decimal-places 2]]]]]]
    ]] {}..`);
  expect(out.data.questions[0].validation.valid_response.value)
    .toEqual([[{ method: "equivValue", value: "1/2", options: { decimalPlaces: 2 } }]]);
});

// instant-feedback needs an answer to check against, or Learnosity draws its
// Check Answer button and the button does nothing. Every scorable type supplies
// a default valid_response and `withDefaults` merges one level deep, so an
// authored validation can no longer strip it — the case that used to bite is
// covered by "an authored validation keeps the default scoring_type" above.
// The manually-scored types have no valid answer by construction and so do not
// accept the attribute at all.
test("instant-feedback is not an attribute of the manually-scored types", async () => {
  for (const type of ["longtext", "plaintext"]) {
    await expect(compile(`set-var "lrn-id" "t" questions [${type} [
        stimulus "Explain your reasoning."
        instant-feedback true
      ]] {}..`)).rejects.toContainEqual(expect.objectContaining({
      message: expect.stringContaining(`\`instant-feedback\` is not an attribute of ${type}`),
    }));
  }
});

test("instant-feedback with a valid-response compiles", async () => {
  const out = await compile(`set-var "lrn-id" "t" questions [mcq [
      stimulus "2 + 2 = ?"
      options [[label "3" value "0"] [label "4" value "1"]]
      instant-feedback true
      validation [scoring-type "exactMatch" valid-response [score 1 value ["1"]]]
    ]] {}..`);
  expect(out.data.questions[0].instant_feedback).toBe(true);
});

// The bug this guards: `withDefaults` used a flat spread, so an authored
// `validation` replaced the type's default wholesale and took `scoring_type`
// with it. Measured against a live render — a question with no scoring_type
// still renders and still draws the instant-feedback Check Answer button, but
// `getScore()` returns null and pressing the button does nothing.
test("an authored validation keeps the default scoring-type", async () => {
  const out = await compile(`set-var "lrn-id" "t" items [item [questions [mcq [
      stimulus "Which president served two non-consecutive terms?"
      options [[label "Theodore Roosevelt" value "0"] [label "Grover Cleveland" value "1"]]
      instant-feedback true
      validation [valid-response [score 1 value ["1"]]]
    ]] {}]] {}..`);
  expect(out.data.questions[0].validation).toEqual({
    scoring_type: "exactMatch",
    valid_response: { score: 1, value: ["1"] },
  });
});

// One level only. An authored valid-response replaces the default answer rather
// than merging into it — otherwise the default's `value` would survive beside
// the author's and the question would accept answers nobody wrote.
test("an authored valid-response replaces the default rather than merging", async () => {
  const out = await compile(`set-var "lrn-id" "t" questions [orderlist [
      list ["a" "b"]
      validation [valid-response [score 5 value [1 0]]]
    ]] {}..`);
  expect(out.data.questions[0].validation).toEqual({
    scoring_type: "exactMatch",
    valid_response: { score: 5, value: [1, 0] },
  });
});

// The same hazard for the other object-valued default.
test("an authored ui-style keeps the rest of the default", async () => {
  const out = await compile(`set-var "lrn-id" "t" questions [classification [
      ui-style [column-count 3]
    ]] {}..`);
  expect(out.data.questions[0].ui_style).toEqual({
    column_count: 3,
    column_titles: ["Category A", "Category B"],
  });
});

// The guarantee, stated once for every scorable type: an author who writes a
// validation without a scoring-type still gets one. Two layers supply it — the
// one-level-deep merge in `withDefaults` carries the type's own default through,
// and `applyScoring` backstops with exactMatch for a type that has none. A
// question with no scoring_type renders and scores nobody, so this must hold for
// all of them, not just the one that was reported.
test("every scorable type keeps a scoring-type when the author writes a bare validation", async () => {
  const cases: Record<string, string> = {
    mcq: 'options [[label "a" value "0"]] validation [valid-response [score 1 value ["0"]]]',
    shorttext: 'validation [valid-response [value "Dublin"]]',
    clozetext: 'template "{{response}}" validation [valid-response [score 1 value [["a"]]]]',
    clozeassociation: 'template "{{response}}" possible-responses [["a"]] validation [valid-response [score 1 value [["a"]]]]',
    clozedropdown: 'template "{{response}}" possible-responses [["a"]] validation [valid-response [score 1 value [["a"]]]]',
    clozeformula: 'template "{{response}}" validation [valid-response [score 1 value [[[method "equivLiteral" value "1"]]]]]',
    choicematrix: 'stems ["s"] options ["a"] validation [valid-response [score 1 value [[0]]]]',
    orderlist: 'list ["a" "b"] validation [valid-response [score 1 value [0 1]]]',
    classification: 'possible-responses ["a"] validation [valid-response [score 1 value [[0]]]]',
    bowtie: 'validation [valid-response [score 1 value [[0 1] [4] [7 8]]]]',
    "token-highlight": 'template "<span class=\\"lrn_token\\">a</span>" validation [valid-response [score 1 value [0]]]',
  };
  for (const [type, body] of Object.entries(cases)) {
    const out = await compile(
      `set-var "lrn-id" "t" questions [${type} [stimulus "s" ${body}]] {}..`);
    const validation = out.data.questions[0].validation;
    expect(validation.scoring_type, `${type} lost its scoring_type`).toBeDefined();
    expect(validation.valid_response, `${type} lost its valid_response`).toBeDefined();
  }
});

// The top-level `questions [...]` path used to emit the item-bank record shape
// ({type, reference, data}) as the render payload. Learnosity rejects that
// activity outright — "the question object at index 0 is missing the
// response_id attribute" — so nothing rendered at all. The bank record and the
// render payload are two different shapes and both are needed.
describe("top-level questions renders", () => {
  test("questions carry response_id and inline data, not a nested record", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [
      mcq [stimulus "Q1" options [[label "a" value "0"]]
           validation [valid-response [score 1 value ["0"]]]]
      shorttext [stimulus "Q2" validation [valid-response [value "x"]]]
    ] {}..`);
    expect(out.type).toBe("questions");
    const qs = out.data.questions;
    expect(qs.map((q: any) => q.response_id))
      .toEqual(["artcompiler-mcq-t-0", "artcompiler-shorttext-t-1"]);
    // The fields Learnosity reads must be inline, not behind `data`.
    expect(qs.map((q: any) => q.stimulus)).toEqual(["Q1", "Q2"]);
    expect(qs.every((q: any) => q.data === undefined)).toBe(true);
    expect(qs.every((q: any) => q.reference === undefined)).toBe(true);
  });

  test("response_ids are unique, since Learnosity keys the DOM by them", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [
      mcq [stimulus "A" options [[label "a" value "0"]]
           validation [valid-response [score 1 value ["0"]]]]
      mcq [stimulus "B" options [[label "b" value "0"]]
           validation [valid-response [score 1 value ["0"]]]]
    ] {}..`);
    const ids = out.data.questions.map((q: any) => q.response_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// The generator writes from spec/, and a stale example there is reproduced
// verbatim into generated items. The reported case put the whole equation in
// the stimulus with a bare `template "{{response}}"`: it compiled, signed and
// rendered, but rendered the question as a prompt with an unlabelled box
// stranded underneath instead of a blank inline after "x =".
describe("cloze blanks come from the template", () => {
  test("a blank in the stimulus is rejected, since nothing scans for it", async () => {
    await expect(compile(`set-var "lrn-id" "t" questions [clozetext [
        stimulus "The {{response}} is the powerhouse of the cell."
        validation [valid-response [score 1 value [["mitochondria"]]]]
      ]] {}..`)).rejects.toContainEqual(expect.objectContaining({
      message: expect.stringContaining("only `template` is scanned for blanks"),
    }));
  });

  test("a template with no blank is rejected, since nothing renders", async () => {
    await expect(compile(`set-var "lrn-id" "t" questions [clozeformula [
        stimulus "Solve for x."
        template "no blank here"
        validation [valid-response [score 1 value [[[method "equivLiteral" value "4"]]]]]
      ]] {}..`)).rejects.toContainEqual(expect.objectContaining({
      message: expect.stringContaining("renders with no blank"),
    }));
  });

  test("prompt in the stimulus and formula in the template compiles", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [clozeformula [
        stimulus "Solve for \\\\(x\\\\)."
        template "\\\\(x + 3 = 7\\\\). \\\\(x =\\\\) {{response}}"
        is-math true
        validation [valid-response [score 1 value [[[method "equivLiteral" value "4"]]]]]
      ]] {}..`);
    const q = out.data.questions[0];
    expect(q.template).toContain("{{response}}");
    expect(q.stimulus).not.toContain("{{response}}");
  });
});

// The corruption the docs were teaching: a stimulus that trails off into an
// operator because the expression the learner completes was written there
// instead of in the template. It compiles and renders — the blank just lands on
// its own line below the prompt rather than after the "=".
describe("a cloze stimulus must be a complete prompt", () => {
  const cloze = (stimulus: string, template = "{{response}}") =>
    compile(`set-var "lrn-id" "t" questions [clozeformula [
      stimulus ${JSON.stringify(stimulus)}
      template ${JSON.stringify(template)}
      is-math true
      validation [valid-response [score 1 value [[[method "equivLiteral" value "4"]]]]]
    ]] {}..`);

  test("a stimulus ending mid-expression is rejected", async () => {
    for (const s of [
      "Solve: \\(x + 3 = 7\\). \\(x =\\)",   // the reported case, verbatim
      "2 + 2 =",
      "The total is <b>x +</b>",             // the operator is behind markup
      "Compare \\(3\\) \\(\\lt\\)",          // a LaTeX relation, not an ASCII one
    ]) {
      await expect(cloze(s), s).rejects.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("ends mid-expression"),
      }));
    }
  });

  test("complete prompts are left alone", async () => {
    // Trailing punctuation and closing delimiters are stripped before judging,
    // so an equation that merely *appears* in a finished sentence is fine.
    for (const s of [
      "Given \\(x + 3 = 7\\), find x.",
      "Evaluate the expression:",
      "What is \\(2 + 2\\)?",
      "Solve for \\(x\\).",
    ]) {
      await expect(cloze(s), s).resolves.toBeTruthy();
    }
  });
});

// Math is encoded as LaTeX, always. Two ways that goes wrong silently: the
// wrong encoding reaches Learnosity as inert text, or a single-backslash LaTeX
// command is eaten by the string literal before it ever gets there.
describe("math is encoded as LaTeX", () => {
  const stim = (s: string) =>
    compile(`set-var "lrn-id" "t" questions [mcq [
      stimulus ${JSON.stringify(s)}
      options [[label "a" value "0"]] is-math true
      validation [valid-response [score 1 value ["0"]]]
    ]] {}..`);

  // Written as real source, one backslash, exactly as a generator would emit it.
  test("a single-backslash LaTeX command is rejected, not silently mangled", async () => {
    const cases: [string, string][] = [
      [String.raw`\(3 \times 4\)`, "\\t"],
      [String.raw`\(x \neq 4\)`, "\\n"],
      [String.raw`\(x \rightarrow 0\)`, "\\r"],
    ];
    for (const [src, ch] of cases) {
      await expect(
        compile(`set-var "lrn-id" "t" questions [clozetext [
          stimulus "Compute." template "${src} {{response}}"
          validation [valid-response [score 1 value [["a"]]]]
        ]] {}..`), src,
      ).rejects.toContainEqual(expect.objectContaining({
        message: expect.stringContaining(`contains a raw "${ch}"`),
      }));
    }
  });

  test("doubled backslashes reach Learnosity as LaTeX", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [clozetext [
      stimulus "Compute." template "${String.raw`\\(3 \\times 4\\)`} {{response}}"
      validation [valid-response [score 1 value [["a"]]]]
    ]] {}..`);
    // One backslash on the wire is what MathJax needs.
    expect(out.data.questions[0].template).toBe(String.raw`\(3 \times 4\) {{response}}`);
  });

  test("MathML is rejected", async () => {
    await expect(stim("<math><mi>x</mi></math>")).rejects.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("contains MathML") }));
  });

  test("Unicode math characters are rejected, with the LaTeX to use", async () => {
    for (const [ch, latex] of [["×", "times"], ["≤", "le"], ["√", "sqrt"], ["²", "^2"]]) {
      await expect(stim(`3 ${ch} 4`), ch).rejects.toContainEqual(expect.objectContaining({
        message: expect.stringContaining(latex),
      }));
    }
  });

  test("currency and ordinary prose are left alone", async () => {
    for (const s of ["Cost is $5 and £3", "Which president served two terms?", "50% of 20"]) {
      await expect(stim(s), s).resolves.toBeTruthy();
    }
  });
});

// equivSyntax checks the FORM of a response, not its value, so it carries no
// `value` at all — the rule goes in `options.syntax`. Verified against
// Learnosity's own truth table by rendering: \scientific accepts "2\times10^3"
// and rejects "10\times10^2"; \decimal3 accepts "1.234" and rejects "1.2"; and
// ignoreText lets "1.23\text{ cm}" still count as a decimal.
describe("equivSyntax", () => {
  test("the rule and ignore-text reach options, with no value emitted", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [clozeformula [
      stimulus "Give the mass of the Sun in scientific notation."
      template "{{response}} kg"
      validation [valid-response [score 1 value
        [[[method "equivSyntax" options [syntax "\\\\scientific" ignore-text true]]]]]]
    ]] {}..`);
    expect(out.data.questions[0].validation.valid_response.value).toEqual([
      [{ method: "equivSyntax", options: { syntax: "\\scientific", ignoreText: true } }],
    ]);
  });

  test("a rule may carry its argument", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [clozeformula [
      stimulus "Round to three decimal places."
      template "{{response}}"
      validation [valid-response [score 1 value
        [[[method "equivSyntax" options [syntax "\\\\decimal3"]]]]]]
    ]] {}..`);
    expect(out.data.questions[0].validation.valid_response.value[0][0].options)
      .toEqual({ syntax: "\\decimal3" });
  });

  // Learnosity documents equivSyntax as a *supporting* method: being purely
  // syntactic it accepts any response of the right form, right or wrong, so a
  // question that must check both pairs it with a value-comparing rule.
  test("it pairs with a value-comparing rule in the same blank", async () => {
    const out = await compile(`set-var "lrn-id" "t" questions [clozeformula [
      stimulus "Give one half as a decimal."
      template "{{response}}"
      validation [valid-response [score 1 value
        [[[method "equivValue" value "0.5"]
          [method "equivSyntax" options [syntax "\\\\decimal"]]]]]]
    ]] {}..`);
    const rules = out.data.questions[0].validation.valid_response.value[0];
    expect(rules.map((r: any) => r.method)).toEqual(["equivValue", "equivSyntax"]);
  });
});

// An equivSyntax rule is a free string, so a generator that knows the method but
// not the vocabulary will invent one — and an unrecognised rule scores every
// response 0 without reporting anything, exactly like an unknown method.
describe("equivSyntax rules", () => {
  const withRule = (rule: string) =>
    compile(`set-var "lrn-id" "t" questions [clozeformula [
      stimulus "Give it." template "{{response}}"
      validation [valid-response [score 1 value
        [[[method "equivSyntax" options [syntax "${rule}"]]]]]]
    ]] {}..`);

  test("all nine documented rules are accepted, with or without an argument", async () => {
    for (const r of ["\\\\number", "\\\\integer", "\\\\decimal", "\\\\scientific",
      "\\\\variable", "\\\\fraction", "\\\\simpleFraction", "\\\\mixedFraction",
      "\\\\fractionOrDecimal", "\\\\decimal3", "\\\\decimal{3}", "\\\\integer 2"]) {
      await expect(withRule(r), r).resolves.toBeTruthy();
    }
  });

  test("an invented rule is rejected", async () => {
    for (const r of ["\\\\notARule", "decimal", "\\\\Decimal"]) {
      await expect(withRule(r), r).rejects.toContainEqual(expect.objectContaining({
        message: expect.stringContaining("is not an equivSyntax rule"),
      }));
    }
  });
});
