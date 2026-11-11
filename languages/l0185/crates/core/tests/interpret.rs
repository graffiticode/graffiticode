// SPDX-License-Identifier: MIT

//! L0185 under the interpreter (docs/c3-l0185-interpreter-plan.md): every conformance case's
//! model is a plan (models never fetch), interpreting it in both modes gives exactly what
//! compiling it gives, and a result that fetched is `shared` until FETCHED_TTL_MS after its
//! earliest fetch, while one that didn't carries no restriction (immutable, as today).

use async_trait::async_trait;
use graffiticode_l0000::{CacheClass, Compiler, Diagnostic, Identity, Mode, ModelKind, Restriction, Value};
use graffiticode_l0185::{FETCHED_TTL_MS, FetchResult, Fetcher, L0185, now_ms};
use serde::Deserialize;
use serde_json::{Value as Json, json};

mod common;
use common::Fixtures;

#[derive(Deserialize)]
struct Case {
    src: String,
    ast: Json,
}

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("conformance/cases.json")).unwrap()
}

/// What the server writes for a result: the JSON text of its value (none when undefined), or
/// its errors.
fn written(result: &Result<Value, Vec<Diagnostic>>) -> Result<Option<String>, String> {
    match result {
        Ok(value) => Ok(value.to_json().map(|json| graffiticode_l0000::json_text(&json))),
        Err(errors) => Err(format!("{errors:?}")),
    }
}

/// Whether `restriction` is `shared`, expiring FETCHED_TTL_MS after a fetch made within
/// [`before`, `after`].
fn fetched_restriction(restriction: Option<Restriction>, before: u64, after: u64) -> bool {
    matches!(restriction, Some(Restriction { class: CacheClass::Shared, expires_at: Some(at) })
        if at >= before + FETCHED_TTL_MS && at <= after + FETCHED_TTL_MS)
}

#[tokio::test]
async fn every_case_is_a_plan_that_interprets_exactly_as_it_compiles() {
    let all = cases();
    assert!(all.len() >= 4000, "the fixture looks truncated: {} cases", all.len());
    let (mut fetching, mut failures) = (0, Vec::new());
    for case in &all {
        let fixtures = Fixtures::new();
        let compiler = Compiler::new(L0185::with_fetcher(fixtures.clone()));
        let before = now_ms();
        let compiled = compiler.compile(&case.ast, &json!({}), &json!({}), Identity::default()).await;
        let after = now_ms();
        let fetched = !fixtures.fetched.lock().unwrap().is_empty();
        // A fetch ran exactly when the result is restricted to `shared` for FETCHED_TTL_MS; a
        // restricted result comes only from a program that fetches; nothing else is restricted.
        if fetched {
            fetching += 1;
            if !fetched_restriction(compiled.restriction, before, after) {
                failures.push(format!("{}: fetched, but restricted {:?}", case.src, compiled.restriction));
            }
        } else if compiled.restriction.is_some() && !case.src.contains("fetch") {
            failures.push(format!("{}: fetched nothing, but restricted {:?}", case.src, compiled.restriction));
        }
        let model = match compiler.model(&case.ast, &json!({})).await {
            Ok(model) => model,
            Err(errors) => {
                if written(&compiled.result) != Err(format!("{errors:?}")) {
                    failures
                        .push(format!("{}: no model ({errors:?}), but compiled to {:?}", case.src, compiled.result));
                }
                continue;
            }
        };
        // Models never fetch: every L0185 model is a plan.
        if !matches!(model.kind, ModelKind::Plan(_)) {
            failures.push(format!("{}: a value model", case.src));
            continue;
        }
        for mode in [Mode::Evaluate, Mode::Present] {
            let fixtures = Fixtures::new();
            let compiler = Compiler::new(L0185::with_fetcher(fixtures));
            let interpreted = compiler.interpret(&model, &json!({}), &json!({}), mode, Identity::default()).await;
            if written(&interpreted.result) != written(&compiled.result) {
                failures.push(format!(
                    "{} ({mode:?}): interpreted {:?}, compiled {:?}",
                    case.src,
                    written(&interpreted.result),
                    written(&compiled.result)
                ));
            }
            if interpreted.restriction.map(|r| r.class) != compiled.restriction.map(|r| r.class) {
                failures.push(format!(
                    "{} ({mode:?}): interpreted restriction {:?}, compiled {:?}",
                    case.src, interpreted.restriction, compiled.restriction
                ));
            }
        }
    }
    assert!(fetching >= 1000, "too few cases fetched: {fetching}");
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), all.len(), failures.join("\n"));
}

/// A body served from a cache keeps its original fetch time, so the result expires
/// FETCHED_TTL_MS after the data was fetched, not after the cache answered.
#[tokio::test]
async fn a_cached_body_expires_from_its_original_fetch() {
    struct Cached;
    #[async_trait]
    impl Fetcher for Cached {
        async fn fetch(&self, _url: &str) -> Result<FetchResult, String> {
            Ok(FetchResult { text: "[1,2]".into(), content_type: "application/json".into(), fetched_at: Some(1_000) })
        }
    }
    let ast = json!({
        "1": { "tag": "STR", "elts": ["https://example.org/x.json"] },
        "2": { "tag": "RECORD", "elts": [] },
        "3": { "tag": "FETCH", "elts": [1, 2] },
        "4": { "tag": "EXPRS", "elts": [3] },
        "5": { "tag": "PROG", "elts": [4] },
        "root": 5
    });
    let compiled =
        Compiler::new(L0185::with_fetcher(Cached)).compile(&ast, &json!({}), &json!({}), Identity::default()).await;
    assert!(compiled.result.is_ok(), "{:?}", compiled.result.err());
    assert_eq!(
        compiled.restriction,
        Some(Restriction { class: CacheClass::Shared, expires_at: Some(1_000 + FETCHED_TTL_MS) })
    );
}
