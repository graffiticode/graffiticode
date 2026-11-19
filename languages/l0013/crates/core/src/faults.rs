// SPDX-License-Identifier: MIT

//! The C5d drive's capture fault points (`docs/c5d-snapshot-commands-plan.md`, slice 1 item 3),
//! read from the environment of a service other than production's `l0013r`.
//!
//! `L0013_CAPTURE_FAULTS` is a JSON map from a target command id to a fault:
//! `{"c:<64 hex>": "exit-after-stage"}`. It is set once, on the drive revision the run's commands
//! pin, and never changed during the run. A fault is **targeted and one-shot**: it fires only
//! when the command session names its command (`cmd`) and the owner's fencing generation (`fg`)
//! is 1. A takeover (generation 2 or later, on the same revision with the same environment)
//! runs the capture to completion, and an untargeted command is never touched.
//!
//! - `exit-after-reserve`: the process exits after `reserve_capture` returns, before rendering.
//! - `exit-after-stage`: it exits after staging, before `invoke`.
//! - `stall-before-stage`: after rendering, before staging, the request is held open until the
//!   takeover is observed. Every [`PROBE_INTERVAL`] it repeats `reserve_capture` for its own
//!   occurrence under its generation-1 session: before a takeover the repeat answers the
//!   recorded reservation (state-neutral); after one Policy refuses it as `stale-generation`,
//!   which is the signal to continue to its own staging (which Policy must also refuse). If no
//!   takeover is seen within [`STALL_BOUND`], it logs `no-takeover` and continues.
//!
//! The production service (`K_SERVICE=l0013r`) refuses to start with the variable set, as
//! Broker's `BROKER_FAULTS` and the api's `API_COMMAND_FAULTS` are refused on theirs.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use graffiticode_l0000::CommandClaims;

/// The environment variable that configures the faults.
pub const ENV: &str = "L0013_CAPTURE_FAULTS";
/// The production service, which refuses the variable.
pub const PRODUCTION_SERVICE: &str = "l0013r";
/// The process's exit status when a fault exits it: distinctive in the drive's logs.
pub const EXIT_CODE: i32 = 86;
/// How often a stalled capture probes for the takeover.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(10);
/// How long a stalled capture waits for the takeover: under the request's 300 s timeout.
pub const STALL_BOUND: Duration = Duration::from_secs(240);
/// Policy's refusal of a request from an owner generation that is no longer current.
pub const STALE_GENERATION: &str = "stale-generation";

/// Where a capture stops, or stalls, for its target command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CaptureFault {
    ExitAfterReserve,
    ExitAfterStage,
    StallBeforeStage,
}

impl CaptureFault {
    pub const ALL: [CaptureFault; 3] =
        [CaptureFault::ExitAfterReserve, CaptureFault::ExitAfterStage, CaptureFault::StallBeforeStage];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExitAfterReserve => "exit-after-reserve",
            Self::ExitAfterStage => "exit-after-stage",
            Self::StallBeforeStage => "stall-before-stage",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|fault| fault.as_str() == text)
    }
}

/// What a fault does to the process: exit it, wait, and log. The server's is real
/// (`std::process::exit`, a timer, `tracing`); tests record instead.
#[async_trait]
pub trait FaultRuntime: Send + Sync {
    /// Ends the process. A test's records the call and returns, and the capture then stops
    /// with an error, so nothing after the fault point runs either way.
    fn exit(&self, fault: CaptureFault, command: &str);
    async fn sleep(&self, duration: Duration);
    /// One warning line, logged as `WARN`.
    fn warn(&self, line: &str);
}

/// The targets, by command id, as the environment names them.
pub type Targets = HashMap<String, CaptureFault>;

/// Reads `L0013_CAPTURE_FAULTS`. Unset or blank is no faults. Anything set is refused on the
/// production service, and a map that isn't exactly `{ "c:<64 hex>": <fault>, … }` (one entry
/// at least) is refused: either refusal stops the server starting.
pub fn parse_targets(value: Option<&str>, k_service: Option<&str>) -> Result<Option<Targets>, String> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if k_service == Some(PRODUCTION_SERVICE) {
        return Err(format!("{ENV} is refused on the production {PRODUCTION_SERVICE} service"));
    }
    let bad = |why: String| format!("{ENV} must be a JSON map from command id (c:<64 hex>) to a fault: {why}");
    let map: serde_json::Map<String, serde_json::Value> = match serde_json::from_str(value) {
        Ok(serde_json::Value::Object(map)) => map,
        Ok(_) => return Err(bad("not an object".into())),
        Err(err) => return Err(bad(err.to_string())),
    };
    if map.is_empty() {
        return Err(bad("it names no command".into()));
    }
    let mut targets = Targets::new();
    for (command, fault) in map {
        if !is_command_id(&command) {
            return Err(bad(format!("{command:?} is not a command id")));
        }
        let fault = fault.as_str().and_then(CaptureFault::parse).ok_or_else(|| {
            bad(format!("{fault} is not one of exit-after-reserve, exit-after-stage, stall-before-stage"))
        })?;
        targets.insert(command, fault);
    }
    Ok(Some(targets))
}

/// `c:` and a sha256 in lowercase hex, as `commandIdFor` writes a command id.
fn is_command_id(id: &str) -> bool {
    id.strip_prefix("c:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// The configured faults, with the runtime they act through.
#[derive(Clone)]
pub struct CaptureFaults {
    targets: Targets,
    runtime: Arc<dyn FaultRuntime>,
    probe_interval: Duration,
    stall_bound: Duration,
}

impl CaptureFaults {
    pub fn new(targets: Targets, runtime: impl FaultRuntime + 'static) -> Self {
        Self { targets, runtime: Arc::new(runtime), probe_interval: PROBE_INTERVAL, stall_bound: STALL_BOUND }
    }

    /// A stall's probe interval and bound, in place of 10 s and 240 s.
    pub fn with_timing(mut self, probe_interval: Duration, stall_bound: Duration) -> Self {
        self.probe_interval = probe_interval;
        self.stall_bound = stall_bound;
        self
    }

    pub fn targets(&self) -> &Targets {
        &self.targets
    }

    pub fn probe_interval(&self) -> Duration {
        self.probe_interval
    }

    pub fn stall_bound(&self) -> Duration {
        self.stall_bound
    }

    /// The fault armed for this command session: its command is a target and its owner's
    /// generation is 1. Never for a takeover, and never without both claims.
    pub fn armed(&self, claims: Option<&CommandClaims>) -> Option<Armed> {
        let claims = claims.filter(|c| c.generation == 1)?;
        let fault = *self.targets.get(&claims.command)?;
        Some(Armed { fault, command: claims.command.clone(), faults: self.clone() })
    }
}

/// A fault armed for one capture.
#[derive(Clone)]
pub struct Armed {
    pub fault: CaptureFault,
    pub command: String,
    faults: CaptureFaults,
}

impl Armed {
    /// Logs the fault and exits the process (a test's runtime returns instead).
    pub fn exit(&self) {
        self.warn("");
        self.faults.runtime.exit(self.fault, &self.command);
    }

    /// `WARN capture fault <kind> command <id>`, with a detail when there is one.
    pub fn warn(&self, detail: &str) {
        let line = format!("capture fault {} command {}", self.fault.as_str(), self.command);
        self.faults.runtime.warn(&if detail.is_empty() { line } else { format!("{line}: {detail}") });
    }

    pub async fn sleep(&self) {
        self.faults.runtime.sleep(self.faults.probe_interval).await;
    }

    /// How many probes fit in the bound.
    pub fn probes(&self) -> u32 {
        let interval = self.faults.probe_interval.as_millis().max(1);
        u32::try_from(self.faults.stall_bound.as_millis() / interval).unwrap_or(u32::MAX)
    }
}
