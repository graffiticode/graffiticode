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
//! The language holds no Learnosity credential. A result for the final consumer (`present`, and
//! every `/compile`) is signed through the broker, so it expires and is never cached; a result
//! for the next stage of a chain (`evaluate`) is never signed, and is a function of the program
//! and its input ([`Dialect::cacheable_in`], C6 part 2).

pub mod activities;
pub mod lowering;
pub mod plain;
pub mod protection;
pub mod questions;
pub mod text;

use std::borrow::Cow;
use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{
    Ast, Diagnostic, Dialect, Evaluator, Intent, Lexicon, Mode, Node, NodeId, Op, ProtectedFunction, Value,
};
use serde_json::{Value as Json, json};

use crate::plain::{Object, js_order, js_string, plain, truthy};
use crate::protection::is_brokered;

/// The words L0176 adds to the base lexicon, deprecated spellings included. Generated from the
/// TypeScript package by `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

/// Retired spellings (`deprecatedAliases` in `packages/core/src/lexicon.ts`). A saved source that
/// uses one still compiles, because the parser maps it onto the current word's AST name. But like
/// the TypeScript's published `lexicon.json` (`tools/build-static.js`), the lexicon served here
/// never advertises one: no autocomplete entry, no spec row, no generator prompt.
pub const DEPRECATED_WORDS: &[&str] = &["hot-text"];

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let mut additions: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    for word in DEPRECATED_WORDS {
        additions.remove(*word);
    }
    let additions = serde_json::from_value(serde_json::Value::Object(additions)).expect("the additions are a lexicon");
    Lexicon::base().merge(additions, &[], Some("L0176")).expect("L0176 redefines no base word")
});

/// L0176's published vocabulary: the base lexicon with the Learnosity words laid over it, without
/// the retired spellings in [`DEPRECATED_WORDS`].
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

/// How many times each save call site has run in this command's `start`: the ordinal in its
/// expansion key (C6).
#[derive(Default)]
struct SiteCounts(std::collections::HashMap<String, u64>);

/// The most saves one call site may make in a command (C6 plan, decision 6): a proposed limit,
/// not an existing one. Past it, policy refuses the bind and records the refusal, and the
/// command ends partial.
pub const MAX_SAVES_PER_SITE: u32 = 1000;

/// A save call site, as stable as the stored program: its source position, or its node id where
/// the parser gave none (nodes in a lambda body have no `coord`). The same stored program gives
/// the same sites on every compile.
pub fn save_site(ast: &Ast, id: NodeId) -> String {
    ast.span(id).map_or_else(|| format!("n{id}"), |span| span.from.to_string())
}

/// A save call site's intent id: `save:<site>` (policy accepts `[A-Za-z0-9_:.-]`).
pub fn save_intent_id(site: &str) -> String {
    format!("save:{site}")
}

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

    /// Gateway-only (plan system-preview-rate-limit): a no-connection preview is signed only for
    /// the api's verified compile, or with `SYSTEM_PREVIEW_DIRECT=1`; any other goes out
    /// unsigned, `gateway-only`, without asking policy.
    fn system_sessions_gateway_only(&self) -> bool {
        true
    }

    /// A compile carries a fresh, expiring signature.
    fn cacheable(&self) -> bool {
        false
    }

    /// Only `present` signs (C6 part 2, decision 1), so only `present` results (and every
    /// `/compile`'s, which is `present`) are `cache: false`, whatever they hold: an error or an
    /// unsigned result included, as the legacy API needs. An `evaluate` result is unsigned. (The
    /// kernel never caches a replay, whatever this says.)
    fn cacheable_in(&self, mode: Mode) -> bool {
        mode != Mode::Present
    }

    /// B6 (docs/b6-command-repair-plan.md decision 6): every save goes through
    /// `ExecContext::invoke`, the save's command branch runs in `Replay` (answered from its
    /// recorded result), and nothing in L0176 fetches on its own. Signing is `present`-only.
    fn materializes(&self) -> bool {
        true
    }

    /// One runtime-expanding intent per save call site (C6 plan, decision 1): a site may run any
    /// number of times (a callback under `map` repeats it, with or without a `LAMBDA` of its
    /// own), so no site is static.
    fn intents(&self, ast: &Ast) -> Vec<Intent> {
        ast.nodes()
            .filter_map(|(id, node)| match node {
                Node::Form { op, .. } if op.tag() == "SAVE_TO_ITEMBANK" => Some(Intent::expanding(
                    save_intent_id(&save_site(ast, id)),
                    protection::SAVE,
                    protection::SAVE_OP,
                    MAX_SAVES_PER_SITE,
                )),
                _ => None,
            })
            .collect()
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
    let item_bank = if cx.exec().mode() == Mode::Evaluate {
        // `evaluate` writes nothing (C6 part 2), with a connection or without: the save is
        // validated and reported beside the activity, and policy is never asked. (The kernel
        // refuses any protected call in `evaluate` too.)
        json!({ "skipped": "evaluate", "fn": protection::SAVE, "occurrence": key })
    } else if is_brokered(cx.exec()) || cx.exec().is_replay() {
        // A replay (B6, decision 6) takes the command branch with no session: the occurrence is
        // expanded exactly as the original's was, and the kernel answers the save from its
        // recorded result, or fails it. Nothing is written or asked.
        // A command's save is an expansion of its site's intent, keyed by the call's ordinal at
        // that site; a compile's is `<key>.<N>`, as always.
        let occurrence = if cx.exec().is_command() {
            let site = save_site(cx.ast(), id);
            let n = {
                let counts = &mut cx.exec().state::<SiteCounts>().0;
                let n = counts.entry(site.clone()).or_default();
                *n += 1;
                *n - 1
            };
            match cx.exec().expand(&save_intent_id(&site), &format!("{site}#{n}")) {
                Ok(occurrence) => occurrence,
                Err(error) => {
                    let diagnostic = protection::Failure::refused(&error, protection::SAVE).diagnostic(cx.exec());
                    cx.report_diagnostic(diagnostic);
                    return Value::Undefined;
                }
            }
        } else {
            cx.exec().next_occurrence(&key)
        };
        match protection::save(cx.exec(), &plan, occurrence).await {
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
/// session; unsigned, the activity with `signing: { unsigned, message }`. Anything but a
/// `{ type, data }` activity Broker would accept is a compile error, and a `request` it arrives
/// with is dropped and the activity signed afresh.
async fn init(cx: &mut Evaluator<'_>, id: NodeId, elts: &[NodeId]) -> Value {
    let before = cx.error_count();
    let activity = plain(&cx.eval_arg(id, elts, 0).await);
    if cx.error_count() > before {
        return Value::Undefined;
    }
    if is_author(activity.as_ref()) {
        fail(cx, AUTHOR_NOT_SUPPORTED);
        return Value::Undefined;
    }
    if let Some(refusal) = protection::activity_refusal(activity.as_ref()) {
        fail(cx, refusal);
        return Value::Undefined;
    }
    let Some(Json::Object(mut activity)) = activity else { return Value::Undefined };
    protection::without_signing(&mut activity);
    // A command saves; it doesn't sign (C6 plan, decision 3).
    if cx.exec().is_command() {
        activity.insert("signing".into(), json!({ "unsigned": "command" }));
        return value(activity);
    }
    // Data for the next stage is never signed (C6 part 2, decision 1): the activity, validated.
    // Only `present` signs, so neither does a replay (B6) or any mode added later.
    if cx.exec().mode() != Mode::Present {
        return value(activity);
    }
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
    // Only a `{ type, data }` activity. One arriving with a `request` (an old cached output,
    // signed elsewhere) is never passed through: its request is dropped and it is signed afresh.
    let Some(Json::Object(mut activity)) = activity else { return top };
    if !truthy(activity.get("type")) {
        return top;
    }
    let top = if protection::without_signing(&mut activity) { value(activity.clone()) } else { top };
    // A command saves; it doesn't sign (C6 plan, decision 3).
    if cx.exec().is_command() {
        activity.insert("signing".into(), json!({ "unsigned": "command" }));
        return value(activity);
    }
    // Data for the next stage is never signed (C6 part 2, decision 1): only the head's
    // `present` signs, so an `evaluate` result carries no `request` or `signing`, and neither
    // does a replay (B6) or any mode added later.
    if cx.exec().mode() != Mode::Present {
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
