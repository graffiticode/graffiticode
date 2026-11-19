// SPDX-License-Identifier: MIT

//! The C5d drive's capture fault points (docs/c5d-snapshot-commands-plan.md, slice 1 item 3),
//! against a fake policy whose sessions carry `cmd` and `fg` as Policy's do, and a runtime that
//! records exits, waits and warnings instead of acting on the process. Each fault fires only for
//! its target command at owner generation 1: never at generation 2 (the takeover, on the same
//! revision with the same map), never for another command.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use graffiticode_l0000::{
    Compiler, Identity, OccurrenceBinding, PolicyClient, PolicySnapshot, ProtectedCall, ProtectedCallError,
    Reservation, ReserveRequest, RevisionIdentity, SnapshotRequest, Staged, StagedDigest,
};
use graffiticode_l0013::faults::{
    CaptureFault, CaptureFaults, FaultRuntime, PRODUCTION_SERVICE, STALE_GENERATION, Targets, parse_targets,
};
use graffiticode_l0013::{Camera, CameraError, L0013, SnapRequest, Snapshot};
use serde_json::{Value as Json, json};

fn command_id(c: char) -> String {
    format!("c:{}", c.to_string().repeat(64))
}

/// A session as Policy signs one for a command stage: a JWT naming the command and the owner's
/// generation (the signature isn't read here; Policy verifies it).
fn session(command: &str, generation: u64) -> String {
    let claims = json!({ "sub": "owner", "stg": "s0", "cmd": command, "fg": generation });
    format!("eyJhbGciOiJFUzI1NiJ9.{}.c2ln", base64url(claims.to_string().as_bytes()))
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
            }
        }
    }
    out
}

#[derive(Clone, Default)]
struct FakeCamera {
    rendered: Arc<Mutex<usize>>,
}

#[async_trait]
impl Camera for FakeCamera {
    async fn snap(&self, _request: SnapRequest) -> Result<Snapshot, CameraError> {
        Err("a command never snaps directly".into())
    }

    async fn render(&self, request: SnapRequest) -> Result<Vec<u8>, CameraError> {
        *self.rendered.lock().unwrap() += 1;
        Ok(format!("\u{89}PNG {}", request.item).into_bytes())
    }
}

/// Policy as the faults meet it: a reservation recorded once per occurrence (whichever
/// generation asks) and answered again on a repeat, with what was staged for it, and, once `taken_over` is set, every generation-1
/// call refused as a stale generation.
#[derive(Clone, Default)]
struct Policy {
    bind: Option<Json>,
    calls: Arc<Mutex<Vec<String>>>,
    reservations: Arc<Mutex<HashMap<String, Reservation>>>,
    staged: Arc<Mutex<HashMap<String, StagedDigest>>>,
    /// The takeover happens on this reserve call (1-based), counting every call.
    takeover_at: Option<usize>,
    taken_over: Arc<Mutex<bool>>,
}

impl Policy {
    fn fenced(&self, session: &str, path: &str) -> Result<(), ProtectedCallError> {
        if *self.taken_over.lock().unwrap() && is_generation_one(session) {
            return Err(ProtectedCallError::Rejected {
                path: path.into(),
                status: 409,
                reason: Some(STALE_GENERATION.into()),
                category: None,
                effect_unknown: false,
            });
        }
        Ok(())
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

/// Whether a session is a generation-1 owner's (of either command these tests use).
fn is_generation_one(session: &str) -> bool {
    [command_id('a'), command_id('b')].iter().any(|command| self::session(command, 1) == session)
}

#[async_trait]
impl PolicyClient for Policy {
    async fn snapshot(&self, _request: SnapshotRequest<'_>) -> Result<PolicySnapshot, ProtectedCallError> {
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
        self.calls.lock().unwrap().push("reserve".into());
        if self.takeover_at == Some(self.calls().iter().filter(|c| *c == "reserve").count()) {
            *self.taken_over.lock().unwrap() = true;
        }
        self.fenced(session, "/v1/command-reservations")?;
        let mut reservations = self.reservations.lock().unwrap();
        let next = reservations.len() as u64 + 1;
        let key = request.occurrence_id.clone();
        let staged = self.staged.lock().unwrap().get(&key).cloned();
        let reservation = reservations.entry(key).or_insert_with(|| Reservation {
            item: request.item.clone(),
            capture_sequence: next,
            public_capture: true,
            staged: None,
            render_grant: None,
        });
        Ok(Reservation { staged, ..reservation.clone() })
    }

    async fn stage(&self, session: &str, occurrence_id: &str, png: &[u8]) -> Result<Staged, ProtectedCallError> {
        self.calls.lock().unwrap().push("stage".into());
        self.fenced(session, "/v1/command-stagings")?;
        let digest = StagedDigest { sha256: format!("{:0>64}", png.len()), size: png.len() as u64 };
        self.staged.lock().unwrap().insert(occurrence_id.to_owned(), digest.clone());
        Ok(Staged { item: "abc123".into(), capture_sequence: 1, sha256: digest.sha256, size: digest.size })
    }

    async fn bind_occurrence(&self, session: &str, _binding: &OccurrenceBinding) -> Result<(), ProtectedCallError> {
        self.calls.lock().unwrap().push("bind".into());
        self.fenced(session, "/v1/command-occurrences")
    }

    async fn invoke(&self, session: &str, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        self.calls.lock().unwrap().push("invoke".into());
        self.fenced(session, "/v1/execute")?;
        let mut result = call.payload.clone();
        result["url"] = json!("https://storage.googleapis.com/drive/abc123.png?v=x");
        Ok(json!({ "status": "succeeded", "steps": ["publish"], "result": result }))
    }
}

/// What the faults did to the "process".
#[derive(Clone, Default)]
struct Runtime {
    exits: Arc<Mutex<Vec<(CaptureFault, String)>>>,
    sleeps: Arc<Mutex<Vec<Duration>>>,
    warnings: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl FaultRuntime for Runtime {
    fn exit(&self, fault: CaptureFault, command: &str) {
        self.exits.lock().unwrap().push((fault, command.to_owned()));
    }

    async fn sleep(&self, duration: Duration) {
        self.sleeps.lock().unwrap().push(duration);
    }

    fn warn(&self, line: &str) {
        self.warnings.lock().unwrap().push(line.to_owned());
    }
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

fn revision() -> RevisionIdentity {
    RevisionIdentity {
        revision: Some("l0013r-c5d-drive-r1".into()),
        image_digest: Some(format!("sha256:{}", "3".repeat(64))),
    }
}

struct Run {
    ok: bool,
    calls: Vec<String>,
    rendered: usize,
    runtime: Runtime,
}

/// One command stage, as the drive's compiler runs it with `targets` configured. Command `a`
/// is the usual target; `b` is another command.
async fn run(targets: &[(char, CaptureFault)], command: char, generation: u64, policy: Policy) -> Run {
    run_with(targets, Some(session(&command_id(command), generation)), policy, Duration::from_secs(240)).await
}

async fn run_with(targets: &[(char, CaptureFault)], session: Option<String>, policy: Policy, bound: Duration) -> Run {
    let camera = FakeCamera::default();
    let runtime = Runtime::default();
    let targets: Targets = targets.iter().map(|(c, fault)| (command_id(*c), *fault)).collect();
    let faults = CaptureFaults::new(targets, runtime.clone()).with_timing(Duration::from_secs(10), bound);
    let dialect = || L0013::new(camera.clone()).with_capture_faults(faults.clone());
    let manifest = Compiler::new(dialect()).with_revision(revision()).preflight(&literal(), "s0", &Json::Null).unwrap();
    let policy = Policy { bind: Some(json!(manifest)), ..policy };
    let compiler = Compiler::new(dialect()).with_policy(policy.clone()).with_revision(revision());
    let model = compiler.model(&literal(), &Json::Null).await.expect("a model");
    let identity = Identity {
        uid: Some("owner".into()),
        stage: Some("s0".into()),
        command_session: session,
        ..Identity::default()
    };
    let started = compiler.start(&model, &Json::Null, &Json::Null, identity).await;
    let rendered = *camera.rendered.lock().unwrap();
    Run { ok: started.result.is_ok(), calls: policy.calls(), rendered, runtime }
}

const COMPLETED: [&str; 4] = ["reserve", "stage", "bind", "invoke"];

fn untouched(run: &Run) {
    assert!(run.ok, "the capture completes");
    assert_eq!(run.calls, COMPLETED);
    assert_eq!(run.rendered, 1);
    assert!(run.runtime.exits.lock().unwrap().is_empty());
    assert!(run.runtime.sleeps.lock().unwrap().is_empty());
    assert!(run.runtime.warnings.lock().unwrap().is_empty());
}

#[tokio::test]
async fn exit_after_reserve_exits_its_target_at_generation_1_before_rendering() {
    let run = run(&[('a', CaptureFault::ExitAfterReserve)], 'a', 1, Policy::default()).await;
    assert!(!run.ok);
    assert_eq!(run.calls, ["reserve"]);
    assert_eq!(run.rendered, 0, "nothing is rendered");
    assert_eq!(*run.runtime.exits.lock().unwrap(), [(CaptureFault::ExitAfterReserve, command_id('a'))]);
    assert_eq!(
        *run.runtime.warnings.lock().unwrap(),
        [format!("capture fault exit-after-reserve command {}", command_id('a'))]
    );
}

#[tokio::test]
async fn exit_after_stage_exits_its_target_at_generation_1_before_invoking() {
    let run = run(&[('a', CaptureFault::ExitAfterStage)], 'a', 1, Policy::default()).await;
    assert!(!run.ok);
    assert_eq!(run.calls, ["reserve", "stage"], "nothing is bound or invoked");
    assert_eq!(run.rendered, 1);
    assert_eq!(*run.runtime.exits.lock().unwrap(), [(CaptureFault::ExitAfterStage, command_id('a'))]);
    assert_eq!(
        *run.runtime.warnings.lock().unwrap(),
        [format!("capture fault exit-after-stage command {}", command_id('a'))]
    );
}

#[tokio::test]
async fn no_fault_fires_at_generation_2() {
    for fault in CaptureFault::ALL {
        untouched(&run(&[('a', fault)], 'a', 2, Policy::default()).await);
        untouched(&run(&[('a', fault)], 'a', 3, Policy::default()).await);
    }
}

#[tokio::test]
async fn no_fault_fires_for_an_untargeted_command() {
    for fault in CaptureFault::ALL {
        untouched(&run(&[('a', fault)], 'b', 1, Policy::default()).await);
    }
}

#[tokio::test]
async fn no_fault_fires_for_a_session_without_command_claims() {
    for fault in CaptureFault::ALL {
        let run =
            run_with(&[('a', fault)], Some("session-s0".into()), Policy::default(), Duration::from_secs(240)).await;
        untouched(&run);
    }
}

#[tokio::test]
async fn the_generation_2_takeover_of_an_exited_capture_completes_from_what_was_staged() {
    // One map for the run: generation 1 exits after staging, generation 2 finishes.
    let targets = [('a', CaptureFault::ExitAfterStage)];
    let policy = Policy::default();
    let first = run(&targets, 'a', 1, policy.clone()).await;
    assert_eq!(first.runtime.exits.lock().unwrap().len(), 1);
    let takeover = run(&targets, 'a', 2, policy).await;
    assert!(takeover.ok);
    assert!(takeover.runtime.exits.lock().unwrap().is_empty());
    assert_eq!(takeover.rendered, 0, "the staged bytes are reused");
    assert_eq!(takeover.calls[2..], ["reserve", "bind", "invoke"]);
}

#[tokio::test]
async fn stall_before_stage_continues_only_once_its_probe_is_refused_as_stale() {
    // The takeover lands with the third probe (the fourth reservation).
    let policy = Policy { takeover_at: Some(4), ..Policy::default() };
    let run = run(&[('a', CaptureFault::StallBeforeStage)], 'a', 1, policy).await;
    assert_eq!(run.rendered, 1);
    assert_eq!(*run.runtime.sleeps.lock().unwrap(), [Duration::from_secs(10); 3], "a probe every 10 s");
    // Two probes answered the recorded reservation; the third was refused; its own stage is
    // refused too, and nothing is bound or invoked.
    assert_eq!(run.calls, ["reserve", "reserve", "reserve", "reserve", "stage"]);
    assert!(!run.ok);
    assert!(run.runtime.exits.lock().unwrap().is_empty());
    let warnings = run.runtime.warnings.lock().unwrap().clone();
    let prefix = format!("capture fault stall-before-stage command {}", command_id('a'));
    assert_eq!(warnings, [format!("{prefix}: stalling until the takeover"), format!("{prefix}: takeover observed")]);
}

#[tokio::test]
async fn stall_before_stage_probes_are_state_neutral_before_the_takeover() {
    let policy = Policy { takeover_at: Some(3), ..Policy::default() };
    let _ = run(&[('a', CaptureFault::StallBeforeStage)], 'a', 1, policy.clone()).await;
    // Every repeat answered the one recorded reservation: nothing new was reserved.
    assert_eq!(policy.reservations.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn stall_before_stage_logs_no_takeover_at_its_bound_and_continues() {
    let run = run_with(
        &[('a', CaptureFault::StallBeforeStage)],
        Some(session(&command_id('a'), 1)),
        Policy::default(),
        Duration::from_secs(50),
    )
    .await;
    assert_eq!(*run.runtime.sleeps.lock().unwrap(), [Duration::from_secs(10); 5], "50 s at 10 s a probe");
    assert_eq!(run.calls, ["reserve"; 6].into_iter().chain(["stage", "bind", "invoke"]).collect::<Vec<_>>());
    assert!(run.ok, "with no takeover it continues");
    let warnings = run.runtime.warnings.lock().unwrap().clone();
    assert_eq!(
        warnings.last().unwrap(),
        &format!("capture fault stall-before-stage command {}: no-takeover", command_id('a'))
    );
}

#[tokio::test]
async fn the_default_stall_is_10_s_probes_bounded_at_240_s() {
    let faults = CaptureFaults::new(Targets::new(), Runtime::default());
    assert_eq!((faults.probe_interval(), faults.stall_bound()), (Duration::from_secs(10), Duration::from_secs(240)));
}

#[test]
fn the_map_names_commands_and_faults() {
    let value = json!({ command_id('a'): "exit-after-reserve", command_id('b'): "stall-before-stage" }).to_string();
    let targets = parse_targets(Some(&value), Some("l0013r-c5d-drive")).unwrap().unwrap();
    assert_eq!(targets.len(), 2);
    assert_eq!(targets[&command_id('a')], CaptureFault::ExitAfterReserve);
    assert_eq!(targets[&command_id('b')], CaptureFault::StallBeforeStage);
    assert_eq!(parse_targets(None, Some(PRODUCTION_SERVICE)).unwrap(), None);
    assert_eq!(parse_targets(Some("  "), None).unwrap(), None);
}

#[test]
fn the_production_service_refuses_the_variable() {
    let value = json!({ command_id('a'): "exit-after-stage" }).to_string();
    let refused = parse_targets(Some(&value), Some(PRODUCTION_SERVICE)).unwrap_err();
    assert!(refused.contains("refused on the production l0013r service"), "{refused}");
    // Malformed or not, it never starts there.
    assert!(parse_targets(Some("nonsense"), Some(PRODUCTION_SERVICE)).is_err());
}

#[test]
fn a_malformed_map_is_refused() {
    let a = command_id('a');
    for value in [
        "not json".to_owned(),
        "[]".to_owned(),
        "\"exit-after-stage\"".to_owned(),
        "{}".to_owned(),
        json!({ &a: "exit-before-anything" }).to_string(),
        json!({ &a: 1 }).to_string(),
        json!({ "c:short": "exit-after-stage" }).to_string(),
        json!({ a.to_uppercase().replace("C:", "c:"): "exit-after-stage" }).to_string(),
        json!({ a.trim_start_matches("c:"): "exit-after-stage" }).to_string(),
    ] {
        assert!(parse_targets(Some(&value), Some("l0013r-c5d-drive")).is_err(), "{value} is refused");
    }
}
