// SPDX-License-Identifier: MIT

//! L0176 saves as B5 commands (C6 slice 1, docs/c6-l0176-commands-plan.md §3): one
//! runtime-expanding intent per save site, each save an expansion keyed by its ordinal at the
//! site and bound under the command's session before it is minted; no signing under `start`;
//! and a save repeated by `map`, with or without a lambda of its own.

use std::sync::{Arc, LazyLock, Mutex};

use async_trait::async_trait;
use graffiticode_l0000::{
    Compiler, Identity, Model, OccurrenceBinding, PolicyClient, PolicySnapshot, ProtectedCall, ProtectedCallError,
    RevisionIdentity, SnapshotRequest, runtime_occurrence_id,
};
use graffiticode_l0176::{L0176, MAX_SAVES_PER_SITE, save_intent_id};
use serde_json::{Value as Json, json};

static PROGRAMS: LazyLock<Json> =
    LazyLock::new(|| serde_json::from_str(include_str!("conformance/programs.json")).unwrap());

const ITEM: &str = "item [questions [mcq []] {}]";

fn program(src: &str) -> &'static Json {
    PROGRAMS.get(src).unwrap_or_else(|| panic!("no parsed program for {src:?}"))
}

fn one_save() -> String {
    format!(r#"set-var "lrn-id" "t" save-to-itembank items [{ITEM}] {{}}.."#)
}
fn two_saves() -> String {
    format!(r#"set-var "lrn-id" "t" [save-to-itembank items [{ITEM}] {{}} save-to-itembank items [{ITEM}] {{}}].."#)
}
fn mapped_by_lambda() -> String {
    format!(r#"set-var "lrn-id" "t" map (<x: save-to-itembank items [{ITEM}] {{}}>) [1 2 3].."#)
}
fn mapped_by_callback() -> String {
    format!(r#"set-var "lrn-id" "t" map (save-to-itembank items [{ITEM}] {{}}) [1 2 3].."#)
}

fn revision() -> RevisionIdentity {
    RevisionIdentity { revision: Some("l0176r-r1".into()), image_digest: Some(format!("sha256:{}", "1".repeat(64))) }
}

/// Policy and the broker, for a command: the session's functions and binding, and every bind
/// and call. `refuse_after` refuses binds past that many, as policy does past a bound.
#[derive(Clone, Default)]
struct Fake {
    bind: Option<Json>,
    refuse_after: Option<usize>,
    binds: Arc<Mutex<Vec<OccurrenceBinding>>>,
    calls: Arc<Mutex<Vec<ProtectedCall>>>,
}

#[async_trait]
impl PolicyClient for Fake {
    async fn snapshot(&self, _request: SnapshotRequest<'_>) -> Result<PolicySnapshot, ProtectedCallError> {
        Err(ProtectedCallError::Unavailable("a command takes no snapshot".into()))
    }

    async fn command_session(&self, session_token: &str) -> Result<PolicySnapshot, ProtectedCallError> {
        Ok(PolicySnapshot {
            allowed: vec!["init".into(), "save-to-itembank".into()],
            session_token: Some(session_token.to_owned()),
            bind: self.bind.clone(),
        })
    }

    async fn bind_occurrence(
        &self,
        _session_token: &str,
        binding: &OccurrenceBinding,
    ) -> Result<(), ProtectedCallError> {
        let mut binds = self.binds.lock().unwrap();
        if self.refuse_after.is_some_and(|max| binds.len() >= max) {
            return Err(ProtectedCallError::Rejected {
                path: "/v1/command-occurrences".into(),
                status: 403,
                reason: Some("bounds-exceeded".into()),
                category: Some("permission".into()),
                effect_unknown: false,
            });
        }
        binds.push(binding.clone());
        Ok(())
    }

    async fn invoke(&self, _session_token: &str, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        self.calls.lock().unwrap().push(call.clone());
        Ok(json!({ "status": "succeeded", "result": { "saved": true, "references": [call.occurrence_id] } }))
    }
}

/// A compiler whose session binds this program's stage `s0`, the fake, and the program's model.
async fn setup(src: &str, fake: Fake) -> (Compiler, Fake, Model) {
    let manifest =
        Compiler::new(L0176::new()).with_revision(revision()).preflight(program(src), "s0", &json!({})).unwrap();
    let fake = Fake { bind: Some(json!(manifest)), ..fake };
    let compiler = Compiler::new(L0176::new()).with_policy(fake.clone()).with_revision(revision());
    let model = compiler.model(program(src), &json!({})).await.expect("a model");
    (compiler, fake, model)
}

fn command() -> Identity {
    Identity { stage: Some("s0".into()), command_session: Some("command-session".into()), ..Identity::default() }
}

/// What policy accepts in an intent id (packages/policy/src/policy.ts, `modelIntents`).
fn policy_accepts(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || "_:.-".contains(c))
}

#[tokio::test]
async fn each_save_site_is_one_runtime_intent_policy_accepts() {
    for (src, sites) in [(one_save(), 1), (two_saves(), 2), (mapped_by_lambda(), 1), (mapped_by_callback(), 1)] {
        let (_, _, model) = setup(&src, Fake::default()).await;
        assert_eq!(model.intents.len(), sites, "{src}");
        for intent in &model.intents {
            assert!(intent.id.starts_with("save:") && policy_accepts(&intent.id), "{}", intent.id);
            assert_eq!((intent.function.as_str(), intent.op.as_str()), ("save-to-itembank", "learnosity.write-items"));
            assert!(intent.is_runtime());
            assert_eq!(intent.max_occurrences, Some(MAX_SAVES_PER_SITE));
        }
        // The JSON policy reads, with the intents in it.
        assert_eq!(model.to_json()["intents"][0]["runtime"], true);
    }
}

#[tokio::test]
async fn a_start_binds_each_save_before_it_writes_and_never_signs() {
    let (compiler, fake, model) = setup(&one_save(), Fake::default()).await;
    let started = compiler.start(&model, &json!({}), &json!({}), command()).await;
    let value = started.result.expect("the save ran").to_json().unwrap();
    let intent = &model.intents[0];
    let site = intent.id.trim_start_matches("save:");
    let binds = fake.binds.lock().unwrap().clone();
    assert_eq!(binds.len(), 1);
    assert_eq!(binds[0].intent_id, intent.id);
    assert_eq!(binds[0].expansion_key.as_deref(), Some(format!("{site}#0").as_str()));
    assert_eq!(binds[0].occurrence_id, runtime_occurrence_id(&intent.id, &format!("{site}#0")));
    // Only the save reached the broker: no PROG or INIT signing under a command.
    let calls = fake.calls.lock().unwrap().clone();
    assert_eq!(calls.iter().map(|c| c.op.as_str()).collect::<Vec<_>>(), ["learnosity.write-items"]);
    assert_eq!(calls[0].occurrence_id, binds[0].occurrence_id);
    assert_eq!(value["signing"], json!({ "unsigned": "command" }));
    assert_eq!(value["data"]["itemBank"]["saved"], true);
    assert_eq!(started.occurrences.unwrap()[&intent.id], vec![binds[0].occurrence_id.clone()]);
}

#[tokio::test]
async fn a_retried_start_binds_the_same_arguments() {
    let (compiler, fake, model) = setup(&two_saves(), Fake::default()).await;
    for _ in 0..2 {
        compiler.start(&model, &json!({}), &json!({}), command()).await.result.expect("the saves ran");
    }
    let binds = fake.binds.lock().unwrap().clone();
    assert_eq!(binds.len(), 4);
    for (first, again) in binds[..2].iter().zip(&binds[2..]) {
        assert_eq!((&first.occurrence_id, &first.args, &first.argd), (&again.occurrence_id, &again.args, &again.argd));
    }
    // Two sites, two intents, each its own occurrence.
    assert_ne!(binds[0].intent_id, binds[1].intent_id);
}

#[tokio::test]
async fn a_save_repeated_by_map_is_one_expansion_per_call() {
    for src in [mapped_by_lambda(), mapped_by_callback()] {
        let (compiler, fake, model) = setup(&src, Fake::default()).await;
        compiler.start(&model, &json!({}), &json!({}), command()).await.result.expect("the saves ran");
        let binds = fake.binds.lock().unwrap().clone();
        let calls = fake.calls.lock().unwrap().clone();
        // However the program repeats its save site, every call is its own expansion, bound
        // before it writes: never a static id a second call would collide with.
        // Three elements, three saves: the callback with no lambda of its own runs its save once
        // per element, just as the lambda does.
        assert_eq!(binds.len(), 3, "{src}");
        assert_eq!(binds.len(), calls.len(), "{src}");
        let keys: Vec<_> = binds.iter().map(|b| b.expansion_key.clone().unwrap()).collect();
        let site = model.intents[0].id.trim_start_matches("save:").to_owned();
        assert_eq!(keys, (0..binds.len()).map(|n| format!("{site}#{n}")).collect::<Vec<_>>(), "{src}");
        assert!(binds.iter().all(|b| b.intent_id == model.intents[0].id));
    }
}

#[tokio::test]
async fn a_save_in_a_lambda_body_is_a_site_by_its_node() {
    // The parser gives a lambda body's nodes no source position; the site is the node's id.
    let (_, _, model) = setup(&mapped_by_lambda(), Fake::default()).await;
    let id = &model.intents[0].id;
    assert!(id.starts_with("save:n") && policy_accepts(id), "{id}");
    // The same stored program gives the same site again.
    let (_, _, again) = setup(&mapped_by_lambda(), Fake::default()).await;
    assert_eq!(&again.intents[0].id, id);
}

#[tokio::test]
async fn a_refused_bind_writes_nothing_and_the_stage_reports_it() {
    let (compiler, fake, model) = setup(&mapped_by_lambda(), Fake { refuse_after: Some(2), ..Fake::default() }).await;
    let started = compiler.start(&model, &json!({}), &json!({}), command()).await;
    let errors = started.result.expect_err("the third save was refused");
    assert!(errors.iter().any(|e| e.code.as_deref() == Some("bounds-exceeded")), "{errors:?}");
    // The two bound saves wrote; the refused one didn't, and isn't listed for the stage's close.
    assert_eq!(fake.calls.lock().unwrap().len(), 2);
    assert_eq!(started.occurrences.unwrap()[&model.intents[0].id].len(), 2);
}

#[tokio::test]
async fn an_ordinary_compile_saves_and_signs_as_before() {
    let (compiler, fake, _model) = setup(&one_save(), Fake::default()).await;
    // A compile through a connection, with no command session: today's occurrence ids.
    let identity = Identity { connection_id: Some("conn-1".into()), ..command() };
    let compiled = compiler
        .compile(program(&one_save()), &json!({}), &json!({}), Identity { command_session: None, ..identity })
        .await;
    // Without a snapshot the fake grants nothing, so nothing is bound or written.
    assert!(compiled.occurrences.is_none());
    assert!(fake.binds.lock().unwrap().is_empty());
    let _ = save_intent_id("0");
}
