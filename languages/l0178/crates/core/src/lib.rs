// SPDX-License-Identifier: MIT

//! L0178 — a Learnosity Data API cookbook. A program describes a data job (which operation,
//! what its request carries, how far a paged read goes); compiling checks it, reports its
//! holes, and records the exact API path of every field it sets. The recipe a developer
//! follows is produced from that by `get_spec`, not here.
//!
//! ```text
//! data-job paging EXHAUSTIVE
//!   items-get [ references ["Grade7_ELA_1021"] status ["published"] limit 50 {} ] {}..
//! ```
//!
//! A keyword names an operation, usually an (endpoint, action) pair. Property words only
//! collect: a field's legality and type depend on the operation it lands in, so everything is
//! checked at the operation's fold, and the job as a whole at `data-job`.

pub mod plain;
pub mod text;

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Dialect, Evaluator, Lexicon, NodeId, Op, Value};
use indexmap::IndexMap;
use serde_json::{Value as Json, json};

use crate::plain::{Object, js_order, js_string, plain, truthy};

/// The words L0178 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0178")).expect("L0178 redefines no base word")
});

/// L0178's vocabulary: the base lexicon with the data-job words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// The operations ("blocks"), the top-level properties and the paging policies, as
/// `packages/core/src/vocab.ts` declares them. `vocab.json` is generated from it; change the
/// vocabulary there and regenerate. A block stays JSON: it is carried through the job as the
/// TypeScript carries it, and read where it is used.
struct Vocab {
    blocks: IndexMap<String, Json>,
    paging_tags: IndexMap<String, String>,
    toplevel: Vec<String>,
}

static VOCAB: LazyLock<Vocab> = LazyLock::new(|| {
    let json: Json = serde_json::from_str(include_str!("vocab.json")).expect("the embedded vocabulary is valid");
    let object = |name: &str| json[name].as_object().cloned().unwrap_or_default();
    Vocab {
        blocks: object("blocks").into_iter().collect(),
        paging_tags: object("pagingTags").into_iter().map(|(tag, policy)| (tag, js_string(&policy))).collect(),
        toplevel: object("toplevel").keys().cloned().collect(),
    }
});

fn is_property(word: &str) -> bool {
    VOCAB.toplevel.iter().any(|name| name == word)
        || VOCAB.blocks.values().any(|block| block["fields"].get(word).is_some())
}

/// A node tag as the keyword it came from: `ITEMS_GET` is `items-get`.
fn keyword(tag: &str) -> String {
    tag.to_lowercase().replace('_', "-")
}

/// What the whole compile has found: the warnings, and every request field set with its
/// API path. Shared by every word, as the TypeScript's compile options are.
#[derive(Default)]
struct Findings {
    warnings: Vec<String>,
    paths: IndexMap<String, String>,
}

impl Findings {
    fn warn(&mut self, warning: impl Into<String>) {
        self.warnings.push(warning.into());
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct L0178;

#[async_trait]
impl Dialect for L0178 {
    fn lang_id(&self) -> &str {
        "0178"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        if tag == "PROG" {
            return Some(cx.eval_kernel(id).await);
        }
        let word = keyword(tag);
        Some(if word == "data-job" {
            let job = or_empty(plain(&cx.eval_arg(id, elts, 0).await));
            let findings = cx.exec().state::<Findings>();
            finalize(&job, findings)
        } else if let Some(block) = VOCAB.blocks.get(&word) {
            let list = plain(&cx.eval_arg(id, elts, 0).await);
            let rest = plain(&cx.eval_arg(id, elts, 1).await);
            let findings = cx.exec().state::<Findings>();
            let request = fold_block(&word, block, list, findings);
            let mut job = spread(or_empty(rest));
            job.insert("block".into(), block.clone());
            job.insert("request".into(), Json::Object(request));
            value(job)
        } else if is_property(&word) {
            let given = plain(&cx.eval_arg(id, elts, 0).await);
            let rest = plain(&cx.eval_arg(id, elts, 1).await);
            let mut chain = spread(or_empty(rest));
            if word == "paging" {
                // Design intent carried by a tag, not an API field: resolved here, since it
                // has no block to be scoped by.
                let findings = cx.exec().state::<Findings>();
                match paging_policy(given.as_ref(), findings) {
                    Some(policy) => chain.insert(word, json!(policy)),
                    None => chain.shift_remove(&word),
                };
            } else {
                chain.insert(word, given.unwrap_or(Json::Null));
            }
            value(chain)
        } else {
            return None;
        })
    }
}

fn value(object: Object) -> Value {
    Value::from_json(&js_order(Json::Object(object)))
}

fn or_empty(json: Option<Json>) -> Json {
    match json {
        Some(json) if truthy(Some(&json)) => json,
        _ => json!({}),
    }
}

/// A value's fields as JavaScript's `Object.entries` gives them.
fn entries(json: &Json) -> Vec<(String, Json)> {
    match json {
        Json::Object(object) => object.iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Json::Array(items) => items.iter().enumerate().map(|(i, item)| (i.to_string(), item.clone())).collect(),
        Json::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), json!(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Vec::new(),
    }
}

fn spread(json: Json) -> Object {
    entries(&json).into_iter().collect()
}

fn listed(json: Option<&Json>) -> Vec<Json> {
    match json {
        Some(Json::Array(items)) => items.clone(),
        None | Some(Json::Null) => Vec::new(),
        Some(one) => vec![one.clone()],
    }
}

fn keys(json: &Json) -> Vec<String> {
    json.as_object().map(|object| object.keys().cloned().collect()).unwrap_or_default()
}

fn paging_policy(given: Option<&Json>, findings: &mut Findings) -> Option<String> {
    let tag = match given {
        Some(Json::Object(object)) if object.contains_key("tag") => object.get("tag"),
        other => other,
    };
    let policy = tag.and_then(Json::as_str).and_then(|tag| VOCAB.paging_tags.get(tag)).cloned();
    if policy.is_none() {
        let written = tag.map_or_else(|| "undefined".to_owned(), js_string);
        let tags: Vec<&str> = VOCAB.paging_tags.keys().map(String::as_str).collect();
        findings.warn(format!("paging: {written} isn't a paging policy — use {}.", tags.join(" or ")));
    }
    policy
}

/// Checks one field's value against its type. `field` is `[path, type, constraint?]`.
fn check_value(name: &str, field: &Json, value: Option<&Json>, findings: &mut Findings) -> Option<Json> {
    let kind = field[1].as_str().unwrap_or_default();
    let c = &field[2];
    let values: Option<Vec<&str>> =
        c["values"].as_array().map(|values| values.iter().filter_map(Json::as_str).collect());
    let in_range = |v: &Json| values.as_ref().is_none_or(|values| v.as_str().is_some_and(|v| values.contains(&v)));
    let range_warning = |v: &Json| {
        let accepted: Vec<String> = values.iter().flatten().map(|value| format!("\"{value}\"")).collect();
        format!("{name}: {} isn't one of {}.", serde_json::to_string(v).expect("JSON serializes"), accepted.join(", "))
    };
    let max_entries = c["maxEntries"].as_f64().filter(|max| *max != 0.0);
    match kind {
        // Learnosity's TagsV2, written as records so the job mirrors the payload.
        "tags" => {
            let mut out = Vec::new();
            for tag in listed(value) {
                let Json::Object(tag) = tag else {
                    findings.warn(format!(
                        "{name}: each tag must be a record like {{type: \"subject\", name: \"English\"}}."
                    ));
                    continue;
                };
                let Some(kind) = tag.get("type").and_then(Json::as_str).filter(|kind| !text::trim(kind).is_empty())
                else {
                    findings.warn(format!(
                        "{name}: every tag needs a \"type\" string — e.g. {{type: \"subject\", name: \"English\"}}."
                    ));
                    continue;
                };
                let named = tag.get("name");
                if !matches!(named, None | Some(Json::String(_))) {
                    findings.warn(format!("{name}: a tag's \"name\" must be a string."));
                    continue;
                }
                for key in tag.keys().filter(|key| *key != "type" && *key != "name") {
                    findings.warn(format!(
                        "{name}: \"{key}\" isn't part of a tag — a tag is {{type, name}}; \"name\" is optional and matches every name of that type when omitted."
                    ));
                }
                out.push(match named {
                    None => json!({ "type": kind }),
                    Some(named) => json!({ "type": kind, "name": named }),
                });
            }
            Some(Json::Array(out))
        }
        // Documented, deliberately not modelled: passed through, and said so.
        "unmodeled" => {
            findings.warn(format!(
                "{name}: passed through unchecked. It carries item CONTENT, which this dialect does not model — compose it where the content lives and hand it through. Nothing here validates its shape."
            ));
            value.cloned()
        }
        // A list of records, each key checked against the element schema.
        "records" => {
            let schema = &c["schema"];
            let required: Vec<&str> =
                c["required"].as_array().map(|r| r.iter().filter_map(Json::as_str).collect()).unwrap_or_default();
            let mut out = Vec::new();
            for record in listed(value) {
                let Json::Object(record) = record else {
                    let first = keys(schema).first().cloned().unwrap_or_else(|| "undefined".to_owned());
                    findings.warn(format!("{name}: each entry must be a record, e.g. {{{first}: …}}."));
                    continue;
                };
                let mut clean = Object::new();
                for (key, v) in record {
                    let Some(spec) = schema.get(&key) else {
                        findings.warn(format!(
                            "{name}: \"{key}\" isn't part of this record. Accepts: {}.",
                            keys(schema).join(", ")
                        ));
                        continue;
                    };
                    if let Some(checked) = check_value(&key, spec, Some(&v), findings) {
                        clean.insert(key, checked);
                    }
                }
                for key in &required {
                    if !clean.contains_key(*key) {
                        findings.warn(format!("{name}: every entry needs \"{key}\"."));
                    }
                }
                out.push(Json::Object(clean));
            }
            if let Some(max) = max_entries
                && out.len() as f64 > max
            {
                findings.warn(format!(
                    "{name}: {} entries exceeds the documented maximum of {}.",
                    out.len(),
                    js_string(&c["maxEntries"])
                ));
            }
            Some(Json::Array(out))
        }
        "strings" => {
            let list = listed(value);
            if !list.iter().all(Json::is_string) {
                findings.warn(format!("{name} must be a list of strings."));
            } else {
                for v in list.iter().filter(|v| !in_range(v)) {
                    findings.warn(range_warning(v));
                }
            }
            if let Some(max) = max_entries
                && list.len() as f64 > max
            {
                findings.warn(format!(
                    "{name}: {} entries exceeds the documented maximum of {}.",
                    list.len(),
                    js_string(&c["maxEntries"])
                ));
            }
            Some(Json::Array(list))
        }
        // A UTC Unix integer or an ISO 8601 string: only a third kind is wrong.
        "timestamp" => {
            if !matches!(value, Some(Json::Number(_) | Json::String(_))) {
                findings.warn(format!("{name} must be a UTC Unix timestamp (number) or an ISO 8601 datetime string."));
            }
            value.cloned()
        }
        "boolean" => {
            if !matches!(value, Some(Json::Bool(_))) {
                findings.warn(format!("{name} must be true or false."));
            }
            value.cloned()
        }
        "number" => {
            match value {
                Some(Json::Number(n)) => {
                    // Measured: the API clamps rather than rejects, so every page looks short
                    // and a loop that stops on a short page drops the rest.
                    if let Some(max) = c["max"].as_f64()
                        && n.as_f64().is_some_and(|n| n > max)
                    {
                        let (n, max) = (js_string(&Json::Number(n.clone())), js_string(&c["max"]));
                        findings.warn(format!(
                            "{name}: {n} exceeds the maximum of {max}. Learnosity silently clamps it — the request succeeds and returns {max} records with no error, so every page looks short and a loop that stops on a short page will drop the rest. Set {name} to {max} or less, and terminate the loop on this endpoint's own end-of-data signal rather than on page size."
                        ));
                    }
                }
                _ => findings.warn(format!("{name} must be a number.")),
            }
            value.cloned()
        }
        "string" => {
            match value {
                Some(v @ Json::String(_)) if !in_range(v) => findings.warn(range_warning(v)),
                Some(Json::String(_)) => {}
                _ => findings.warn(format!("{name} must be a string.")),
            }
            value.cloned()
        }
        _ => value.cloned(),
    }
}

/// Folds an operation's `[list]` into its request. A field the operation does not take is
/// warned about and dropped: it would go to Learnosity in a signed request body.
fn fold_block(word: &str, block: &Json, list: Option<Json>, findings: &mut Findings) -> Object {
    let elements = match list {
        Some(Json::Array(elements)) => elements,
        None | Some(Json::Null) => Vec::new(),
        Some(one) => vec![one],
    };
    let fields = &block["fields"];
    let mut request = Object::new();
    for element in elements.iter().filter(|e| truthy(Some(e)) && (e.is_object() || e.is_array())) {
        for (key, given) in entries(element) {
            let Some(field) = fields.get(&key) else {
                findings.warn(format!(
                    "{word}: \"{key}\" isn't a request field of this operation — dropped. Accepts: {}.",
                    keys(fields).join(", ")
                ));
                continue;
            };
            if let Some(checked) = check_value(&key, field, Some(&given), findings) {
                request.insert(key.clone(), checked);
            }
            findings.paths.insert(key, js_string(&field[0]));
        }
    }
    // The discriminant a branched operation always sends.
    for (key, fixed) in block["fixed"].as_object().into_iter().flatten() {
        request.insert(key.clone(), fixed[1].clone());
        findings.paths.insert(key.clone(), js_string(&fixed[0]));
    }
    // Rules the documentation states across fields.
    let set = |key: &str| request.contains_key(key);
    if set("advanced-tags-none") && !set("advanced-tags-all") && !set("advanced-tags-either") {
        findings.warn("advanced-tags-none can't be used on its own — Learnosity requires advanced-tags-all or advanced-tags-either in the same request.");
    }
    if set("authoring-workflow-states") && !set("authoring-workflow-reference") {
        findings.warn("authoring-workflow-states needs authoring-workflow-reference — the workflow reference is mandatory whenever authoring_workflow is part of the request.");
    }
    if set("next") {
        findings.warn("`next` is a cursor the API hands back in meta.next, not a value to author. Set a paging policy instead and let the procedure carry the token between requests.");
    }
    request
}

/// `data-job`: the operation's properties, the job's holes first, and the paths.
fn finalize(job: &Json, findings: &mut Findings) -> Value {
    let mut top = Object::new();
    for (key, given) in entries(job) {
        if !(VOCAB.toplevel.contains(&key) || matches!(key.as_str(), "block" | "request" | "paths")) {
            findings.warn(format!("\"{key}\" isn't a top-level data-job property."));
            continue;
        }
        top.insert(key, given);
    }
    let block = top.get("block").filter(|block| truthy(Some(block))).cloned();
    let request = top.get("request").filter(|request| truthy(Some(request))).cloned().unwrap_or_else(|| json!({}));
    let paging = top.get("paging").cloned();
    let flag = |name: &str| block.as_ref().is_some_and(|block| truthy(block.get(name)));
    let said = |name: &str| request.get(name).is_some();

    let mut holes: Vec<String> = Vec::new();
    let mut specificity: Vec<String> = Vec::new();
    if block.is_none() {
        let names: Vec<&str> = VOCAB.blocks.keys().map(String::as_str).collect();
        holes.push(format!("Which Data API operation? Use exactly one of: {}.", names.join(", ")));
    }
    // The centrepiece: a paged read that does not say how far it reads ships truncated, as a
    // valid 200 whose meta.records counts the page.
    if flag("paged") && paging.is_none() {
        holes.push("This read is paged and the design doesn't say how far it reads. Set `paging EXHAUSTIVE` to read the whole result set, or `paging SINGLE-PAGE` to deliberately take one page. Leaving it unsaid is how a truncated read ships: the response is a valid 200 either way, and meta.records counts the page you got, not the total that matched.".to_owned());
    }
    if let Some(block) = &block {
        let endpoint = js_string(&block["endpoint"]);
        let action = js_string(&block["action"]);
        if paging.as_ref().is_some_and(|paging| paging == "single-page") {
            specificity.push("`paging SINGLE-PAGE` returns at most one page. The result is not the full match set, and nothing in the response says so — meta.records counts what came back.".to_owned());
        }
        // A bank or pool chooses the container, not the contents, so it does not narrow.
        const NOT_FILTERS: &[&str] = &["limit", "next", "sort", "sort-field", "organisation-id", "item-pool-id"];
        let filters: Vec<String> = keys(&block["fields"])
            .into_iter()
            .filter(|f| !NOT_FILTERS.contains(&f.as_str()) && !f.starts_with("include-"))
            .collect();
        if flag("paged") && !filters.iter().any(|f| said(f)) {
            let named: Vec<&str> = filters.iter().take(4).map(String::as_str).collect();
            specificity.push(format!(
                "No filter is set, so this reads everything {endpoint} returns. Narrow it with {} or a mintime/maxtime window unless a full extract is what you want.",
                named.join(", ")
            ));
        }
        if flag("primaryBankDefault") && !said("organisation-id") {
            specificity.push(
                "No Item bank specified (`organisation-id`) — the consumer's primary Item bank is used.".to_owned(),
            );
        }
        // Write safety: every hazard here is silent.
        if flag("destructive") {
            specificity.push(format!(
                "This job DESTROYS data irreversibly. {endpoint} + {action} cannot be undone, the response carries only a job reference, and there is nothing to re-read afterwards to check what went. Confirm the target is what you mean BEFORE running it, not after."
            ));
        }
        if flag("writes") {
            let in_bank = endpoint.starts_with("itembank/");
            let (persists, rehearse) = if in_bank {
                (" to the Item bank", " Point it at a scratch bank until you have seen it do the right thing.")
            } else {
                ("", " Rehearse it against data you can afford to lose before pointing it at anything real.")
            };
            specificity.push(format!(
                "This job WRITES. {endpoint} + {action} persists{persists}, and the response does not echo what was written — re-read to confirm.{rehearse}"
            ));
            match block.get("writeSemantics").and_then(Json::as_str) {
                Some("replace") => specificity.push(format!(
                    "`{action}` on this endpoint REPLACES what is there — anything you do not send is cleared, not kept. To change one thing without losing the rest, send the whole picture, or use an operation on this endpoint that merges if one exists."
                )),
                Some("merge") => specificity.push(format!(
                    "`{action}` on this endpoint MERGES into what is there, so this adds without clearing. That is measured for this operation and does not generalise — the same endpoint's `set` replaces."
                )),
                Some(_) => {}
                None => specificity.push("Whether this REPLACES what is there or MERGES into it has NOT been established for this operation. Two endpoints were measured and both replace under `set` and merge under `update`, but they were both tag assignments, and this API has repeatedly turned out to differ per endpoint. Rehearse against data you can afford to lose and observe which it does before trusting it.".to_owned()),
            }
            let items: Vec<&Json> = request
                .get("items")
                .and_then(Json::as_array)
                .into_iter()
                .flatten()
                .filter(|entry| truthy(Some(entry)))
                .collect();
            if items.iter().any(|entry| entry.get("status").is_none()) {
                specificity.push("An Item written without `status` defaults to `unpublished`, and an unpublished Item cannot be used in an assessment. The write succeeds either way, so nothing tells you until delivery is empty — set `status` explicitly.".to_owned());
            }
            if items.iter().any(|entry| entry.get("new-reference").is_some()) {
                specificity.push("`new-reference` RENAMES the Item at `reference`. Anything referring to the old reference — activities, saved sessions, your own records — will no longer resolve.".to_owned());
            }
        }
        if !said("limit") && flag("paged") {
            specificity.push(
                "No `limit` set — Learnosity's default page size applies, and the documented maximum is 50.".to_owned(),
            );
        }
    }

    // Holes lead, specificity waits for them, and validity warnings always surface.
    let mut warnings: Vec<String> = Vec::new();
    if holes.is_empty() {
        warnings.extend(findings.warnings.iter().cloned());
        warnings.extend(specificity);
    } else {
        warnings.extend(holes.iter().cloned());
        warnings.extend(findings.warnings.iter().cloned());
    }

    let field = |name: &str| block.as_ref().and_then(|block| block.get(name)).cloned();
    let mut out = Object::new();
    let mut put = |key: &str, value: Option<Json>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    put("endpoint", field("endpoint"));
    put("action", field("action"));
    put("writes", field("writes"));
    put("write_semantics", field("writeSemantics"));
    put("paged", field("paged"));
    put("paging_end", field("pagingEnd"));
    put("async", field("async"));
    // Where an async operation is redeemed, and where its response holds the reference:
    // verified to differ per endpoint, so it is stated only when the block declares it.
    put(
        "poll_with",
        flag("async").then(|| {
            let mut poll = json!({ "endpoint": "jobs", "action": "get" });
            match field("asyncEnvelope").as_ref().and_then(Json::as_str) {
                Some("object") => poll["job_reference_at"] = json!("data.job_reference"),
                Some(_) => poll["job_reference_at"] = json!("data[0].job_reference"),
                None => {}
            }
            poll
        }),
    );
    put("paging", paging);
    put("request", Some(request));
    let paths: Object = findings.paths.iter().map(|(from, to)| (from.clone(), json!(to))).collect();
    put("paths", Some(Json::Object(paths)));
    put("complete", Some(json!(holes.is_empty())));
    put("warnings", Some(json!(warnings)));
    value(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vocabulary_loads() {
        assert_eq!(VOCAB.blocks.len(), 30);
        assert_eq!(VOCAB.blocks["items-get"]["pagingEnd"], "next-absent");
        assert_eq!(VOCAB.blocks["responses-get"]["pagingEnd"], "empty-page");
        assert_eq!(VOCAB.paging_tags["SINGLE-PAGE"], "single-page");
        // A block is never also a property: a keyword has one arity.
        assert!(VOCAB.blocks.keys().all(|block| !is_property(block)));
    }
}
