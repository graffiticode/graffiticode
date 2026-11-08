// SPDX-License-Identifier: MIT

//! Commands in the kernel (B5 slice 4, docs/b5-commands-plan.md §4–§6): intents carried in the
//! model and its digest only when present, `start` admitted by the command session and bound to
//! the model's intents, every occurrence bound before it is minted, runtime expansion, recorded
//! observations, and the occurrences a stage's answer lists.

use std::sync::{Arc, LazyLock, Mutex};

use async_trait::async_trait;
use graffiticode_l0000::{
    Ast, Compiler, Dialect, Evaluator, Identity, Intent, Model, ModelKind, NodeId, OccurrenceBinding, Op, PolicyClient,
    PolicySnapshot, ProtectedCall, ProtectedCallError, ProtectedFunction, ProtectedKind, RevisionIdentity,
    SnapshotRequest, Value, json_text, runtime_occurrence_id,
};
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};

static PROGRAMS: LazyLock<Json> =
    LazyLock::new(|| serde_json::from_str(include_str!("conformance/programs.json")).unwrap());

fn program(src: &str) -> &'static Json {
    PROGRAMS.get(src).unwrap_or_else(|| panic!("no parsed program for {src:?}"))
}

fn revision() -> RevisionIdentity {
    RevisionIdentity { revision: Some("l9999-r1".into()), image_digest: Some(format!("sha256:{}", "1".repeat(64))) }
}

/// A dialect whose `save-it` is a write. Statically, each `save-it` node is an intent of one
/// occurrence (`n<id>.0`); with `expanding`, one runtime intent covers them all, each call an
/// expansion keyed by its argument. `hello` reads through an observation.
struct Cmd {
    expanding: bool,
    protected: Vec<(String, ProtectedFunction)>,
    reads: Arc<Mutex<usize>>,
}

impl Cmd {
    fn new(expanding: bool) -> Self {
        Self {
            expanding,
            protected: vec![("SAVE_IT".to_owned(), ProtectedFunction::new("save-it", ProtectedKind::Write))],
            reads: Arc::default(),
        }
    }
}

#[async_trait]
impl Dialect for Cmd {
    fn lang_id(&self) -> &str {
        "9999"
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        match op.tag() {
            "SAVE_IT" => {
                let arg = cx.eval_arg(id, elts, 0).await;
                let payload = arg.to_json().unwrap_or(Json::Null);
                let occurrence_id = if self.expanding {
                    match cx.exec().expand("batch", &format!("item {payload}")) {
                        Ok(occurrence) => occurrence,
                        Err(err) => return Some(Value::from(format!("refused: {err}"))),
                    }
                } else {
                    cx.exec().next_occurrence(&format!("n{id}"))
                };
                let call = ProtectedCall {
                    function: "save-it".to_owned(),
                    op: "toy.write".to_owned(),
                    payload,
                    occurrence_id,
                };
                Some(match cx.exec().invoke(&call).await {
                    Ok(receipt) => Value::from_json(&receipt),
                    Err(err) => Value::from(format!("refused: {err}")),
                })
            }
            "HELLO" => {
                let reads = Arc::clone(&self.reads);
                let observed = cx
                    .exec()
                    .observe("cohort", || async move {
                        *reads.lock().unwrap() += 1;
                        Ok(json!({ "b": 2, "a": 1 }))
                    })
                    .await;
                Some(match observed {
                    Ok(json) => Value::from_json(&json),
                    Err(err) => Value::from(format!("unobserved: {err}")),
                })
            }
            _ => None,
        }
    }

    fn protected_functions(&self) -> &[(String, ProtectedFunction)] {
        &self.protected
    }

    fn registry_version(&self) -> Option<u32> {
        Some(6)
    }

    fn intents(&self, ast: &Ast) -> Vec<Intent> {
        if self.expanding {
            return vec![Intent::expanding("batch", "save-it", "toy.write", 2)];
        }
        ast.nodes()
            .filter_map(|(id, node)| match node {
                graffiticode_l0000::Node::Form { op, .. } if op.tag() == "SAVE_IT" => {
                    Some(Intent::fixed(format!("save-{id}"), "save-it", "toy.write", vec![format!("n{id}.0")]))
                }
                _ => None,
            })
            .collect()
    }
}

/// Policy as the kernel sees it for a command: the session's functions and binding, and every
/// bind, mint and observation it was asked for.
#[derive(Clone, Default)]
struct Policy {
    bind: Option<Json>,
    refuse_binds: bool,
    binds: Arc<Mutex<Vec<OccurrenceBinding>>>,
    minted: Arc<Mutex<Vec<String>>>,
    recorded: Arc<Mutex<Option<String>>>,
    snapshots: Arc<Mutex<usize>>,
}

#[async_trait]
impl PolicyClient for Policy {
    async fn snapshot(&self, _request: SnapshotRequest<'_>) -> Result<PolicySnapshot, ProtectedCallError> {
        *self.snapshots.lock().unwrap() += 1;
        Ok(PolicySnapshot { allowed: vec!["save-it".into()], session_token: Some("legacy-session".into()), bind: None })
    }

    async fn command_session(&self, session_token: &str) -> Result<PolicySnapshot, ProtectedCallError> {
        if session_token != "command-session" {
            return Err(ProtectedCallError::BadSession);
        }
        Ok(PolicySnapshot {
            allowed: vec!["save-it".into()],
            session_token: Some(session_token.into()),
            bind: self.bind.clone(),
        })
    }

    async fn bind_occurrence(
        &self,
        _session_token: &str,
        binding: &OccurrenceBinding,
    ) -> Result<(), ProtectedCallError> {
        if self.refuse_binds {
            return Err(ProtectedCallError::Rejected {
                path: "/v1/command-occurrences".into(),
                status: 403,
                reason: Some("bounds-exceeded".into()),
                category: Some("permission".into()),
                effect_unknown: false,
            });
        }
        self.binds.lock().unwrap().push(binding.clone());
        Ok(())
    }

    async fn invoke(&self, _session_token: &str, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        self.minted.lock().unwrap().push(call.occurrence_id.clone());
        Ok(json!({ "status": "succeeded", "steps": [], "result": { "saved": call.payload } }))
    }

    async fn observe(
        &self,
        _session_token: &str,
        _key: &str,
        text: Option<&str>,
    ) -> Result<Option<String>, ProtectedCallError> {
        let mut recorded = self.recorded.lock().unwrap();
        if let Some(text) = text
            && recorded.is_none()
        {
            *recorded = Some(text.to_owned());
        }
        Ok(recorded.clone())
    }
}

/// A compiler for `Cmd`, and a policy whose session binds this compiler's stage `s0` of `src`.
async fn setup(src: &str, expanding: bool) -> (Compiler, Policy, Model) {
    let unbound = Compiler::new(Cmd::new(expanding)).with_revision(revision());
    let manifest = unbound.preflight(program(src), "s0", &Json::Null).expect("a manifest");
    let policy = Policy { bind: Some(json!(manifest)), ..Policy::default() };
    let compiler = Compiler::new(Cmd::new(expanding)).with_policy(policy.clone()).with_revision(revision());
    let model = compiler.model(program(src), &Json::Null).await.expect("a model");
    (compiler, policy, model)
}

fn command(stage: &str) -> Identity {
    Identity {
        uid: Some("u1".into()),
        connection_id: Some("conn-1".into()),
        stage: Some(stage.into()),
        command_session: Some("command-session".into()),
        ..Identity::default()
    }
}

#[test]
fn a_model_without_intents_keeps_its_text_and_digest() {
    let model = Model::new("9999", ModelKind::Value(json!({ "z": 1, "a": 2 })));
    let json = model.to_json();
    assert!(json.get("intents").is_none());
    let before = hex::encode(Sha256::digest(json_text(
        &json!({ "lang": "9999", "kind": "value", "carried": { "z": 1, "a": 2 } }),
    )));
    assert_eq!(model.digest(), before);
    assert_eq!(Model::from_json(&json).unwrap(), model);
}

#[test]
fn intents_join_the_text_and_the_digest() {
    let plain = Model::new("9999", ModelKind::Plan(json!({ "root": "0" })));
    let with =
        Model { intents: vec![Intent::fixed("save-1", "save-it", "toy.write", vec!["n1.0".into()])], ..plain.clone() };
    assert_ne!(with.digest(), plain.digest());
    let json = with.to_json();
    assert_eq!(
        json["intents"],
        json!([{ "id": "save-1", "fn": "save-it", "op": "toy.write", "occurrences": ["n1.0"] }])
    );
    assert_eq!(Model::from_json(&json).unwrap(), with);
    // Intents can't be added to, or dropped from, a model that keeps its digest.
    let mut stripped = json.clone();
    stripped.as_object_mut().unwrap().remove("intents");
    assert!(Model::from_json(&stripped).is_err());
    let runtime = Intent::expanding("batch", "save-it", "toy.write", 3);
    assert_eq!(
        runtime.to_json(),
        json!({ "id": "batch", "fn": "save-it", "op": "toy.write", "runtime": true, "bounds": { "maxOccurrences": 3 } })
    );
    assert_eq!(Intent::from_json(&runtime.to_json()).unwrap(), runtime);
}

#[test]
fn runtime_occurrence_ids_match_policys_encoding() {
    // The same vectors as packages/policy/src/command-records.spec.ts, from JSON.stringify.
    assert_eq!(
        runtime_occurrence_id("batch", "batch 3"),
        "x:f35a77fd3bf9bee5b6545b22e547993efae82e6447c58aeccdea9f053eddd5d0"
    );
    assert_eq!(
        runtime_occurrence_id("sa\"ve/é", "k\n1"),
        "x:dcd6ad29865e8912dad4c9a8839841d6b91a7d6443a2f5c6868f221248f133b5"
    );
}

#[tokio::test]
async fn a_plan_carries_the_dialects_intents() {
    let (_compiler, _policy, model) = setup("save-it 1..", false).await;
    assert_eq!(model.intents.len(), 1);
    assert_eq!(model.intents[0].function, "save-it");
}

#[tokio::test]
async fn start_binds_each_occurrence_before_minting_and_lists_them() {
    let (compiler, policy, model) = setup("save-it 1..", false).await;
    let started = compiler.start(&model, &json!({}), &Json::Null, command("s0")).await;
    assert!(started.result.is_ok(), "{:?}", started.result);
    let occurrence = model.intents[0].occurrences[0].clone();
    let binds = policy.binds.lock().unwrap().clone();
    assert_eq!(binds.len(), 1);
    assert_eq!(
        (binds[0].occurrence_id.as_str(), binds[0].intent_id.as_str(), binds[0].args.as_str()),
        (occurrence.as_str(), model.intents[0].id.as_str(), "1")
    );
    assert_eq!(binds[0].argd, graffiticode_l0000::canonical::args_digest(&json!(1)));
    assert_eq!(*policy.minted.lock().unwrap(), vec![occurrence.clone()]);
    assert_eq!(started.occurrences.unwrap(), [(model.intents[0].id.clone(), vec![occurrence])].into_iter().collect());
    // Admission came from the command session: no legacy snapshot.
    assert_eq!(*policy.snapshots.lock().unwrap(), 0);
}

#[tokio::test]
async fn start_refuses_before_anything_runs() {
    let (compiler, policy, model) = setup("save-it 1..", false).await;
    let code = |c: graffiticode_l0000::Compilation| c.result.unwrap_err()[0].code.clone();
    let no_intents = Model { intents: Vec::new(), ..model.clone() };
    assert_eq!(
        code(compiler.start(&no_intents, &json!({}), &Json::Null, command("s0")).await).as_deref(),
        Some("no-intents")
    );
    let no_session = Identity { command_session: None, ..command("s0") };
    assert_eq!(code(compiler.start(&model, &json!({}), &Json::Null, no_session).await).as_deref(), Some("bad-session"));
    let forged = Identity { command_session: Some("forged".into()), ..command("s0") };
    assert_eq!(code(compiler.start(&model, &json!({}), &Json::Null, forged).await).as_deref(), Some("bad-session"));
    // Another stage than the one the session binds: this compiler isn't the pinned one.
    let bound_elsewhere = Policy { bind: Some(json!({ "lang": "9999" })), ..policy.clone() };
    let other = Compiler::new(Cmd::new(false)).with_policy(bound_elsewhere).with_revision(revision());
    assert!(other.start(&model, &json!({}), &Json::Null, command("s0")).await.result.is_err());
    assert!(policy.binds.lock().unwrap().is_empty());
    assert!(policy.minted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_occurrence_outside_the_models_intents_is_never_bound_or_minted() {
    let (compiler, policy, model) = setup("save-it 1..", false).await;
    // The same program, but the model declares another node's occurrence.
    let wrong =
        Model { intents: vec![Intent::fixed("save-x", "save-it", "toy.write", vec!["n999.0".into()])], ..model };
    let started = compiler.start(&wrong, &json!({}), &Json::Null, command("s0")).await;
    assert!(format!("{:?}", started.result).contains("refused"), "{:?}", started.result);
    assert!(policy.binds.lock().unwrap().is_empty());
    assert!(policy.minted.lock().unwrap().is_empty());
    assert_eq!(started.effects[0].status, graffiticode_l0000::EffectStatus::Failed);
}

#[tokio::test]
async fn a_refused_bind_mints_nothing() {
    let (_unused, mut policy, model) = setup("save-it 1..", false).await;
    policy.refuse_binds = true;
    let compiler = Compiler::new(Cmd::new(false)).with_policy(policy.clone()).with_revision(revision());
    let started = compiler.start(&model, &json!({}), &Json::Null, command("s0")).await;
    assert!(policy.minted.lock().unwrap().is_empty());
    assert_eq!(started.effects[0].reason.as_deref(), Some("bounds-exceeded"));
    assert!(started.occurrences.unwrap().is_empty());
}

#[tokio::test]
async fn runtime_expansions_bind_with_their_keys() {
    let (compiler, policy, model) = setup("map (<x: save-it x>) [1 2]..", true).await;
    let started = compiler.start(&model, &json!({}), &Json::Null, command("s0")).await;
    assert!(started.result.is_ok(), "{:?}", started.result);
    let binds = policy.binds.lock().unwrap().clone();
    let keys: Vec<_> = binds.iter().map(|b| (b.expansion_key.clone().unwrap(), b.occurrence_id.clone())).collect();
    assert_eq!(
        keys,
        vec![
            ("item 1".to_owned(), runtime_occurrence_id("batch", "item 1")),
            ("item 2".to_owned(), runtime_occurrence_id("batch", "item 2")),
        ]
    );
    assert_eq!(started.occurrences.unwrap()["batch"].len(), 2);
}

#[tokio::test]
async fn a_read_never_runs_as_a_command() {
    let (compiler, policy, model) = setup("save-it 1..", false).await;
    // `get` with a command session: admitted the legacy way, never bound.
    let read =
        compiler.interpret(&model, &json!({}), &Json::Null, graffiticode_l0000::Mode::Evaluate, command("s0")).await;
    assert!(read.occurrences.is_none());
    assert!(policy.binds.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_observation_is_read_once_and_replayed() {
    let src = "hello \"world\"..";
    let unbound = Compiler::new(Cmd::new(false)).with_revision(revision());
    let manifest = unbound.preflight(program(src), "s0", &Json::Null).unwrap();
    let policy = Policy { bind: Some(json!(manifest)), ..Policy::default() };
    let dialect = Cmd::new(false);
    let reads = Arc::clone(&dialect.reads);
    let compiler = Compiler::new(dialect).with_policy(policy.clone()).with_revision(revision());
    let model = Model {
        intents: vec![Intent::fixed("never", "save-it", "toy.write", vec!["n0.0".into()])],
        ..compiler.model(program(src), &Json::Null).await.unwrap()
    };
    for _ in 0..2 {
        let started = compiler.start(&model, &json!({}), &Json::Null, command("s0")).await;
        // The recorded text, key order kept.
        assert_eq!(started.result.unwrap().to_json().map(|j| j.to_string()), Some("{\"b\":2,\"a\":1}".to_owned()));
    }
    assert_eq!(*reads.lock().unwrap(), 1, "the read ran once; the retry replayed its record");
}
