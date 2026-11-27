// SPDX-License-Identifier: MIT

//! The backfill's extractor (C4, `docs/c4-l0182-assignment-plan.md` decision 10 and §4). A pure
//! function: it reads a stored program (its AST pool) and the output a compile saved for it, and
//! reports, per identity, what the saved output **demonstrates**. It never draws, never
//! evaluates a survey, and reads and writes nothing else. The backfill script decides what to do
//! with the report.
//!
//! - **An occurrence** is a reachable `survey` whose attribute list is a literal list. Its
//!   identity is known when its `id` and `session-id` are string literals (an empty session is
//!   none). Anything else (a computed list, a computed `id` or `session-id`, an entry that is not
//!   a literal attribute) leaves the identity unknown.
//! - **An output survey record** is an object `{ survey: { id, instance, sessionId? }, response? }`
//!   anywhere in the saved output. It is matched to the occurrences whose literal `id` and
//!   `session-id` fit it.
//! - **Per identity:** demonstrated when its occurrences are matched by records that all show one
//!   version, and that version is a version of the ref (`<ref>-<n>` for a survey id, the ref itself
//!   for a named version). Otherwise unresolved, with the reason: fewer records than occurrences
//!   (a survey consumed by a computation, or dropped by `PROG` keeping the last expression),
//!   records that disagree, or an instance that isn't a version of the ref.
//! - **Quarantine** (task-level): an occurrence whose identity can't be named at all, or a record
//!   that no literal occurrence can account for while some occurrence is unknown.
//! - **Sessionless** occurrences are listed with what was shown, for review only: under the
//!   selected policy they are never assigned, so nothing is backfilled for them.
//!
//! A response is "error-free" only if the saved compile reported no errors.

use std::collections::BTreeMap;

use graffiticode_l0000::{Ast, Node, NodeId, Op};
use serde_json::{Value as Json, json};

use crate::assigned::key;

/// One `survey` occurrence in the program, as far as its literals say.
#[derive(Debug)]
struct Occurrence {
    survey: Option<String>,
    /// `None`: sessionless. `Some(None)`: computed.
    session: Option<Option<String>>,
    unknown: Option<&'static str>,
}

/// What a saved output shows for one survey.
#[derive(Debug)]
struct Shown {
    survey: String,
    session: Option<String>,
    instance: String,
    response: bool,
}

/// Extracts the per-identity evidence from a stored program and its saved output.
///
/// `program` is the AST pool the task stores; `output` the compiled value saved for it, or
/// `None` when there is none; `errors` whether that compile reported errors.
pub fn extract(program: &Json, output: Option<&Json>, errors: bool) -> Json {
    let ast = match Ast::from_json(program) {
        Ok(ast) => ast,
        Err(e) => return json!({ "quarantine": [{ "reason": "unreadable-program", "detail": e.to_string() }] }),
    };
    let occurrences = occurrences(&ast);
    let mut shown = Vec::new();
    if let Some(output) = output {
        collect(output, &mut shown);
    }

    let mut quarantine = Vec::new();
    let mut sessionless = Vec::new();
    // Each literal identity's occurrence count, in first-seen order.
    let mut identities: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut order = Vec::new();
    for occ in &occurrences {
        if let Some(reason) = occ.unknown {
            quarantine.push(json!({ "reason": reason }));
            continue;
        }
        let survey = occ.survey.clone().unwrap_or_default();
        match &occ.session {
            None => sessionless.push(survey),
            Some(None) => quarantine.push(json!({ "reason": "computed-session", "survey": survey })),
            Some(Some(session)) => {
                let k = (survey, session.clone());
                if !identities.contains_key(&k) {
                    order.push(k.clone());
                }
                *identities.entry(k).or_default() += 1;
            }
        }
    }
    let any_unknown = !quarantine.is_empty();

    let mut demonstrated = Vec::new();
    let mut unresolved = Vec::new();
    for (survey, session) in &order {
        let wanted = identities[&(survey.clone(), session.clone())];
        let records: Vec<&Shown> =
            shown.iter().filter(|s| &s.survey == survey && s.session.as_deref() == Some(session)).collect();
        let identity = json!({ "survey": survey, "session": session, "key": key(survey, session) });
        let unresolved_with = |reason: &str| {
            let mut entry = identity.clone();
            entry["reason"] = json!(reason);
            entry["shown"] = records.iter().map(|r| json!(r.instance)).collect();
            entry
        };
        if records.len() < wanted {
            unresolved.push(unresolved_with("absent-from-output"));
        } else if records.len() > wanted {
            unresolved.push(unresolved_with("ambiguous-match"));
        } else if records.iter().any(|r| r.instance != records[0].instance) {
            unresolved.push(unresolved_with("conflicting-instances"));
        } else if !is_version(&records[0].instance, survey) {
            unresolved.push(unresolved_with("instance-not-a-version"));
        } else {
            let mut entry = identity;
            entry["instance"] = json!(records[0].instance);
            entry["response"] = json!(records.iter().any(|r| r.response));
            entry["errorFree"] = json!(!errors);
            demonstrated.push(entry);
        }
    }

    // A record no literal identity accounts for.
    for record in &shown {
        let accounted = match &record.session {
            Some(session) => identities.contains_key(&(record.survey.clone(), session.clone())),
            None => sessionless.contains(&record.survey),
        };
        if !accounted {
            let reason = if any_unknown { "unattributable-record" } else { "unmatched-record" };
            quarantine.push(json!({
                "reason": reason, "survey": record.survey, "session": record.session, "instance": record.instance,
            }));
        }
    }

    let sessionless: Vec<Json> = sessionless
        .iter()
        .map(|survey| {
            let shown: Vec<&str> = shown
                .iter()
                .filter(|s| &s.survey == survey && s.session.is_none())
                .map(|s| s.instance.as_str())
                .collect();
            json!({ "survey": survey, "shown": shown })
        })
        .collect();

    json!({
        "identities": demonstrated,
        "unresolved": unresolved,
        "quarantine": quarantine,
        "sessionless": sessionless,
    })
}

fn is_version(instance: &str, survey: &str) -> bool {
    instance == survey
        || instance
            .strip_prefix(survey)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn dialect(op: &Op) -> Option<&str> {
    match op {
        Op::Dialect(_) => Some(op.tag()),
        _ => None,
    }
}

/// Every reachable `survey` occurrence, as far as its literals say.
fn occurrences(ast: &Ast) -> Vec<Occurrence> {
    ast.reachable()
        .into_iter()
        .filter_map(|(_, node)| match node {
            Node::Form { op, elts } if dialect(op) == Some("SURVEY") => occurrence(ast, elts.first().copied()),
            _ => None,
        })
        .collect()
}

fn literal_str(ast: &Ast, id: Option<NodeId>) -> Option<String> {
    match id.and_then(|id| ast.get(id)) {
        Some(Node::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

/// `None` for a `survey` with a literal list and no `id`: the compile refuses it, so it drew
/// nothing and has nothing to show.
fn occurrence(ast: &Ast, list: Option<NodeId>) -> Option<Occurrence> {
    let unknown = |reason| Some(Occurrence { survey: None, session: None, unknown: Some(reason) });
    let Some(Node::Form { op: Op::List, elts }) = list.and_then(|id| ast.get(id)) else {
        return unknown("computed-attributes");
    };
    let mut survey = None;
    let mut session: Option<Option<String>> = None;
    for &entry in elts {
        let Some(Node::Form { op, elts: args }) = ast.get(entry) else { return unknown("computed-attributes") };
        match dialect(op) {
            Some("ID") => match literal_str(ast, args.first().copied()) {
                Some(id) => survey = Some(id),
                None => return unknown("computed-id"),
            },
            Some("SESSION_ID") => {
                session = Some(literal_str(ast, args.first().copied()).map(|s| s.trim().to_owned()));
                if session == Some(Some(String::new())) {
                    session = None; // an empty session is no session
                }
            }
            Some(_) => {} // another attribute: it names nothing about the identity
            None => return unknown("computed-attributes"),
        }
    }
    survey.map(|survey| Occurrence { survey: Some(survey), session, unknown: None })
}

/// Every survey record in a saved output, in document order.
fn collect(value: &Json, out: &mut Vec<Shown>) {
    match value {
        Json::Array(items) => items.iter().for_each(|item| collect(item, out)),
        Json::Object(object) => {
            if let Some(Json::Object(survey)) = object.get("survey")
                && let (Some(Json::String(id)), Some(Json::String(instance))) =
                    (survey.get("id"), survey.get("instance"))
            {
                out.push(Shown {
                    survey: id.clone(),
                    session: survey.get("sessionId").and_then(Json::as_str).map(str::to_owned),
                    instance: instance.clone(),
                    response: object.get("response").is_some(),
                });
                return;
            }
            object.values().for_each(|item| collect(item, out));
        }
        _ => {}
    }
}
