// SPDX-License-Identifier: MIT

//! L0176 — Learnosity assessments. A program compiles to a Learnosity activity, signed for the
//! browser SDK by the credential broker, and can save its items to a Learnosity item bank.
//!
//! ```text
//! set-var "lrn-id" get-val-public "itemId"
//! items [item [questions [mcq [stimulus "…" options [[label "A" value "0"] …]
//!                              validation [valid-response [score 1 value ["0"]]]]] {}]] {}..
//! ```
//!
//! - [`questions`] — the question types and attribute words, and how a member list becomes a
//!   Learnosity object.
//! - [`activities`] — the `questions` and `items` activities, and their save plans.
//! - [`protection`] — signing and saving through policy and the broker.
//! - [`lowering`] — the legacy save member rewritten to the explicit save.
//! - [`plain`] — values as the JSON the rest works on.
//!
//! The language holds no Learnosity credential. A compile signs through the broker every time,
//! so its output expires and is never cached ([`Dialect::cacheable`]).

pub mod activities;
pub mod lowering;
pub mod plain;
pub mod protection;
pub mod questions;
pub mod text;

use std::borrow::Cow;
use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Diagnostic, Dialect, Evaluator, Lexicon, NodeId, Op, ProtectedFunction, Value};
use serde_json::{Value as Json, json};

use crate::plain::{Object, js_order, js_string, plain, truthy};
use crate::protection::is_brokered;

/// The words L0176 adds to the base lexicon, deprecated spellings included. Generated from the
/// TypeScript package by `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0176")).expect("L0176 redefines no base word")
});

/// L0176's vocabulary: the base lexicon with the Learnosity words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

pub const LANG_ID: &str = "0176";

const AUTHOR_NOT_SUPPORTED: &str = "Error: L0176 doesn't open the Learnosity Author Site. It makes items and activities for the item bank; to plan an Author API integration, which your own application signs, use L0177.";
const LEGACY_SAVE_MEMBER: &str = "Error: save-to-itembank wraps the activity to save: `save-to-itembank items [...] {}`. As an items-list member it is only accepted as the literal `save-to-itembank true`.";
const NOT_AN_ACTIVITY: &str =
    "Error: save-to-itembank must wrap an activity built by `items [...] {}` or `questions [...] {}`.";
const NO_ID: &str = "Error: set-var \"lrn-id\" must be set to a non-empty string before items is called.";

/// The activities this compile built, each with its save plan. `save-to-itembank` saves only
/// one of these: never a plan from program data, and never one another compile built.
#[derive(Default)]
struct SavePlans(Vec<(Json, Json)>);

pub struct L0176 {
    protected: Vec<(String, ProtectedFunction)>,
    implicit: Vec<ProtectedFunction>,
}

impl Default for L0176 {
    fn default() -> Self {
        Self { protected: protection::protected_functions(), implicit: protection::implicit_protected_functions() }
    }
}

impl L0176 {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl Dialect for L0176 {
    fn lang_id(&self) -> &str {
        LANG_ID
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    fn protected_functions(&self) -> &[(String, ProtectedFunction)] {
        &self.protected
    }

    fn implicit_protected_functions(&self) -> &[ProtectedFunction] {
        &self.implicit
    }

    fn registry_version(&self) -> Option<u32> {
        Some(protection::REGISTRY_VERSION)
    }

    /// The legacy save member becomes the explicit save before anything sees the program.
    fn normalize<'a>(&self, code: &'a Json) -> Result<Cow<'a, Json>, String> {
        Ok(lowering::lower_legacy_save(code))
    }

    /// Without a connection, previews sign through a system session and saves are skipped.
    fn degrades_without_connection(&self) -> bool {
        true
    }

    /// Every compile carries a fresh, expiring signature.
    fn cacheable(&self) -> bool {
        false
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        Some(match tag {
            "PROG" => prog(cx, id).await,
            // Defined for compatibility; it is the value it is given.
            "HELLO" => cx.eval_arg(id, elts, 0).await,
            "INIT" => init(cx, id, elts).await,
            "ITEMS" => items(cx, id, elts).await,
            "ITEM" => item(cx, id, elts).await,
            "QUESTIONS" => questions_block(cx, id, elts).await,
            "SAVE_TO_ITEMBANK" => save_to_itembank(cx, id, elts).await,
            tag if questions::is_question_type(tag) => question(cx, id, tag, elts).await,
            tag => match questions::member(tag) {
                Some((field, shape)) => member(cx, id, elts, field, shape).await,
                None => return None,
            },
        })
    }
}

fn fail(cx: &mut Evaluator<'_>, message: impl Into<String>) {
    cx.report_diagnostic(Diagnostic::new(message));
}

fn value(object: Object) -> Value {
    Value::from_json(&js_order(Json::Object(object)))
}

/// Where a protected call was written, as its occurrence key: the same node in a retried
/// compile of the same program gets the same key. Policy accepts `[A-Za-z0-9_:.-]`.
fn occurrence_key(cx: &Evaluator<'_>, id: NodeId, tag: &str) -> String {
    let from = cx.ast().span(id).map_or_else(|| "-".to_owned(), |span| span.from.to_string());
    format!("{tag}:{from}")
}

/// The id `set-var "lrn-id"` gave, if any.
fn lrn_id(cx: &Evaluator<'_>) -> Option<String> {
    let id = cx.var("lrn-id").and_then(plain);
    truthy(id.as_ref()).then(|| js_string(id.as_ref().unwrap()))
}

/// The entries of an `items` or `questions` list.
fn entries(list: Option<Json>) -> Vec<Json> {
    match list {
        Some(Json::Array(entries)) => entries,
        Some(Json::Object(object)) if object.get("list").is_some_and(|list| !list.is_null()) => match &object["list"] {
            Json::Array(entries) => entries.clone(),
            one => vec![one.clone()],
        },
        Some(one) => vec![one],
        None => Vec::new(),
    }
}

/// A value's fields as JavaScript's object spread gives them.
fn spread(json: Option<Json>) -> Object {
    match json {
        Some(Json::Object(object)) => object,
        Some(Json::Array(items)) => items.into_iter().enumerate().map(|(i, item)| (i.to_string(), item)).collect(),
        Some(Json::String(text)) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), json!(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Object::new(),
    }
}

fn is_author(json: Option<&Json>) -> bool {
    json.and_then(|json| json.get("type")).is_some_and(|kind| kind == "author")
}

/// An attribute word: its one-field object.
async fn member(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId], field: &str, shape: questions::Shape) -> Value {
    let raw = plain(&cx.eval_arg(id, elts, 0).await);
    match questions::member_value(field, shape, raw) {
        Ok(object) => value(object),
        Err(message) => {
            fail(cx, message);
            value(Object::new())
        }
    }
}

/// A question type: its member list, merged and built.
async fn question(cx: &mut Evaluator<'_>, id: NodeId, tag: &str, elts: &[NodeId]) -> Value {
    let before = cx.error_count();
    let members = cx.eval_arg(id, elts, 0).await;
    if cx.error_count() > before {
        return Value::Null;
    }
    let built = questions::merge_members(plain(&members).as_ref(), &questions::keyword(tag))
        .and_then(|attrs| questions::build(tag, attrs));
    match built {
        Ok(question) => value(question),
        Err(message) => {
            fail(cx, message);
            Value::Undefined
        }
    }
}

/// `item [...]`: a member list like a question's, since `metadata` is a member at both levels.
async fn item(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
    let members = plain(&cx.eval_arg(id, elts, 0).await);
    match questions::merge_members(members.as_ref(), "item").and_then(|merged| {
        questions::check_item_members(&merged)?;
        Ok(merged)
    }) {
        Ok(merged) => value(merged),
        Err(message) => {
            fail(cx, message);
            value(Object::new())
        }
    }
}

/// Keeps a built activity's save plan for this compile, and gives the activity as a value.
fn built(cx: &mut Evaluator<'_>, continuation: Option<Json>, built: activities::Built) -> Value {
    let mut activity = spread(continuation);
    activity.extend(built.activity);
    let activity = js_order(Json::Object(activity));
    cx.exec().state::<SavePlans>().0.push((activity.clone(), built.save_plan));
    Value::from_json(&activity)
}

/// `items [...] {}`: items-level members (`params`) beside the `item` entries; the trailing
/// record is spread onto the activity.
async fn items(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
    let before = cx.error_count();
    let list = plain(&cx.eval_arg(id, elts, 0).await);
    let continuation = plain(&cx.eval_arg(id, elts, 1).await);
    let (members, items) = questions::partition_items_list(entries(list));
    let Some(batch) = lrn_id(cx) else {
        fail(cx, NO_ID);
        return Value::Undefined;
    };
    if items.is_empty() {
        fail(cx, "items: no `item` entries — an items list needs at least one item.");
        return Value::Undefined;
    }
    // A failed entry would leave a hole in the list.
    if cx.error_count() > before {
        return Value::Undefined;
    }
    if let Err(message) = questions::check_items_entries(&items) {
        fail(cx, message);
        return Value::Undefined;
    }
    // A save flag that survived lowering was not the literal member form. Only
    // `save-to-itembank <activity>` writes.
    if members.contains_key("save_to_itembank") {
        fail(cx, LEGACY_SAVE_MEMBER);
        return Value::Undefined;
    }
    match activities::create_items(&items, members.get("params"), &batch) {
        Ok(activity) => built(cx, continuation, activity),
        Err(message) => {
            fail(cx, format!("Error: {message}"));
            Value::Undefined
        }
    }
}

/// `questions [...] {}`: the questions as one activity.
async fn questions_block(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
    let before = cx.error_count();
    let list = plain(&cx.eval_arg(id, elts, 0).await);
    let continuation = plain(&cx.eval_arg(id, elts, 1).await);
    let (members, questions) = questions::partition_items_list(entries(list));
    let Some(batch) = lrn_id(cx) else { return value(Object::new()) };
    if cx.error_count() > before {
        return value(Object::new());
    }
    if members.contains_key("save_to_itembank") {
        fail(cx, LEGACY_SAVE_MEMBER);
        return value(Object::new());
    }
    built(cx, continuation, activities::create_questions(questions, &batch))
}

/// The item-bank write. Its argument must be an activity this compile built; the plan is that
/// build's, never program data, and nothing else in the language writes.
async fn save_to_itembank(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
    let before = cx.error_count();
    let activity = plain(&cx.eval_arg(id, elts, 0).await);
    if cx.error_count() > before {
        return Value::Undefined;
    }
    let plan = activity.as_ref().filter(|activity| activity.is_object()).and_then(|activity| {
        cx.exec().state::<SavePlans>().0.iter().find(|(built, _)| built == activity).map(|(_, plan)| plan.clone())
    });
    let (Some(Json::Object(activity)), Some(plan)) = (activity.clone(), plan) else {
        fail(cx, if matches!(activity, Some(Json::Bool(_))) { LEGACY_SAVE_MEMBER } else { NOT_AN_ACTIVITY });
        return Value::Undefined;
    };
    let key = occurrence_key(cx, id, "SAVE_TO_ITEMBANK");
    let item_bank = if is_brokered(cx.exec()) {
        match protection::save(cx.exec(), &plan, &key).await {
            Ok(item_bank) => item_bank,
            Err(failure) => {
                let diagnostic = failure.diagnostic(cx.exec());
                cx.report_diagnostic(diagnostic);
                return Value::Undefined;
            }
        }
    } else {
        // No connection, no authority to write. The save is validated and reported beside the
        // activity, so a valid program still compiles and its preview still renders.
        json!({ "skipped": "no-connection", "fn": protection::SAVE, "occurrence": key })
    };
    let mut activity = activity;
    let mut data = spread(activity.get("data").cloned());
    data.insert("itemBank".into(), item_bank);
    activity.insert("data".into(), Json::Object(data));
    value(activity)
}

/// `init <activity>`: the signed request. Without a connection, signed through the system
/// session; unsigned, the activity with `signing: { unsigned, message }`.
async fn init(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
    let activity = plain(&cx.eval_arg(id, elts, 0).await);
    if is_author(activity.as_ref()) {
        fail(cx, AUTHOR_NOT_SUPPORTED);
        return Value::Undefined;
    }
    let Some(Json::Object(activity)) = activity else { return Value::Undefined };
    let key = occurrence_key(cx, id, "INIT");
    if is_brokered(cx.exec()) {
        return match protection::sign(cx.exec(), &activity, &key).await {
            Ok(Some(request)) => Value::from_json(&js_order(request)),
            Ok(None) => Value::Undefined,
            Err(failure) => {
                let diagnostic = failure.diagnostic(cx.exec());
                cx.report_diagnostic(diagnostic);
                Value::Undefined
            }
        };
    }
    if !matches!(activity.get("type").and_then(Json::as_str), Some("questions" | "items")) {
        return Value::Undefined;
    }
    let mut signed = protection::sign_preview(cx.exec(), LANG_ID, activity, &key).await;
    match signed.remove("request") {
        Some(request) if !request.is_null() => Value::from_json(&js_order(request)),
        _ => value(signed),
    }
}

/// The program's value, signed for rendering: the shared View issues one `POST /compile` and
/// hands the result to the form, so the output must already carry a signed `request`.
async fn prog(cx: &mut Evaluator<'_>, id: NodeId) -> Value {
    let before = cx.error_count();
    let top = cx.eval_kernel(id).await;
    // A failed compile is not signed.
    if cx.error_count() > before {
        return top;
    }
    let activity = plain(&top);
    if is_author(activity.as_ref()) {
        fail(cx, AUTHOR_NOT_SUPPORTED);
        return Value::Undefined;
    }
    // Only a `{ type, data }` activity not already signed.
    let Some(Json::Object(activity)) = activity else { return top };
    if !truthy(activity.get("type")) || truthy(activity.get("request")) {
        return top;
    }
    if is_brokered(cx.exec()) {
        return match protection::sign(cx.exec(), &activity, "prog").await {
            Ok(Some(request)) if truthy(Some(&request)) => {
                let mut signed = activity;
                signed.insert("request".into(), request);
                value(signed)
            }
            Ok(_) => top,
            Err(failure) => {
                let diagnostic = failure.diagnostic(cx.exec());
                cx.report_diagnostic(diagnostic);
                Value::Undefined
            }
        };
    }
    // Only the two preview types are signed without a connection.
    if !matches!(activity.get("type").and_then(Json::as_str), Some("questions" | "items")) {
        return top;
    }
    value(protection::sign_preview(cx.exec(), LANG_ID, activity, "prog").await)
}
