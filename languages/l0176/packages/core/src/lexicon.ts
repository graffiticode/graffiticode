// SPDX-License-Identifier: MIT
// L0176's lexicon = L0000's base vocabulary + L0176's Learnosity additions
// (child keys win on merge). Ported from L0158 (@graffiticode/basis) verbatim —
// the entry shape (tk/name/cls/length/arity) is identical between basis and L0000.
import { lexicon as base } from "@graffiticode/l0000";

const additions = {
  // Block / structural keywords
  init: { tk: 1, name: "INIT", cls: "function", length: 1, arity: 1 },
  items: { tk: 1, name: "ITEMS", cls: "function", length: 2, arity: 2 },
  item: { tk: 1, name: "ITEM", cls: "function", length: 1, arity: 1 },
  questions: { tk: 1, name: "QUESTIONS", cls: "function", length: 2, arity: 2 },
  author: { tk: 1, name: "AUTHOR", cls: "function", length: 1, arity: 1 },
  hello: { tk: 1, name: "HELLO", cls: "function", length: 1, arity: 1 },

  // Question-type keywords (arity 1)
  mcq: { tk: 1, name: "MCQ", cls: "function", length: 1, arity: 1 },
  shorttext: { tk: 1, name: "SHORTTEXT", cls: "function", length: 1, arity: 1 },
  longtext: { tk: 1, name: "LONGTEXT", cls: "function", length: 1, arity: 1 },
  plaintext: { tk: 1, name: "PLAINTEXT", cls: "function", length: 1, arity: 1 },
  clozetext: { tk: 1, name: "CLOZETEXT", cls: "function", length: 1, arity: 1 },
  clozeassociation: { tk: 1, name: "CLOZEASSOCIATION", cls: "function", length: 1, arity: 1 },
  clozedropdown: { tk: 1, name: "CLOZEDROPDOWN", cls: "function", length: 1, arity: 1 },
  clozeformula: { tk: 1, name: "CLOZEFORMULA", cls: "function", length: 1, arity: 1 },
  choicematrix: { tk: 1, name: "CHOICEMATRIX", cls: "function", length: 1, arity: 1 },
  orderlist: { tk: 1, name: "ORDERLIST", cls: "function", length: 1, arity: 1 },
  classification: { tk: 1, name: "CLASSIFICATION", cls: "function", length: 1, arity: 1 },
  bowtie: { tk: 1, name: "BOWTIE", cls: "function", length: 1, arity: 1 },
  custom: { tk: 1, name: "CUSTOM", cls: "function", length: 1, arity: 1 },
  "token-highlight": { tk: 1, name: "TOKEN_HIGHLIGHT", cls: "function", length: 1, arity: 1 },

  // Attribute keywords (arity 2)
  stimulus: { tk: 1, name: "STIMULUS", cls: "function", length: 1, arity: 1 },
  options: { tk: 1, name: "OPTIONS", cls: "function", length: 1, arity: 1 },
  "valid-response": { tk: 1, name: "VALID_RESPONSE", cls: "function", length: 1, arity: 1 },
  "instant-feedback": { tk: 1, name: "INSTANT_FEEDBACK", cls: "function", length: 1, arity: 1 },
  "is-math": { tk: 1, name: "IS_MATH", cls: "function", length: 1, arity: 1 },
  "shuffle-options": { tk: 1, name: "SHUFFLE_OPTIONS", cls: "function", length: 1, arity: 1 },
  "multiple-responses": { tk: 1, name: "MULTIPLE_RESPONSES", cls: "function", length: 1, arity: 1 },
  "case-sensitive": { tk: 1, name: "CASE_SENSITIVE", cls: "function", length: 1, arity: 1 },
  "max-length": { tk: 1, name: "MAX_LENGTH", cls: "function", length: 1, arity: 1 },
  placeholder: { tk: 1, name: "PLACEHOLDER", cls: "function", length: 1, arity: 1 },
  "possible-responses": { tk: 1, name: "POSSIBLE_RESPONSES", cls: "function", length: 1, arity: 1 },
  columns: { tk: 1, name: "COLUMNS", cls: "function", length: 1, arity: 1 },
  list: { tk: 1, name: "ORDER_LIST", cls: "function", length: 1, arity: 1 },
  "column-titles": { tk: 1, name: "COLUMN_TITLES", cls: "function", length: 1, arity: 1 },
  "max-selection": { tk: 1, name: "MAX_SELECTION", cls: "function", length: 1, arity: 1 },
  method: { tk: 1, name: "METHOD", cls: "function", length: 1, arity: 1 },
  lang: { tk: 1, name: "LANG", cls: "function", length: 1, arity: 1 },
  model: { tk: 1, name: "MODEL", cls: "function", length: 1, arity: 1 },
  "save-to-itembank": { tk: 1, name: "SAVE_TO_ITEMBANK", cls: "function", length: 1, arity: 1 },
  params: { tk: 1, name: "PARAMS", cls: "function", length: 1, arity: 1 },

  // --- Aligned Learnosity vocabulary -------------------------------------
  // Every word below is the kebab-case spelling of the Learnosity field it
  // emits, and nests the way the field nests. Introduced with `clozetext`; the
  // remaining question types still use the older flat spellings above and are
  // converted one at a time. Which words a given type accepts is scoped by
  // `validAttributes` in question-types.ts, not by the lexicon, which is global.

  // Question-level fields
  template: { tk: 1, name: "TEMPLATE", cls: "function", length: 1, arity: 1 },
  "stimulus-review": { tk: 1, name: "STIMULUS_REVIEW", cls: "function", length: 1, arity: 1 },
  "instructor-stimulus": { tk: 1, name: "INSTRUCTOR_STIMULUS", cls: "function", length: 1, arity: 1 },
  "character-map": { tk: 1, name: "CHARACTER_MAP", cls: "function", length: 1, arity: 1 },
  "multiple-line": { tk: 1, name: "MULTIPLE_LINE", cls: "function", length: 1, arity: 1 },
  spellcheck: { tk: 1, name: "SPELLCHECK", cls: "function", length: 1, arity: 1 },
  "ignore-leading-and-trailing-spaces": { tk: 1, name: "IGNORE_LEADING_AND_TRAILING_SPACES", cls: "function", length: 1, arity: 1 },
  "match-all-possible-responses": { tk: 1, name: "MATCH_ALL_POSSIBLE_RESPONSES", cls: "function", length: 1, arity: 1 },
  "feedback-attempts": { tk: 1, name: "FEEDBACK_ATTEMPTS", cls: "function", length: 1, arity: 1 },

  // validation (arity 2) — value is the record built by the words beneath it
  validation: { tk: 1, name: "VALIDATION", cls: "function", length: 1, arity: 1 },
  "scoring-type": { tk: 1, name: "SCORING_TYPE", cls: "function", length: 1, arity: 1 },
  "alt-responses": { tk: 1, name: "ALT_RESPONSES", cls: "function", length: 1, arity: 1 },
  "allow-negative-scores": { tk: 1, name: "ALLOW_NEGATIVE_SCORES", cls: "function", length: 1, arity: 1 },
  penalty: { tk: 1, name: "PENALTY", cls: "function", length: 1, arity: 1 },
  "min-score-if-attempted": { tk: 1, name: "MIN_SCORE_IF_ATTEMPTED", cls: "function", length: 1, arity: 1 },
  unscored: { tk: 1, name: "UNSCORED", cls: "function", length: 1, arity: 1 },
  automarkable: { tk: 1, name: "AUTOMARKABLE", cls: "function", length: 1, arity: 1 },
  "enable-fullwidth-scoring": { tk: 1, name: "ENABLE_FULLWIDTH_SCORING", cls: "function", length: 1, arity: 1 },
  "accent-sensitivity": { tk: 1, name: "ACCENT_SENSITIVITY", cls: "function", length: 1, arity: 1 },
  enabled: { tk: 1, name: "ENABLED", cls: "function", length: 1, arity: 1 },
  "accent-penalty-points": { tk: 1, name: "ACCENT_PENALTY_POINTS", cls: "function", length: 1, arity: 1 },

  // ui-style and response containers (arity 2) — values are records
  "ui-style": { tk: 1, name: "UI_STYLE", cls: "function", length: 1, arity: 1 },
  fontsize: { tk: 1, name: "FONTSIZE", cls: "function", length: 1, arity: 1 },
  "validation-stem-numeration": { tk: 1, name: "VALIDATION_STEM_NUMERATION", cls: "function", length: 1, arity: 1 },
  "response-container": { tk: 1, name: "RESPONSE_CONTAINER", cls: "function", length: 1, arity: 1 },
  "response-containers": { tk: 1, name: "RESPONSE_CONTAINERS", cls: "function", length: 1, arity: 1 },
  height: { tk: 1, name: "HEIGHT", cls: "function", length: 1, arity: 1 },
  width: { tk: 1, name: "WIDTH", cls: "function", length: 1, arity: 1 },
  "input-type": { tk: 1, name: "INPUT_TYPE", cls: "function", length: 1, arity: 1 },
  "aria-label": { tk: 1, name: "ARIA_LABEL", cls: "function", length: 1, arity: 1 },

  // Added with the seven mechanical types (shorttext, longtext, plaintext,
  // orderlist, clozeassociation, clozedropdown, choicematrix). `type` is a
  // ui_style member (orderlist's button/list/inline, choicematrix's
  // inline/table); the question's own type is emitted, never authored.
  "disable-auto-link": { tk: 1, name: "DISABLE_AUTO_LINK", cls: "function", length: 1, arity: 1 },
  "formatting-options": { tk: 1, name: "FORMATTING_OPTIONS", cls: "function", length: 1, arity: 1 },
  "horizontal-layout": { tk: 1, name: "HORIZONTAL_LAYOUT", cls: "function", length: 1, arity: 1 },
  "show-word-count": { tk: 1, name: "SHOW_WORD_COUNT", cls: "function", length: 1, arity: 1 },
  "show-word-limit": { tk: 1, name: "SHOW_WORD_LIMIT", cls: "function", length: 1, arity: 1 },
  "submit-over-limit": { tk: 1, name: "SUBMIT_OVER_LIMIT", cls: "function", length: 1, arity: 1 },
  "text-blocks": { tk: 1, name: "TEXT_BLOCKS", cls: "function", length: 1, arity: 1 },
  "show-copy": { tk: 1, name: "SHOW_COPY", cls: "function", length: 1, arity: 1 },
  "show-cut": { tk: 1, name: "SHOW_CUT", cls: "function", length: 1, arity: 1 },
  "show-paste": { tk: 1, name: "SHOW_PASTE", cls: "function", length: 1, arity: 1 },
  "duplicate-responses": { tk: 1, name: "DUPLICATE_RESPONSES", cls: "function", length: 1, arity: 1 },
  "group-possible-responses": { tk: 1, name: "GROUP_POSSIBLE_RESPONSES", cls: "function", length: 1, arity: 1 },
  stems: { tk: 1, name: "STEMS", cls: "function", length: 1, arity: 1 },
  "horizontal-lines": { tk: 1, name: "HORIZONTAL_LINES", cls: "function", length: 1, arity: 1 },
  "max-height": { tk: 1, name: "MAX_HEIGHT", cls: "function", length: 1, arity: 1 },
  "min-height": { tk: 1, name: "MIN_HEIGHT", cls: "function", length: 1, arity: 1 },
  "option-row-title": { tk: 1, name: "OPTION_ROW_TITLE", cls: "function", length: 1, arity: 1 },
  "option-width": { tk: 1, name: "OPTION_WIDTH", cls: "function", length: 1, arity: 1 },
  "possibility-list-position": { tk: 1, name: "POSSIBILITY_LIST_POSITION", cls: "function", length: 1, arity: 1 },
  "show-drag-handle": { tk: 1, name: "SHOW_DRAG_HANDLE", cls: "function", length: 1, arity: 1 },
  "stem-title": { tk: 1, name: "STEM_TITLE", cls: "function", length: 1, arity: 1 },
  "stem-width": { tk: 1, name: "STEM_WIDTH", cls: "function", length: 1, arity: 1 },
  type: { tk: 1, name: "TYPE", cls: "function", length: 1, arity: 1 },
  wordwrap: { tk: 1, name: "WORDWRAP", cls: "function", length: 1, arity: 1 },
  "matching-rule": { tk: 1, name: "MATCHING_RULE", cls: "function", length: 1, arity: 1 },
  "max-score": { tk: 1, name: "MAX_SCORE", cls: "function", length: 1, arity: 1 },
  "score-with-feedbackaide": { tk: 1, name: "SCORE_WITH_FEEDBACKAIDE", cls: "function", length: 1, arity: 1 },
  "feedbackaide-passages": { tk: 1, name: "FEEDBACKAIDE_PASSAGES", cls: "function", length: 1, arity: 1 },

  // Added with mcq, classification, bowtie and token-highlight: the option and
  // response-group object members, and the ui_style members those types document.
  label: { tk: 1, name: "LABEL", cls: "function", length: 1, arity: 1 },
  "assistive-label": { tk: 1, name: "ASSISTIVE_LABEL", cls: "function", length: 1, arity: 1 },
  "exposed-visible-label": { tk: 1, name: "EXPOSED_VISIBLE_LABEL", cls: "function", length: 1, arity: 1 },
  responses: { tk: 1, name: "RESPONSES", cls: "function", length: 1, arity: 1 },
  title: { tk: 1, name: "TITLE", cls: "function", length: 1, arity: 1 },
  "min-selection": { tk: 1, name: "MIN_SELECTION", cls: "function", length: 1, arity: 1 },
  "max-response-per-cell": { tk: 1, name: "MAX_RESPONSE_PER_CELL", cls: "function", length: 1, arity: 1 },
  "possible-response-groups": { tk: 1, name: "POSSIBLE_RESPONSE_GROUPS", cls: "function", length: 1, arity: 1 },
  tokenization: { tk: 1, name: "TOKENIZATION", cls: "function", length: 1, arity: 1 },
  "choice-label": { tk: 1, name: "CHOICE_LABEL", cls: "function", length: 1, arity: 1 },
  "column-count": { tk: 1, name: "COLUMN_COUNT", cls: "function", length: 1, arity: 1 },
  orientation: { tk: 1, name: "ORIENTATION", cls: "function", length: 1, arity: 1 },
  "row-count": { tk: 1, name: "ROW_COUNT", cls: "function", length: 1, arity: 1 },
  "row-header": { tk: 1, name: "ROW_HEADER", cls: "function", length: 1, arity: 1 },
  "row-min-height": { tk: 1, name: "ROW_MIN_HEIGHT", cls: "function", length: 1, arity: 1 },
  "row-titles": { tk: 1, name: "ROW_TITLES", cls: "function", length: 1, arity: 1 },
  "row-titles-width": { tk: 1, name: "ROW_TITLES_WIDTH", cls: "function", length: 1, arity: 1 },

  // Added with clozeformula. `items-list` rather than `items`: the block
  // keyword `items` is arity 2 and already taken, and hints.items is the only
  // place a question needs the field.
  "handwriting-recognises": { tk: 1, name: "HANDWRITING_RECOGNISES", cls: "function", length: 1, arity: 1 },
  hints: { tk: 1, name: "HINTS", cls: "function", length: 1, arity: 1 },
  "is-dynamic-content": { tk: 1, name: "IS_DYNAMIC_CONTENT", cls: "function", length: 1, arity: 1 },
  "math-image-capture": { tk: 1, name: "MATH_IMAGE_CAPTURE", cls: "function", length: 1, arity: 1 },
  "items-list": { tk: 1, name: "ITEMS_LIST", cls: "function", length: 1, arity: 1 },
  content: { tk: 1, name: "CONTENT", cls: "function", length: 1, arity: 1 },
  "keyboard-below-response-area": { tk: 1, name: "KEYBOARD_BELOW_RESPONSE_AREA", cls: "function", length: 1, arity: 1 },
  "min-width": { tk: 1, name: "MIN_WIDTH", cls: "function", length: 1, arity: 1 },
  "response-font-scale": { tk: 1, name: "RESPONSE_FONT_SCALE", cls: "function", length: 1, arity: 1 },
  "show-hints-button": { tk: 1, name: "SHOW_HINTS_BUTTON", cls: "function", length: 1, arity: 1 },

  // Members of a scoring rule's `options`. Learnosity spells these camelCase,
  // alone among its fields, so the kebab keyword maps to camelCase not snake.
  // Which of them a given method honours is unsettled — see C1 and C2.
  // `ignore-leading-and-trailing-spaces-rule` is distinguished from the
  // question-level attribute of nearly the same name, which is snake_case.
  "decimal-places": { tk: 1, name: "DECIMAL_PLACES", cls: "function", length: 1, arity: 1 },
  "set-decimal-separator": { tk: 1, name: "SET_DECIMAL_SEPARATOR", cls: "function", length: 1, arity: 1 },
  "set-thousands-separator": { tk: 1, name: "SET_THOUSANDS_SEPARATOR", cls: "function", length: 1, arity: 1 },
  "ignore-order": { tk: 1, name: "IGNORE_ORDER", cls: "function", length: 1, arity: 1 },
  "ignore-leading-and-trailing-spaces-rule": { tk: 1, name: "IGNORE_LEADING_TRAILING_RULE", cls: "function", length: 1, arity: 1 },
  "treat-multiple-spaces-as-one": { tk: 1, name: "TREAT_MULTIPLE_SPACES_AS_ONE", cls: "function", length: 1, arity: 1 },
  "inverse-result": { tk: 1, name: "INVERSE_RESULT", cls: "function", length: 1, arity: 1 },
  // `equivSyntax` carries its rule here rather than in `value` — the rule names
  // a form the response must take, not an expression to match against, so there
  // is nothing for `value` to hold. `ignore-text` is its companion, and applies
  // to LaTeX \text{...} the learner types alongside the answer.
  "syntax": { tk: 1, name: "SYNTAX", cls: "function", length: 1, arity: 1 },
  "ignore-text": { tk: 1, name: "IGNORE_TEXT", cls: "function", length: 1, arity: 1 },
  // The rest of the documented rule options, one Author Guide article naming
  // each: "Allow decimal marks", "Compare sides", "Treat all letters as
  // variables", "Allow thousands separator".
  "allow-decimal": { tk: 1, name: "ALLOW_DECIMAL", cls: "function", length: 1, arity: 1 },
  "compare-sides": { tk: 1, name: "COMPARE_SIDES", cls: "function", length: 1, arity: 1 },
  "treat-letters-as-variables": { tk: 1, name: "TREAT_LETTERS_AS_VARIABLES", cls: "function", length: 1, arity: 1 },
  "allow-thousands-separator": { tk: 1, name: "ALLOW_THOUSANDS_SEPARATOR", cls: "function", length: 1, arity: 1 },

  // Leaf-object members (arity 1). Each returns a single-key record; the
  // enclosing collector merges a list of them into one object. Modelled on
  // L0169's `assess [method "value" expected 42]`.
  score: { tk: 1, name: "SCORE", cls: "function", length: 1, arity: 1 },
  value: { tk: 1, name: "VALUE", cls: "function", length: 1, arity: 1 },

  // Metadata container (arity 2) — value is a list of member constructors
  metadata: { tk: 1, name: "METADATA", cls: "function", length: 1, arity: 1 },

  // Metadata member constructors (arity 1) — each returns a tagged entry
  tags: { tk: 1, name: "TAGS", cls: "function", length: 1, arity: 1 },
  notes: { tk: 1, name: "NOTES", cls: "function", length: 1, arity: 1 },
  "distractor-rationale": { tk: 1, name: "DISTRACTOR_RATIONALE", cls: "function", length: 1, arity: 1 },
  acknowledgements: { tk: 1, name: "ACKNOWLEDGEMENTS", cls: "function", length: 1, arity: 1 },
  "distractor-rationale-response-level": { tk: 1, name: "DISTRACTOR_RATIONALE_RESPONSE_LEVEL", cls: "function", length: 1, arity: 1 },
  "rubric-reference": { tk: 1, name: "RUBRIC_REFERENCE", cls: "function", length: 1, arity: 1 },
  "sample-answer": { tk: 1, name: "SAMPLE_ANSWER", cls: "function", length: 1, arity: 1 },
  "response-shuffle-seed": { tk: 1, name: "RESPONSE_SHUFFLE_SEED", cls: "function", length: 1, arity: 1 },
  description: { tk: 1, name: "DESCRIPTION", cls: "function", length: 1, arity: 1 },
  source: { tk: 1, name: "SOURCE", cls: "function", length: 1, arity: 1 },
  "difficulty-level": { tk: 1, name: "DIFFICULTY_LEVEL", cls: "function", length: 1, arity: 1 },
};

// Retired spellings. They still lex — a source saved before the rename must keep
// compiling — but each maps onto the current keyword's AST name, so there is one
// node type and one builder downstream. They are stripped from the published
// lexicon.json (see tools/build-static.js), so nothing advertises them: no
// autocomplete entry, no spec row, no generator prompt. Removing one is a
// breaking change for already-saved sources.
const deprecatedAliases: Record<string, string> = {
  "hot-text": "token-highlight", // renamed to match the Learnosity widget name
};

const aliasEntries = Object.fromEntries(
  Object.entries(deprecatedAliases).map(([alias, current]) => [
    alias,
    (additions as Record<string, any>)[current],
  ]),
);

// The alias words, for build-static.js to filter out of the public lexicon.json.
export const deprecatedWords = Object.keys(deprecatedAliases);

export const lexicon = { ...base, ...additions, ...aliasEntries };
