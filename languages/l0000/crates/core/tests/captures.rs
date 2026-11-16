// SPDX-License-Identifier: MIT

//! Item-scoped commands in the kernel (C5a slice 6, docs/c5-l0013-commands-plan.md decisions 1,
//! 9 and 10): intents that act on an item, a command session with no connection, and a capture
//! reserved, rendered only when nothing is staged, staged, bound with exactly what was staged,
//! and invoked. Outside a command, a language whose protected functions run only as commands
//! asks policy nothing.

use std::sync::{Arc, LazyLock, Mutex};

use async_trait::async_trait;
use graffiticode_l0000::canonical::args_digest;
use graffiticode_l0000::{
    Ast, Compiler, Dialect, Evaluator, Identity, Intent, IntentScope, Model, ModelKind, NodeId, OccurrenceBinding, Op,
    PolicyClient, PolicySnapshot, ProtectedCall, ProtectedCallError, ProtectedFunction, ProtectedKind, Reservation,
    ReserveRequest, RevisionIdentity, SnapshotRequest, Staged, StagedDigest, Value,
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

/// `save-it <n>` captures `item-<n>`: as a command, reserved, rendered (counted) only when
/// nothing is staged, staged, then invoked with `{ item, sha256, captureSequence }`. Outside a
/// command it answers `direct`, as L0013 uploads directly. Its intent's item is a literal
/// (`static_item`) or arrives as data.
struct Capturer {
    static_item: Option<String>,
    protected: Vec<(String, ProtectedFunction)>,
    renders: Arc<Mutex<usize>>,
}

impl Capturer {
    fn new(static_item: Option<&str>) -> Self {
        Self {
            static_item: static_item.map(str::to_owned),
            protected: vec![("SAVE_IT".to_owned(), ProtectedFunction::new("save-it", ProtectedKind::Write))],
            renders: Arc::default(),
        }
    }
}

#[async_trait]
impl Dialect for Capturer {
    fn lang_id(&self) -> &str {
        "9999"
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        if op.tag() != "SAVE_IT" {
            return None;
        }
        let n = cx.eval_arg(id, elts, 0).await.to_json().unwrap_or(Json::Null);
        let item = format!("item-{n}");
        if !cx.exec().is_command() {
            return Some(Value::from("direct"));
        }
        let outcome: Result<Json, ProtectedCallError> = async {
            let occurrence = cx.exec().expand("capture", &format!("{id}#{n}"))?;
            let reserved = cx.exec().reserve_capture(&occurrence, &item).await?;
            let sha256 = match reserved.staged {
                Some(staged) => staged.sha256,
                None => {
                    *self.renders.lock().unwrap() += 1;
                    cx.exec().stage_capture(&occurrence, format!("png of {item}").as_bytes()).await?.sha256
                }
            };
            let call = ProtectedCall {
                function: "save-it".into(),
                op: "toy.capture".into(),
                payload: json!({ "item": reserved.item, "sha256": sha256, "captureSequence": reserved.capture_sequence }),
                occurrence_id: occurrence,
            };
            cx.exec().invoke(&call).await
        }
        .await;
        Some(match outcome {
            Ok(receipt) => Value::from_json(&receipt["result"]),
            Err(err) => Value::from(format!("refused: {err}")),
        })
    }

    fn protected_functions(&self) -> &[(String, ProtectedFunction)] {
        &self.protected
    }

    fn registry_version(&self) -> Option<u32> {
        Some(9)
    }

    fn admits_outside_commands(&self) -> bool {
        false
    }

    fn intents(&self, _ast: &Ast) -> Vec<Intent> {
        vec![
            Intent::expanding("capture", "save-it", "toy.capture", 4)
                .with_scope(IntentScope::Item(self.static_item.clone())),
        ]
    }
}

/// Policy as a capture sees it: its session (with no connection), every reservation, staging,
/// bind and mint in order, and what it has recorded.
#[derive(Clone, Default)]
struct Policy {
    bind: Option<Json>,
    calls: Arc<Mutex<Vec<String>>>,
    reservations: Arc<Mutex<Vec<ReserveRequest>>>,
    binds: Arc<Mutex<Vec<OccurrenceBinding>>>,
    staged: Arc<Mutex<Option<StagedDigest>>>,
    snapshots: Arc<Mutex<usize>>,
}

#[async_trait]
impl PolicyClient for Policy {
    async fn snapshot(&self, _request: SnapshotRequest<'_>) -> Result<PolicySnapshot, ProtectedCallError> {
        *self.snapshots.lock().unwrap() += 1;
        Ok(PolicySnapshot { allowed: vec!["save-it".into()], session_token: Some("legacy".into()), bind: None })
    }

    async fn command_session(&self, session_token: &str) -> Result<PolicySnapshot, ProtectedCallError> {
        Ok(PolicySnapshot {
            allowed: vec!["save-it".into()],
            session_token: Some(session_token.into()),
            bind: self.bind.clone(),
        })
    }

    async fn reserve(&self, _session: &str, request: &ReserveRequest) -> Result<Reservation, ProtectedCallError> {
        self.calls.lock().unwrap().push("reserve".into());
        self.reservations.lock().unwrap().push(request.clone());
        Ok(Reservation {
            item: request.item.clone(),
            capture_sequence: 7,
            public_capture: false,
            staged: self.staged.lock().unwrap().clone(),
        })
    }

    async fn stage(&self, _session: &str, _occurrence_id: &str, png: &[u8]) -> Result<Staged, ProtectedCallError> {
        self.calls.lock().unwrap().push("stage".into());
        let digest = StagedDigest { sha256: hex::encode(Sha256::digest(png)), size: png.len() as u64 };
        *self.staged.lock().unwrap() = Some(digest.clone());
        Ok(Staged { item: "item-1".into(), capture_sequence: 7, sha256: digest.sha256, size: digest.size })
    }

    async fn bind_occurrence(&self, _session: &str, binding: &OccurrenceBinding) -> Result<(), ProtectedCallError> {
        self.calls.lock().unwrap().push("bind".into());
        self.binds.lock().unwrap().push(binding.clone());
        Ok(())
    }

    async fn invoke(&self, _session: &str, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        self.calls.lock().unwrap().push("mint".into());
        Ok(json!({ "status": "succeeded", "steps": ["publish"], "result": call.payload }))
    }
}

async fn setup(static_item: Option<&str>) -> (Compiler, Policy, Model, Arc<Mutex<usize>>) {
    let unbound = Compiler::new(Capturer::new(static_item)).with_revision(revision());
    let manifest = unbound.preflight(program("save-it 1.."), "s0", &Json::Null).expect("a manifest");
    let policy = Policy { bind: Some(json!(manifest)), ..Policy::default() };
    let dialect = Capturer::new(static_item);
    let renders = Arc::clone(&dialect.renders);
    let compiler = Compiler::new(dialect).with_policy(policy.clone()).with_revision(revision());
    let model = compiler.model(program("save-it 1.."), &Json::Null).await.expect("a model");
    (compiler, policy, model, renders)
}

/// A command stage's identity with no connection and no user token: an item capture's.
fn connectionless() -> Identity {
    Identity {
        uid: Some("u1".into()),
        stage: Some("s0".into()),
        command_session: Some("command-session".into()),
        ..Identity::default()
    }
}

#[test]
fn an_item_scope_is_carried_in_the_model_and_a_connection_scope_keeps_its_text() {
    let plain = Model::new("9999", ModelKind::Plan(json!({})));
    let connection = Intent::fixed("save-1", "save-it", "toy.write", vec!["n1.0".into()])
        .with_scope(IntentScope::Connection("conn-1".into()));
    let with = |intent: Intent| Model { intents: vec![intent], ..plain.clone() };
    // A connection scope is its bare id, as before C5.
    assert_eq!(with(connection.clone()).to_json()["intents"][0]["scope"], json!("conn-1"));
    let static_item = Intent::expanding("capture", "snap", "gcs.put-thumbnail", 4)
        .with_scope(IntentScope::Item(Some("item-1".into())));
    let bound = Intent::expanding("capture", "snap", "gcs.put-thumbnail", 4).with_scope(IntentScope::Item(None));
    assert_eq!(with(static_item.clone()).to_json()["intents"][0]["scope"], json!({ "kind": "item", "id": "item-1" }));
    assert_eq!(with(bound.clone()).to_json()["intents"][0]["scope"], json!({ "kind": "item" }));
    for intent in [connection, static_item, bound] {
        let model = with(intent);
        assert_eq!(Model::from_json(&model.to_json()).unwrap(), model);
    }
    for scope in [
        json!({ "kind": "connection", "id": "conn-1" }),
        json!({ "kind": "item", "id": "" }),
        json!({ "kind": "item", "extra": 1 }),
        json!(7),
    ] {
        let mut text = with(Intent::fixed("i", "f", "o", vec!["n.0".into()])).to_json();
        text["intents"][0]["scope"] = scope;
        assert!(Model::from_json(&text).is_err());
    }
}

#[tokio::test]
async fn a_connectionless_command_reserves_renders_stages_binds_and_invokes_in_order() {
    let (compiler, policy, model, renders) = setup(None).await;
    let run = compiler.start(&model, &Json::Null, &Json::Null, connectionless()).await;
    let result = run.result.expect("the capture ran");
    assert_eq!(*policy.calls.lock().unwrap(), ["reserve", "stage", "bind", "mint"]);
    assert_eq!(*renders.lock().unwrap(), 1);
    // A bound item arrives at reservation, with the occurrence's expansion.
    let reserved = policy.reservations.lock().unwrap()[0].clone();
    assert_eq!((reserved.intent_id.as_str(), reserved.item.as_str()), ("capture", "item-1"));
    assert!(reserved.expansion_key.is_some());
    // Bound with exactly the reserved and staged payload, and its canonical digest.
    let staged = policy.staged.lock().unwrap().clone().unwrap();
    let payload = json!({ "item": "item-1", "sha256": staged.sha256, "captureSequence": 7 });
    let bind = policy.binds.lock().unwrap()[0].clone();
    assert_eq!(serde_json::from_str::<Json>(&bind.args).unwrap(), payload);
    assert_eq!(bind.argd, args_digest(&payload));
    assert_eq!(bind.occurrence_id, reserved.occurrence_id);
    assert_eq!(result.to_json().unwrap(), payload);
    assert_eq!(*policy.snapshots.lock().unwrap(), 0);
}

#[tokio::test]
async fn a_retry_after_staging_does_not_render() {
    let (compiler, policy, model, renders) = setup(None).await;
    *policy.staged.lock().unwrap() = Some(StagedDigest { sha256: "b".repeat(64), size: 12 });
    let run = compiler.start(&model, &Json::Null, &Json::Null, connectionless()).await;
    run.result.expect("the capture ran");
    assert_eq!(*policy.calls.lock().unwrap(), ["reserve", "bind", "mint"]);
    assert_eq!(*renders.lock().unwrap(), 0);
    let bind = policy.binds.lock().unwrap()[0].clone();
    assert_eq!(serde_json::from_str::<Json>(&bind.args).unwrap()["sha256"], json!("b".repeat(64)));
}

#[tokio::test]
async fn a_static_items_model_names_it() {
    let (_compiler, _policy, model, _renders) = setup(Some("item-1")).await;
    assert_eq!(model.to_json()["intents"][0]["scope"], json!({ "kind": "item", "id": "item-1" }));
}

#[tokio::test]
async fn outside_a_command_nothing_is_admitted_or_asked_whatever_connection_was_sent() {
    let (compiler, policy, _model, renders) = setup(None).await;
    let identity = Identity { uid: Some("u1".into()), connection_id: Some("conn-1".into()), ..Identity::default() };
    let compiled = compiler.compile(program("save-it 1.."), &Json::Null, &Json::Null, identity).await;
    assert_eq!(compiled.result.expect("compiled").to_json().unwrap(), json!("direct"));
    assert_eq!(*policy.snapshots.lock().unwrap(), 0);
    assert!(policy.calls.lock().unwrap().is_empty());
    assert_eq!(*renders.lock().unwrap(), 0);
}

#[tokio::test]
async fn nothing_is_reserved_or_staged_outside_a_commands_start() {
    let mut exec = graffiticode_l0000::ExecContext::new(connectionless());
    assert!(matches!(exec.reserve_capture("x:1", "item-1").await, Err(ProtectedCallError::NotAdmitted(_))));
    assert!(matches!(exec.stage_capture("x:1", b"png").await, Err(ProtectedCallError::NotAdmitted(_))));
}
