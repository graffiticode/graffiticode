// SPDX-License-Identifier: MIT

//! The `Assigned` source case by case (C4 slice 2): requests and their candidates, table hits,
//! zero candidates and retained content, the selected sessionless policy, and the exchange
//! through suspension, branching and dependency depth. Programs are built node by node, the
//! way the parser lays out its pool.

use std::collections::HashSet;

use graffiticode_l0000::{Ast, Compilation, Compiler, Identity, Mode, json_text};
use graffiticode_l0182::L0182;
use graffiticode_l0182::assigned::{key, program_digest};
use graffiticode_l0182::js::Js;
use graffiticode_l0182::source::{Candidate, Files, Loaded, SurveySource, digest_of};
use serde_json::{Value as Json, json};

mod common;
use common::Prog;

// ---- The exchange ----

async fn interpret_with(source: impl SurveySource + 'static, code: &Json, input: Json, table: &Json) -> Compilation {
    let compiler = Compiler::new(L0182::with_source(source));
    let model = compiler.model(code, &json!({})).await.expect("a model");
    compiler.interpret_assigned(&model, &input, &json!({}), Mode::Evaluate, Identity::default(), Some(table)).await
}

async fn interpret(code: &Json, table: &Json) -> Compilation {
    interpret_with(Files::installed(|_| 0), code, json!({}), table).await
}

fn requests(compiled: &Compilation) -> &[Json] {
    compiled.needs_assignment.as_deref().unwrap_or_else(|| panic!("no needsAssignment: {:?}", compiled.result))
}

fn keys(compiled: &Compilation) -> Vec<String> {
    requests(compiled).iter().map(|r| r["key"].as_str().unwrap().to_owned()).collect()
}

fn value(compiled: &Compilation) -> Json {
    assert!(compiled.needs_assignment.is_none(), "still asking: {:?}", compiled.needs_assignment);
    compiled.result.as_ref().unwrap_or_else(|e| panic!("errors: {e:?}")).to_json().unwrap()
}

fn errors(compiled: &Compilation) -> Vec<(Option<String>, String)> {
    assert!(compiled.needs_assignment.is_none());
    compiled.result.as_ref().expect_err("expected errors").iter().map(|e| (e.code.clone(), e.message.clone())).collect()
}

fn file(instance: &str) -> String {
    Files::installed(|_| 0)
        .candidates(&Js::Str(instance.to_owned()))
        .unwrap()
        .into_iter()
        .find(|c| c.instance == instance)
        .unwrap()
        .text
}

fn entry(instance: &str) -> Json {
    json!({ "instance": instance, "digest": digest_of(&file(instance)) })
}

/// Plays the api: answers each request with its first candidate (or `absent`) until a result,
/// asserting progress. Returns the result and every call's requested keys.
async fn exchange(code: &Json) -> (Compilation, Vec<Vec<String>>) {
    let mut table = serde_json::Map::new();
    let mut calls = Vec::new();
    for _ in 0..16 {
        let compiled = interpret(code, &Json::Object(table.clone())).await;
        let Some(asked) = &compiled.needs_assignment else { return (compiled, calls) };
        let asked_keys: Vec<String> = asked.iter().map(|r| r["key"].as_str().unwrap().to_owned()).collect();
        for request in asked {
            let k = request["key"].as_str().unwrap().to_owned();
            assert!(!table.contains_key(&k), "asked again for {k}");
            let first = &request["candidates"][0];
            let answer = if first.is_null() {
                json!({ "absent": true })
            } else {
                json!({ "instance": first["instance"], "digest": first["digest"] })
            };
            table.insert(k, answer);
        }
        calls.push(asked_keys);
    }
    panic!("no result within 16 calls");
}

/// A source with some installed versions removed, as a release that deletes them would leave it.
struct Without(Files, &'static [&'static str]);

impl SurveySource for Without {
    fn load(&self, id: &Js, session: Option<&str>) -> Result<Loaded, String> {
        self.0.load(id, session)
    }
    fn candidates(&self, id: &Js) -> Result<Vec<Candidate>, String> {
        Ok(self.0.candidates(id)?.into_iter().filter(|c| !self.1.contains(&c.instance.as_str())).collect())
    }
    fn missing(&self, id: &Js) -> String {
        self.0.missing(id)
    }
    fn named(&self, id: &Js) -> bool {
        self.0.named(id)
    }
}

// ---- Requests and hits ----

#[tokio::test]
async fn a_miss_asks_with_every_candidate_and_draws_nothing() {
    let mut p = Prog::default();
    let s = p.session("civic-priorities", "s-1");
    let code = p.program(&[s]);
    let compiled = interpret(&code, &json!({})).await;
    let [request] = requests(&compiled) else { panic!("one request") };
    assert_eq!(request["identity"], json!({ "survey": "civic-priorities", "session": "s-1" }));
    assert_eq!(request["key"], json!(key("civic-priorities", "s-1")));
    assert_eq!(request["ordinal"], json!(0));
    let candidates = request["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 12);
    assert_eq!(candidates[1]["instance"], json!("civic-priorities-2")); // version order
    for c in candidates {
        assert_eq!(c["digest"].as_str().unwrap(), digest_of(c["content"].as_str().unwrap()));
    }
    // The envelope carries the requests and no data.
    let envelope = Compiler::new(L0182::default()).envelope(&compiled);
    assert_eq!(envelope["status"], json!(200));
    assert!(envelope.get("data").is_none());
}

#[tokio::test]
async fn a_hit_serves_the_assigned_version_on_every_call() {
    let mut p = Prog::default();
    let s = p.session("civic-priorities", "s-1");
    let code = p.program(&[s]);
    let table = json!({ key("civic-priorities", "s-1"): entry("civic-priorities-7") });
    for _ in 0..3 {
        let out = value(&interpret(&code, &table).await);
        assert_eq!(out["survey"]["instance"], json!("civic-priorities-7"));
        assert_eq!(out["survey"]["sessionId"], json!("s-1"));
    }
}

#[tokio::test]
async fn a_named_version_asks_with_its_one_candidate() {
    let mut p = Prog::default();
    let s = p.session("civic-priorities-3", "s-1");
    let code = p.program(&[s]);
    let compiled = interpret(&code, &json!({})).await;
    let candidates = requests(&compiled)[0]["candidates"].as_array().unwrap().clone();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0]["instance"], json!("civic-priorities-3"));
    let table = json!({ key("civic-priorities-3", "s-1"): entry("civic-priorities-3") });
    assert_eq!(value(&interpret(&code, &table).await)["survey"]["instance"], json!("civic-priorities-3"));
}

#[tokio::test]
async fn one_identity_is_asked_for_once_and_shared() {
    let mut p = Prog::default();
    let a = p.session("civic-priorities", "a");
    let b = p.session("workplace-pulse", "a");
    let c = p.session("civic-priorities", "a");
    let list = p.form("LIST", &[a, b, c]);
    let code = p.program(&[list]);
    let first = interpret(&code, &json!({})).await;
    assert_eq!(keys(&first), [key("civic-priorities", "a"), key("workplace-pulse", "a")]);
    let table = json!({
        key("civic-priorities", "a"): entry("civic-priorities-5"),
        key("workplace-pulse", "a"): entry("workplace-pulse-2"),
    });
    let out = value(&interpret(&code, &table).await);
    // One record per (survey, session): both civic occurrences get the same version (decision 2).
    assert_eq!(out[0]["survey"]["instance"], json!("civic-priorities-5"));
    assert_eq!(out[1]["survey"]["instance"], json!("workplace-pulse-2"));
    assert_eq!(out[2]["survey"]["instance"], json!("civic-priorities-5"));
}

// ---- Zero candidates and retained content ----

#[tokio::test]
async fn zero_candidates_still_ask_and_absent_gives_todays_message() {
    for id in ["civic-priorities-99", "no-such-survey"] {
        let mut p = Prog::default();
        let s = p.session(id, "s-1");
        let code = p.program(&[s]);
        let compiled = interpret(&code, &json!({})).await;
        assert_eq!(requests(&compiled)[0]["candidates"], json!([]));
        let absent = interpret(&code, &json!({ key(id, "s-1"): { "absent": true } })).await;
        let today = Compiler::new(L0182::with_source(Files::installed(|_| 0)))
            .compile(&code, &json!({}), &json!({}), Identity::default())
            .await;
        let today: Vec<String> = today.result.unwrap_err().into_iter().map(|e| e.message).collect();
        assert_eq!(errors(&absent).into_iter().map(|(_, m)| m).collect::<Vec<_>>(), today, "{id}");
    }
}

/// A response to version 3, choosing its first option by text, which only version 3 is sure to
/// offer.
fn answered(p: &mut Prog, id: &str) -> u32 {
    let data: Json = serde_json::from_str(&file("civic-priorities-3")).unwrap();
    let option = data["options"][0].as_str().unwrap().to_owned();
    let choice = p.str(&option);
    let choices = p.form("LIST", &[choice]);
    let choices = p.form("CHOICES", &[choices]);
    let attrs = p.form("LIST", &[choices]);
    let response = p.form("RESPONSE", &[attrs]);
    let session = p.str("s-1");
    p.survey(id, Some(session), &[response])
}

#[tokio::test]
async fn retained_content_renders_and_validates_once_the_version_is_removed() {
    for id in ["civic-priorities-3", "civic-priorities"] {
        let mut p = Prog::default();
        let s = answered(&mut p, id);
        let code = p.program(&[s]);
        let table = json!({ key(id, "s-1"): entry("civic-priorities-3") });
        let original = value(&interpret(&code, &table).await);
        assert!(original.get("response").is_some(), "{original}");
        let gone = Without(Files::installed(|_| 0), &["civic-priorities-3"]);
        // Without retained content the frozen version can't be served.
        let missing = interpret_with(gone, &code, json!({}), &table).await;
        assert_eq!(errors(&missing)[0].0.as_deref(), Some("assignment-content-missing"));
        let mut retained = table.clone();
        retained[key(id, "s-1")]["content"] = json!(file("civic-priorities-3"));
        let gone = Without(Files::installed(|_| 0), &["civic-priorities-3"]);
        let served = value(&interpret_with(gone, &code, json!({}), &retained).await);
        assert_eq!(json_text(&served), json_text(&original), "{id}");
    }
}

#[tokio::test]
async fn retained_content_must_match_its_digest_and_the_instance_must_be_a_version() {
    let mut p = Prog::default();
    let s = p.session("civic-priorities", "s-1");
    let code = p.program(&[s]);
    let k = key("civic-priorities", "s-1");
    let wrong =
        json!({ &k: { "instance": "civic-priorities-3", "digest": "00", "content": file("civic-priorities-3") } });
    assert_eq!(errors(&interpret(&code, &wrong).await)[0].0.as_deref(), Some("assignment-content-mismatch"));
    let stranger = json!({ &k: entry("workplace-pulse-1") });
    assert_eq!(errors(&interpret(&code, &stranger).await)[0].0.as_deref(), Some("assignment-invalid"));
    let stale = json!({ &k: { "instance": "civic-priorities-3", "digest": "00" } });
    assert_eq!(errors(&interpret(&code, &stale).await)[0].0.as_deref(), Some("assignment-content-missing"));
}

#[tokio::test]
async fn a_survey_id_is_never_served_as_itself_nor_a_named_version_as_one_of_its_own() {
    // Bare ref, instance equal to the ref; named ref, instance `<ref>-1`. Both refused, whether
    // served from a candidate or from retained content whose digest matches.
    let content = file("civic-priorities-3");
    for (id, instance) in [("civic-priorities", "civic-priorities"), ("civic-priorities-3", "civic-priorities-3-1")] {
        let mut p = Prog::default();
        let s = p.session(id, "s-1");
        let code = p.program(&[s]);
        let k = key(id, "s-1");
        let retained = json!({ &k: { "instance": instance, "digest": digest_of(&content), "content": content } });
        assert_eq!(errors(&interpret(&code, &retained).await)[0].0.as_deref(), Some("assignment-invalid"), "{id}");
        let plain = json!({ &k: { "instance": instance, "digest": digest_of(&content) } });
        assert_eq!(errors(&interpret(&code, &plain).await)[0].0.as_deref(), Some("assignment-invalid"), "{id}");
    }
}

// ---- The program digest: bounded, with shared subgraphs and cycles ----

/// A program whose untaken branch holds `shape` (a DAG or a cycle) and whose taken branch is a
/// sessionless survey, so the program digest is computed.
fn untaken(build: impl FnOnce(&mut Prog) -> u32) -> Json {
    let mut p = Prog::default();
    let hidden = build(&mut p);
    let no = p.node("BOOL", vec![json!(false)]);
    let shown = p.survey("civic-priorities", None, &[]);
    let branch = p.form("IF", &[no, hidden, shown]);
    p.program(&[branch])
}

#[tokio::test]
async fn the_program_digest_is_bounded_for_a_shared_dag_and_a_cycle() {
    // 45 nodes, each referring twice to the one before: 2^44 paths if expanded.
    let dag = untaken(|p| {
        let mut prev = p.str("leaf");
        for _ in 0..44 {
            prev = p.form("LIST", &[prev, prev]);
        }
        prev
    });
    // A list that contains itself.
    let cycle = untaken(|p| {
        let leaf = p.str("leaf");
        let list = p.form("LIST", &[leaf]);
        let mut pool = std::mem::take(p);
        pool.set_elts(list, &[leaf, list]);
        *p = pool;
        list
    });
    for code in [dag, cycle] {
        // Expanding the graph (the previous digest) never returned for either; this is linear.
        let started = std::time::Instant::now();
        let first = value(&interpret(&code, &json!({})).await);
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
        assert_eq!(value(&interpret(&code, &json!({})).await), first);
        let digest = program_digest(&Ast::from_json(&code).unwrap());
        assert_eq!(digest, program_digest(&Ast::from_json(&code).unwrap()));
    }
}

#[test]
fn the_program_digest_covers_the_program_and_nothing_else() {
    let make = |text: &str| {
        let mut p = Prog::default();
        let s = p.str(text);
        p.program(&[s])
    };
    let a = program_digest(&Ast::from_json(&make("a")).unwrap());
    assert_ne!(a, program_digest(&Ast::from_json(&make("b")).unwrap()));
    // Source positions don't count.
    let mut placed = make("a");
    placed["1"]["coord"] = json!({ "from": 0, "to": 3 });
    assert_eq!(a, program_digest(&Ast::from_json(&placed).unwrap()));
}

// ---- Sessionless (selected: stateless reads) ----

#[tokio::test]
async fn a_sessionless_occurrence_is_never_requested_and_picks_statelessly() {
    let mut p = Prog::default();
    let a = p.survey("civic-priorities", None, &[]);
    let b = p.survey("civic-priorities", None, &[]);
    let list = p.form("LIST", &[a, b]);
    let code = p.program(&[list]);
    let first = value(&interpret(&code, &json!({})).await);
    for _ in 0..3 {
        assert_eq!(value(&interpret(&code, &json!({})).await), first);
    }
    // A table, even one naming these surveys, changes nothing: nothing is looked up.
    let table = json!({ key("civic-priorities", ""): entry("civic-priorities-1") });
    assert_eq!(value(&interpret(&code, &table).await), first);
    assert!(first[0]["survey"].get("sessionId").is_none());
}

#[tokio::test]
async fn a_sessionless_pick_waits_until_everything_before_it_is_resolved() {
    let mut p = Prog::default();
    let s = p.session("civic-priorities", "s-1");
    let bare = p.survey("workplace-pulse", None, &[]);
    let list = p.form("LIST", &[s, bare]);
    let code = p.program(&[list]);
    let first = interpret(&code, &json!({})).await;
    assert_eq!(keys(&first), [key("civic-priorities", "s-1")]);
    let table = json!({ key("civic-priorities", "s-1"): entry("civic-priorities-2") });
    let out = value(&interpret(&code, &table).await);
    // The pick is the one a run with nothing pending makes.
    let mut q = Prog::default();
    let s2 = q.session("civic-priorities", "s-1");
    let bare2 = q.survey("workplace-pulse", None, &[]);
    let list2 = q.form("LIST", &[s2, bare2]);
    let same = q.program(&[list2]);
    assert_eq!(value(&interpret(&same, &table).await), out);
}

// ---- Suspension, branching and depth ----

#[tokio::test]
async fn a_session_from_the_input_asks_for_the_runtime_identity() {
    let mut p = Prog::default();
    let record = p.form("RECORD", &[]);
    let data = p.form("DATA", &[record]);
    let name = p.str("s");
    let session = p.form("GET", &[name, data]);
    let s = p.survey("civic-priorities", Some(session), &[]);
    let code = p.program(&[s]);
    let compiled = interpret_with(Files::installed(|_| 0), &code, json!({ "s": "from-input" }), &json!({})).await;
    assert_eq!(keys(&compiled), [key("civic-priorities", "from-input")]);
}

#[tokio::test]
async fn a_branch_on_a_surveys_content_asks_only_for_the_branch_taken() {
    let mut p = Prog::default();
    let s1 = p.session("civic-priorities", "a");
    let instance = p.instance_of(s1);
    let first = p.str("civic-priorities-1");
    let cond = p.form("EQUIV", &[instance, first]);
    let then = p.session("workplace-pulse", "b");
    let otherwise = p.session("workplace-pulse", "c");
    let branch = p.form("IF", &[cond, then, otherwise]);
    let code = p.program(&[branch]);
    let (result, calls) = exchange(&code).await;
    assert_eq!(calls, [vec![key("civic-priorities", "a")], vec![key("workplace-pulse", "b")]]);
    assert_eq!(value(&result)["survey"]["sessionId"], json!("b"));
}

#[tokio::test]
async fn a_session_computed_from_a_survey_waits_for_it() {
    let mut p = Prog::default();
    let s1 = p.session("civic-priorities", "a");
    let instance = p.instance_of(s1);
    let s2 = p.survey("workplace-pulse", Some(instance), &[]);
    let code = p.program(&[s2]);
    let (result, calls) = exchange(&code).await;
    assert_eq!(calls, [vec![key("civic-priorities", "a")], vec![key("workplace-pulse", "civic-priorities-1")]]);
    assert_eq!(value(&result)["survey"]["sessionId"], json!("civic-priorities-1"));
}

#[tokio::test]
async fn a_suspended_branch_that_sets_a_variable_suspends_what_reads_it() {
    let mut p = Prog::default();
    let s1 = p.session("civic-priorities", "a");
    let instance = p.instance_of(s1);
    let first = p.str("civic-priorities-1");
    let cond = p.form("EQUIV", &[instance, first]);
    let (n1, v1, n2, v2) = (p.str("s"), p.str("x"), p.str("s"), p.str("y"));
    let set_x = p.form("SET_VAR", &[n1, v1]);
    let set_y = p.form("SET_VAR", &[n2, v2]);
    let branch = p.form("IF", &[cond, set_x, set_y]);
    let name = p.str("s");
    let read = p.form("GET_VAR", &[name]);
    let s2 = p.survey("workplace-pulse", Some(read), &[]);
    let code = p.program(&[branch, s2]);
    let (result, calls) = exchange(&code).await;
    // Never asked under a stale or undefined session: only once the branch has run.
    assert_eq!(calls, [vec![key("civic-priorities", "a")], vec![key("workplace-pulse", "x")]]);
    assert_eq!(value(&result)["survey"]["sessionId"], json!("x"));
}

#[tokio::test]
async fn a_filter_on_survey_content_suspends_and_a_map_asks_for_every_session() {
    // map <s: survey [id "civic-priorities" session-id s]> ["a" "b"]: both asked in one call.
    let mut p = Prog::default();
    let param = p.ident("s");
    let body = p.survey("civic-priorities", Some(param), &[]);
    let mapper = p.lambda(&["s"], body);
    let (a, b) = (p.str("a"), p.str("b"));
    let sessions = p.form("LIST", &[a, b]);
    let map = p.form("MAP", &[mapper, sessions]);
    let code = p.program(&[map]);
    let (result, calls) = exchange(&code).await;
    assert_eq!(calls, [vec![key("civic-priorities", "a"), key("civic-priorities", "b")]]);
    assert_eq!(value(&result).as_array().unwrap().len(), 2);

    // filter <x: equiv (instance x) "civic-priorities-1"> [S(a) S(b)], then a survey for each kept
    // one: nothing beyond the two is asked until they resolve.
    let mut p = Prog::default();
    let sa = p.session("civic-priorities", "a");
    let sb = p.session("civic-priorities", "b");
    let list = p.form("LIST", &[sa, sb]);
    let x = p.ident("x");
    let instance = p.instance_of(x);
    let first = p.str("civic-priorities-1");
    let keep = p.form("EQUIV", &[instance, first]);
    let predicate = p.lambda(&["x"], keep);
    let filtered = p.form("FILTER", &[predicate, list]);
    let code = p.program(&[filtered]);
    let (result, calls) = exchange(&code).await;
    assert_eq!(calls.len(), 1);
    assert_eq!(value(&result).as_array().unwrap().len(), 2); // both were assigned the first candidate
}

#[tokio::test]
async fn a_dependency_chain_takes_one_call_per_link_with_progress_on_each() {
    // Each survey's session is the previous one's instance plus its link number: five links,
    // six calls.
    let mut p = Prog::default();
    let mut prev = p.session("civic-priorities", "root");
    for link in 0..5 {
        let instance = p.instance_of(prev);
        let suffix = p.str(&format!("/{link}"));
        let session = p.form("CONCAT", &[instance, suffix]);
        prev = p.survey("workplace-pulse", Some(session), &[]);
    }
    let code = p.program(&[prev]);
    let (result, calls) = exchange(&code).await;
    assert_eq!(calls.len(), 6);
    assert!(calls.iter().all(|asked| asked.len() == 1));
    let distinct: HashSet<&String> = calls.iter().flatten().collect();
    assert_eq!(distinct.len(), 6);
    value(&result);
}

#[tokio::test]
async fn compile_is_unchanged_it_draws_and_never_asks() {
    let mut p = Prog::default();
    let s = p.session("civic-priorities", "s-1");
    let code = p.program(&[s]);
    let compiled = Compiler::new(L0182::with_source(Files::installed(|_| 0)))
        .compile(&code, &json!({}), &json!({}), Identity::default())
        .await;
    assert!(compiled.needs_assignment.is_none());
    assert_eq!(compiled.result.unwrap().to_json().unwrap()["survey"]["instance"], json!("civic-priorities-1"));
}
