// SPDX-License-Identifier: MIT

//! The word handlers, all driven by [`crate::vocab`]:
//!
//! - a **property** (`text "A" {}`) checks its value and adds it to the rest of its chain;
//! - a **member** (`sticky …`) checks its description — every key a property it takes, every
//!   value one that property takes, its required properties present — and evaluates to
//!   `{sticky: description}`;
//! - a **container** (`section [ … ] …`) checks each list item and its settings and evaluates to
//!   `{section: {settings, children}}`;
//! - `save-to-figjam` evaluates to `{save-to-figjam: fileKey}`.
//!
//! A description is checked wherever it came from: a chain, a record, a binding or upstream
//! data. Unknown keys never disappear into the record (design §11). Each word reports its own
//! errors at its own position. A member or container whose arguments reported anything skips
//! the rules that failure would trip (required properties, layout rules), so one mistake is
//! reported once, where it was made; list items that are not members are still reported.

use graffiticode_l0000::{Diagnostic, Evaluator, Key, NodeId, Record, Value};

use crate::check::{check_value, show};
use crate::diag::source;
use crate::vocab::{self, CONTAINERS, MEMBERS, REMOVED_GEOMETRY, REMOVED_OTHER, SAVE_TO_FIGJAM};

/// The key a container's settings and children are kept under.
pub const SETTINGS: &str = "settings";
pub const CHILDREN: &str = "children";

pub fn key(word: &str) -> Key {
    Key::str(word)
}

pub fn report(cx: &mut Evaluator<'_>, at: NodeId, code: &str, message: impl Into<String>) {
    let span = cx.ast().span(at);
    cx.report_diagnostic(source(code, message, span));
}

/// How an object is named in an error: `sticky "idea"`, or `sticky (item 2)` before it has an
/// id.
pub fn label(word: &str, rec: Option<&Record>, index: Option<usize>) -> String {
    match rec.and_then(|r| r.get(&key("id"))) {
        Some(Value::Str(id)) if !id.trim().is_empty() => format!("{word} {id:?}"),
        _ => match index {
            Some(i) => format!("{word} (item {})", i + 1),
            None => word.to_owned(),
        },
    }
}

/// The word a key names, from a source spelling or an output field spelling (`fontSize`).
fn word_for_key(name: &str) -> Option<&'static str> {
    vocab::PROPERTIES.iter().map(|p| p.word).find(|w| *w == name || vocab::field(w) == name)
}

/// The kebab-case spelling of an output field: `fromSide` → `from-side`.
fn kebab(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// What to do instead of a word that is not a property of `owner`.
pub fn hint_for(name: &str, owner: &str) -> String {
    let spelled = kebab(name);
    if REMOVED_GEOMETRY.contains(&name) || REMOVED_GEOMETRY.contains(&spelled.as_str()) {
        return format!(
            " L0187 computes placement, so `{spelled}` is not a word: arrange content with `layout` (ROW, COLUMN, GRID with `columns`, or FLOW with `direction` and `before`) on the page, section or group that holds it, e.g. `group [ … ] id \"cards\" layout GRID columns 3 {{}}`."
        );
    }
    if REMOVED_OTHER.contains(&name) || REMOVED_OTHER.contains(&spelled.as_str()) {
        return format!(" `{spelled}` is not part of L0187.");
    }
    match word_for_key(name) {
        Some(word) if word != name => format!(" Write it as `{word}`."),
        Some(word) => {
            let owners = vocab::owners(word);
            if owners.contains(&owner) {
                String::new()
            } else {
                format!(" `{word}` belongs to: {}.", owners.join(", "))
            }
        }
        None => String::new(),
    }
}

/// Checks a description against the properties it may have. Returns the description with only
/// its good entries, and one message per problem.
fn check_description(owner: &str, allowed: &[&str], rec: &Record, at: &str) -> (Record, Vec<(&'static str, String)>) {
    let mut clean = Record::new();
    let mut problems = Vec::new();
    for (k, value) in rec.iter() {
        let name = k.name();
        match allowed.iter().find(|w| **w == name).and_then(|w| vocab::property(w)) {
            Some(property) => match check_value(property, value) {
                Ok(value) => clean.insert(key(property.word), value),
                Err(message) => problems.push(("invalid-value", format!("{at}: {message}"))),
            },
            None => {
                let what = if name.is_empty() { "an empty key".to_owned() } else { format!("`{name}`") };
                problems.push((
                    "unknown-property",
                    format!(
                        "{at}: {what} is not a property of {owner}. It takes: {}.{}",
                        allowed.join(", "),
                        hint_for(&name, owner)
                    ),
                ));
            }
        }
    }
    (clean, problems)
}

fn missing(required: &[&str], rec: &Record, at: &str, example: &str) -> Vec<(&'static str, String)> {
    required
        .iter()
        .filter(|w| rec.get(&key(w)).is_none())
        .map(|w| ("missing-property", format!("{at}: needs `{w}`, e.g. {example}.")))
        .collect()
}

/// The conditional rules on a region's settings (design §5): `columns` only with GRID, which
/// requires it; `direction` only with FLOW.
fn layout_rules(word: &str, settings: &Record, at: &str) -> Vec<(&'static str, String)> {
    let layout = match settings.get(&key("layout")) {
        Some(Value::Tag(tag)) => tag.as_str(),
        _ => "AUTO",
    };
    let mut problems = Vec::new();
    if settings.get(&key("columns")).is_some() && layout != "GRID" {
        problems.push((
            "misplaced-setting",
            format!(
                "{at}: `columns` is legal only with `layout GRID`, e.g. `{word} [ … ] id \"cards\" layout GRID columns 3 {{}}`. The legal settings of a {word} are: {}.",
                vocab::container(word).map(|c| c.settings.join(", ")).unwrap_or_default()
            ),
        ));
    }
    if layout == "GRID" && settings.get(&key("columns")).is_none() {
        problems.push((
            "missing-property",
            format!(
                "{at}: `layout GRID` needs `columns`, e.g. `{word} [ … ] id \"cards\" layout GRID columns 3 {{}}`."
            ),
        ));
    }
    if settings.get(&key("direction")).is_some() && layout != "FLOW" {
        problems.push((
            "misplaced-setting",
            format!(
                "{at}: `direction` is legal only with `layout FLOW`, e.g. `{word} [ … ] id \"steps\" layout FLOW direction DOWN {{}}`."
            ),
        ));
    }
    problems
}

fn is_save_marker(value: &Value) -> bool {
    matches!(value, Value::Record(r) if r.len() == 1 && r.get(&key(SAVE_TO_FIGJAM)).is_some())
}

const SAVE_HINT: &str = " Write `save-to-figjam \"<file key or link>\"` on its own line before the board.";

/// A property: the value, then the rest of the chain.
pub fn property(cx: &mut Evaluator<'_>, at: NodeId, word: &str, given: Value, rest: Value) -> Value {
    let property = vocab::property(word).expect("a property word");
    let checked = check_value(property, &given);
    if let Err(message) = &checked {
        report(cx, at, "invalid-value", message.clone());
    }
    let mut rec = match rest {
        Value::Record(rec) if !is_save_marker(&Value::Record(rec.clone())) => rec,
        rest => {
            let message = if is_save_marker(&rest) {
                format!("{word}: save-to-figjam cannot end a description.{SAVE_HINT}")
            } else {
                format!(
                    "{word}: a description must end in `{{}}` after its last word, e.g. `{word} {} {{}}`. Got {} where the rest of the description was expected.",
                    example_value(word),
                    show(&rest)
                )
            };
            report(cx, at, "unterminated-description", message);
            return Value::Record(Record::new());
        }
    };
    if rec.get(&key(word)).is_some() {
        report(
            cx,
            at,
            "repeated-property",
            format!("{word}: is given twice. Each property appears once in a description."),
        );
        return Value::Record(rec);
    }
    if let Ok(value) = checked {
        // A chain is written left to right and evaluated right to left; insert at the front so
        // the description keeps the order it was written in.
        let mut ordered = Record::new();
        ordered.insert(key(word), value);
        for (k, v) in rec.iter() {
            ordered.insert(k.clone(), v.clone());
        }
        rec = ordered;
    }
    Value::Record(rec)
}

fn example_value(word: &str) -> String {
    match vocab::property(word).map(|p| p.value) {
        Some(vocab::ValueType::Tag(set)) => set.tags[0].0.to_owned(),
        Some(vocab::ValueType::IdList) => "[\"b\"]".to_owned(),
        Some(vocab::ValueType::Count) => "3".to_owned(),
        Some(vocab::ValueType::Opacity) => "50".to_owned(),
        Some(vocab::ValueType::Boolean) => "true".to_owned(),
        Some(vocab::ValueType::Color) => "\"yellow\"".to_owned(),
        _ => "\"…\"".to_owned(),
    }
}

/// Checks a member's description. `Ok` holds the clean description; `Err` the problems.
pub fn check_member(
    word: &str,
    raw: &Value,
    index: Option<usize>,
    quiet: bool,
) -> Result<Record, Vec<(&'static str, String)>> {
    let member = vocab::member(word).expect("a member word");
    let Value::Record(rec) = raw else {
        let message = if is_save_marker(raw) {
            format!("{word}: save-to-figjam cannot be a description.{SAVE_HINT}")
        } else {
            format!("{word}: expected a description ending in `{{}}`, e.g. {}; got {}.", member.example, show(raw))
        };
        return Err(vec![("unterminated-description", message)]);
    };
    let at = label(word, Some(rec), index);
    let (clean, mut problems) = check_description(word, member.properties, rec, &at);
    if !quiet && problems.is_empty() {
        problems.extend(missing(member.required, &clean, &at, member.example));
    }
    if problems.is_empty() { Ok(clean) } else { Err(problems) }
}

pub fn member(cx: &mut Evaluator<'_>, at: NodeId, word: &str, raw: Value, quiet: bool) -> Value {
    let mut out = Record::new();
    match check_member(word, &raw, None, quiet) {
        Ok(clean) => out.insert(key(word), Value::Record(clean)),
        Err(problems) => {
            for (code, message) in problems {
                report(cx, at, code, message);
            }
            out.insert(key(word), Value::Record(Record::new()));
        }
    }
    Value::Record(out)
}

/// A list item as written, for an error message.
fn describe(item: &Value) -> String {
    let Value::Record(rec) = item else { return show(item) };
    let names: Vec<String> = rec.iter().map(|(k, _)| k.name().into_owned()).collect();
    match names.as_slice() {
        [] => "a stray `{}`: a description ends in exactly one `{}`, after its last word".to_owned(),
        [name] => format!("`{name}`"),
        _ => format!("a description ({}) with no member word in front of it", names.join(", ")),
    }
}

/// Checks a container's list and settings, recursively re-checking any item that did not come
/// from a handler. `quiet` skips the rules a failed argument would make noise of.
pub fn check_container(
    word: &str,
    list: &Value,
    settings: &Value,
    quiet: bool,
) -> Result<Record, Vec<(&'static str, String)>> {
    let container = vocab::container(word).expect("a container word");
    let Value::Record(settings) = settings else {
        return Err(vec![(
            "unterminated-description",
            format!(
                "{word}: needs its settings after the `]`, ending in `{{}}`, e.g. {}; got {}.",
                container.example,
                show(settings)
            ),
        )]);
    };
    let at = label(word, Some(settings), None);
    let Value::List(items) = list else {
        return Err(vec![(
            "not-a-list",
            format!("{at}: expected its members in [brackets], e.g. {}; got {}.", container.example, show(list)),
        )]);
    };
    let (clean, mut problems) = check_description(&format!("{word} settings"), container.settings, settings, &at);
    if !quiet && problems.is_empty() {
        problems.extend(missing(container.required, &clean, &at, container.example));
        problems.extend(layout_rules(word, &clean, &at));
    }
    let mut children = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        match check_item(word, container.children, item, i, &at, quiet) {
            Ok(child) => children.push(child),
            Err(mut more) => problems.append(&mut more),
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let mut out = Record::new();
    out.insert(key(SETTINGS), Value::Record(clean));
    out.insert(key(CHILDREN), Value::List(children));
    Ok(out)
}

fn check_item(
    word: &str,
    allowed: &[&str],
    item: &Value,
    i: usize,
    at: &str,
    quiet: bool,
) -> Result<Value, Vec<(&'static str, String)>> {
    let entry = match item {
        Value::Record(rec) if rec.len() == 1 => rec.iter().next().map(|(k, v)| (k.name().into_owned(), v.clone())),
        _ => None,
    };
    let not_member = |extra: String| {
        vec![(
            "not-a-member",
            format!(
                "{at}: item {} is {}, which is not a member of {word}. It holds: {}.{extra}",
                i + 1,
                describe(item),
                allowed.join(", ")
            ),
        )]
    };
    let Some((child, value)) = entry else {
        return Err(not_member(String::new()));
    };
    if child == SAVE_TO_FIGJAM {
        return Err(vec![(
            "save-to-figjam",
            format!("{at}: item {} is save-to-figjam, which is not a member of {word}.{SAVE_HINT}", i + 1),
        )]);
    }
    if !allowed.contains(&child.as_str()) {
        let extra = if vocab::member(&child).is_some() || vocab::container(&child).is_some() {
            match (word, child.as_str()) {
                ("section", "section") => " A section cannot hold another section.".to_owned(),
                (_, "connector") => " Connectors are written directly in the page.".to_owned(),
                _ => String::new(),
            }
        } else if vocab::property(&child).is_some() && i > 0 {
            format!(
                " If `{child}` belongs to the description before it, a `{{}}` ended that description early: a description ends in exactly one `{{}}`, after its last word."
            )
        } else {
            hint_for(&child, word)
        };
        return Err(not_member(extra));
    }
    let checked = if vocab::member(&child).is_some() {
        check_member(&child, &value, Some(i), quiet).map(Value::Record)
    } else {
        let Value::Record(inner) = &value else { return Err(not_member(String::new())) };
        let settings = inner.get(&key(SETTINGS)).cloned().unwrap_or(Value::Undefined);
        let list = inner.get(&key(CHILDREN)).cloned().unwrap_or(Value::Undefined);
        check_container(&child, &list, &settings, quiet).map(Value::Record)
    };
    let mut out = Record::new();
    out.insert(key(&child), checked?);
    Ok(Value::Record(out))
}

/// A container. When an argument already reported, `quiet` leaves out the rules its failure
/// would make noise of (required settings, layout rules), but list items that are not members
/// are still reported: that is where an early `{}` shows.
pub fn container(cx: &mut Evaluator<'_>, at: NodeId, word: &str, list: Value, settings: Value, quiet: bool) -> Value {
    let checked = match check_container(word, &list, &settings, quiet) {
        Ok(checked) => checked,
        Err(problems) => {
            for (code, message) in problems {
                report(cx, at, code, message);
            }
            // Typed and empty, so the container holding this one sees a member, not a stray.
            let mut empty = Record::new();
            empty.insert(key(SETTINGS), Value::Record(Record::new()));
            empty.insert(key(CHILDREN), Value::List(Vec::new()));
            empty
        }
    };
    let mut out = Record::new();
    out.insert(key(word), Value::Record(checked));
    Value::Record(out)
}

/// `save-to-figjam "<link or key>"`.
pub fn save_to_figjam(cx: &mut Evaluator<'_>, at: NodeId, raw: Value) -> Value {
    match parse_file_key(&raw) {
        Ok(file_key) => {
            let mut out = Record::new();
            out.insert(key(SAVE_TO_FIGJAM), Value::Str(file_key));
            Value::Record(out)
        }
        Err(message) => {
            report(cx, at, "save-to-figjam", message);
            Value::Record(Record::new())
        }
    }
}

fn figma_url_key(text: &str) -> Option<&str> {
    text.match_indices("figma.com/").find_map(|(at, prefix)| {
        let rest = &text[at + prefix.len()..];
        let rest = ["board/", "design/", "file/"].iter().find_map(|kind| rest.strip_prefix(kind))?;
        let end = rest.find(|c: char| !c.is_ascii_alphanumeric()).unwrap_or(rest.len());
        (end > 0).then(|| &rest[..end])
    })
}

/// A FigJam file key from a bare key or a figma.com board/design/file link.
pub fn parse_file_key(raw: &Value) -> Result<String, String> {
    if let Value::Str(text) = raw {
        let text = text.trim();
        if let Some(file_key) = figma_url_key(text) {
            return Ok(file_key.to_owned());
        }
        if text.len() >= 6 && text.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Ok(text.to_owned());
        }
    }
    Err(format!(
        "save-to-figjam: expected a FigJam link like \"https://www.figma.com/board/ABC123/Name\" or a bare file key like \"ABC123\", got {}.",
        show(raw)
    ))
}

/// Whether a node tag is one of L0187's description words.
pub fn is_own(tag: &str) -> bool {
    vocab::word_of_tag(tag).is_some_and(|w| w != SAVE_TO_FIGJAM)
}

/// Every member and container word.
pub fn item_words() -> impl Iterator<Item = &'static str> {
    MEMBERS.iter().map(|m| m.word).chain(CONTAINERS.iter().map(|c| c.word))
}

pub fn diagnostics(problems: Vec<(&'static str, String)>) -> Vec<Diagnostic> {
    problems.into_iter().map(|(code, message)| source(code, message, None)).collect()
}
