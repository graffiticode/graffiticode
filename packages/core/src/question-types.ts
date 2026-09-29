// SPDX-License-Identifier: MIT
// Ported from L0158 packages/api/src/question-types.js — pure logic, no compiler
// dependency. Objects that are mutated after construction are typed `any` so the
// non-strict TS build accepts the incremental field assignment.

// Default mock data per question type
const DEFAULTS: Record<string, any> = {
  mcq: {
    stimulus: "Which of the following is correct?",
    options: [
      { label: "Option A", value: "0" },
      { label: "Option B", value: "1" },
      { label: "Option C", value: "2" },
      { label: "Option D", value: "3" },
    ],
    validation: {
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: ["0"] },
    },
  },
  shorttext: {
    stimulus: "Type your answer below.",
    validation: {
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: "answer" },
    },
  },
  longtext: {
    stimulus: "Write a detailed response.",
    max_length: 500,
    placeholder: "Start writing here...",
  },
  plaintext: {
    stimulus: "Write your response in plain text.",
    max_length: 300,
    placeholder: "Start writing here...",
  },
  clozetext: {
    template: "The {{response}} is the answer.",
    validation: {
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: ["answer"] },
    },
  },
  clozeassociation: {
    template: "Drag the correct {{response}} here.",
    possible_responses: ["correct", "incorrect", "maybe"],
    validation: {
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: ["correct"] },
    },
  },
  clozedropdown: {
    template: "Select the correct {{response}}.",
    possible_responses: [["correct", "incorrect", "maybe"]],
    validation: {
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: ["correct"] },
    },
  },
  clozeformula: {
    template: "Solve: {{response}}",
    is_math: true,
    ui_style: { type: "block-on-focus-keyboard" },
    validation: {
      scoring_type: "exactMatch",
      valid_response: {
        score: 1,
        value: [[{ method: "equivLiteral", value: "x+1" }]],
      },
    },
  },
  choicematrix: {
    stimulus: "Select the correct answer for each row.",
    stems: ["Statement 1", "Statement 2"],
    options: ["True", "False"],
    validation: {
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: [[0], [1]] },
    },
  },
  orderlist: {
    stimulus: "Arrange the items in the correct order.",
    list: ["First", "Second", "Third", "Fourth"],
    validation: {
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: [0, 1, 2, 3] },
    },
  },
  classification: {
    stimulus: "Sort the items into the correct categories.",
    possible_responses: ["Item 1", "Item 2", "Item 3", "Item 4"],
    ui_style: { column_count: 2, column_titles: ["Category A", "Category B"] },
    validation: {
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: [[0, 2], [1, 3]] },
    },
  },
  bowtie: {
    stimulus: "Review the scenario and complete the diagram.",
    group_possible_responses: true,
    possible_response_groups: [
      { title: "Actions to Take", responses: ["Action A", "Action B", "Action C", "Action D"] },
      { title: "Condition Most Likely", responses: ["Condition X", "Condition Y", "Condition Z"] },
      { title: "Parameters to Monitor", responses: ["Parameter P", "Parameter Q", "Parameter R"] },
    ],
    ui_style: {
      column_titles: ["Actions to Take", "Condition Most Likely", "Parameters to Monitor"],
    },
    validation: {
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: [[0, 1], [4], [7, 8]] },
    },
  },
  tokenhighlight: {
    stimulus: "Highlight the verbs in the sentence.",
    template: 'The <span class="lrn_token">cat</span> <span class="lrn_token">runs</span> ' +
      'then <span class="lrn_token">jumps</span> <span class="lrn_token">high</span>.',
    tokenization: "custom",
    validation: {
      scoring_type: "exactMatch",
      valid_response: { score: 1, value: [1, 2] },
    },
  },
};

// Merged one level deep, which matters for the object-valued defaults —
// `validation` and `ui_style`. A flat spread makes an authored member *replace*
// the default wholesale, and the failure that causes is silent: a question
// written as
//
//   validation [ valid-response [score 1 value ["1"]] ]
//
// loses the default `scoring_type`, and Learnosity cannot score a question with
// no scoring type. It still renders, and `instant-feedback` still draws its
// Check Answer button — the button just does nothing, because `getScore()`
// returns null. Measured; see C2's neighbours in spec/conflict-resolution.md.
//
// One level only. An authored `valid-response` must still replace the default
// answer rather than merge into it, or the default's `value` would survive
// alongside the author's.
function withDefaults(type: string, attrs: any) {
  const defaults: any = DEFAULTS[type] || {};
  const merged: any = { ...defaults, ...attrs };
  for (const [key, base] of Object.entries(defaults)) {
    const given = attrs?.[key];
    if (isPlainRecord(base) && isPlainRecord(given)) {
      merged[key] = { ...(base as any), ...given };
    }
  }
  return merged;
}

function isPlainRecord(v: any) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// Learnosity scores a question either all-or-nothing (`exactMatch`) or awards a
// fraction of the score per correct response (`partialMatch`). `partial-credit`
// picks between them. The score stays 1 either way, so a partial-credit question
// awards a fraction of that single point per correct response rather than
// changing the question's total worth.
//
// Only types with more than one scorable response accept it — the rest are
// all-or-nothing by construction, and silently ignoring the attribute there
// would emit a question that scores differently than the author asked for.
// Reject attributes the question type does not take. Learnosity ignores unknown
// fields silently, so without this an attribute belonging to another type — or a
// typo — reaches the item bank and the question simply behaves unexpectedly.
// Only types listed in `validAttributes` are enforced; the rest are unconverted.
function assertKnownAttributes(type: string, key: string, attrs: any) {
  const allowed = validAttributes[key];
  if (!allowed) {
    return;
  }
  const unknown = Object.keys(attrs).filter((k) => !allowed.includes(k));
  if (unknown.length === 0) {
    return;
  }
  const kebab = (s: string) => s.replace(/_/g, "-");
  // The commonest way to get here is scoring written at the top of the question
  // instead of inside `validation`, which is where every scored type keeps it.
  const misplaced = unknown.filter((k) => fieldsOfValidation().has(k));
  const hint = misplaced.length > 0
    ? ` ${misplaced.map(kebab).map((m) => `\`${m}\``).join(" and ")} ` +
      `${misplaced.length === 1 ? "belongs" : "belong"} inside \`validation\`, ` +
      `e.g. validation [valid-response [score 1 value "x"]].`
    : "";
  throw new Error(
    `${type}: ${unknown.map((u) => `\`${kebab(u)}\``).join(", ")} ` +
      `${unknown.length === 1 ? "is not an attribute" : "are not attributes"} of ${type}. ` +
      `It takes: ${allowed.map(kebab).join(", ")}.${hint}`,
  );
}

// Fields whose value is an object, or an array of objects, per memberFields.
// Derived rather than restated so the two cannot drift apart.
// The members that live inside `validation`, for the misplacement hint.
const VALIDATION_FIELDS = [
  "scoring_type", "valid_response", "alt_responses", "allow_negative_scores",
  "penalty", "min_score_if_attempted", "unscored", "automarkable", "max_score",
  "enable_fullwidth_scoring", "accent_sensitivity",
];
let validationFields: Set<string> | undefined;
function fieldsOfValidation() {
  if (!validationFields) validationFields = new Set(VALIDATION_FIELDS);
  return validationFields;
}

// Computed on first use: memberFields is declared further down the file.
let shapeSets: { object: Set<string>; objectArray: Set<string> } | undefined;
function fieldsByShape() {
  if (!shapeSets) {
    const of = (s: string) =>
      new Set(Object.values(memberFields).filter((m) => m.shape === s).map((m) => m.field));
    shapeSets = { object: of("object"), objectArray: of("objectArray") };
  }
  return shapeSets;
}

const isPlainObject = (v: any) => v != null && typeof v === "object" && !Array.isArray(v);

function describe(v: any) {
  if (Array.isArray(v)) return `a list of ${v.length} value${v.length === 1 ? "" : "s"}`;
  if (v === null || v === undefined) return "nothing";
  return `a ${typeof v}`;
}

// Report a member written with the wrong shape, naming the question type and the
// path to it. Runs *after* assertKnownAttributes so that an attribute in the
// wrong place is reported as misplaced rather than as misshapen —
// `valid-response [0]` on an mcq is the former, and "expected a member list"
// would send the author to fix the wrong thing.
function assertMemberShapes(type: string, value: any, path: string) {
  if (!isPlainObject(value)) return;
  for (const [field, v] of Object.entries(value)) {
    const name = field.replace(/_/g, "-");
    const where = path ? `${path}.${name}` : name;
    if (fieldsByShape().object.has(field) && !isPlainObject(v)) {
      throw new Error(
        `${type}: ${where} takes a member list — ${name} [score 1 value "x"] — got ${describe(v)}.`,
      );
    }
    // An answer set's `value` is a string, number or array — never an object. A
    // record here is a member list nested one level too deep:
    // `valid-response [score 1 value [score 1 value "x"]]`.
    if (field === "valid_response" || field === "alt_responses") {
      const sets = Array.isArray(v) ? v : [v];
      sets.forEach((set: any, i: number) => {
        if (isPlainObject(set) && isPlainObject(set.value)) {
          const at = Array.isArray(v) ? `${where}[${i + 1}]` : where;
          throw new Error(
            `${type}: ${at}.value is a member list, but a value is a string, number or ` +
            `list — write ${name} [score 1 value "x"], not ${name} [score 1 value [score 1 value "x"]].`,
          );
        }
      });
    }
    if (fieldsByShape().objectArray.has(field)) {
      if (!Array.isArray(v) || !v.every(isPlainObject)) {
        throw new Error(
          `${type}: ${where} takes a list of member lists — ${name} [[score 1 value "x"]] — got ${describe(v)}.`,
        );
      }
      v.forEach((entry: any, i: number) => assertMemberShapes(type, entry, `${where}[${i + 1}]`));
      continue;
    }
    assertMemberShapes(type, v, where);
  }
}

// The scoring types a widget accepts, from its Learnosity article. Learnosity
// falls back to exactMatch on an unrecognized value rather than erroring, which
// turns a typo into a silently mis-scored question.
const SCORING_TYPES: Record<string, string[]> = {
  clozetext: ["exactMatch", "partialMatchV2", "partialMatch"],
  clozeassociation: ["exactMatch", "partialMatchV2", "partialMatch"],
  clozedropdown: ["exactMatch", "partialMatchV2", "partialMatch"],
  choicematrix: ["exactMatch", "partialMatchV2", "partialMatch"],
  // The only mode this widget documents.
  shorttext: ["exactMatch"],
  // Alone in offering pairwise comparison of adjacent entries.
  orderlist: ["exactMatch", "partialMatchV2", "partialMatch", "partialMatchPairwise"],
  mcq: ["exactMatch", "partialMatchV2", "partialMatch"],
  clozeformula: ["exactMatch", "partialMatchV2", "partialMatch"],
  tokenhighlight: ["exactMatch", "partialMatchV2", "partialMatch"],
  // Four modes, two of them per-element rather than per-cell.
  classification: ["exactMatch", "partialMatchV2", "partialMatch",
    "partialMatchElement", "partialMatchElementV2"],
  // Documented in prose only, and the widest set of any type.
  bowtie: ["exactMatch", "partialMatchV2", "partialMatch",
    "partialMatchElement", "partialMatchElementV2"],
  // longtext and plaintext are absent: neither documents scoring_type at all —
  // they are manually scored, and their validation carries max_score instead.
};

// Measured: Learnosity needs BOTH a `scoring_type` and a `valid_response` to
// score a question. With either missing it still renders — and `instant-feedback`
// still draws its Check Answer button — but `getScore()` returns null, nothing is
// marked correct or incorrect, and no error is reported at any layer. The
// question silently scores nobody.
//
// Learnosity's articles document `Default: "exactMatch"` for
// `validation.scoring_type`, but its scorer does not apply that default — a
// question sent without the key scores null, measured side by side against an
// otherwise identical question that carries it. The default is documentation
// only, so the key has to be on the wire. See C10 in
// spec/conflict-resolution.md.
//
// Hence defaulted here rather than demanded: an author who omits it means the
// ordinary thing, and every type's first supported mode is `exactMatch`.
// `valid_response` cannot be defaulted the same way — there is no sensible
// stand-in for the answer — so its absence is an error.
//
// Types absent from SCORING_TYPES (`longtext`, `plaintext`) are manually scored:
// they document no scoring_type and carry `max_score` instead, so they are
// exempt from all of this.
function applyScoring(type: string, merged: any) {
  const allowed = SCORING_TYPES[type];
  if (!allowed) {
    return;
  }
  const validation = merged.validation;
  if (validation == null || typeof validation !== "object" || Array.isArray(validation)) {
    throw new Error(
      `${type}: needs a \`validation\` to be scorable — without one Learnosity ` +
      `renders the question but scores every response as unattempted.`,
    );
  }
  const given = validation.scoring_type;
  if (given !== undefined && !allowed.includes(given)) {
    throw new Error(
      `${type}: scoring-type "${given}" is not supported — use one of ${allowed.join(", ")}.`,
    );
  }
  if (validation.valid_response == null) {
    throw new Error(
      `${type}: \`validation\` has no \`valid-response\`. There is nothing for ` +
      `Learnosity to score against, so every response is marked unattempted.`,
    );
  }
  if (given === undefined) {
    // A fresh object: `validation` may still be the shared DEFAULTS entry.
    merged.validation = { scoring_type: allowed[0], ...validation };
  }
}

// The scoring-method set: one article each in Learnosity's Author Guide — the
// "Legacy Scoring Articles" the question-type pages defer to for what a `method`
// means. Cached at ~/work/learnosity/scoring-methods-docs.
//
// The math engine's runtime error names six more (`validSyntax`, `simplify`,
// `expand`, `variables`, `format`, `calculate`). That is the math API's method
// list, which mixes scoring methods with engine actions, and C1 briefly mistook
// it for the enumeration. None of the six is a question scoring method, so none
// is accepted here.
const MATH_METHODS = new Set([
  "equivLiteral", "equivSymbolic", "equivValue", "equivSyntax", "stringMatch",
  "isSimplified", "isFactorised", "isExpanded", "isUnit", "isTrue",
]);

// A method Learnosity does not recognise is rejected at render time and scores
// every response 0. The item still renders, so nothing downstream looks broken —
// it reads as a learner getting the question wrong. Catching it here is the only
// place it is visible. (`options` cannot be checked the same way: an
// unrecognised key is accepted in silence, so there is no authority to check
// against — C2.)
// The nine forms `equivSyntax` compares against, each a LaTeX-style command,
// optionally carrying a digit count (`\\decimal3`). Learnosity's math engine
// recognises two undocumented synonyms as well (`\\mixedNumber`,
// `\\nonMixedNumber`); the Author Guide names these nine, and an author has no
// reason to reach past them.
//
// A rule that is not one of these does not error — it silently scores every
// response 0, the same failure mode as an unknown `method`, and the one the
// generator is most likely to hit because the form is a free string.
const SYNTAX_RULES = new Set([
  "\\number", "\\integer", "\\decimal", "\\scientific", "\\variable",
  "\\fraction", "\\simpleFraction", "\\mixedFraction", "\\fractionOrDecimal",
]);

function assertSyntaxRule(type: string, rule: any, path: string) {
  const syntax = rule?.options?.syntax;
  if (typeof syntax !== "string") return;
  // The argument is appended to the rule, so strip it before comparing.
  const bare = syntax.replace(/\s*\{?\s*\d+\s*\}?$/, "").trim();
  if (!SYNTAX_RULES.has(bare)) {
    throw new Error(
      `${type}: "${syntax}" is not an equivSyntax rule${path ? ` (at ${path})` : ""}. ` +
      `Learnosity accepts ${[...SYNTAX_RULES].join(", ")}, each optionally followed ` +
      `by a digit count — e.g. "\\\\decimal3". An unrecognised rule scores every ` +
      `response 0 without reporting anything.`,
    );
  }
}

function assertMethods(type: string, value: any, path: string) {
  if (Array.isArray(value)) {
    value.forEach((v, n) => assertMethods(type, v, `${path}[${n}]`));
    return;
  }
  if (value == null || typeof value !== "object") {
    return;
  }
  const given = value.method;
  if (typeof given === "string" && !MATH_METHODS.has(given)) {
    throw new Error(
      `${type}: "${given}" is not a scoring method${path ? ` (at ${path})` : ""}. ` +
      `Learnosity accepts ${[...MATH_METHODS].join(", ")}.`,
    );
  }
  assertSyntaxRule(type, value, path);
  for (const [k, v] of Object.entries(value)) {
    // `options` holds the method's own settings, not nested rules.
    if (k !== "options") assertMethods(type, v, path ? `${path}.${k}` : k);
  }
}

// A cloze blank is placed by the `template`; the `stimulus` is the prompt above
// it and is never scanned for `{{response}}`. Both mistakes below render without
// complaint from Learnosity, which is what makes them worth catching here.
const CLOZE_TYPES = new Set([
  "clozetext", "clozeformula", "clozedropdown", "clozeassociation",
]);

function assertClozeTemplate(type: string, attrs: any) {
  if (!CLOZE_TYPES.has(type)) return;
  const { stimulus, template } = attrs;
  if (typeof stimulus === "string" && stimulus.includes("{{response}}")) {
    throw new Error(
      `${type}: \`stimulus\` contains {{response}}, which does nothing — only ` +
      `\`template\` is scanned for blanks. Put the prompt in \`stimulus\` and the ` +
      `text the learner completes in \`template\`, e.g. ` +
      `stimulus "Complete the sentence." template "The {{response}} is ...".`,
    );
  }
  if (typeof template === "string" && !template.includes("{{response}}")) {
    throw new Error(
      `${type}: \`template\` contains no {{response}}, so the question renders ` +
      `with no blank for the learner to fill in. Each {{response}} in the ` +
      `template becomes one blank, at that position.`,
    );
  }
  if (typeof stimulus === "string") {
    const tail = strippedTail(stimulus);
    if (tail && DANGLING_TAIL.test(tail)) {
      const shown = tail.length > 24 ? `…${tail.slice(-24)}` : tail;
      throw new Error(
        `${type}: \`stimulus\` ends mid-expression, on "${shown}". A ` +
        `stimulus is a complete prompt — it is not continued by the blank, which ` +
        `renders from \`template\` and, on most types, on its own line. Move the ` +
        `expression the learner completes into \`template\` and put the blank where ` +
        `the answer goes, e.g. template "\\(x + 3 = 7\\). \\(x =\\) {{response}}".`,
      );
    }
  }
}

// Trailing noise that sits between the last meaningful character and the end of
// the string: whitespace, LaTeX/HTML closers, sentence punctuation. Stripped so
// that "\\(x =\\)" is judged on the `=` rather than on the delimiter.
const TRAILING_NOISE = /(?:\s+|\\[)\]]|\$+|[.,;:!?]|<\/?[^>]*>)+$/;

function strippedTail(s: string) {
  let out = s;
  let prev;
  do {
    prev = out;
    out = out.replace(TRAILING_NOISE, "");
  } while (out !== prev);
  return out;
}

// A relation or binary operator with nothing after it. Prose does not end this
// way; an expression waiting for its answer does.
const DANGLING_TAIL =
  /(?:[=+\-*/<>×÷±·]|\\(?:times|div|pm|cdot|approx|lt|gt|le|ge|ne|leq|geq|neq))$/;

// Math is encoded as LaTeX, always. Learnosity's question fields are HTML with
// MathJax configured for LaTeX delimiters, so MathML is not typeset at all, and
// literal Unicode math characters are inert text: they do not size or align with
// surrounding math and cannot be scored as an expression.
const UNICODE_MATH: Record<string, string> = {
  "×": "\\times", "÷": "\\div", "−": "-", "⋅": "\\cdot", "∙": "\\cdot",
  "≤": "\\le", "≥": "\\ge", "≠": "\\ne", "≈": "\\approx", "≡": "\\equiv",
  "±": "\\pm", "∓": "\\mp", "√": "\\sqrt{...}", "∞": "\\infty",
  "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∂": "\\partial",
  "∈": "\\in", "∉": "\\notin", "⊂": "\\subset", "∪": "\\cup", "∩": "\\cap",
  "→": "\\to", "⇒": "\\Rightarrow", "↔": "\\leftrightarrow",
  "½": "\\frac{1}{2}", "¼": "\\frac{1}{4}", "¾": "\\frac{3}{4}",
  "²": "^2", "³": "^3", "⁴": "^4", "π": "\\pi", "θ": "\\theta",
  "α": "\\alpha", "β": "\\beta", "Δ": "\\Delta", "Σ": "\\Sigma", "Ω": "\\Omega",
};

// Fields whose content is rendered as HTML and may carry notation.
const MATH_TEXT_FIELDS = ["stimulus", "template", "stimulus_review"];

// The string literal interprets \t, \n and \r, so a single backslash before a
// LaTeX command starting with t, n or r is eaten: "\times" arrives as a tab
// followed by "imes". Nothing downstream reports it — the question compiles,
// signs and renders with the math quietly broken — so the control character it
// leaves behind is the only evidence, and it is a reliable one: none of these
// characters has any business in a Learnosity HTML field.
const MANGLED_ESCAPE: Record<string, string> = {
  "\t": "\\t (e.g. \\times, \\theta, \\text)",
  "\n": "\\n (e.g. \\ne, \\neq, \\nu)",
  "\r": "\\r (e.g. \\rightarrow, \\rho, \\right)",
};

function assertMathEncoding(type: string, attrs: any) {
  for (const field of MATH_TEXT_FIELDS) {
    const value = attrs[field];
    if (typeof value !== "string") continue;
    const where = field.replace(/_/g, "-");

    for (const [ch, hint] of Object.entries(MANGLED_ESCAPE)) {
      if (!value.includes(ch)) continue;
      throw new Error(
        `${type}: \`${where}\` contains a raw ${JSON.stringify(ch)}, which is what ` +
        `a single-backslash LaTeX command turns into — the string literal reads ` +
        `${hint} as an escape and eats the backslash. Write every backslash ` +
        `doubled: "\\\\times", "\\\\(", "\\\\frac{1}{2}".`,
      );
    }

    if (/<\s*math[\s>/]/i.test(value)) {
      throw new Error(
        `${type}: \`${where}\` contains MathML, which Learnosity does not typeset — ` +
        `its fields are HTML with MathJax configured for LaTeX. Write the ` +
        `expression as LaTeX between \\\\( and \\\\) instead.`,
      );
    }

    for (const ch of value) {
      const latex = UNICODE_MATH[ch];
      if (latex) {
        throw new Error(
          `${type}: \`${where}\` contains the Unicode math character "${ch}", which ` +
          `renders as inert text — it is not typeset, does not align with ` +
          `surrounding math, and cannot be scored as an expression. Write it as ` +
          `LaTeX between \\\\( and \\\\): "${latex}".`,
        );
      }
    }
  }
}

// Learnosity's options are {label, value} objects. `value` is what a response
// records, so it is the author's to choose — the array index as a string is
// only what the authoring tools happen to generate.
export function buildMcq(attrs: any) {
  const merged = withDefaults("mcq", attrs);
  assertKnownAttributes("mcq", "MCQ", merged);
  assertMemberShapes("mcq", merged, "");
  assertMathEncoding("mcq", merged);
  applyScoring("mcq", merged);
  return {
    ...merged,
    type: "mcq",
  };
}

export function buildShorttext(attrs: any) {
  const merged = withDefaults("shorttext", attrs);
  assertKnownAttributes("shorttext", "SHORTTEXT", merged);
  assertMemberShapes("shorttext", merged, "");
  assertMathEncoding("shorttext", merged);
  applyScoring("shorttext", merged);
  return {
    ...merged,
    type: "shorttext",
  };
}

// The bare `longtext` slug is Learnosity's deprecated type; the current one is
// longtextV2, which is what the keyword emits.
export function buildLongtext(attrs: any) {
  const merged = withDefaults("longtext", attrs);
  assertKnownAttributes("longtext", "LONGTEXT", merged);
  assertMemberShapes("longtext", merged, "");
  assertMathEncoding("longtext", merged);
  applyScoring("longtext", merged);
  return {
    ...merged,
    type: "longtextV2",
  };
}

export function buildPlaintext(attrs: any) {
  const merged = withDefaults("plaintext", attrs);
  assertKnownAttributes("plaintext", "PLAINTEXT", merged);
  assertMemberShapes("plaintext", merged, "");
  assertMathEncoding("plaintext", merged);
  applyScoring("plaintext", merged);
  return {
    ...merged,
    type: "plaintext",
  };
}

export function buildClozetext(attrs: any) {
  const merged = withDefaults("clozetext", attrs);
  assertKnownAttributes("clozetext", "CLOZETEXT", merged);
  assertMemberShapes("clozetext", merged, "");
  assertMathEncoding("clozetext", merged);
  assertClozeTemplate("clozetext", merged);
  applyScoring("clozetext", merged);
  return {
    type: "clozetext",
    ...merged,
  };
}

// `stimulus` is the prompt and `template` the passage carrying the blanks —
// two fields, as Learnosity documents them.
export function buildClozeassociation(attrs: any) {
  const merged = withDefaults("clozeassociation", attrs);
  assertKnownAttributes("clozeassociation", "CLOZEASSOCIATION", merged);
  assertMemberShapes("clozeassociation", merged, "");
  assertMathEncoding("clozeassociation", merged);
  assertClozeTemplate("clozeassociation", merged);
  applyScoring("clozeassociation", merged);
  return {
    ...merged,
    type: "clozeassociation",
  };
}

// possible_responses is an array per drop-down, in order of appearance.
export function buildClozedropdown(attrs: any) {
  const merged = withDefaults("clozedropdown", attrs);
  assertKnownAttributes("clozedropdown", "CLOZEDROPDOWN", merged);
  assertMemberShapes("clozedropdown", merged, "");
  assertMathEncoding("clozedropdown", merged);
  assertClozeTemplate("clozedropdown", merged);
  applyScoring("clozedropdown", merged);
  return {
    ...merged,
    type: "clozedropdown",
  };
}

// The keyword is `clozeformula`, the emitted type `clozeformulaV2` — Learnosity's
// "Math". Its own `clozeformula` ("Cloze math") is an older, different type.
//
// validation.valid_response.value is an array per blank of arrays of rule
// objects, which is the deepest nesting in the language:
//
//   value [ [[method "equivLiteral" value "1/2"]]
//           [[method "equivValue" value "7" options [decimal-places 2]]] ]
//
// `method` is checked against Learnosity's own enumeration; `options` is not,
// because Learnosity ignores unrecognised keys without complaint and so offers
// nothing to check against. See C1 and C2 in spec/conflict-resolution.md.
export function buildClozeformula(attrs: any) {
  const merged = withDefaults("clozeformula", attrs);
  assertKnownAttributes("clozeformula", "CLOZEFORMULA", merged);
  assertMemberShapes("clozeformula", merged, "");
  assertMathEncoding("clozeformula", merged);
  assertClozeTemplate("clozeformula", merged);
  applyScoring("clozeformula", merged);
  assertMethods("clozeformula", merged.validation, "validation");
  return {
    ...merged,
    type: "clozeformulaV2",
  };
}

export function buildChoicematrix(attrs: any) {
  const merged = withDefaults("choicematrix", attrs);
  assertKnownAttributes("choicematrix", "CHOICEMATRIX", merged);
  assertMemberShapes("choicematrix", merged, "");
  assertMathEncoding("choicematrix", merged);
  applyScoring("choicematrix", merged);
  return {
    ...merged,
    type: "choicematrix",
  };
}

export function buildOrderlist(attrs: any) {
  const merged = withDefaults("orderlist", attrs);
  assertKnownAttributes("orderlist", "ORDERLIST", merged);
  assertMemberShapes("orderlist", merged, "");
  assertMathEncoding("orderlist", merged);
  applyScoring("orderlist", merged);
  return {
    ...merged,
    type: "orderlist",
  };
}

// The column and row layout lives in ui_style, where Learnosity puts it —
// column_count is written, not counted from a list of category names.
export function buildClassification(attrs: any) {
  const merged = withDefaults("classification", attrs);
  assertKnownAttributes("classification", "CLASSIFICATION", merged);
  assertMemberShapes("classification", merged, "");
  assertMathEncoding("classification", merged);
  applyScoring("classification", merged);
  return {
    ...merged,
    type: "classification",
  };
}

// valid_response.value is three arrays of indices into the flattened
// possible_response_groups. Nothing here checks them: see C8 in
// spec/conflict-resolution.md, where the docs' own example does not decode.
export function buildBowtie(attrs: any) {
  const merged = withDefaults("bowtie", attrs);
  assertKnownAttributes("bowtie", "BOWTIE", merged);
  assertMemberShapes("bowtie", merged, "");
  assertMathEncoding("bowtie", merged);
  applyScoring("bowtie", merged);
  return {
    ...merged,
    type: "bowtie",
  };
}

export function buildCustom(attrs: any) {
  const { lang, data, ...rest } = attrs || {};
  // The embedded language owns its own scoring, so there is nothing here to
  // reject any more: `partial-credit` no longer exists as a keyword.
  if (typeof lang !== "string" || lang.length === 0) {
    throw new Error('custom requires lang to be a non-empty string (e.g. lang "0179").');
  }
  const base = `https://l${lang}.graffiticode.org`;
  const out: any = {
    type: "custom",
    custom_type: `custom_question_l${lang}`,
    js: {
      question: `${base}/question.js`,
      scorer: `${base}/scorer.js`,
    },
    css: `${base}/question.css`,
    ...rest,
  };
  if (data !== undefined) {
    out.data = data;
  }
  return out;
}

// The template carries its own <span class="lrn_token"> markup and the valid
// response is span indices in document order, as Learnosity documents them.
export function buildTokenHighlight(attrs: any) {
  const merged = withDefaults("tokenhighlight", attrs);
  assertKnownAttributes("tokenhighlight", "TOKEN_HIGHLIGHT", merged);
  assertMemberShapes("tokenhighlight", merged, "");
  assertMathEncoding("tokenhighlight", merged);
  applyScoring("tokenhighlight", merged);
  return {
    ...merged,
    type: "tokenhighlight",
  };
}

// Registry mapping AST names to builders
export const questionTypeBuilders: Record<string, (attrs: any) => any> = {
  MCQ: buildMcq,
  SHORTTEXT: buildShorttext,
  LONGTEXT: buildLongtext,
  PLAINTEXT: buildPlaintext,
  CLOZETEXT: buildClozetext,
  CLOZEASSOCIATION: buildClozeassociation,
  CLOZEDROPDOWN: buildClozedropdown,
  CLOZEFORMULA: buildClozeformula,
  CHOICEMATRIX: buildChoicematrix,
  ORDERLIST: buildOrderlist,
  CLASSIFICATION: buildClassification,
  BOWTIE: buildBowtie,
  CUSTOM: buildCustom,
  TOKEN_HIGHLIGHT: buildTokenHighlight,
};

// Registry mapping AST names to attribute field names and expected types
// valueType: "string" | "number" | "boolean" | "array" | "any"
// Every attribute is an arity-1 member returning a single-key record, so a
// question, and every object inside it, is written as a member list. `shape`
// says how to read the member's argument:
//
//   (none)        the value as written — a scalar, or a list of scalars
//   "object"      a member list, merged into one object
//   "objectArray" a list of member lists, each merged
//   "infer"       the reading is decided by what is in the list, for the two
//                 words Learnosity gives different types on different question
//                 types. The three readings are mutually exclusive by element
//                 type, so there is nothing to guess:
//                   members            -> one object   (a rule's `options`)
//                   member lists       -> array        (mcq's `options`)
//                   lists of members   -> array[array] (clozeformula's `value`)
//                 anything else passes through unchanged.
//
// A member needs no builder involvement: the question-type transformer merges
// the list and the field lands by name.
export type MemberShape = "object" | "objectArray" | "infer";
export const memberFields: Record<string, { field: string; shape?: MemberShape }> = {
  // Question-level content
  STIMULUS: { field: "stimulus" },
  STIMULUS_REVIEW: { field: "stimulus_review" },
  INSTRUCTOR_STIMULUS: { field: "instructor_stimulus" },
  TEMPLATE: { field: "template" },
  IS_MATH: { field: "is_math" },
  OPTIONS: { field: "options", shape: "infer" },
  POSSIBLE_RESPONSES: { field: "possible_responses" },
  ORDER_LIST: { field: "list" },
  COLUMNS: { field: "columns" },
  COLUMN_TITLES: { field: "column_titles" },

  // Behaviour
  INSTANT_FEEDBACK: { field: "instant_feedback" },
  FEEDBACK_ATTEMPTS: { field: "feedback_attempts" },
  SHUFFLE_OPTIONS: { field: "shuffle_options" },
  MULTIPLE_RESPONSES: { field: "multiple_responses" },
  MAX_SELECTION: { field: "max_selection" },
  CASE_SENSITIVE: { field: "case_sensitive" },
  MAX_LENGTH: { field: "max_length" },
  PLACEHOLDER: { field: "placeholder" },
  MULTIPLE_LINE: { field: "multiple_line" },
  CHARACTER_MAP: { field: "character_map" },
  SPELLCHECK: { field: "spellcheck" },
  IGNORE_LEADING_AND_TRAILING_SPACES: { field: "ignore_leading_and_trailing_spaces" },
  MATCH_ALL_POSSIBLE_RESPONSES: { field: "match_all_possible_responses" },
  METHOD: { field: "method" },

  // Nested objects
  VALIDATION: { field: "validation", shape: "object" },
  SCORING_TYPE: { field: "scoring_type" },
  VALID_RESPONSE: { field: "valid_response", shape: "object" },
  ALT_RESPONSES: { field: "alt_responses", shape: "objectArray" },
  ALLOW_NEGATIVE_SCORES: { field: "allow_negative_scores" },
  PENALTY: { field: "penalty" },
  MIN_SCORE_IF_ATTEMPTED: { field: "min_score_if_attempted" },
  UNSCORED: { field: "unscored" },
  AUTOMARKABLE: { field: "automarkable" },
  ENABLE_FULLWIDTH_SCORING: { field: "enable_fullwidth_scoring" },
  ACCENT_SENSITIVITY: { field: "accent_sensitivity", shape: "object" },
  ENABLED: { field: "enabled" },
  ACCENT_PENALTY_POINTS: { field: "accent_penalty_points" },
  SCORE: { field: "score" },
  VALUE: { field: "value", shape: "infer" },

  UI_STYLE: { field: "ui_style", shape: "object" },
  FONTSIZE: { field: "fontsize" },
  VALIDATION_STEM_NUMERATION: { field: "validation_stem_numeration" },
  RESPONSE_CONTAINER: { field: "response_container", shape: "object" },
  RESPONSE_CONTAINERS: { field: "response_containers", shape: "objectArray" },
  HEIGHT: { field: "height" },
  WIDTH: { field: "width" },
  INPUT_TYPE: { field: "input_type" },
  ARIA_LABEL: { field: "aria_label" },

  // Seven mechanical types
  DISABLE_AUTO_LINK: { field: "disable_auto_link" },
  FORMATTING_OPTIONS: { field: "formatting_options" },
  HORIZONTAL_LAYOUT: { field: "horizontal_layout" },
  SHOW_WORD_COUNT: { field: "show_word_count" },
  SHOW_WORD_LIMIT: { field: "show_word_limit" },
  SUBMIT_OVER_LIMIT: { field: "submit_over_limit" },
  TEXT_BLOCKS: { field: "text_blocks" },
  SHOW_COPY: { field: "show_copy" },
  SHOW_CUT: { field: "show_cut" },
  SHOW_PASTE: { field: "show_paste" },
  DUPLICATE_RESPONSES: { field: "duplicate_responses" },
  GROUP_POSSIBLE_RESPONSES: { field: "group_possible_responses" },
  STEMS: { field: "stems" },
  HORIZONTAL_LINES: { field: "horizontal_lines" },
  MAX_HEIGHT: { field: "max_height" },
  MIN_HEIGHT: { field: "min_height" },
  OPTION_ROW_TITLE: { field: "option_row_title" },
  OPTION_WIDTH: { field: "option_width" },
  POSSIBILITY_LIST_POSITION: { field: "possibility_list_position" },
  SHOW_DRAG_HANDLE: { field: "show_drag_handle" },
  STEM_TITLE: { field: "stem_title" },
  STEM_WIDTH: { field: "stem_width" },
  TYPE: { field: "type" },
  WORDWRAP: { field: "wordwrap" },
  MATCHING_RULE: { field: "matching_rule" },
  MAX_SCORE: { field: "max_score" },
  SCORE_WITH_FEEDBACKAIDE: { field: "score_with_feedbackaide" },
  FEEDBACKAIDE_PASSAGES: { field: "feedbackaide_passages" },

  // mcq, classification, bowtie, token-highlight
  LABEL: { field: "label" },
  ASSISTIVE_LABEL: { field: "assistive_label", shape: "object" },
  EXPOSED_VISIBLE_LABEL: { field: "exposed_visible_label" },
  RESPONSES: { field: "responses" },
  TITLE: { field: "title" },
  MIN_SELECTION: { field: "min_selection" },
  MAX_RESPONSE_PER_CELL: { field: "max_response_per_cell" },
  POSSIBLE_RESPONSE_GROUPS: { field: "possible_response_groups", shape: "objectArray" },
  TOKENIZATION: { field: "tokenization" },
  CHOICE_LABEL: { field: "choice_label" },
  COLUMN_COUNT: { field: "column_count" },
  ORIENTATION: { field: "orientation" },
  ROW_COUNT: { field: "row_count" },
  ROW_HEADER: { field: "row_header" },
  ROW_MIN_HEIGHT: { field: "row_min_height" },
  ROW_TITLES: { field: "row_titles" },
  ROW_TITLES_WIDTH: { field: "row_titles_width" },

  // clozeformula
  HANDWRITING_RECOGNISES: { field: "handwriting_recognises" },
  HINTS: { field: "hints", shape: "object" },
  IS_DYNAMIC_CONTENT: { field: "is_dynamic_content" },
  MATH_IMAGE_CAPTURE: { field: "math_image_capture" },
  ITEMS_LIST: { field: "items", shape: "objectArray" },
  CONTENT: { field: "content" },
  KEYBOARD_BELOW_RESPONSE_AREA: { field: "keyboard_below_response_area" },
  MIN_WIDTH: { field: "min_width" },
  RESPONSE_FONT_SCALE: { field: "response_font_scale" },
  SHOW_HINTS_BUTTON: { field: "show_hints_button" },

  // Scoring-rule options (camelCase in Learnosity)
  SYNTAX: { field: "syntax" },
  IGNORE_TEXT: { field: "ignoreText" },
  ALLOW_DECIMAL: { field: "allowDecimal" },
  COMPARE_SIDES: { field: "compareSides" },
  TREAT_LETTERS_AS_VARIABLES: { field: "treatLettersAsVariables" },
  ALLOW_THOUSANDS_SEPARATOR: { field: "allowThousandsSeparator" },
  DECIMAL_PLACES: { field: "decimalPlaces" },
  SET_DECIMAL_SEPARATOR: { field: "setDecimalSeparator" },
  SET_THOUSANDS_SEPARATOR: { field: "setThousandsSeparator" },
  IGNORE_ORDER: { field: "ignoreOrder" },
  IGNORE_LEADING_TRAILING_RULE: { field: "ignoreLeadingAndTrailingSpaces" },
  TREAT_MULTIPLE_SPACES_AS_ONE: { field: "treatMultipleSpacesAsOne" },
  INVERSE_RESULT: { field: "inverseResult" },

  // metadata members. Ordinary members returning a single-key record, so
  // `metadata` merges them into the object Learnosity expects. At item level
  // translateItemMetadata routes them to their several destinations.
  TAGS: { field: "tags" },
  NOTES: { field: "notes" },
  DISTRACTOR_RATIONALE: { field: "distractor_rationale" },
  ACKNOWLEDGEMENTS: { field: "acknowledgements" },
  RESPONSE_SHUFFLE_SEED: { field: "response_shuffle_seed" },
  SAMPLE_ANSWER: { field: "sample_answer" },
  RUBRIC_REFERENCE: { field: "rubric_reference" },
  DISTRACTOR_RATIONALE_RESPONSE_LEVEL: { field: "distractor_rationale_response_level" },
  DESCRIPTION: { field: "description" },
  SOURCE: { field: "source" },
  DIFFICULTY_LEVEL: { field: "difficulty_level" },

  // Item level. `metadata` is a member at both question and item level, which is
  // why `item` takes a member list too — a word has one arity.
  METADATA: { field: "metadata", shape: "object" },
  // Items-level members: they sit in the `items` list beside the `item`
  // entries rather than on any one item. `params` is the activity's
  // dynamic-content table, and Learnosity attaches one per rendered activity.
  PARAMS: { field: "params" },
  // SAVE_TO_ITEMBANK is not a member: it is the item-bank write, defined on the
  // Transformer. The literal legacy member is lowered to it (save-lowering.ts).

  // custom
  LANG: { field: "lang" },
  MODEL: { field: "data" },
};

// True when every element is a single-key record — i.e. the list was written as
// members (`[score 1 value "x"]`) rather than as a bare list of values. Used
// only by inferShape, to tell the readings of `options` and `value` apart.
export function isMemberList(v: any) {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (e: any) =>
        e != null && typeof e === "object" && !Array.isArray(e) && Object.keys(e).length === 1,
    )
  );
}

// `options` and `value` are each one word for several Learnosity types — a rule's
// options object, mcq's array of {label, value}, clozeformula's array of arrays
// of rules, and plain arrays of strings or numbers. Which is meant is decided by
// element type, and the readings do not overlap, so nothing is guessed.
export function inferShape(raw: any, where: string): any {
  if (!Array.isArray(raw) || raw.length === 0) {
    return raw;
  }
  const isMember = (e: any) =>
    e != null && typeof e === "object" && !Array.isArray(e) && Object.keys(e).length === 1;
  if (raw.every(isMember)) {
    return mergeMembers(raw, where);                        // one object
  }
  if (raw.every(isMemberList)) {
    return raw.map((e: any, i: number) => mergeMembers(e, `${where}[${i + 1}]`));
  }
  if (raw.every((e: any) => Array.isArray(e) && e.length > 0 && e.every(isMemberList))) {
    return raw.map((outer: any, i: number) =>
      outer.map((e: any, j: number) => mergeMembers(e, `${where}[${i + 1}][${j + 1}]`)));
  }
  return raw;
}

// The `items` list holds items-level members alongside `item` entries. A member
// is a single-key record whose key is one of these; an item is anything else.
// `item [metadata [...]]` merges to `{metadata: ...}` and `metadata` is not in
// this set, so it reads as an item — the two readings cannot overlap.
const ITEMS_MEMBERS = new Set(["params", "save_to_itembank"]);

// `item` and `items` merge whatever members they are given, and `createItems`
// then reads only the handful it knows. Everything else used to vanish with no
// error — an attribute written one level too high (`item [instant-feedback true
// questions [...] {}]`) compiled clean, rendered clean, and simply did not do
// what it said. The question builders have enforced their own attribute sets
// since the conversion; the block levels did not, and this closes that gap.
//
// `questions [...] {}` contributes the whole `createQuestions` result when it
// merges into the item — `type`, `data`, `templateVariablesRecords` and
// `questionRefs` — so those are members of an item as much as `metadata` is.
const ITEM_MEMBERS = new Set([
  "type", "data", "templateVariablesRecords", "questionRefs", "metadata",
]);

function kebab(field: string) {
  return field.replace(/_/g, "-");
}

export function assertItemMembers(merged: any) {
  if (merged == null || typeof merged !== "object") return;
  const stray = Object.keys(merged).filter((k) => !ITEM_MEMBERS.has(k));
  if (stray.length === 0) return;
  const names = stray.map((k) => `\`${kebab(k)}\``).join(", ");
  throw new Error(
    `item: ${names} ${stray.length === 1 ? "is not a member" : "are not members"} of ` +
    `\`item\`. An item takes \`questions [...] {}\` and \`metadata\`. Question ` +
    `attributes belong inside the question type — e.g. ` +
    `\`questions [mcq [${kebab(stray[0])} ...]] {}\`, not on the item.`,
  );
}

// The same hazard one level further out. `partitionItemsList` treats anything
// that is not a known items-level member as an item, so a stray attribute became
// an "item" with no questions and crashed `createItems` with a bare TypeError
// about reading 'questions' of undefined.
export function assertItemsEntries(items: any[]) {
  const stray = items.filter((e) => e == null || typeof e !== "object" || e.data == null);
  if (stray.length === 0) return;
  const names = stray
    .flatMap((e) => (e && typeof e === "object" ? Object.keys(e) : []))
    .map((k) => `\`${kebab(k)}\``);
  const what = names.length ? names.join(", ") + " is not an" : "an entry in the items list is not an";
  throw new Error(
    `items: ${what} \`item\`. The items list takes \`item [...]\` entries plus ` +
    `\`params\` and \`save-to-itembank\`. Question attributes belong inside the ` +
    `question type, not at items level.`,
  );
}

export function partitionItemsList(entries: any[]) {
  const members: any = {};
  const items: any[] = [];
  for (const e of entries) {
    const keys = e != null && typeof e === "object" && !Array.isArray(e) ? Object.keys(e) : [];
    if (keys.length === 1 && ITEMS_MEMBERS.has(keys[0])) {
      Object.assign(members, e);
    } else if (e != null) {
      items.push(e);
    }
  }
  return { members, items };
}

// Merge a list of single-key member records into one object, per L0169's ASSESS.
// Throws rather than silently dropping, so a malformed list is a compile error.
export function mergeMembers(members: any, where: string) {
  if (!Array.isArray(members)) {
    throw new Error(`${where}: expected a member list in [brackets], e.g. [score 1 value "x"].`);
  }
  const out: any = {};
  for (const m of members) {
    if (m == null || typeof m !== "object" || Array.isArray(m)) {
      throw new Error(
        `${where}: every entry must be an attribute applied to a value, e.g. [score 1 value "x"].`,
      );
    }
    // A member list merges into one object, so a repeated member would replace
    // the first without a word. Two `validation` blocks in one question — one
    // holding `scoring-type`, the next `valid-response` — compiled clean and
    // silently dropped the scoring type.
    for (const key of Object.keys(m)) {
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        throw new Error(
          `${where}: \`${kebab(key)}\` is given twice. A member list merges into one ` +
          `object, so the second would replace the first — write everything under one ` +
          `\`${kebab(key)}\` [...].`,
        );
      }
    }
    Object.assign(out, m);
  }
  return out;
}


// Which attributes are valid for each question type
export const validAttributes: Record<string, string[]> = {
  MCQ: [
    "feedback_attempts", "instant_feedback", "instructor_stimulus",
    "is_math", "max_selection", "metadata", "min_selection",
    "multiple_responses", "options", "shuffle_options", "stimulus",
    "stimulus_review", "ui_style", "validation",
  ],
  SHORTTEXT: [
    "case_sensitive", "character_map", "feedback_attempts",
    "ignore_leading_and_trailing_spaces", "instant_feedback",
    "instructor_stimulus", "is_math", "max_length", "metadata",
    "placeholder", "response_container", "spellcheck", "stimulus",
    "stimulus_review", "ui_style", "validation",
  ],
  LONGTEXT: [
    "character_map", "disable_auto_link", "formatting_options",
    "horizontal_layout", "instructor_stimulus", "is_math", "max_length",
    "metadata", "placeholder", "show_word_count", "show_word_limit",
    "spellcheck", "stimulus", "stimulus_review", "submit_over_limit",
    "text_blocks", "ui_style", "validation",
  ],
  PLAINTEXT: [
    "character_map", "instructor_stimulus", "is_math", "max_length",
    "metadata", "placeholder", "show_copy", "show_cut", "show_paste",
    "spellcheck", "stimulus", "stimulus_review", "submit_over_limit",
    "ui_style", "validation",
  ],
  // From Cloze-text-clozetext.md's attribute table. `description` is omitted
  // (deprecated in favour of stimulus_review) and `type` is emitted, not authored.
  CLOZETEXT: [
    "stimulus", "stimulus_review", "instructor_stimulus", "template",
    "is_math", "metadata", "ui_style", "validation",
    "instant_feedback", "feedback_attempts",
    "response_container", "response_containers",
    "character_map", "max_length", "multiple_line", "spellcheck",
    "case_sensitive", "ignore_leading_and_trailing_spaces",
    "match_all_possible_responses",
  ],
  CLOZEASSOCIATION: [
    "duplicate_responses", "feedback_attempts", "group_possible_responses",
    "instant_feedback", "instructor_stimulus", "is_math",
    "match_all_possible_responses", "metadata", "possible_responses",
    "response_container", "response_containers", "shuffle_options",
    "stimulus", "stimulus_review", "template", "ui_style", "validation",
  ],
  CLOZEDROPDOWN: [
    "case_sensitive", "feedback_attempts", "instant_feedback",
    "instructor_stimulus", "is_math", "match_all_possible_responses",
    "metadata", "possible_responses", "response_container",
    "response_containers", "shuffle_options", "stimulus", "stimulus_review",
    "template", "ui_style", "validation",
  ],
  CLOZEFORMULA: [
    "feedback_attempts", "handwriting_recognises", "hints",
    "horizontal_layout", "instant_feedback", "instructor_stimulus",
    "is_dynamic_content", "is_math", "math_image_capture", "metadata",
    "response_container", "response_containers", "show_hints_button",
    "stimulus", "stimulus_review", "template", "text_blocks", "ui_style",
    "validation",
  ],
  CHOICEMATRIX: [
    "feedback_attempts", "instant_feedback", "instructor_stimulus",
    "is_math", "metadata", "multiple_responses", "options",
    "shuffle_options", "stems", "stimulus", "stimulus_review", "ui_style",
    "validation",
  ],
  ORDERLIST: [
    "feedback_attempts", "instant_feedback", "instructor_stimulus",
    "is_math", "list", "metadata", "shuffle_options", "stimulus",
    "stimulus_review", "ui_style", "validation",
  ],
  CLASSIFICATION: [
    "duplicate_responses", "feedback_attempts", "group_possible_responses",
    "instant_feedback", "instructor_stimulus", "is_math",
    "max_response_per_cell", "metadata", "possible_responses",
    "shuffle_options", "stimulus", "stimulus_review", "ui_style",
    "validation",
  ],
  BOWTIE: [
    "feedback_attempts", "group_possible_responses", "instant_feedback",
    "instructor_stimulus", "is_math", "metadata",
    "possible_response_groups", "stimulus", "stimulus_review", "ui_style",
    "validation",
  ],
  TOKEN_HIGHLIGHT: [
    "feedback_attempts", "instant_feedback", "instructor_stimulus",
    "is_math", "max_selection", "metadata", "stimulus", "stimulus_review",
    "template", "tokenization", "ui_style", "validation",
  ],
};
