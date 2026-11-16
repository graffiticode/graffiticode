// SPDX-License-Identifier: MIT

//! `snap` as a command (C5a slice 6, docs/c5-l0013-commands-plan.md decisions 1, 9 and 10),
//! against a fake policy and a camera that records what it renders: inside a command session a
//! snap reserves, renders only if nothing is staged, stages, binds and invokes; outside one it is
//! unchanged, and asks policy nothing.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use graffiticode_l0000::canonical::args_digest;
use graffiticode_l0000::exec::{Recorded, runtime_occurrence_id};
use graffiticode_l0000::{
    Compiler, Identity, OccurrenceBinding, PolicyClient, PolicySnapshot, ProtectedCall, ProtectedCallError,
    Reservation, ReserveRequest, RevisionIdentity, SnapshotRequest, Staged, StagedDigest,
};
use graffiticode_l0013::{Camera, CameraError, L0013, REGISTRY_VERSION, SnapRequest, Snapshot};
use serde_json::{Value as Json, json};

#[derive(Clone, Default)]
struct FakeCamera {
    rendered: Arc<Mutex<Vec<String>>>,
    snapped: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl Camera for FakeCamera {
    async fn snap(&self, request: SnapRequest) -> Result<Snapshot, CameraError> {
        self.snapped.lock().unwrap().push(request.item.clone());
        Ok(Snapshot { url: format!("https://storage.example/thumbnails/{}.png?v=1", request.item), item: request.item })
    }

    async fn render(&self, request: SnapRequest) -> Result<Vec<u8>, CameraError> {
        self.rendered.lock().unwrap().push(request.item.clone());
        Ok(format!("\u{89}PNG {}", request.item).into_bytes())
    }
}

/// Policy and Broker as a command snap meets them: reservations by (stage session,
/// occurrence), staging once, and a publication answering the capture's stable result.
#[derive(Clone, Default)]
struct Policy {
    bind: Option<Json>,
    calls: Arc<Mutex<Vec<String>>>,
    reservations: Arc<Mutex<Vec<(String, ReserveRequest)>>>,
    staged: Arc<Mutex<std::collections::HashMap<String, StagedDigest>>>,
    binds: Arc<Mutex<Vec<OccurrenceBinding>>>,
    sequence: Arc<Mutex<u64>>,
    snapshots: Arc<Mutex<usize>>,
    /// Reservations are refused for now (503), as item authority unavailable is.
    unavailable: Arc<Mutex<bool>>,
}

#[async_trait]
impl PolicyClient for Policy {
    async fn snapshot(&self, _request: SnapshotRequest<'_>) -> Result<PolicySnapshot, ProtectedCallError> {
        *self.snapshots.lock().unwrap() += 1;
        Ok(PolicySnapshot { allowed: vec![], session_token: None, bind: None })
    }

    async fn command_session(&self, session_token: &str) -> Result<PolicySnapshot, ProtectedCallError> {
        Ok(PolicySnapshot {
            allowed: vec!["snap".into()],
            session_token: Some(session_token.into()),
            bind: self.bind.clone(),
        })
    }

    async fn reserve(&self, session: &str, request: &ReserveRequest) -> Result<Reservation, ProtectedCallError> {
        self.calls.lock().unwrap().push(format!("reserve {session}"));
        if *self.unavailable.lock().unwrap() {
            return Err(ProtectedCallError::Rejected {
                path: "/v1/command-reservations".into(),
                status: 503,
                reason: Some("item-authority-unavailable".into()),
                category: Some("unavailable".into()),
                effect_unknown: false,
            });
        }
        self.reservations.lock().unwrap().push((session.to_owned(), request.clone()));
        let key = format!("{session}/{}", request.occurrence_id);
        let sequence = {
            let mut next = self.sequence.lock().unwrap();
            *next += 1;
            *next
        };
        Ok(Reservation {
            item: request.item.clone(),
            capture_sequence: sequence,
            public_capture: false,
            staged: self.staged.lock().unwrap().get(&key).cloned(),
        })
    }

    async fn stage(&self, session: &str, occurrence_id: &str, png: &[u8]) -> Result<Staged, ProtectedCallError> {
        self.calls.lock().unwrap().push(format!("stage {session}"));
        let digest = StagedDigest { sha256: format!("{:0>64}", png.len()), size: png.len() as u64 };
        self.staged.lock().unwrap().insert(format!("{session}/{occurrence_id}"), digest.clone());
        let sequence = *self.sequence.lock().unwrap();
        Ok(Staged { item: "abc123".into(), capture_sequence: sequence, sha256: digest.sha256, size: digest.size })
    }

    async fn bind_occurrence(&self, session: &str, binding: &OccurrenceBinding) -> Result<(), ProtectedCallError> {
        self.calls.lock().unwrap().push(format!("bind {session}"));
        self.binds.lock().unwrap().push(binding.clone());
        Ok(())
    }

    async fn invoke(&self, session: &str, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        self.calls.lock().unwrap().push(format!("invoke {session}"));
        let mut result = call.payload.clone();
        result["url"] =
            json!(format!("https://storage.googleapis.com/gate/{}.png?v=x", call.payload["item"].as_str().unwrap()));
        Ok(json!({ "status": "succeeded", "steps": ["publish"], "result": result }))
    }
}

fn revision() -> RevisionIdentity {
    RevisionIdentity { revision: Some("l0013r-r1".into()), image_digest: Some(format!("sha256:{}", "3".repeat(64))) }
}

/// `snap item "abc123" {}..`
fn literal() -> Json {
    json!({
        "1": { "tag": "RECORD", "elts": [] },
        "2": { "tag": "STR", "elts": ["abc123"] }, "3": { "tag": "ITEM", "elts": [2, 1] },
        "4": { "tag": "SNAP", "elts": [3], "coord": { "from": 0, "to": 4 } },
        "5": { "tag": "EXPRS", "elts": [4] }, "6": { "tag": "PROG", "elts": [5] }, "root": 6,
    })
}

/// `snap width 240 item get-var "data" {}..`: the item arrives as data.
fn from_data() -> Json {
    json!({
        "1": { "tag": "RECORD", "elts": [] },
        "9": { "tag": "STR", "elts": ["data"] },
        "2": { "tag": "GET_VAR", "elts": [9] }, "3": { "tag": "ITEM", "elts": [2, 1] },
        "7": { "tag": "NUM", "elts": ["240"] }, "8": { "tag": "WIDTH", "elts": [7, 3] },
        "4": { "tag": "SNAP", "elts": [8], "coord": { "from": 0, "to": 4 } },
        "5": { "tag": "EXPRS", "elts": [4] }, "6": { "tag": "PROG", "elts": [5] }, "root": 6,
    })
}

async fn setup(code: &Json) -> (Compiler, Policy, FakeCamera, graffiticode_l0000::Model) {
    let camera = FakeCamera::default();
    let unbound = Compiler::new(L0013::new(camera.clone())).with_revision(revision());
    let manifest = unbound.preflight(code, "s0", &Json::Null).expect("a manifest");
    let policy = Policy { bind: Some(json!(manifest)), ..Policy::default() };
    let compiler = Compiler::new(L0013::new(camera.clone())).with_policy(policy.clone()).with_revision(revision());
    let model = compiler.model(code, &Json::Null).await.expect("a model");
    (compiler, policy, camera, model)
}

/// A command stage with no connection and no user token: an item capture's.
fn command(session: &str) -> Identity {
    Identity {
        uid: Some("owner".into()),
        stage: Some("s0".into()),
        command_session: Some(session.into()),
        ..Identity::default()
    }
}

#[tokio::test]
async fn preflight_reports_snap_and_the_registry_version() {
    let manifest = Compiler::new(L0013::new(FakeCamera::default()))
        .with_revision(revision())
        .preflight(&literal(), "s0", &Json::Null)
        .unwrap();
    assert_eq!(manifest.required_functions, vec!["snap".to_owned()]);
    assert_eq!(manifest.registry_version, REGISTRY_VERSION);
}

#[tokio::test]
async fn the_model_names_a_literal_item_and_leaves_a_computed_one_bound() {
    let (_, _, _, model) = setup(&literal()).await;
    let intent = &model.to_json()["intents"][0];
    assert_eq!(intent["fn"], "snap");
    assert_eq!(intent["op"], "gcs.put-thumbnail");
    assert_eq!(intent["runtime"], true);
    assert_eq!(intent["scope"], json!({ "kind": "item", "id": "abc123" }));
    let (_, _, _, model) = setup(&from_data()).await;
    assert_eq!(model.to_json()["intents"][0]["scope"], json!({ "kind": "item" }));
}

#[tokio::test]
async fn a_command_snap_reserves_renders_stages_binds_and_invokes() {
    let (compiler, policy, camera, model) = setup(&literal()).await;
    let started = compiler.start(&model, &Json::Null, &Json::Null, command("session-s0")).await;
    let value = started.result.expect("the capture ran").to_json().unwrap();
    assert_eq!(value, json!({ "url": "https://storage.googleapis.com/gate/abc123.png?v=x", "item": "abc123" }));
    assert_eq!(
        *policy.calls.lock().unwrap(),
        ["reserve session-s0", "stage session-s0", "bind session-s0", "invoke session-s0"]
    );
    assert_eq!(*camera.rendered.lock().unwrap(), ["abc123"]);
    assert!(camera.snapped.lock().unwrap().is_empty(), "nothing is uploaded directly");
    let staged = policy.staged.lock().unwrap().values().next().cloned().unwrap();
    let payload = json!({ "item": "abc123", "sha256": staged.sha256, "captureSequence": 1 });
    let bind = policy.binds.lock().unwrap()[0].clone();
    assert_eq!(serde_json::from_str::<Json>(&bind.args).unwrap(), payload);
    assert_eq!(bind.argd, args_digest(&payload));
    assert_eq!(*policy.snapshots.lock().unwrap(), 0);
}

#[tokio::test]
async fn a_retry_after_staging_does_not_render() {
    let (compiler, policy, camera, model) = setup(&literal()).await;
    compiler.start(&model, &Json::Null, &Json::Null, command("session-s0")).await.result.expect("the first run");
    // The worker died after staging; its retry renders nothing and binds what was staged.
    compiler.start(&model, &Json::Null, &Json::Null, command("session-s0")).await.result.expect("the retry");
    assert_eq!(*camera.rendered.lock().unwrap(), ["abc123"]);
    let calls = policy.calls.lock().unwrap().clone();
    assert_eq!(calls[4..], ["reserve session-s0", "bind session-s0", "invoke session-s0"]);
    let binds = policy.binds.lock().unwrap();
    assert_eq!(
        serde_json::from_str::<Json>(&binds[1].args).unwrap()["sha256"],
        serde_json::from_str::<Json>(&binds[0].args).unwrap()["sha256"]
    );
}

#[tokio::test]
async fn two_stages_with_the_same_snap_each_reserve_and_stage_their_own_capture() {
    let (compiler, policy, camera, model) = setup(&literal()).await;
    for session in ["session-s0", "session-s1"] {
        compiler.start(&model, &Json::Null, &Json::Null, command(session)).await.result.expect("a stage");
    }
    let reservations = policy.reservations.lock().unwrap().clone();
    // The same occurrence id in each stage, under each stage's own session.
    assert_eq!(reservations[0].1.occurrence_id, reservations[1].1.occurrence_id);
    assert_eq!((reservations[0].0.as_str(), reservations[1].0.as_str()), ("session-s0", "session-s1"));
    assert_eq!(*camera.rendered.lock().unwrap(), ["abc123", "abc123"]);
    assert_eq!(policy.staged.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_bound_item_is_reserved_as_the_data_names_it() {
    let (compiler, policy, _camera, model) = setup(&from_data()).await;
    compiler
        .start(&model, &json!({ "data": "item-from-data", "errors": [] }), &Json::Null, command("session-s0"))
        .await
        .result
        .expect("the capture");
    assert_eq!(policy.reservations.lock().unwrap()[0].1.item, "item-from-data");
}

#[tokio::test]
async fn outside_a_command_snap_is_unchanged_and_asks_policy_nothing_whatever_connection_was_sent() {
    let (compiler, policy, camera, _model) = setup(&literal()).await;
    let identity = Identity {
        uid: Some("u1".into()),
        connection_id: Some("conn-1".into()),
        user_token: Some("t".into()),
        ..Identity::default()
    };
    let compiled = compiler.compile(&literal(), &json!({}), &json!({}), identity).await;
    assert_eq!(
        compiled.result.unwrap().to_json(),
        Some(json!({ "url": "https://storage.example/thumbnails/abc123.png?v=1", "item": "abc123" }))
    );
    assert_eq!(*camera.snapped.lock().unwrap(), ["abc123"]);
    assert!(camera.rendered.lock().unwrap().is_empty());
    assert_eq!(*policy.snapshots.lock().unwrap(), 0);
    assert!(policy.calls.lock().unwrap().is_empty());
}

// The owner's review of #406: a capture refused for now leaves the stage to resume later with
// its expansion open, and a blocked capture is never reserved, rendered or staged.
#[tokio::test]
async fn a_capture_refused_for_now_resumes_later_with_nothing_closed() {
    let (compiler, policy, camera, model) = setup(&literal()).await;
    *policy.unavailable.lock().unwrap() = true;
    let started = compiler.start(&model, &Json::Null, &Json::Null, command("session-s0")).await;
    assert_eq!(started.resume.as_deref(), Some("item-authority-unavailable"));
    assert_eq!(started.occurrences, None);
    assert_eq!(compiler.envelope(&started)["resume"], json!({ "reason": "item-authority-unavailable" }));
    assert!(camera.rendered.lock().unwrap().is_empty());
    assert_eq!(*policy.calls.lock().unwrap(), ["reserve session-s0"]);
}

#[tokio::test]
async fn a_blocked_capture_is_never_reserved_rendered_or_staged() {
    let (compiler, policy, camera, model) = setup(&literal()).await;
    let blocked = runtime_occurrence_id("snap:0", "0#0");
    let recorded = Recorded::from_json(&json!({ "blocked": [blocked] })).unwrap();
    let started = compiler.start_with(&model, &Json::Null, &Json::Null, command("session-s0"), Some(recorded)).await;
    let errors = started.result.expect_err("the stage fails on the refusal");
    assert!(errors.iter().any(|e| e.code.as_deref() == Some("not-selected")), "{errors:?}");
    assert!(policy.calls.lock().unwrap().is_empty());
    assert!(camera.rendered.lock().unwrap().is_empty());
}
