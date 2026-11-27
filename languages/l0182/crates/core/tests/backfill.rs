// SPDX-License-Identifier: MIT

//! The backfill extractor on fixtures (C4 slice 2): a stored program and the output a compile
//! saved for it, never anything read from a store. Saved outputs are produced here by today's
//! compile (`Files::installed`) or written by hand where a fixture needs what a compile can't
//! give (two records that disagree, as process-local draws left them).

use std::io::Write;
use std::process::{Command, Stdio};

use graffiticode_l0000::{Compiler, Identity};
use graffiticode_l0182::L0182;
use graffiticode_l0182::assigned::key;
use graffiticode_l0182::backfill::extract;
use graffiticode_l0182::source::Files;
use serde_json::{Value as Json, json};

mod common;
use common::Prog;

/// What today's compile saves for `code`.
async fn saved(code: &Json, pick: fn(usize) -> usize) -> Json {
    Compiler::new(L0182::with_source(Files::installed(pick)))
        .compile(code, &json!({}), &json!({}), Identity::default())
        .await
        .result
        .expect("the fixture compiles")
        .to_json()
        .unwrap()
}

fn answered(p: &mut Prog, id: &str, session: &str) -> u32 {
    let choice = p.str("affordable housing");
    let choices = p.form("LIST", &[choice]);
    let choices = p.form("CHOICES", &[choices]);
    let attrs = p.form("LIST", &[choices]);
    let response = p.form("RESPONSE", &[attrs]);
    let session = p.str(session);
    p.survey(id, Some(session), &[response])
}

#[tokio::test]
async fn an_answered_session_demonstrates_its_version_and_response() {
    let mut p = Prog::default();
    let s = answered(&mut p, "civic-priorities-3", "s-1");
    let code = p.program(&[s]);
    let output = saved(&code, |_| 0).await;
    let report = extract(&code, Some(&output), false);
    assert_eq!(
        report["identities"],
        json!([{
            "survey": "civic-priorities-3", "session": "s-1", "key": key("civic-priorities-3", "s-1"),
            "instance": "civic-priorities-3", "response": true, "errorFree": true,
        }])
    );
    assert_eq!(report["unresolved"], json!([]));
    assert_eq!(report["quarantine"], json!([]));
    // A compile that reported errors never demonstrates an error-free response.
    assert_eq!(extract(&code, Some(&output), true)["identities"][0]["errorFree"], json!(false));
}

#[tokio::test]
async fn a_bare_id_is_confirmed_by_its_instance() {
    let mut p = Prog::default();
    let a = p.session("civic-priorities", "a");
    let code = p.program(&[a]);
    let output = saved(&code, |_| 0).await;
    let report = extract(&code, Some(&output), false);
    assert_eq!(report["identities"][0]["instance"], json!("civic-priorities-1"));
    assert_eq!(report["identities"][0]["response"], json!(false));

    // The bare/named distinction: a survey id is never shown as itself, and a version of
    // another survey isn't one of its versions.
    for shown in ["civic-priorities", "workplace-pulse-1", "civic-priorities-x"] {
        let mut wrong = output.clone();
        wrong["survey"]["instance"] = json!(shown);
        let report = extract(&code, Some(&wrong), false);
        assert_eq!(report["identities"], json!([]), "{shown}");
        assert_eq!(report["unresolved"][0]["reason"], json!("instance-not-a-version"), "{shown}");
    }
}

#[tokio::test]
async fn a_named_version_is_confirmed_only_by_itself() {
    let mut p = Prog::default();
    let s = p.session("civic-priorities-3", "a");
    let code = p.program(&[s]);
    let output = saved(&code, |_| 0).await;
    assert_eq!(extract(&code, Some(&output), false)["identities"][0]["instance"], json!("civic-priorities-3"));
    let mut wrong = output;
    wrong["survey"]["instance"] = json!("civic-priorities-3-1");
    let report = extract(&code, Some(&wrong), false);
    assert_eq!(report["identities"], json!([]));
    assert_eq!(report["unresolved"][0]["reason"], json!("instance-not-a-version"));
}

#[tokio::test]
async fn an_ambiguous_match_stays_unresolved_even_when_the_records_agree() {
    // Two literal occurrences of one identity: each record fits both, so neither is evidence.
    let mut p = Prog::default();
    let a = p.session("civic-priorities", "a");
    let b = p.session("civic-priorities", "a");
    let list = p.form("LIST", &[a, b]);
    let code = p.program(&[list]);
    let output = saved(&code, |_| 0).await;
    assert_eq!(output[0]["survey"]["instance"], output[1]["survey"]["instance"]);
    let report = extract(&code, Some(&output), false);
    assert_eq!(report["identities"], json!([]));
    assert_eq!(report["unresolved"][0]["reason"], json!("ambiguous-match"));

    // One occurrence with several records (it ran more than once): agreeing is still
    // ambiguous, and disagreeing is today's process-local loss.
    let mut p = Prog::default();
    let s = p.session("civic-priorities", "a");
    let code = p.program(&[s]);
    let record =
        |instance: &str| json!({ "survey": { "id": "civic-priorities", "sessionId": "a", "instance": instance } });
    let agree = json!([record("civic-priorities-1"), record("civic-priorities-1")]);
    assert_eq!(extract(&code, Some(&agree), false)["unresolved"][0]["reason"], json!("ambiguous-match"));
    let split = json!([record("civic-priorities-1"), record("civic-priorities-4")]);
    let report = extract(&code, Some(&split), false);
    assert_eq!(report["unresolved"][0]["reason"], json!("conflicting-instances"));
    assert_eq!(report["unresolved"][0]["shown"], json!(["civic-priorities-1", "civic-priorities-4"]));
}

#[tokio::test]
async fn a_survey_the_saved_output_dropped_is_unresolved() {
    // `PROG` keeps the last expression: the first survey drew but its record isn't saved.
    let mut p = Prog::default();
    let a = p.session("civic-priorities", "a");
    let b = p.session("workplace-pulse", "b");
    let code = p.program(&[a, b]);
    let output = saved(&code, |_| 0).await;
    let report = extract(&code, Some(&output), false);
    assert_eq!(report["identities"].as_array().unwrap().len(), 1);
    assert_eq!(report["identities"][0]["survey"], json!("workplace-pulse"));
    assert_eq!(report["unresolved"][0]["survey"], json!("civic-priorities"));
    assert_eq!(report["unresolved"][0]["reason"], json!("absent-from-output"));
    // With no saved output at all, every identity is unresolved, and nothing is guessed.
    let none = extract(&code, None, false);
    assert_eq!(none["identities"], json!([]));
    assert_eq!(none["unresolved"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn an_identity_that_cant_be_named_quarantines_the_task() {
    // A session from the input.
    let mut p = Prog::default();
    let record = p.form("RECORD", &[]);
    let data = p.form("DATA", &[record]);
    let name = p.str("s");
    let session = p.form("GET", &[name, data]);
    let s = p.survey("civic-priorities", Some(session), &[]);
    let code = p.program(&[s]);
    let output = json!({ "survey": { "id": "civic-priorities", "sessionId": "x", "instance": "civic-priorities-2" } });
    let report = extract(&code, Some(&output), false);
    assert_eq!(report["quarantine"][0], json!({ "reason": "computed-session", "survey": "civic-priorities" }));
    // The record it left can't be attributed while an occurrence is unknown.
    assert_eq!(report["quarantine"][1]["reason"], json!("unattributable-record"));
    assert_eq!(report["identities"], json!([]));

    // A computed id, and an attribute list that isn't a literal list.
    let mut p = Prog::default();
    let name = p.str("id");
    let var = p.form("GET_VAR", &[name]);
    let id = p.form("ID", &[var]);
    let attrs = p.form("LIST", &[id]);
    let computed_id = p.form("SURVEY", &[attrs]);
    let name = p.str("attrs");
    let var = p.form("GET_VAR", &[name]);
    let computed_list = p.form("SURVEY", &[var]);
    let list = p.form("LIST", &[computed_id, computed_list]);
    let code = p.program(&[list]);
    let reasons: Vec<Json> =
        extract(&code, None, false)["quarantine"].as_array().unwrap().iter().map(|q| q["reason"].clone()).collect();
    assert!(reasons.contains(&json!("computed-id")), "{reasons:?}");
    assert!(reasons.contains(&json!("computed-attributes")), "{reasons:?}");
}

#[tokio::test]
async fn sessionless_occurrences_are_listed_for_review_only() {
    let mut p = Prog::default();
    let s = p.survey("civic-priorities", None, &[]);
    let code = p.program(&[s]);
    let output = saved(&code, |_| 0).await;
    let report = extract(&code, Some(&output), false);
    assert_eq!(report["sessionless"], json!([{ "survey": "civic-priorities", "shown": ["civic-priorities-1"] }]));
    assert_eq!(report["identities"], json!([]));
    assert_eq!(report["unresolved"], json!([]));
    assert_eq!(report["quarantine"], json!([]));
}

#[tokio::test]
async fn a_record_no_occurrence_accounts_for_is_reported() {
    let mut p = Prog::default();
    let s = p.session("civic-priorities", "a");
    let code = p.program(&[s]);
    let output = json!([
        { "survey": { "id": "civic-priorities", "sessionId": "a", "instance": "civic-priorities-1" } },
        { "survey": { "id": "workplace-pulse", "sessionId": "z", "instance": "workplace-pulse-1" } },
    ]);
    let report = extract(&code, Some(&output), false);
    assert_eq!(report["identities"][0]["instance"], json!("civic-priorities-1"));
    assert_eq!(report["quarantine"][0]["reason"], json!("unmatched-record"));
}

#[tokio::test]
async fn an_unreadable_program_quarantines_without_panicking() {
    let report = extract(&json!({ "nope": 1 }), None, false);
    assert_eq!(report["quarantine"][0]["reason"], json!("unreadable-program"));
}

#[tokio::test]
async fn the_cli_reads_stdin_and_writes_the_report() {
    let mut p = Prog::default();
    let s = answered(&mut p, "civic-priorities-3", "s-1");
    let code = p.program(&[s]);
    let output = saved(&code, |_| 0).await;
    let mut child =
        Command::new(env!("CARGO_BIN_EXE_l0182-extract")).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let input = json!({ "program": code, "output": output, "errors": false });
    child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let report: Json = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report, extract(&code, Some(&output), false));
}
