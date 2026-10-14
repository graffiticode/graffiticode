// SPDX-License-Identifier: MIT

//! The question types, the attribute words, and how a member list becomes a Learnosity object.
//!
//! An attribute is named for the Learnosity field it emits and nests the way the field nests,
//! so a question is a transcription of its JSON: `mcq [stimulus "…" validation [valid-response
//! [score 1 value ["0"]]]]`. Every attribute word returns a one-field object; a bracketed list
//! of them merges into one object ([`merge_members`]). A question type's builder then applies
//! its defaults and checks what Learnosity would otherwise accept in silence: an attribute the
//! type does not take, a member written with the wrong shape, an unsupported scoring type, a
//! cloze blank in the wrong field, math that would not typeset.
//!
//! Every message here is the TypeScript compiler's, word for word.

use serde_json::{Value as Json, json};

use crate::plain::{Object, describe, js_string, kebab};

/// How a member's argument is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// As written: a scalar, or a list of scalars.
    Value,
    /// A member list, merged into one object.
    Object,
    /// A list of member lists, each merged.
    ObjectArray,
    /// Decided by what the list holds, for the two words Learnosity gives different types on
    /// different question types (`options`, `value`). See [`infer_shape`].
    Infer,
}

/// Each attribute word: its node tag, the field it emits, and how its argument is read.
pub const MEMBERS: &[(&str, &str, Shape)] = &[
    // Question-level content
    ("STIMULUS", "stimulus", Shape::Value),
    ("STIMULUS_REVIEW", "stimulus_review", Shape::Value),
    ("INSTRUCTOR_STIMULUS", "instructor_stimulus", Shape::Value),
    ("TEMPLATE", "template", Shape::Value),
    ("IS_MATH", "is_math", Shape::Value),
    ("OPTIONS", "options", Shape::Infer),
    ("POSSIBLE_RESPONSES", "possible_responses", Shape::Value),
    ("ORDER_LIST", "list", Shape::Value),
    ("COLUMNS", "columns", Shape::Value),
    ("COLUMN_TITLES", "column_titles", Shape::Value),
    // Behaviour
    ("INSTANT_FEEDBACK", "instant_feedback", Shape::Value),
    ("FEEDBACK_ATTEMPTS", "feedback_attempts", Shape::Value),
    ("SHUFFLE_OPTIONS", "shuffle_options", Shape::Value),
    ("MULTIPLE_RESPONSES", "multiple_responses", Shape::Value),
    ("MAX_SELECTION", "max_selection", Shape::Value),
    ("CASE_SENSITIVE", "case_sensitive", Shape::Value),
    ("MAX_LENGTH", "max_length", Shape::Value),
    ("PLACEHOLDER", "placeholder", Shape::Value),
    ("MULTIPLE_LINE", "multiple_line", Shape::Value),
    ("CHARACTER_MAP", "character_map", Shape::Value),
    ("SPELLCHECK", "spellcheck", Shape::Value),
    ("IGNORE_LEADING_AND_TRAILING_SPACES", "ignore_leading_and_trailing_spaces", Shape::Value),
    ("MATCH_ALL_POSSIBLE_RESPONSES", "match_all_possible_responses", Shape::Value),
    ("METHOD", "method", Shape::Value),
    // Nested objects
    ("VALIDATION", "validation", Shape::Object),
    ("SCORING_TYPE", "scoring_type", Shape::Value),
    ("VALID_RESPONSE", "valid_response", Shape::Object),
    ("ALT_RESPONSES", "alt_responses", Shape::ObjectArray),
    ("ALLOW_NEGATIVE_SCORES", "allow_negative_scores", Shape::Value),
    ("PENALTY", "penalty", Shape::Value),
    ("MIN_SCORE_IF_ATTEMPTED", "min_score_if_attempted", Shape::Value),
    ("UNSCORED", "unscored", Shape::Value),
    ("AUTOMARKABLE", "automarkable", Shape::Value),
    ("ENABLE_FULLWIDTH_SCORING", "enable_fullwidth_scoring", Shape::Value),
    ("ACCENT_SENSITIVITY", "accent_sensitivity", Shape::Object),
    ("ENABLED", "enabled", Shape::Value),
    ("ACCENT_PENALTY_POINTS", "accent_penalty_points", Shape::Value),
    ("SCORE", "score", Shape::Value),
    ("VALUE", "value", Shape::Infer),
    ("UI_STYLE", "ui_style", Shape::Object),
    ("FONTSIZE", "fontsize", Shape::Value),
    ("VALIDATION_STEM_NUMERATION", "validation_stem_numeration", Shape::Value),
    ("RESPONSE_CONTAINER", "response_container", Shape::Object),
    ("RESPONSE_CONTAINERS", "response_containers", Shape::ObjectArray),
    ("HEIGHT", "height", Shape::Value),
    ("WIDTH", "width", Shape::Value),
    ("INPUT_TYPE", "input_type", Shape::Value),
    ("ARIA_LABEL", "aria_label", Shape::Value),
    // The seven mechanical types
    ("DISABLE_AUTO_LINK", "disable_auto_link", Shape::Value),
    ("FORMATTING_OPTIONS", "formatting_options", Shape::Value),
    ("HORIZONTAL_LAYOUT", "horizontal_layout", Shape::Value),
    ("SHOW_WORD_COUNT", "show_word_count", Shape::Value),
    ("SHOW_WORD_LIMIT", "show_word_limit", Shape::Value),
    ("SUBMIT_OVER_LIMIT", "submit_over_limit", Shape::Value),
    ("TEXT_BLOCKS", "text_blocks", Shape::Value),
    ("SHOW_COPY", "show_copy", Shape::Value),
    ("SHOW_CUT", "show_cut", Shape::Value),
    ("SHOW_PASTE", "show_paste", Shape::Value),
    ("DUPLICATE_RESPONSES", "duplicate_responses", Shape::Value),
    ("GROUP_POSSIBLE_RESPONSES", "group_possible_responses", Shape::Value),
    ("STEMS", "stems", Shape::Value),
    ("HORIZONTAL_LINES", "horizontal_lines", Shape::Value),
    ("MAX_HEIGHT", "max_height", Shape::Value),
    ("MIN_HEIGHT", "min_height", Shape::Value),
    ("OPTION_ROW_TITLE", "option_row_title", Shape::Value),
    ("OPTION_WIDTH", "option_width", Shape::Value),
    ("POSSIBILITY_LIST_POSITION", "possibility_list_position", Shape::Value),
    ("SHOW_DRAG_HANDLE", "show_drag_handle", Shape::Value),
    ("STEM_TITLE", "stem_title", Shape::Value),
    ("STEM_WIDTH", "stem_width", Shape::Value),
    ("TYPE", "type", Shape::Value),
    ("WORDWRAP", "wordwrap", Shape::Value),
    ("MATCHING_RULE", "matching_rule", Shape::Value),
    ("MAX_SCORE", "max_score", Shape::Value),
    ("SCORE_WITH_FEEDBACKAIDE", "score_with_feedbackaide", Shape::Value),
    ("FEEDBACKAIDE_PASSAGES", "feedbackaide_passages", Shape::Value),
    // mcq, classification, bowtie, token-highlight
    ("LABEL", "label", Shape::Value),
    ("ASSISTIVE_LABEL", "assistive_label", Shape::Object),
    ("EXPOSED_VISIBLE_LABEL", "exposed_visible_label", Shape::Value),
    ("RESPONSES", "responses", Shape::Value),
    ("TITLE", "title", Shape::Value),
    ("MIN_SELECTION", "min_selection", Shape::Value),
    ("MAX_RESPONSE_PER_CELL", "max_response_per_cell", Shape::Value),
    ("POSSIBLE_RESPONSE_GROUPS", "possible_response_groups", Shape::ObjectArray),
    ("TOKENIZATION", "tokenization", Shape::Value),
    ("CHOICE_LABEL", "choice_label", Shape::Value),
    ("COLUMN_COUNT", "column_count", Shape::Value),
    ("ORIENTATION", "orientation", Shape::Value),
    ("ROW_COUNT", "row_count", Shape::Value),
    ("ROW_HEADER", "row_header", Shape::Value),
    ("ROW_MIN_HEIGHT", "row_min_height", Shape::Value),
    ("ROW_TITLES", "row_titles", Shape::Value),
    ("ROW_TITLES_WIDTH", "row_titles_width", Shape::Value),
    // clozeformula
    ("HANDWRITING_RECOGNISES", "handwriting_recognises", Shape::Value),
    ("HINTS", "hints", Shape::Object),
    ("IS_DYNAMIC_CONTENT", "is_dynamic_content", Shape::Value),
    ("MATH_IMAGE_CAPTURE", "math_image_capture", Shape::Value),
    ("ITEMS_LIST", "items", Shape::ObjectArray),
    ("CONTENT", "content", Shape::Value),
    ("KEYBOARD_BELOW_RESPONSE_AREA", "keyboard_below_response_area", Shape::Value),
    ("MIN_WIDTH", "min_width", Shape::Value),
    ("RESPONSE_FONT_SCALE", "response_font_scale", Shape::Value),
    ("SHOW_HINTS_BUTTON", "show_hints_button", Shape::Value),
    // A scoring rule's options, which Learnosity alone among its fields spells in camelCase
    ("SYNTAX", "syntax", Shape::Value),
    ("IGNORE_TEXT", "ignoreText", Shape::Value),
    ("ALLOW_DECIMAL", "allowDecimal", Shape::Value),
    ("COMPARE_SIDES", "compareSides", Shape::Value),
    ("TREAT_LETTERS_AS_VARIABLES", "treatLettersAsVariables", Shape::Value),
    ("ALLOW_THOUSANDS_SEPARATOR", "allowThousandsSeparator", Shape::Value),
    ("DECIMAL_PLACES", "decimalPlaces", Shape::Value),
    ("SET_DECIMAL_SEPARATOR", "setDecimalSeparator", Shape::Value),
    ("SET_THOUSANDS_SEPARATOR", "setThousandsSeparator", Shape::Value),
    ("IGNORE_ORDER", "ignoreOrder", Shape::Value),
    ("IGNORE_LEADING_TRAILING_RULE", "ignoreLeadingAndTrailingSpaces", Shape::Value),
    ("TREAT_MULTIPLE_SPACES_AS_ONE", "treatMultipleSpacesAsOne", Shape::Value),
    ("INVERSE_RESULT", "inverseResult", Shape::Value),
    // metadata members; at item level they are routed to their several destinations
    ("TAGS", "tags", Shape::Value),
    ("NOTES", "notes", Shape::Value),
    ("DISTRACTOR_RATIONALE", "distractor_rationale", Shape::Value),
    ("ACKNOWLEDGEMENTS", "acknowledgements", Shape::Value),
    ("RESPONSE_SHUFFLE_SEED", "response_shuffle_seed", Shape::Value),
    ("SAMPLE_ANSWER", "sample_answer", Shape::Value),
    ("RUBRIC_REFERENCE", "rubric_reference", Shape::Value),
    ("DISTRACTOR_RATIONALE_RESPONSE_LEVEL", "distractor_rationale_response_level", Shape::Value),
    ("DESCRIPTION", "description", Shape::Value),
    ("SOURCE", "source", Shape::Value),
    ("DIFFICULTY_LEVEL", "difficulty_level", Shape::Value),
    // A member at both question and item level
    ("METADATA", "metadata", Shape::Object),
    // Items-level: the activity's dynamic-content table
    ("PARAMS", "params", Shape::Value),
    // custom
    ("LANG", "lang", Shape::Value),
    ("MODEL", "data", Shape::Value),
];

/// The attribute word with this node tag.
pub fn member(tag: &str) -> Option<(&'static str, Shape)> {
    MEMBERS.iter().find(|(word, ..)| *word == tag).map(|(_, field, shape)| (*field, *shape))
}

/// The question types by node tag: the name the defaults, scoring types and messages use, and
/// the Learnosity type emitted.
pub const QUESTION_TYPES: &[(&str, &str, &str)] = &[
    ("MCQ", "mcq", "mcq"),
    ("SHORTTEXT", "shorttext", "shorttext"),
    // The bare `longtext` slug is Learnosity's deprecated type.
    ("LONGTEXT", "longtext", "longtextV2"),
    ("PLAINTEXT", "plaintext", "plaintext"),
    ("CLOZETEXT", "clozetext", "clozetext"),
    ("CLOZEASSOCIATION", "clozeassociation", "clozeassociation"),
    ("CLOZEDROPDOWN", "clozedropdown", "clozedropdown"),
    // Learnosity's "Math"; its own `clozeformula` is an older, different type.
    ("CLOZEFORMULA", "clozeformula", "clozeformulaV2"),
    ("CHOICEMATRIX", "choicematrix", "choicematrix"),
    ("ORDERLIST", "orderlist", "orderlist"),
    ("CLASSIFICATION", "classification", "classification"),
    ("BOWTIE", "bowtie", "bowtie"),
    ("CUSTOM", "custom", "custom"),
    ("TOKEN_HIGHLIGHT", "tokenhighlight", "tokenhighlight"),
];

pub fn is_question_type(tag: &str) -> bool {
    QUESTION_TYPES.iter().any(|(word, ..)| *word == tag)
}

/// What a question type's member list is called in a message: its keyword.
pub fn keyword(tag: &str) -> String {
    tag.to_lowercase().replace('_', "-")
}

fn defaults(name: &str) -> Json {
    match name {
        "mcq" => json!({
            "stimulus": "Which of the following is correct?",
            "options": [
                { "label": "Option A", "value": "0" },
                { "label": "Option B", "value": "1" },
                { "label": "Option C", "value": "2" },
                { "label": "Option D", "value": "3" },
            ],
            "validation": { "scoring_type": "exactMatch", "valid_response": { "score": 1, "value": ["0"] } },
        }),
        "shorttext" => json!({
            "stimulus": "Type your answer below.",
            "validation": { "scoring_type": "exactMatch", "valid_response": { "score": 1, "value": "answer" } },
        }),
        "longtext" => json!({
            "stimulus": "Write a detailed response.",
            "max_length": 500,
            "placeholder": "Start writing here...",
        }),
        "plaintext" => json!({
            "stimulus": "Write your response in plain text.",
            "max_length": 300,
            "placeholder": "Start writing here...",
        }),
        "clozetext" => json!({
            "template": "The {{response}} is the answer.",
            "validation": { "scoring_type": "exactMatch", "valid_response": { "score": 1, "value": ["answer"] } },
        }),
        "clozeassociation" => json!({
            "template": "Drag the correct {{response}} here.",
            "possible_responses": ["correct", "incorrect", "maybe"],
            "validation": { "scoring_type": "exactMatch", "valid_response": { "score": 1, "value": ["correct"] } },
        }),
        "clozedropdown" => json!({
            "template": "Select the correct {{response}}.",
            "possible_responses": [["correct", "incorrect", "maybe"]],
            "validation": { "scoring_type": "exactMatch", "valid_response": { "score": 1, "value": ["correct"] } },
        }),
        "clozeformula" => json!({
            "template": "Solve: {{response}}",
            "is_math": true,
            "ui_style": { "type": "block-on-focus-keyboard" },
            "validation": {
                "scoring_type": "exactMatch",
                "valid_response": { "score": 1, "value": [[{ "method": "equivLiteral", "value": "x+1" }]] },
            },
        }),
        "choicematrix" => json!({
            "stimulus": "Select the correct answer for each row.",
            "stems": ["Statement 1", "Statement 2"],
            "options": ["True", "False"],
            "validation": { "scoring_type": "exactMatch", "valid_response": { "score": 1, "value": [[0], [1]] } },
        }),
        "orderlist" => json!({
            "stimulus": "Arrange the items in the correct order.",
            "list": ["First", "Second", "Third", "Fourth"],
            "validation": { "scoring_type": "exactMatch", "valid_response": { "score": 1, "value": [0, 1, 2, 3] } },
        }),
        "classification" => json!({
            "stimulus": "Sort the items into the correct categories.",
            "possible_responses": ["Item 1", "Item 2", "Item 3", "Item 4"],
            "ui_style": { "column_count": 2, "column_titles": ["Category A", "Category B"] },
            "validation": {
                "scoring_type": "exactMatch",
                "valid_response": { "score": 1, "value": [[0, 2], [1, 3]] },
            },
        }),
        "bowtie" => json!({
            "stimulus": "Review the scenario and complete the diagram.",
            "group_possible_responses": true,
            "possible_response_groups": [
                { "title": "Actions to Take", "responses": ["Action A", "Action B", "Action C", "Action D"] },
                { "title": "Condition Most Likely", "responses": ["Condition X", "Condition Y", "Condition Z"] },
                { "title": "Parameters to Monitor", "responses": ["Parameter P", "Parameter Q", "Parameter R"] },
            ],
            "ui_style": { "column_titles": ["Actions to Take", "Condition Most Likely", "Parameters to Monitor"] },
            "validation": {
                "scoring_type": "exactMatch",
                "valid_response": { "score": 1, "value": [[0, 1], [4], [7, 8]] },
            },
        }),
        "tokenhighlight" => json!({
            "stimulus": "Highlight the verbs in the sentence.",
            "template": "The <span class=\"lrn_token\">cat</span> <span class=\"lrn_token\">runs</span> then <span class=\"lrn_token\">jumps</span> <span class=\"lrn_token\">high</span>.",
            "tokenization": "custom",
            "validation": { "scoring_type": "exactMatch", "valid_response": { "score": 1, "value": [1, 2] } },
        }),
        _ => json!({}),
    }
}

/// The attributes each question type takes, from its Learnosity article.
fn valid_attributes(tag: &str) -> Option<&'static [&'static str]> {
    Some(match tag {
        "MCQ" => &[
            "feedback_attempts",
            "instant_feedback",
            "instructor_stimulus",
            "is_math",
            "max_selection",
            "metadata",
            "min_selection",
            "multiple_responses",
            "options",
            "shuffle_options",
            "stimulus",
            "stimulus_review",
            "ui_style",
            "validation",
        ],
        "SHORTTEXT" => &[
            "case_sensitive",
            "character_map",
            "feedback_attempts",
            "ignore_leading_and_trailing_spaces",
            "instant_feedback",
            "instructor_stimulus",
            "is_math",
            "max_length",
            "metadata",
            "placeholder",
            "response_container",
            "spellcheck",
            "stimulus",
            "stimulus_review",
            "ui_style",
            "validation",
        ],
        "LONGTEXT" => &[
            "character_map",
            "disable_auto_link",
            "formatting_options",
            "horizontal_layout",
            "instructor_stimulus",
            "is_math",
            "max_length",
            "metadata",
            "placeholder",
            "show_word_count",
            "show_word_limit",
            "spellcheck",
            "stimulus",
            "stimulus_review",
            "submit_over_limit",
            "text_blocks",
            "ui_style",
            "validation",
        ],
        "PLAINTEXT" => &[
            "character_map",
            "instructor_stimulus",
            "is_math",
            "max_length",
            "metadata",
            "placeholder",
            "show_copy",
            "show_cut",
            "show_paste",
            "spellcheck",
            "stimulus",
            "stimulus_review",
            "submit_over_limit",
            "ui_style",
            "validation",
        ],
        "CLOZETEXT" => &[
            "stimulus",
            "stimulus_review",
            "instructor_stimulus",
            "template",
            "is_math",
            "metadata",
            "ui_style",
            "validation",
            "instant_feedback",
            "feedback_attempts",
            "response_container",
            "response_containers",
            "character_map",
            "max_length",
            "multiple_line",
            "spellcheck",
            "case_sensitive",
            "ignore_leading_and_trailing_spaces",
            "match_all_possible_responses",
        ],
        "CLOZEASSOCIATION" => &[
            "duplicate_responses",
            "feedback_attempts",
            "group_possible_responses",
            "instant_feedback",
            "instructor_stimulus",
            "is_math",
            "match_all_possible_responses",
            "metadata",
            "possible_responses",
            "response_container",
            "response_containers",
            "shuffle_options",
            "stimulus",
            "stimulus_review",
            "template",
            "ui_style",
            "validation",
        ],
        "CLOZEDROPDOWN" => &[
            "case_sensitive",
            "feedback_attempts",
            "instant_feedback",
            "instructor_stimulus",
            "is_math",
            "match_all_possible_responses",
            "metadata",
            "possible_responses",
            "response_container",
            "response_containers",
            "shuffle_options",
            "stimulus",
            "stimulus_review",
            "template",
            "ui_style",
            "validation",
        ],
        "CLOZEFORMULA" => &[
            "feedback_attempts",
            "handwriting_recognises",
            "hints",
            "horizontal_layout",
            "instant_feedback",
            "instructor_stimulus",
            "is_dynamic_content",
            "is_math",
            "math_image_capture",
            "metadata",
            "response_container",
            "response_containers",
            "show_hints_button",
            "stimulus",
            "stimulus_review",
            "template",
            "text_blocks",
            "ui_style",
            "validation",
        ],
        "CHOICEMATRIX" => &[
            "feedback_attempts",
            "instant_feedback",
            "instructor_stimulus",
            "is_math",
            "metadata",
            "multiple_responses",
            "options",
            "shuffle_options",
            "stems",
            "stimulus",
            "stimulus_review",
            "ui_style",
            "validation",
        ],
        "ORDERLIST" => &[
            "feedback_attempts",
            "instant_feedback",
            "instructor_stimulus",
            "is_math",
            "list",
            "metadata",
            "shuffle_options",
            "stimulus",
            "stimulus_review",
            "ui_style",
            "validation",
        ],
        "CLASSIFICATION" => &[
            "duplicate_responses",
            "feedback_attempts",
            "group_possible_responses",
            "instant_feedback",
            "instructor_stimulus",
            "is_math",
            "max_response_per_cell",
            "metadata",
            "possible_responses",
            "shuffle_options",
            "stimulus",
            "stimulus_review",
            "ui_style",
            "validation",
        ],
        "BOWTIE" => &[
            "feedback_attempts",
            "group_possible_responses",
            "instant_feedback",
            "instructor_stimulus",
            "is_math",
            "metadata",
            "possible_response_groups",
            "stimulus",
            "stimulus_review",
            "ui_style",
            "validation",
        ],
        "TOKEN_HIGHLIGHT" => &[
            "feedback_attempts",
            "instant_feedback",
            "instructor_stimulus",
            "is_math",
            "max_selection",
            "metadata",
            "stimulus",
            "stimulus_review",
            "template",
            "tokenization",
            "ui_style",
            "validation",
        ],
        _ => return None,
    })
}

/// The scoring types each widget accepts, from its Learnosity article. `longtext` and
/// `plaintext` have none: they are scored by hand.
fn scoring_types(name: &str) -> Option<&'static [&'static str]> {
    const CLOZE: &[&str] = &["exactMatch", "partialMatchV2", "partialMatch"];
    const PER_ELEMENT: &[&str] =
        &["exactMatch", "partialMatchV2", "partialMatch", "partialMatchElement", "partialMatchElementV2"];
    Some(match name {
        "clozetext" | "clozeassociation" | "clozedropdown" | "choicematrix" | "mcq" | "clozeformula"
        | "tokenhighlight" => CLOZE,
        "shorttext" => &["exactMatch"],
        "orderlist" => &["exactMatch", "partialMatchV2", "partialMatch", "partialMatchPairwise"],
        "classification" | "bowtie" => PER_ELEMENT,
        _ => return None,
    })
}

/// The members that live inside `validation`, for the hint when one is written outside it.
const VALIDATION_FIELDS: &[&str] = &[
    "scoring_type",
    "valid_response",
    "alt_responses",
    "allow_negative_scores",
    "penalty",
    "min_score_if_attempted",
    "unscored",
    "automarkable",
    "max_score",
    "enable_fullwidth_scoring",
    "accent_sensitivity",
];

/// Whether a value is a one-field object: a member.
fn is_member(json: &Json) -> bool {
    json.as_object().is_some_and(|object| object.len() == 1)
}

/// Whether a list was written as members (`[score 1 value "x"]`) rather than as values.
pub fn is_member_list(json: &Json) -> bool {
    json.as_array().is_some_and(|items| !items.is_empty() && items.iter().all(is_member))
}

/// Merges a member list into one object. A malformed list, or a member given twice (which
/// would silently replace the first), is an error.
pub fn merge_members(members: Option<&Json>, at: &str) -> Result<Object, String> {
    let Some(Json::Array(members)) = members else {
        return Err(format!("{at}: expected a member list in [brackets], e.g. [score 1 value \"x\"]."));
    };
    let mut out = Object::new();
    for member in members {
        let Json::Object(member) = member else {
            return Err(format!(
                "{at}: every entry must be an attribute applied to a value, e.g. [score 1 value \"x\"]."
            ));
        };
        if let Some(key) = member.keys().find(|key| out.contains_key(*key)) {
            let name = kebab(key);
            return Err(format!(
                "{at}: `{name}` is given twice. A member list merges into one object, so the second would replace the first — write everything under one `{name}` [...]."
            ));
        }
        out.extend(member.clone());
    }
    Ok(out)
}

/// `options` and `value` each name several Learnosity types: a rule's options object, mcq's
/// array of `{label, value}`, clozeformula's array of arrays of rules, and plain arrays. Which
/// one is meant follows from what the list holds, and the readings do not overlap.
pub fn infer_shape(raw: Option<Json>, at: &str) -> Result<Option<Json>, String> {
    let Some(Json::Array(items)) = &raw else { return Ok(raw) };
    if items.is_empty() {
        return Ok(raw);
    }
    if items.iter().all(is_member) {
        return merge_members(raw.as_ref(), at).map(|object| Some(Json::Object(object)));
    }
    if items.iter().all(is_member_list) {
        let merged: Result<Vec<Json>, String> = items
            .iter()
            .enumerate()
            .map(|(i, entry)| merge_members(Some(entry), &format!("{at}[{}]", i + 1)).map(Json::Object))
            .collect();
        return merged.map(|items| Some(Json::Array(items)));
    }
    let nested =
        |entry: &Json| entry.as_array().is_some_and(|inner| !inner.is_empty() && inner.iter().all(is_member_list));
    if items.iter().all(nested) {
        let merged: Result<Vec<Json>, String> = items
            .iter()
            .enumerate()
            .map(|(i, outer)| {
                let inner = outer.as_array().into_iter().flatten().enumerate();
                let merged: Result<Vec<Json>, String> = inner
                    .map(|(j, entry)| {
                        merge_members(Some(entry), &format!("{at}[{}][{}]", i + 1, j + 1)).map(Json::Object)
                    })
                    .collect();
                merged.map(Json::Array)
            })
            .collect();
        return merged.map(|items| Some(Json::Array(items)));
    }
    Ok(raw)
}

/// What an attribute word evaluates to: its one-field object.
pub fn member_value(field: &str, shape: Shape, raw: Option<Json>) -> Result<Object, String> {
    let at = kebab(field);
    let value = match shape {
        Shape::Object => match &raw {
            Some(Json::Array(items)) if items.is_empty() || is_member_list(raw.as_ref().unwrap()) => {
                Some(Json::Object(merge_members(raw.as_ref(), &at)?))
            }
            _ => raw,
        },
        Shape::ObjectArray => match &raw {
            Some(Json::Array(items)) if items.iter().all(is_member_list) => {
                let merged: Result<Vec<Json>, String> = items
                    .iter()
                    .enumerate()
                    .map(|(i, entry)| merge_members(Some(entry), &format!("{at}[{}]", i + 1)).map(Json::Object))
                    .collect();
                Some(Json::Array(merged?))
            }
            _ => raw,
        },
        Shape::Infer => infer_shape(raw, &at)?,
        Shape::Value => raw,
    };
    let mut out = Object::new();
    out.insert(field.to_owned(), value.unwrap_or(Json::Null));
    Ok(out)
}

/// Builds the question a type's member list describes.
pub fn build(tag: &str, attrs: Object) -> Result<Object, String> {
    let (_, name, emitted) = *QUESTION_TYPES.iter().find(|(word, ..)| *word == tag).expect("a question type");
    if tag == "CUSTOM" {
        return build_custom(attrs);
    }
    let mut merged = with_defaults(name, attrs);
    check_known_attributes(name, tag, &merged)?;
    check_member_shapes(name, &Json::Object(merged.clone()), "")?;
    check_math_encoding(name, &merged)?;
    if matches!(tag, "CLOZETEXT" | "CLOZEFORMULA" | "CLOZEDROPDOWN" | "CLOZEASSOCIATION") {
        check_cloze_template(name, &merged)?;
    }
    apply_scoring(name, &mut merged)?;
    if tag == "CLOZEFORMULA" {
        check_methods(name, merged.get("validation"), "validation")?;
    }
    if tag == "CLOZETEXT" {
        // Alone in leading with its type.
        let mut out = Object::new();
        out.insert("type".into(), json!(emitted));
        out.extend(merged);
        return Ok(out);
    }
    merged.insert("type".into(), json!(emitted));
    Ok(merged)
}

/// Defaults under what was written, one level deep: an authored `validation` keeps the
/// default `scoring_type` (without one Learnosity cannot score the question), but an authored
/// `valid-response` replaces the default answer.
fn with_defaults(name: &str, attrs: Object) -> Object {
    let Json::Object(defaults) = defaults(name) else { unreachable!("defaults are objects") };
    let mut merged = defaults.clone();
    for (key, value) in attrs {
        let value = match (defaults.get(&key), value) {
            (Some(Json::Object(base)), Json::Object(given)) => {
                let mut both = base.clone();
                both.extend(given);
                Json::Object(both)
            }
            (_, value) => value,
        };
        merged.insert(key, value);
    }
    merged
}

/// Learnosity ignores an unknown field in silence, so one belonging to another type, or a typo,
/// would reach the item bank and simply not work.
fn check_known_attributes(name: &str, tag: &str, attrs: &Object) -> Result<(), String> {
    let Some(allowed) = valid_attributes(tag) else { return Ok(()) };
    let unknown: Vec<&String> = attrs.keys().filter(|key| !allowed.contains(&key.as_str())).collect();
    if unknown.is_empty() {
        return Ok(());
    }
    let misplaced: Vec<String> =
        unknown.iter().filter(|key| VALIDATION_FIELDS.contains(&key.as_str())).map(|key| kebab(key)).collect();
    let hint = if misplaced.is_empty() {
        String::new()
    } else {
        let names: Vec<String> = misplaced.iter().map(|name| format!("`{name}`")).collect();
        format!(
            " {} {} inside `validation`, e.g. validation [valid-response [score 1 value \"x\"]].",
            names.join(" and "),
            if misplaced.len() == 1 { "belongs" } else { "belong" }
        )
    };
    let names: Vec<String> = unknown.iter().map(|key| format!("`{}`", kebab(key))).collect();
    let takes: Vec<String> = allowed.iter().map(|field| kebab(field)).collect();
    Err(format!(
        "{name}: {} {} of {name}. It takes: {}.{hint}",
        names.join(", "),
        if unknown.len() == 1 { "is not an attribute" } else { "are not attributes" },
        takes.join(", ")
    ))
}

fn has_shape(field: &str, shape: Shape) -> bool {
    MEMBERS.iter().any(|(_, name, of)| *name == field && *of == shape)
}

/// Reports a member written with the wrong shape, with the path to it. Runs after the
/// attribute check, so an attribute in the wrong place is reported as that.
fn check_member_shapes(name: &str, value: &Json, path: &str) -> Result<(), String> {
    let Json::Object(object) = value else { return Ok(()) };
    for (field, v) in object {
        let word = kebab(field);
        let at = if path.is_empty() { word.clone() } else { format!("{path}.{word}") };
        if has_shape(field, Shape::Object) && !v.is_object() {
            return Err(format!(
                "{name}: {at} takes a member list — {word} [score 1 value \"x\"] — got {}.",
                describe(Some(v))
            ));
        }
        // An answer's value is a string, number or list, never a member list.
        if field == "valid_response" || field == "alt_responses" {
            let sets: Vec<&Json> = match v {
                Json::Array(sets) => sets.iter().collect(),
                one => vec![one],
            };
            for (i, set) in sets.iter().enumerate() {
                if set.is_object() && set.get("value").is_some_and(Json::is_object) {
                    let here = if v.is_array() { format!("{at}[{}]", i + 1) } else { at.clone() };
                    return Err(format!(
                        "{name}: {here}.value is a member list, but a value is a string, number or list — write {word} [score 1 value \"x\"], not {word} [score 1 value [score 1 value \"x\"]]."
                    ));
                }
            }
        }
        if has_shape(field, Shape::ObjectArray) {
            match v {
                Json::Array(entries) if entries.iter().all(Json::is_object) => {
                    for (i, entry) in entries.iter().enumerate() {
                        check_member_shapes(name, entry, &format!("{at}[{}]", i + 1))?;
                    }
                }
                _ => {
                    return Err(format!(
                        "{name}: {at} takes a list of member lists — {word} [[score 1 value \"x\"]] — got {}.",
                        describe(Some(v))
                    ));
                }
            }
            continue;
        }
        check_member_shapes(name, v, &at)?;
    }
    Ok(())
}

/// Learnosity needs both a scoring type and a valid response to score a question; with either
/// missing it renders and silently scores nobody. The scoring type is defaulted (its articles
/// document a default its scorer does not apply); the answer cannot be.
fn apply_scoring(name: &str, merged: &mut Object) -> Result<(), String> {
    let Some(allowed) = scoring_types(name) else { return Ok(()) };
    let Some(Json::Object(validation)) = merged.get("validation") else {
        return Err(format!(
            "{name}: needs a `validation` to be scorable — without one Learnosity renders the question but scores every response as unattempted."
        ));
    };
    let given = validation.get("scoring_type");
    if let Some(given) = given
        && !given.as_str().is_some_and(|given| allowed.contains(&given))
    {
        return Err(format!(
            "{name}: scoring-type \"{}\" is not supported — use one of {}.",
            js_string(given),
            allowed.join(", ")
        ));
    }
    if validation.get("valid_response").is_none_or(Json::is_null) {
        return Err(format!(
            "{name}: `validation` has no `valid-response`. There is nothing for Learnosity to score against, so every response is marked unattempted."
        ));
    }
    if given.is_none() {
        let mut scored = Object::new();
        scored.insert("scoring_type".into(), json!(allowed[0]));
        scored.extend(validation.clone());
        merged.insert("validation".into(), Json::Object(scored));
    }
    Ok(())
}

/// The scoring methods, one Author Guide article each. One Learnosity does not recognise
/// scores every response 0 while the item still renders.
const MATH_METHODS: &[&str] = &[
    "equivLiteral",
    "equivSymbolic",
    "equivValue",
    "equivSyntax",
    "stringMatch",
    "isSimplified",
    "isFactorised",
    "isExpanded",
    "isUnit",
    "isTrue",
];

/// The forms `equivSyntax` compares against, each optionally followed by a digit count.
const SYNTAX_RULES: &[&str] = &[
    "\\number",
    "\\integer",
    "\\decimal",
    "\\scientific",
    "\\variable",
    "\\fraction",
    "\\simpleFraction",
    "\\mixedFraction",
    "\\fractionOrDecimal",
];

/// A syntax rule without its digit count: `\decimal3`, `\decimal {3}` → `\decimal`.
fn without_count(syntax: &str) -> &str {
    let chars: Vec<(usize, char)> = syntax.char_indices().collect();
    let mut end = chars.len();
    let back = |end: &mut usize, test: &dyn Fn(char) -> bool| {
        while *end > 0 && test(chars[*end - 1].1) {
            *end -= 1;
        }
    };
    let mut at = end;
    back(&mut at, &|c| c.is_whitespace());
    if at > 0 && chars[at - 1].1 == '}' {
        at -= 1;
    }
    back(&mut at, &|c| c.is_whitespace());
    let digits_end = at;
    back(&mut at, &|c| c.is_ascii_digit());
    if at == digits_end {
        return syntax.trim();
    }
    back(&mut at, &|c| c.is_whitespace());
    if at > 0 && chars[at - 1].1 == '{' {
        at -= 1;
    }
    back(&mut at, &|c| c.is_whitespace());
    end = at;
    let cut = chars.get(end).map_or(syntax.len(), |(offset, _)| *offset);
    syntax[..cut].trim()
}

fn check_syntax_rule(name: &str, rule: &Json, path: &str) -> Result<(), String> {
    let Some(syntax) = rule.get("options").and_then(|options| options.get("syntax")).and_then(Json::as_str) else {
        return Ok(());
    };
    if SYNTAX_RULES.contains(&without_count(syntax)) {
        return Ok(());
    }
    let at = if path.is_empty() { String::new() } else { format!(" (at {path})") };
    Err(format!(
        "{name}: \"{syntax}\" is not an equivSyntax rule{at}. Learnosity accepts {}, each optionally followed by a digit count — e.g. \"\\\\decimal3\". An unrecognised rule scores every response 0 without reporting anything.",
        SYNTAX_RULES.join(", ")
    ))
}

fn check_methods(name: &str, value: Option<&Json>, path: &str) -> Result<(), String> {
    match value {
        Some(Json::Array(items)) => {
            for (n, item) in items.iter().enumerate() {
                check_methods(name, Some(item), &format!("{path}[{n}]"))?;
            }
            Ok(())
        }
        Some(rule @ Json::Object(object)) => {
            if let Some(Json::String(method)) = object.get("method")
                && !MATH_METHODS.contains(&method.as_str())
            {
                let at = if path.is_empty() { String::new() } else { format!(" (at {path})") };
                return Err(format!(
                    "{name}: \"{method}\" is not a scoring method{at}. Learnosity accepts {}.",
                    MATH_METHODS.join(", ")
                ));
            }
            check_syntax_rule(name, rule, path)?;
            for (key, v) in object {
                // `options` holds the method's own settings, not nested rules.
                if key != "options" {
                    let at = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                    check_methods(name, Some(v), &at)?;
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// A cloze blank is placed by `template`; `stimulus` is the prompt above it.
fn check_cloze_template(name: &str, attrs: &Object) -> Result<(), String> {
    let stimulus = attrs.get("stimulus").and_then(Json::as_str);
    let template = attrs.get("template").and_then(Json::as_str);
    if stimulus.is_some_and(|stimulus| stimulus.contains("{{response}}")) {
        return Err(format!(
            "{name}: `stimulus` contains {{{{response}}}}, which does nothing — only `template` is scanned for blanks. Put the prompt in `stimulus` and the text the learner completes in `template`, e.g. stimulus \"Complete the sentence.\" template \"The {{{{response}}}} is ...\"."
        ));
    }
    if template.is_some_and(|template| !template.contains("{{response}}")) {
        return Err(format!(
            "{name}: `template` contains no {{{{response}}}}, so the question renders with no blank for the learner to fill in. Each {{{{response}}}} in the template becomes one blank, at that position."
        ));
    }
    if let Some(stimulus) = stimulus {
        let tail = stripped_tail(stimulus);
        if !tail.is_empty() && dangles(tail) {
            let units: Vec<u16> = tail.encode_utf16().collect();
            let shown = if units.len() > 24 {
                format!("…{}", String::from_utf16_lossy(&units[units.len() - 24..]))
            } else {
                tail.to_owned()
            };
            return Err(format!(
                "{name}: `stimulus` ends mid-expression, on \"{shown}\". A stimulus is a complete prompt — it is not continued by the blank, which renders from `template` and, on most types, on its own line. Move the expression the learner completes into `template` and put the blank where the answer goes, e.g. template \"\\(x + 3 = 7\\). \\(x =\\) {{{{response}}}}\"."
            ));
        }
    }
    Ok(())
}

/// The text without what trails its last meaningful character: white space, LaTeX and HTML
/// closers, sentence punctuation. So `\(x =\)` is judged on its `=`.
fn stripped_tail(text: &str) -> &str {
    let mut out = text;
    loop {
        let next = strip_noise(out);
        if next.len() == out.len() {
            return out;
        }
        out = next;
    }
}

/// Removes the longest run of trailing noise that starts as early as possible, as the
/// TypeScript's anchored regular expression does.
fn strip_noise(text: &str) -> &str {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let n = chars.len();
    // ends[i]: the suffix from character i is made of noise tokens.
    let mut ends = vec![false; n + 1];
    ends[n] = true;
    for i in (0..n).rev() {
        let c = chars[i].1;
        let next = |len: usize| i + len <= n && ends[i + len];
        ends[i] = match c {
            c if crate::text::is_space(c) => next(1),
            '$' | '.' | ',' | ';' | ':' | '!' | '?' => next(1),
            '\\' => i + 1 < n && matches!(chars[i + 1].1, ')' | ']') && next(2),
            '<' => chars[i + 1..].iter().position(|(_, c)| *c == '>').is_some_and(|close| next(close + 2)),
            _ => false,
        };
    }
    match (0..n).find(|&i| ends[i]) {
        Some(start) => &text[..chars[start].0],
        None => text,
    }
}

/// Whether text ends on a relation or operator with nothing after it, as an expression waiting
/// for its answer does.
fn dangles(tail: &str) -> bool {
    const COMMANDS: &[&str] =
        &["times", "div", "pm", "cdot", "approx", "lt", "gt", "le", "ge", "ne", "leq", "geq", "neq"];
    tail.ends_with(['=', '+', '-', '*', '/', '<', '>', '×', '÷', '±', '·'])
        || COMMANDS.iter().any(|command| tail.ends_with(&format!("\\{command}")))
}

/// Unicode math characters, which render as inert text, and the LaTeX to write instead.
fn unicode_math(c: char) -> Option<&'static str> {
    Some(match c {
        '×' => "\\times",
        '÷' => "\\div",
        '−' => "-",
        '⋅' | '∙' => "\\cdot",
        '≤' => "\\le",
        '≥' => "\\ge",
        '≠' => "\\ne",
        '≈' => "\\approx",
        '≡' => "\\equiv",
        '±' => "\\pm",
        '∓' => "\\mp",
        '√' => "\\sqrt{...}",
        '∞' => "\\infty",
        '∑' => "\\sum",
        '∏' => "\\prod",
        '∫' => "\\int",
        '∂' => "\\partial",
        '∈' => "\\in",
        '∉' => "\\notin",
        '⊂' => "\\subset",
        '∪' => "\\cup",
        '∩' => "\\cap",
        '→' => "\\to",
        '⇒' => "\\Rightarrow",
        '↔' => "\\leftrightarrow",
        '½' => "\\frac{1}{2}",
        '¼' => "\\frac{1}{4}",
        '¾' => "\\frac{3}{4}",
        '²' => "^2",
        '³' => "^3",
        '⁴' => "^4",
        'π' => "\\pi",
        'θ' => "\\theta",
        'α' => "\\alpha",
        'β' => "\\beta",
        'Δ' => "\\Delta",
        'Σ' => "\\Sigma",
        'Ω' => "\\Omega",
        _ => return None,
    })
}

/// Whether text holds a MathML element (`<math`, in any case, then a space, `>` or `/`).
fn has_mathml(text: &str) -> bool {
    text.match_indices('<').any(|(at, _)| {
        let rest = text[at + 1..].trim_start_matches(crate::text::is_space);
        rest.len() >= 4
            && rest.is_char_boundary(4)
            && rest[..4].eq_ignore_ascii_case("math")
            && rest[4..].chars().next().is_some_and(|c| crate::text::is_space(c) || c == '>' || c == '/')
    })
}

/// Math is LaTeX, always: Learnosity's fields are HTML with MathJax set up for LaTeX, so MathML
/// does not typeset and Unicode math is inert text. A raw tab, newline or carriage return is
/// what a single-backslash `\times`, `\ne` or `\right` becomes in a string literal.
fn check_math_encoding(name: &str, attrs: &Object) -> Result<(), String> {
    for field in ["stimulus", "template", "stimulus_review"] {
        let Some(Json::String(value)) = attrs.get(field) else { continue };
        let at = kebab(field);
        for (c, hint) in [
            ('\t', "\\t (e.g. \\times, \\theta, \\text)"),
            ('\n', "\\n (e.g. \\ne, \\neq, \\nu)"),
            ('\r', "\\r (e.g. \\rightarrow, \\rho, \\right)"),
        ] {
            if value.contains(c) {
                let shown = serde_json::to_string(&c.to_string()).expect("a string serializes");
                return Err(format!(
                    "{name}: `{at}` contains a raw {shown}, which is what a single-backslash LaTeX command turns into — the string literal reads {hint} as an escape and eats the backslash. Write every backslash doubled: \"\\\\times\", \"\\\\(\", \"\\\\frac{{1}}{{2}}\"."
                ));
            }
        }
        if has_mathml(value) {
            return Err(format!(
                "{name}: `{at}` contains MathML, which Learnosity does not typeset — its fields are HTML with MathJax configured for LaTeX. Write the expression as LaTeX between \\\\( and \\\\) instead."
            ));
        }
        if let Some((c, latex)) = value.chars().find_map(|c| unicode_math(c).map(|latex| (c, latex))) {
            return Err(format!(
                "{name}: `{at}` contains the Unicode math character \"{c}\", which renders as inert text — it is not typeset, does not align with surrounding math, and cannot be scored as an expression. Write it as LaTeX between \\\\( and \\\\): \"{latex}\"."
            ));
        }
    }
    Ok(())
}

/// An embedded Graffiticode language's question, which does its own scoring.
fn build_custom(mut attrs: Object) -> Result<Object, String> {
    let lang = attrs.remove("lang");
    let data = attrs.remove("data");
    let Some(Json::String(lang)) = lang.filter(|lang| lang.as_str().is_some_and(|lang| !lang.is_empty())) else {
        return Err("custom requires lang to be a non-empty string (e.g. lang \"0179\").".to_owned());
    };
    let base = format!("https://l{lang}.graffiticode.org");
    let mut out = Object::new();
    out.insert("type".into(), json!("custom"));
    out.insert("custom_type".into(), json!(format!("custom_question_l{lang}")));
    out.insert(
        "js".into(),
        json!({ "question": format!("{base}/question.js"), "scorer": format!("{base}/scorer.js") }),
    );
    out.insert("css".into(), json!(format!("{base}/question.css")));
    out.extend(attrs);
    if let Some(data) = data {
        out.insert("data".into(), data);
    }
    Ok(out)
}

/// The `items` list's members: `params`, and the legacy `save-to-itembank` flag. Anything else
/// in the list is an item.
const ITEMS_MEMBERS: &[&str] = &["params", "save_to_itembank"];

/// What an `item` may hold: `metadata`, and what `questions [...] {}` contributes.
const ITEM_MEMBERS: &[&str] = &["type", "data", "templateVariablesRecords", "questionRefs", "metadata"];

/// Splits an `items` list into its items-level members and its items.
pub fn partition_items_list(entries: Vec<Json>) -> (Object, Vec<Json>) {
    let mut members = Object::new();
    let mut items = Vec::new();
    for entry in entries {
        match &entry {
            Json::Object(object)
                if object.len() == 1 && ITEMS_MEMBERS.contains(&object.keys().next().unwrap().as_str()) =>
            {
                members.extend(object.clone());
            }
            Json::Null => {}
            _ => items.push(entry),
        }
    }
    (members, items)
}

/// An attribute written on an item rather than in its question used to vanish in silence.
pub fn check_item_members(merged: &Object) -> Result<(), String> {
    let stray: Vec<&String> = merged.keys().filter(|key| !ITEM_MEMBERS.contains(&key.as_str())).collect();
    let Some(first) = stray.first() else { return Ok(()) };
    let names: Vec<String> = stray.iter().map(|key| format!("`{}`", kebab(key))).collect();
    Err(format!(
        "item: {} {} of `item`. An item takes `questions [...] {{}}` and `metadata`. Question attributes belong inside the question type — e.g. `questions [mcq [{} ...]] {{}}`, not on the item.",
        names.join(", "),
        if stray.len() == 1 { "is not a member" } else { "are not members" },
        kebab(first)
    ))
}

/// The same one level further out: an entry of the `items` list that is not an item.
pub fn check_items_entries(items: &[Json]) -> Result<(), String> {
    let stray: Vec<&Json> = items.iter().filter(|entry| entry.get("data").is_none_or(Json::is_null)).collect();
    if stray.is_empty() {
        return Ok(());
    }
    let names: Vec<String> = stray
        .iter()
        .flat_map(|entry| match entry {
            Json::Object(object) => object.keys().map(|key| format!("`{}`", kebab(key))).collect(),
            Json::Array(items) => (0..items.len()).map(|i| format!("`{i}`")).collect(),
            _ => Vec::new(),
        })
        .collect();
    let what = if names.is_empty() {
        "an entry in the items list is not an".to_owned()
    } else {
        format!("{} is not an", names.join(", "))
    };
    Err(format!(
        "items: {what} `item`. The items list takes `item [...]` entries plus `params` and `save-to-itembank`. Question attributes belong inside the question type, not at items level."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_syntax_rule_is_read_without_its_digit_count() {
        assert_eq!(without_count("\\decimal3"), "\\decimal");
        assert_eq!(without_count(" \\decimal {3} "), "\\decimal");
        assert_eq!(without_count("\\number"), "\\number");
        assert_eq!(without_count("\\fraction 12x"), "\\fraction 12x");
    }

    #[test]
    fn trailing_noise_is_stripped_as_the_regular_expression_strips_it() {
        assert_eq!(stripped_tail("Solve \\(x =\\)."), "Solve \\(x =");
        assert_eq!(stripped_tail("What is <b>x</b> ?"), "What is <b>x");
        assert_eq!(stripped_tail("a<b<c>"), "a");
        assert_eq!(stripped_tail("Total: $$"), "Total");
        assert!(dangles("x =") && dangles("2 \\times") && !dangles("x = 1"));
    }

    #[test]
    fn mathml_is_found_in_any_case() {
        assert!(has_mathml("<MATH>x</MATH>") && has_mathml("< math xmlns") && has_mathml("<math/>"));
        assert!(!has_mathml("<mathematics>") && !has_mathml("math"));
    }
}
