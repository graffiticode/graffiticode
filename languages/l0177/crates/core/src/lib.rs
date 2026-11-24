// SPDX-License-Identifier: MIT

//! L0177 — a Learnosity Author API integration oracle. A program describes an integration
//! design (which authoring view to embed in an app, and how it is configured); compiling
//! checks it, reports what it is missing, and records the exact Learnosity path of every key
//! it sets. The recipe a developer follows is produced from that by `get_spec`, not here.
//!
//! ```text
//! author-embed domain "lms.example.edu" user-id "u123" reference "item-1"
//!   item-edit [ item back true scoring true {} widget edit true delete false {} ] {}..
//! ```
//!
//! Property and member words only collect: whether a property is legal, and what type it
//! takes, depends on where it lands (`status` is a boolean on an item-list item and a list of
//! states under its filter), which a property cannot see. So everything is checked at the fold
//! — the view, the section, or `author-embed` itself — where the context is known. A field a
//! context does not define is warned about and dropped, never passed on: the Author API
//! ignores what it does not recognise, so it would look configured and do nothing.

pub mod plain;
pub mod text;
pub mod vocab;

use std::sync::LazyLock;

use async_trait::async_trait;
use graffiticode_l0000::{Dialect, Evaluator, Lexicon, NodeId, Op, Value};
use indexmap::IndexMap;
use serde_json::{Value as Json, json};

use crate::plain::{Object, js_order, js_string, plain, truthy};
use crate::vocab::{Field, Fields, vocab};

/// The words L0177 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0177")).expect("L0177 redefines no base word")
});

/// L0177's vocabulary: the base lexicon with the design words laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// A node tag as the keyword it came from: `ITEM_EDIT` is `item-edit`. The vocabulary's
/// keywords are lowercase-kebab, so the mapping is exact.
fn keyword(tag: &str) -> String {
    tag.to_lowercase().replace('_', "-")
}

/// What the whole compile has found so far: the warnings, and every config key set with its
/// Learnosity path. Like the TypeScript's compile options, it is shared by every word.
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
pub struct L0177;

#[async_trait]
impl Dialect for L0177 {
    fn lang_id(&self) -> &str {
        "0177"
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
        let vocab = vocab();
        Some(if word == "author-embed" {
            let design = or_empty(plain(&cx.eval_arg(id, elts, 0).await));
            let findings = cx.exec().state::<Findings>();
            finalize(&design, findings)
        } else if let Some(view) = vocab.views.get(&word) {
            let members = plain(&cx.eval_arg(id, elts, 0).await);
            let rest = plain(&cx.eval_arg(id, elts, 1).await);
            let findings = cx.exec().state::<Findings>();
            let config = fold_view(&word, view, members, findings);
            let mut design = spread(or_empty(rest));
            design.insert("mode".into(), json!(view.mode));
            design.insert("config".into(), Json::Object(config));
            value(design)
        } else if let Some(section) = vocab.sections.get(&word) {
            let chain = or_empty(plain(&cx.eval_arg(id, elts, 0).await));
            let rest = plain(&cx.eval_arg(id, elts, 1).await);
            let findings = cx.exec().state::<Findings>();
            let checked =
                check_fields(&chain, &section.fields, &word, findings, &word, &format!("config.{}", section.path));
            let mut design = spread(or_empty(rest));
            design.insert(word, Json::Object(checked));
            value(design)
        } else if vocab.is_member(&word) {
            let chain = or_empty(plain(&cx.eval_arg(id, elts, 0).await));
            value([("kind".to_owned(), json!(word)), ("value".to_owned(), chain)].into_iter().collect())
        } else if vocab.is_property(&word) {
            let given = plain(&cx.eval_arg(id, elts, 0).await);
            let rest = plain(&cx.eval_arg(id, elts, 1).await);
            let mut chain = spread(or_empty(rest));
            chain.insert(word, given.unwrap_or(Json::Null));
            value(chain)
        } else {
            return None;
        })
    }
}

fn value(object: Object) -> Value {
    Value::from_json(&js_order(Json::Object(object)))
}

/// A value, or an empty object for a falsy one, as `value || {}` gives it.
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

/// A value's fields as JavaScript's object spread gives them.
fn spread(json: Json) -> Object {
    entries(&json).into_iter().collect()
}

/// A value as a list: itself if it is one, nothing for a missing value, else a list of one.
fn listed(json: Option<&Json>) -> Vec<Json> {
    match json {
        Some(Json::Array(items)) => items.clone(),
        None | Some(Json::Null) => Vec::new(),
        Some(one) => vec![one.clone()],
    }
}

/// An enum value as written: a tag is its name.
fn tag_of(json: &Json) -> &Json {
    match json {
        Json::Object(object) if object.contains_key("tag") => &object["tag"],
        other => other,
    }
}

fn quoted(values: &[String]) -> String {
    values.iter().map(|value| format!("\"{value}\"")).collect::<Vec<_>>().join(", ")
}

/// Checks one property's value against its type, in the context that declared it, and gives
/// what the design keeps: the value itself, or for a list of tags, records, widgets or groups
/// the checked and normalized list.
fn check_value(name: &str, field: &Field, value: Option<&Json>, findings: &mut Findings) -> Option<Json> {
    let in_range = |v: &Json| {
        field.values.as_ref().is_none_or(|values| v.as_str().is_some_and(|v| values.iter().any(|ok| ok == v)))
    };
    let range_warning = |v: &Json| {
        format!(
            "{name}: {} isn't one of {}.",
            serde_json::to_string(v).expect("JSON serializes"),
            quoted(field.values.as_deref().unwrap_or_default())
        )
    };
    match field.kind.as_str() {
        // Normalized to group references; `finalize` turns the three picker properties into
        // the one restriction. An empty result stays an empty list: a restriction naming
        // nothing is unsatisfiable, and `finalize` must say so.
        "groups" => {
            let groups = &vocab().group_tags;
            let mut keep: Vec<Json> = Vec::new();
            for given in listed(value) {
                let tag = tag_of(&given);
                match tag.as_str().and_then(|tag| groups.get(tag)) {
                    Some(group) => {
                        if !keep.iter().any(|kept| kept == group) {
                            keep.push(json!(group));
                        }
                    }
                    None => findings.warn(format!(
                        "{name}: {} isn't a question-type group — use {}.",
                        js_string(tag),
                        groups.keys().cloned().collect::<Vec<_>>().join(", ")
                    )),
                }
            }
            Some(Json::Array(keep))
        }
        "templates" => {
            let vocab = vocab();
            let mut refs: Vec<Json> = Vec::new();
            for given in listed(value) {
                let tag = tag_of(&given);
                if let Some(template) = tag.as_str().and_then(|tag| vocab.picker_templates.get(tag)) {
                    if !refs.iter().any(|r| r == template.reference.as_str()) {
                        refs.push(json!(template.reference));
                    }
                    continue;
                }
                let kind = tag.as_str().and_then(|tag| vocab.widget_tags.get(tag));
                let variants: Vec<&str> = vocab
                    .picker_templates
                    .iter()
                    .filter(|(_, template)| kind.is_some_and(|kind| *kind == template.kind))
                    .map(|(tag, _)| tag.as_str())
                    .collect();
                let tag = js_string(tag);
                findings.warn(if variants.is_empty() {
                    format!(
                        "{name}: {tag} isn't a documented picker template — use tags like MCQ-STANDARD, CLOZE-DROPDOWN, CLOZE-TEXT, SHORT-TEXT."
                    )
                } else {
                    format!(
                        "{name}: {tag} is a question type, not a template — use allow-widgets for every template of a type, or name one of {}.",
                        variants.join(", ")
                    )
                });
            }
            Some(Json::Array(refs))
        }
        // A list of records checked against a schema, each key as a property.
        "records" => {
            let empty = Fields::new();
            let schema = field.schema.as_ref().unwrap_or(&empty);
            let keys = || schema.keys().cloned().collect::<Vec<_>>();
            let mut out = Vec::new();
            for record in listed(value) {
                let Json::Object(record) = record else {
                    let first = keys().first().cloned().unwrap_or_else(|| "undefined".to_owned());
                    findings.warn(format!("{name}: each entry must be a record, e.g. {{{first}: …}}."));
                    continue;
                };
                let mut clean = Object::new();
                for (key, v) in record {
                    let Some(spec) = schema.get(&key) else {
                        findings.warn(format!(
                            "{name}: \"{key}\" isn't part of this record. Accepts: {}.",
                            keys().join(", ")
                        ));
                        continue;
                    };
                    if spec.kind == "unmodeled" {
                        findings.warn(format!(
                            "{name}: \"{key}\" is a documented Learnosity option that L0177 doesn't model yet — it has been left out of the design rather than guessed at."
                        ));
                        continue;
                    }
                    if let Some(checked) = check_value(&key, spec, Some(&v), findings) {
                        clean.insert(key, checked);
                    }
                }
                out.push(Json::Object(clean));
            }
            Some(Json::Array(out))
        }
        "widgets" => {
            let widgets = &vocab().widget_tags;
            let mut mapped = Vec::new();
            for given in listed(value) {
                let tag = tag_of(&given);
                match tag.as_str().and_then(|tag| widgets.get(tag)) {
                    Some(widget) => mapped.push(json!(widget)),
                    None => findings.warn(format!(
                        "{name}: {} isn't a Learnosity widget type — use tags like MCQ, SHORT-TEXT, CLOZE-TEXT, FORMULA, TOKEN-HIGHLIGHT.",
                        js_string(tag)
                    )),
                }
            }
            Some(Json::Array(mapped))
        }
        // Learnosity's TagsV2: `{type, name?}`, `name` one string or several. Unknown keys are
        // dropped: the API fails open, so a misspelt one would silently narrow nothing.
        "tags" => {
            let mut out = Vec::new();
            for tag in listed(value) {
                let Json::Object(tag) = tag else {
                    findings.warn(format!("{name}: each tag must be a record like {{type: \"Grade\", name: \"4\"}}."));
                    continue;
                };
                let Some(kind) = tag.get("type").and_then(Json::as_str).filter(|kind| !text::trim(kind).is_empty())
                else {
                    findings.warn(format!(
                        "{name}: every tag needs a \"type\" string — e.g. {{type: \"Grade\", name: \"4\"}}."
                    ));
                    continue;
                };
                let named = tag.get("name");
                let name_ok = match named {
                    None | Some(Json::String(_)) => true,
                    Some(Json::Array(names)) => names.iter().all(Json::is_string),
                    Some(_) => false,
                };
                if !name_ok {
                    findings.warn(format!("{name}: a tag's \"name\" must be a string or a list of strings."));
                    continue;
                }
                for key in tag.keys().filter(|key| *key != "type" && *key != "name") {
                    findings.warn(format!(
                        "{name}: \"{key}\" isn't part of a tag — a tag is {{type, name}}; \"name\" is optional and matches every name when omitted."
                    ));
                }
                out.push(match named {
                    None => json!({ "type": kind }),
                    Some(named) => json!({ "type": kind, "name": named }),
                });
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
            Some(Json::Array(list))
        }
        kind => {
            match (kind, value) {
                ("boolean", v) if !matches!(v, Some(Json::Bool(_))) => {
                    findings.warn(format!("{name} must be true or false."))
                }
                ("number", v) if !matches!(v, Some(Json::Number(_))) => {
                    findings.warn(format!("{name} must be a number."))
                }
                ("string", v) if !matches!(v, Some(Json::String(_))) => {
                    findings.warn(format!("{name} must be a string."))
                }
                ("string", Some(v)) if !in_range(v) => findings.warn(range_warning(v)),
                _ => {}
            }
            value.cloned()
        }
    }
}

/// Checks a property chain against the fields legal in this context. A field that does not
/// belong is warned about and dropped: it would emit a config path Learnosity ignores.
fn check_fields(
    chain: &Json,
    fields: &Fields,
    label: &str,
    findings: &mut Findings,
    out_base: &str,
    lrn_base: &str,
) -> Object {
    let mut out = Object::new();
    for (key, given) in entries(chain) {
        let Some(field) = fields.get(&key) else {
            let accepts: Vec<&str> = fields.keys().map(String::as_str).collect();
            let accepts = if accepts.is_empty() {
                "It accepts no properties.".to_owned()
            } else {
                format!("Accepts: {}.", accepts.join(", "))
            };
            findings.warn(format!("{label}: \"{key}\" isn't a valid {label} property here. {accepts}"));
            continue;
        };
        // Nothing kept (a group list naming no group) is no field.
        if let Some(checked) = check_value(&key, field, Some(&given), findings) {
            out.insert(key.clone(), checked);
        }
        let path = field.path.as_deref().unwrap_or("null");
        findings.paths.insert(format!("{out_base}.{key}"), format!("{lrn_base}.{path}"));
    }
    out
}

/// Folds a view's `[members]` into its config, each in the context of this view.
fn fold_view(word: &str, view: &vocab::View, members: Option<Json>, findings: &mut Findings) -> Object {
    let elements = match members {
        Some(Json::Array(elements)) => elements,
        None | Some(Json::Null) => Vec::new(),
        Some(one) => vec![one],
    };
    let mut config = Object::new();
    for element in elements {
        if !truthy(Some(&element)) || !(element.is_object() || element.is_array()) {
            continue;
        }
        let kind = element.get("kind").filter(|kind| truthy(Some(kind))).cloned();
        let Some(kind) = kind else {
            // A bare property chain sets the view's own options: `limit 25 {}`.
            let checked =
                check_fields(&element, &view.view, word, findings, "config", &format!("config.{}", view.mode));
            config.extend(checked);
            continue;
        };
        let kind = js_string(&kind);
        // A view-level chain left unterminated swallows the member after it, and its
        // properties end up on the member's wrapper, where nothing reads them.
        let stray: Vec<String> = entries(&element)
            .into_iter()
            .map(|(key, _)| key)
            .filter(|key| key != "kind" && key != "value")
            .map(|key| format!("\"{key}\""))
            .collect();
        if !stray.is_empty() {
            findings.warn(format!(
                "{word}: {} ran into the \"{kind}\" member and would be dropped — terminate the property chain with {{}} before the next member.",
                stray.join(", ")
            ));
        }
        let Some(member) = view.members.get(&kind) else {
            findings.warn(format!(
                "{word}: \"{kind}\" isn't a member of this view — dropped. {word} accepts: {}.",
                view.members.keys().cloned().collect::<Vec<_>>().join(", ")
            ));
            continue;
        };
        let value = element.get("value").cloned().unwrap_or(Json::Null);
        let lrn_base = format!("config.{}.{}", view.mode, member.path);
        let checked = check_fields(&value, &member.fields, &kind, findings, &format!("config.{kind}"), &lrn_base);
        config.insert(kind, Json::Object(checked));
    }
    config
}

fn non_empty(json: Option<&Json>) -> bool {
    json.and_then(Json::as_str).is_some_and(|text| !text::trim(text).is_empty())
}

/// The question picker, resolved from the three properties that narrow it.
struct Picker {
    requested: bool,
    groups: Option<Json>,
    templates: Option<Json>,
}

/// Each of `question-type-groups` (groups), `allow-widgets` (question types) and
/// `allow-templates` (exact templates) present narrows the documented default templates; the
/// result is `group_defaults: false` plus only the groups left, each naming its templates —
/// the documented restriction. Hiding groups with `template_references: []` under the
/// default `group_defaults: true` is not one: search still lists the hidden templates.
///
/// A requested restriction that leaves nothing is a hole, never emitted empty: with no group
/// matching a template the picker falls back to every question type, which fails open.
fn resolve_picker(get: &dyn Fn(&str) -> Option<Json>, holes: &mut Vec<&str>, findings: &mut Findings) -> Picker {
    let vocab = vocab();
    let strings = |key: &str| {
        get(key)
            .map(|list| listed(Some(&list)).iter().filter_map(|v| v.as_str().map(str::to_owned)).collect::<Vec<_>>())
    };
    let (groups, kinds, refs) = (strings("question-type-groups"), strings("allow-widgets"), strings("allow-templates"));
    if groups.is_none() && kinds.is_none() && refs.is_none() {
        return Picker { requested: false, groups: None, templates: None };
    }
    let allows =
        |list: &Option<Vec<String>>, item: &str| list.as_ref().is_none_or(|list| list.iter().any(|x| x == item));
    let permitted: Vec<(&String, &vocab::Template)> = vocab
        .picker_templates
        .iter()
        .filter(|(_, t)| allows(&groups, &t.group) && allows(&kinds, &t.kind) && allows(&refs, &t.reference))
        .collect();
    for group in groups.iter().flatten() {
        if !permitted.iter().any(|(_, t)| t.group == *group) {
            findings.warn(format!(
                "question-type-groups: {group} keeps no template once the other picker properties are applied — it is not offered."
            ));
        }
    }
    for kind in kinds.iter().flatten() {
        if !vocab.picker_templates.values().any(|t| t.kind == *kind) {
            findings.warn(format!(
                "allow-widgets: {kind} has no documented default picker template, so the picker cannot offer it — not offered."
            ));
        } else if !permitted.iter().any(|(_, t)| t.kind == *kind) {
            findings.warn(format!("allow-widgets: {kind} is excluded by the other picker properties — not offered."));
        }
    }
    for reference in refs.iter().flatten() {
        if !permitted.iter().any(|(_, t)| t.reference == *reference) {
            let tag =
                vocab.picker_templates.iter().find(|(_, t)| t.reference == *reference).map(|(tag, _)| tag.as_str());
            findings.warn(format!(
                "allow-templates: {} is excluded by the other picker properties — not offered.",
                tag.unwrap_or(reference)
            ));
        }
    }
    if permitted.is_empty() {
        holes.push("The question-picker restriction is unsatisfiable: `question-type-groups`, `allow-widgets` and `allow-templates` together leave no documented template to offer, so no picker config was emitted. An empty restriction would FAIL OPEN — with no group matching a template the Author API lists every question type. Name at least one group, question type or template that the others allow.");
        return Picker { requested: true, groups: None, templates: None };
    }
    let emitted: Vec<Json> = vocab
        .group_tags
        .values()
        .filter_map(|group| {
            let refs: Vec<&str> =
                permitted.iter().filter(|(_, t)| t.group == *group).map(|(_, t)| t.reference.as_str()).collect();
            (!refs.is_empty())
                .then(|| json!({ "reference": group, "name": vocab.group_names[group], "template_references": refs }))
        })
        .collect();
    let path = vocab.toplevel["question-type-groups"].path.clone().unwrap_or_default();
    let defaults = format!("{}group_defaults", path.strip_suffix("question_type_groups").unwrap_or(&path));
    findings.paths.insert("group-defaults".into(), defaults);
    findings.paths.insert("question-type-groups".into(), path);
    let templates: Vec<Json> = permitted
        .iter()
        .map(|(_, t)| json!({ "reference": t.reference, "name": t.name, "type": t.kind, "group": t.group }))
        .collect();
    Picker { requested: true, groups: Some(Json::Array(emitted)), templates: Some(Json::Array(templates)) }
}

/// `author-embed`: the design, its holes first (progressive disclosure), and the paths.
fn finalize(design: &Json, findings: &mut Findings) -> Value {
    let vocab = vocab();
    let allowed = |key: &str| {
        vocab.toplevel.contains_key(key)
            || matches!(key, "mode" | "config" | "paths")
            || vocab.sections.contains_key(key)
    };
    let mut top: IndexMap<String, Option<Json>> = IndexMap::new();
    for (key, given) in entries(design) {
        if !allowed(&key) {
            findings.warn(format!("\"{key}\" isn't a top-level author-embed property."));
            continue;
        }
        // Top-level types are checked here, the first place that knows the context.
        let checked = match vocab.toplevel.get(&key) {
            Some(field) => check_value(&key, field, Some(&given), findings),
            None => Some(given),
        };
        top.insert(key, checked);
    }
    let get = |key: &str| top.get(key).cloned().flatten();
    let set = |key: &str| top.get(key).is_some_and(Option::is_some);

    let mode = get("mode");
    let mut holes = Vec::new();
    let mut specificity = Vec::new();
    if !non_empty(mode.as_ref()) {
        holes.push("Which authoring view? Use exactly one of: item-edit, item-list, activity-edit, activity-list.");
    }
    if !non_empty(get("domain").as_ref()) {
        holes.push("Your design doesn't specify the serving `domain` (required — the Author API signature binds to it, and a mismatch is the #1 cause of a 401). Provide the domain where your app serves the editor.");
    }
    if !non_empty(get("user-id").as_ref()) {
        holes.push("Your design doesn't identify the author (required). Provide `user-id` — the author's stable id.");
    }
    let mode_is = |name: &str| mode.as_ref().is_some_and(|mode| mode == name);
    if mode_is("item_edit") && !non_empty(get("reference").as_ref()) {
        holes.push("item-edit needs a `reference` — the existing item to edit, or a new reference to create.");
    }
    let picker = resolve_picker(&get, &mut holes, findings);
    if !picker.requested && (mode_is("item_edit") || mode_is("activity_edit")) {
        specificity.push("No picker restriction — the editor offers every question template. Set `question-type-groups`, `allow-widgets` or `allow-templates` to limit what authors may add.");
    }
    if !set("organisation-id") {
        specificity.push("No item bank specified (`organisation-id`) — the default is used.");
    }

    // Holes lead, and specificity waits until they are filled; but validity warnings always
    // surface: they report input that was rejected or dropped.
    let mut warnings: Vec<String> = Vec::new();
    if holes.is_empty() {
        warnings.extend(findings.warnings.iter().cloned());
        warnings.extend(specificity.into_iter().map(str::to_owned));
    } else {
        warnings.extend(holes.iter().map(|hole| (*hole).to_owned()));
        warnings.extend(findings.warnings.iter().cloned());
    }

    let mut out = Object::new();
    let mut put = |key: &str, value: Option<Json>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    put("mode", mode.filter(|mode| non_empty(Some(mode))));
    put("domain", get("domain"));
    let mut user = Object::new();
    for (field, key) in
        [("id", "user-id"), ("email", "user-email"), ("firstname", "user-firstname"), ("lastname", "user-lastname")]
    {
        if let Some(value) = get(key) {
            user.insert(field.to_owned(), value);
        }
    }
    put("user", Some(Json::Object(user)));
    put("reference", get("reference"));
    put("organisation_id", get("organisation-id"));
    put("allow_widgets", get("allow-widgets"));
    put("allow_templates", get("allow-templates"));
    put("group_defaults", picker.groups.as_ref().map(|_| json!(false)));
    put("question_type_groups", picker.groups);
    put("picker_templates", picker.templates);
    put("config", get("config"));
    put("container", get("container"));
    put("widget_templates", get("widget-templates"));
    put("global", get("global"));
    // Every config key the design sets, with its exact Learnosity path.
    let paths: Object = findings.paths.iter().map(|(from, to)| (from.clone(), json!(to))).collect();
    put("paths", Some(Json::Object(paths)));
    put("complete", Some(json!(holes.is_empty())));
    put("warnings", Some(json!(warnings)));
    value(out)
}
