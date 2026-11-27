// SPDX-License-Identifier: MIT

//! The `Assigned` survey source: how `/interpret` resolves a `survey` occurrence (C4,
//! `docs/c4-l0182-assignment-plan.md` decisions 1, 2 and 7, and the policies selected in
//! `docs/c4-runtime-lifecycle.md` §10). `/compile` never comes here: it has no assignment table,
//! and keeps the legacy draw in `source.rs`.
//!
//! - **With a session,** the identity is `(survey ref, session)`, keyed in the table as the JSON
//!   text of `[ref, session]` ([`key`]). A hit is served from the entry: the retained `content`
//!   when the api passed it (its digest checked), otherwise the current candidate with the
//!   entry's instance and digest. `{ "absent": true }` gives today's "no survey" error. A miss
//!   never draws: it asks, with every current candidate (possibly none), and is pending.
//! - **Without a session** (selected: stateless reads), the occurrence is never requested,
//!   assigned, balanced or frozen. It picks the candidate at
//!   `sha256(program digest, ref, ordinal) mod n` over the candidates sorted by instance name.
//!   The ordinal counts that ref's sessionless occurrences in evaluation order, and the program
//!   digest is the canonical digest of the program being run ([`program_digest`]; the model's
//!   own digest is the api's, which the dialect does not see). Once anything in this run has
//!   been requested, a later sessionless occurrence is suspended instead, so a pick is only ever
//!   made where every earlier occurrence was resolved: its ordinal is the final call's.

use std::collections::{HashMap, HashSet};

use graffiticode_l0000::{Ast, Diagnostic, Evaluator, Node, Value, json_text};
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};

use crate::js::{Js, js_string};
use crate::source::{Candidate, Loaded, SurveySource, digest_of, parse};
use crate::survey::Asked;

/// What this run has asked for and counted, kept for the invocation only.
#[derive(Default)]
struct Run {
    /// Identities requested in this run, so each is asked for once.
    requested: HashSet<String>,
    /// Whether anything in this run is pending (every pending value starts at a request).
    pending: bool,
    /// Every `survey` occurrence reached, unsuspended, in evaluation order.
    ordinal: usize,
    /// Each ref's sessionless occurrences so far.
    sessionless: HashMap<String, usize>,
    program: Option<String>,
}

/// How an occurrence resolved.
pub enum Resolved {
    Loaded(Loaded),
    /// Requested or suspended; the value to evaluate to.
    Pending(Value),
    Refused(Diagnostic),
}

/// The table key of the identity `(ref, session)`: the JSON text of `[ref, session]`.
pub fn key(survey: &str, session: &str) -> String {
    json!([survey, session]).to_string()
}

/// Resolves one occurrence from the assignment table.
pub fn resolve(cx: &mut Evaluator<'_>, source: &dyn SurveySource, asked: &Asked, table: &Json) -> Resolved {
    let candidates = match source.candidates(&asked.id) {
        Ok(candidates) => candidates,
        Err(message) => return Resolved::Refused(Diagnostic::new(message)),
    };
    let survey = js_string(&asked.id);
    let Some(session) = asked.session.as_deref() else {
        return sessionless(cx, source, asked, &survey, candidates);
    };
    let key = key(&survey, session);
    if let Some(entry) = table.get(&key) {
        cx.exec().state::<Run>().ordinal += 1;
        return from_entry(source, asked, &survey, &key, entry, &candidates);
    }
    let run = cx.exec().state::<Run>();
    run.pending = true;
    if !run.requested.insert(key.clone()) {
        // Already asked for in this run: pending, without asking twice.
        return Resolved::Pending(cx.suspend(&[]));
    }
    let ordinal = run.ordinal;
    run.ordinal += 1;
    let request = json!({
        "identity": { "survey": survey, "session": session },
        "key": key,
        "ordinal": ordinal,
        "candidates": candidates.iter().map(Candidate::to_json).collect::<Vec<_>>(),
    });
    Resolved::Pending(cx.request_assignment(request))
}

/// Whether `instance` is what `survey` may be served as: the ref itself for a named version,
/// `<ref>-<n>` for a survey id (decision 10's bare/named distinction), never the other.
pub fn is_version_of(instance: &str, survey: &str, named: bool) -> bool {
    if named {
        return instance == survey;
    }
    instance
        .strip_prefix(survey)
        .and_then(|rest| rest.strip_prefix('-'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn refused(code: &str, message: String) -> Resolved {
    Resolved::Refused(Diagnostic::new(format!("Error: {message}")).with_code(code))
}

/// Serves a table entry: retained content, a current candidate, or `absent`.
fn from_entry(
    source: &dyn SurveySource,
    asked: &Asked,
    survey: &str,
    key: &str,
    entry: &Json,
    candidates: &[Candidate],
) -> Resolved {
    if entry.get("absent") == Some(&Json::Bool(true)) {
        return Resolved::Refused(Diagnostic::new(source.missing(&asked.id)));
    }
    let (Some(instance), Some(digest)) = (entry["instance"].as_str(), entry["digest"].as_str()) else {
        return refused("assignment-invalid", format!("the assignment for {key} has no instance and digest."));
    };
    if !is_version_of(instance, survey, source.named(&asked.id)) {
        return refused(
            "assignment-invalid",
            format!("the assignment for {key} names {instance}, which is not a version of {survey}."),
        );
    }
    let text = match entry.get("content") {
        Some(Json::String(content)) => {
            if digest_of(content) != digest {
                return refused(
                    "assignment-content-mismatch",
                    format!("the retained content for {key} doesn't have the digest its assignment names."),
                );
            }
            content.as_str()
        }
        Some(_) => return refused("assignment-invalid", format!("the retained content for {key} is not text.")),
        None => match candidates.iter().find(|c| c.instance == instance && c.digest() == digest) {
            Some(candidate) => candidate.text.as_str(),
            None => {
                return refused(
                    "assignment-content-missing",
                    format!(
                        "the assignment for {key} names {instance} with a digest no installed version has, and carries no retained content."
                    ),
                );
            }
        },
    };
    match parse(instance, text) {
        Ok(data) => Resolved::Loaded(Loaded { instance: Js::Str(instance.to_owned()), data }),
        Err(message) => Resolved::Refused(Diagnostic::new(message)),
    }
}

/// The stateless pick for a sessionless occurrence (selected policy, §2).
fn sessionless(
    cx: &mut Evaluator<'_>,
    source: &dyn SurveySource,
    asked: &Asked,
    survey: &str,
    mut candidates: Vec<Candidate>,
) -> Resolved {
    let ast = cx.ast();
    let run = cx.exec().state::<Run>();
    if run.pending {
        // Something earlier in this run is pending, so this occurrence's ordinal may not be the
        // final call's. Suspend; it is picked once everything before it is resolved.
        return Resolved::Pending(cx.suspend(&[]));
    }
    run.ordinal += 1;
    let ordinal = {
        let count = run.sessionless.entry(survey.to_owned()).or_default();
        *count += 1;
        *count - 1
    };
    let program = run.program.get_or_insert_with(|| program_digest(ast)).clone();
    if candidates.is_empty() {
        return Resolved::Refused(Diagnostic::new(source.missing(&asked.id)));
    }
    candidates.sort_by(|a, b| a.instance.cmp(&b.instance));
    let chosen = &candidates[pick(&program, survey, ordinal, candidates.len())];
    match parse(&chosen.instance, &chosen.text) {
        Ok(data) => Resolved::Loaded(Loaded { instance: Js::Str(chosen.instance.clone()), data }),
        Err(message) => Resolved::Refused(Diagnostic::new(message)),
    }
}

/// The sessionless pick: SHA-256 over the UTF-8 text `"<program>\n<ref>\n<ordinal>"` (the
/// program digest in lower-case hex, the ordinal in decimal), its first eight bytes read as a
/// big-endian `u64`, modulo `n`.
pub fn pick(program: &str, survey: &str, ordinal: usize, n: usize) -> usize {
    let hash = Sha256::digest(format!("{program}\n{survey}\n{ordinal}").as_bytes());
    let mut first = [0u8; 8];
    first.copy_from_slice(&hash[..8]);
    (u64::from_be_bytes(first) % n as u64) as usize
}

/// The program digest: lower-case hex SHA-256 of a canonical text of the program's graph, with
/// bounded work and cycles allowed. The text is `root <id>` and then one line per node reachable
/// from the root, each visited once (`Ast::reachable`), in that order: `<id> <node>`, where a
/// form is `(<TAG> <child id>…)` and a literal is `n:<number>`, `s:<JSON string>`,
/// `i:<JSON string>`, `t:<JSON string>`, `true`, `false` or `null`. Node ids are written, not
/// expanded, so a shared subtree is written once and a cycle is a back reference. Source
/// positions are left out. One stored program always gives the same digest, as its model does.
pub fn program_digest(ast: &Ast) -> String {
    let mut text = format!("root {}\n", ast.root());
    for (id, node) in ast.reachable() {
        text.push_str(&id.to_string());
        text.push(' ');
        match node {
            Node::Num(n) => {
                text.push_str("n:");
                text.push_str(&Value::Num(n.clone()).to_json().map(|j| json_text(&j)).unwrap_or_default());
            }
            Node::Str(s) => text.push_str(&format!("s:{}", Json::String(s.clone()))),
            Node::Ident(s) => text.push_str(&format!("i:{}", Json::String(s.clone()))),
            Node::Bool(b) => text.push_str(if *b { "true" } else { "false" }),
            Node::Tag(s) => text.push_str(&format!("t:{}", Json::String(s.clone()))),
            Node::Null => text.push_str("null"),
            Node::Form { op, elts } => {
                text.push('(');
                text.push_str(op.tag());
                for elt in elts {
                    text.push(' ');
                    text.push_str(&elt.to_string());
                }
                text.push(')');
            }
        }
        text.push('\n');
    }
    digest_of(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_unambiguous() {
        assert_eq!(key("civic-priorities", "s-1"), r#"["civic-priorities","s-1"]"#);
        assert_ne!(key("a", "b\",\"c"), key("a\",\"b", "c"));
    }

    #[test]
    fn versions_of_a_ref() {
        assert!(is_version_of("civic-priorities-7", "civic-priorities", false));
        assert!(is_version_of("civic-priorities-7", "civic-priorities-7", true));
        // The bare/named distinction: neither is served as the other.
        assert!(!is_version_of("civic-priorities", "civic-priorities", false));
        assert!(!is_version_of("civic-priorities-3-1", "civic-priorities-3", true));
        assert!(!is_version_of("civic-priorities-x", "civic-priorities", false));
        assert!(!is_version_of("civic-prioritiesx-1", "civic-priorities", false));
        assert!(!is_version_of("workplace-pulse-1", "civic-priorities", false));
    }

    #[test]
    fn the_pick_is_stable_and_spreads() {
        assert_eq!(pick("p", "s", 0, 12), pick("p", "s", 0, 12));
        let picks: HashSet<usize> = (0..64).map(|o| pick("p", "civic-priorities", o, 12)).collect();
        assert!(picks.len() > 6, "{picks:?}");
        assert!((0..64).all(|o| pick("p", "s", o, 1) == 0));
    }
}
