// SPDX-License-Identifier: MIT

//! The interpretation gate (C4, `docs/c4-l0182-assignment-plan.md` §4): every conformance case
//! interpreted through the assignment exchange, the way the api will drive it.
//!
//! For each case the test plays the api: it calls `/interpret` with an empty table, answers every
//! request, and calls again until there is a result, requiring progress on every call and no more
//! than 16 calls. It answers a request the way today's compile would have drawn
//! (`Files::installed(|_| 0)`: the first untaken version, in request order), or `absent` when
//! there is no candidate.
//!
//! - **Exactness.** The interpreted result equals a compile whose source serves exactly what the
//!   interpreter served: the table's version for a session, the stateless pick for a
//!   sessionless occurrence. So everything but the choice of version is identical: validation,
//!   messages, field order.
//! - **Against today's compile.** The interpreted result equals the plain compile (the
//!   conformance expectation) except for the deliberate differences (decision 2 and the selected
//!   sessionless policy), each recognised by [`deliberate`] and counted.
//! - **Depth.** The deepest exchange in the corpus is reported and bounded.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use graffiticode_l0000::{Ast, Compilation, Compiler, Identity, Mode, json_text};
use graffiticode_l0182::L0182;
use graffiticode_l0182::assigned::{key, pick, program_digest};
use graffiticode_l0182::backfill::extract;
use graffiticode_l0182::js::{Js, js_string};
use graffiticode_l0182::source::{Candidate, Files, Fixture, Loaded, SurveySource, parse};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
    fixture: Option<Served>,
    expect: Expect,
}

#[derive(Deserialize)]
struct Expect {
    errors: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct Served {
    data: Json,
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("conformance/cases.json")).unwrap()
}

/// The conformance test's own deliberate differences from TypeScript, which concern compiling
/// and are skipped here too.
fn diverges(case: &Case) -> bool {
    case.ast.to_string().contains("\"GET_VAL_PUBLIC\"")
        || (case.src.contains("12345678901234567890")
            && case.expect.errors.iter().flatten().any(|e| e.contains("native code")))
}

fn inner(case: &Case) -> Box<dyn SurveySource> {
    match &case.fixture {
        Some(served) => Box::new(Fixture(served.data.clone())),
        None => Box::new(Files::installed(|_| 0)),
    }
}

/// The api's side of the exchange, answering as today's first-untaken draw would.
#[derive(Default)]
struct Api {
    table: serde_json::Map<String, Json>,
    taken: HashMap<String, HashSet<String>>,
}

impl Api {
    fn answer(&mut self, request: &Json) {
        let key = request["key"].as_str().expect("a request names its key").to_owned();
        assert!(!self.table.contains_key(&key), "asked again for {key}");
        let survey = request["identity"]["survey"].as_str().unwrap().to_owned();
        let candidates: Vec<(&str, &str)> = request["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c["instance"].as_str().unwrap(), c["digest"].as_str().unwrap()))
            .collect();
        let entry = match candidates.as_slice() {
            [] => json!({ "absent": true }),
            [(instance, digest)] if *instance == survey => json!({ "instance": instance, "digest": digest }),
            _ => {
                let marks = self.taken.entry(survey).or_default();
                if candidates.iter().all(|(i, _)| marks.contains(*i)) {
                    marks.clear();
                }
                let (instance, digest) = *candidates.iter().find(|(i, _)| !marks.contains(*i)).unwrap();
                marks.insert(instance.to_owned());
                json!({ "instance": instance, "digest": digest })
            }
        };
        self.table.insert(key, entry);
    }
}

/// What a run gave: the value's JSON text, or the error messages.
fn outcome(compiled: &Compilation) -> Result<Option<String>, Vec<String>> {
    match &compiled.result {
        Ok(value) => Ok(value.to_json().map(|json| json_text(&json))),
        Err(errors) => Err(errors.iter().map(|e| e.message.clone()).collect()),
    }
}

/// Interprets a case through the exchange. Returns the outcome, the final table and the
/// number of calls.
async fn exchange(case: &Case) -> (Result<Option<String>, Vec<String>>, Json, usize) {
    let compiler = Compiler::new(L0182::with_source(BoxedSource(inner(case))));
    let model = match compiler.model(&case.ast, &json!({})).await {
        Ok(model) => model,
        Err(errors) => return (Err(errors.into_iter().map(|e| e.message).collect()), json!({}), 0),
    };
    let mut api = Api::default();
    for call in 1..=16 {
        let table = Json::Object(api.table.clone());
        let compiled = compiler
            .interpret_assigned(&model, &json!({}), &json!({}), Mode::Evaluate, Identity::default(), Some(&table))
            .await;
        match &compiled.needs_assignment {
            Some(requests) => {
                assert!(!requests.is_empty(), "{}: an empty needsAssignment", case.src);
                for request in requests {
                    api.answer(request); // asserts progress: never a key already answered
                }
            }
            None => return (outcome(&compiled), table, call),
        }
    }
    panic!("{}: no result within 16 calls", case.src);
}

struct BoxedSource(Box<dyn SurveySource>);

impl SurveySource for BoxedSource {
    fn load(&self, id: &Js, session: Option<&str>) -> Result<Loaded, String> {
        self.0.load(id, session)
    }
    fn candidates(&self, id: &Js) -> Result<Vec<Candidate>, String> {
        self.0.candidates(id)
    }
    fn missing(&self, id: &Js) -> String {
        self.0.missing(id)
    }
    fn named(&self, id: &Js) -> bool {
        self.0.named(id)
    }
}

/// A compile-time source serving exactly what the interpreter served: the table's version for a
/// session, the stateless pick (counted per ref, in evaluation order) without one.
struct Mirror {
    inner: Box<dyn SurveySource>,
    table: Json,
    program: String,
    ordinals: Mutex<HashMap<String, usize>>,
}

impl SurveySource for Mirror {
    fn load(&self, id: &Js, session: Option<&str>) -> Result<Loaded, String> {
        let mut candidates = self.inner.candidates(id)?;
        let survey = js_string(id);
        let instance = match session {
            Some(session) => {
                let entry = &self.table[key(&survey, session)];
                if entry.get("absent").is_some() || entry.is_null() {
                    return Err(self.inner.missing(id));
                }
                entry["instance"].as_str().unwrap().to_owned()
            }
            None => {
                let ordinal = {
                    let mut ordinals = self.ordinals.lock().unwrap();
                    let count = ordinals.entry(survey.clone()).or_default();
                    *count += 1;
                    *count - 1
                };
                if candidates.is_empty() {
                    return Err(self.inner.missing(id));
                }
                candidates.sort_by(|a, b| a.instance.cmp(&b.instance));
                candidates[pick(&self.program, &survey, ordinal, candidates.len())].instance.clone()
            }
        };
        let candidate = candidates.iter().find(|c| c.instance == instance).expect("the served version is a candidate");
        Ok(Loaded { instance: Js::Str(instance.clone()), data: parse(&instance, &candidate.text)? })
    }
    fn candidates(&self, id: &Js) -> Result<Vec<Candidate>, String> {
        self.inner.candidates(id)
    }
    fn missing(&self, id: &Js) -> String {
        self.inner.missing(id)
    }
    fn named(&self, id: &Js) -> bool {
        self.inner.named(id)
    }
}

async fn compile_with(source: impl SurveySource + 'static, ast: &Json) -> Result<Option<String>, Vec<String>> {
    let compiled =
        Compiler::new(L0182::with_source(source)).compile(ast, &json!({}), &json!({}), Identity::default()).await;
    outcome(&compiled)
}

/// Where interpreting differs from today's compile on purpose:
/// - a sessionless occurrence of a survey with several versions: a stateless pick, not a draw
///   (and a draw it no longer takes shifts the draws after it);
/// - one session taking more than one survey: one record per `(survey, session)`, not one slot
///   per session (decision 2);
/// - an occurrence whose identity the extractor can't name: its program computes the survey or
///   session, so the comparison would need the run itself.
fn deliberate(case: &Case) -> bool {
    let report = extract(&case.ast, None, false);
    let several = |survey: &str| {
        Files::installed(|_| 0).candidates(&Js::Str(survey.to_owned())).map(|c| c.len() > 1).unwrap_or(false)
    };
    let sessionless = report["sessionless"].as_array().unwrap().iter().any(|s| several(s["survey"].as_str().unwrap()));
    let mut by_session: HashMap<String, HashSet<String>> = HashMap::new();
    for identity in report["unresolved"].as_array().unwrap() {
        by_session
            .entry(identity["session"].as_str().unwrap().to_owned())
            .or_default()
            .insert(identity["survey"].as_str().unwrap().to_owned());
    }
    let shared_session = by_session.values().any(|surveys| surveys.len() > 1);
    let unknown = !report["quarantine"].as_array().unwrap().is_empty();
    sessionless || shared_session || unknown
}

#[tokio::test]
async fn every_case_interprets_through_the_exchange() {
    let cases = cases();
    assert!(cases.len() >= 3000, "the fixture looks truncated: {} cases", cases.len());
    let mut exact_failures = Vec::new();
    let mut unexplained = Vec::new();
    let mut deliberate_count = 0;
    let mut deliberate_differing = 0;
    let mut deepest = (0, String::new());
    for case in cases.iter().filter(|case| !diverges(case)) {
        let (interpreted, table, calls) = exchange(case).await;
        if calls > deepest.0 {
            deepest = (calls, case.src.clone());
        }
        let program = program_digest(&Ast::from_json(&case.ast).unwrap());
        let mirror = Mirror { inner: inner(case), table, program, ordinals: Mutex::default() };
        let mirrored = compile_with(mirror, &case.ast).await;
        if mirrored != interpreted {
            exact_failures.push(format!("{}\n  interpreted {interpreted:?}\n  mirrored    {mirrored:?}", case.src));
        }
        let today = compile_with(BoxedSource(inner(case)), &case.ast).await;
        if deliberate(case) {
            deliberate_count += 1;
            deliberate_differing += usize::from(today != interpreted);
        } else if today != interpreted {
            unexplained.push(format!("{}\n  interpreted {interpreted:?}\n  compiled    {today:?}", case.src));
        }
    }
    eprintln!(
        "interpretation gate: deepest exchange {} calls ({}); {deliberate_count} cases with a deliberate difference, {deliberate_differing} of them differing",
        deepest.0, deepest.1
    );
    let (exact, other) = (exact_failures.len(), unexplained.len());
    exact_failures.truncate(5);
    unexplained.truncate(5);
    assert!(exact_failures.is_empty(), "{exact} cases differ from their mirror:\n\n{}", exact_failures.join("\n\n"));
    assert!(
        other == 0,
        "{other} cases differ from today's compile without a deliberate reason:\n\n{}",
        unexplained.join("\n\n")
    );
    assert!(deepest.0 <= 16);
}
