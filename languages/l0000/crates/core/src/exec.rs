// SPDX-License-Identifier: MIT

//! [`ExecContext`] is the per-invocation authorization context: who is compiling, through
//! which connection, under which invocation, and what policy admitted. There are no execution
//! modes: running the program is the action, and the grant is the authority.
//!
//! Two invariants make it a security boundary rather than a convenience:
//!
//! 1. A program cannot reach it. It is not a value, and no variable (`get-var`/`set-var`)
//!    names it.
//! 2. It belongs to one invocation, never to a [`Compiler`](crate::Compiler). A language server
//!    shares one compiler across concurrent requests, so state on the compiler would mix
//!    users. Each compile allocates a fresh context.

use std::any::{Any, TypeId};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::canonical::args_digest;
use crate::model::{Intent, Mode};
use crate::protected::{OccurrenceBinding, PolicyClient, ProtectedCall, ProtectedCallError};

/// A runtime occurrence's id (B5 §4): `x:` and the hex SHA-256 of `{"intentId":…,"expansionKey":…}`
/// in that key order, exactly as policy recomputes it (`runtimeOccurrenceId` in
/// packages/policy/src/command-records.ts, over `JSON.stringify`).
pub fn runtime_occurrence_id(intent_id: &str, expansion_key: &str) -> String {
    let quoted = |s: &str| serde_json::to_string(s).expect("a string serializes");
    let text = format!("{{\"intentId\":{},\"expansionKey\":{}}}", quoted(intent_id), quoted(expansion_key));
    format!("x:{}", hex::encode(Sha256::digest(text.as_bytes())))
}

/// A command stage's effects (B5): the model's intents, the runtime occurrences expanded from
/// them, and the occurrences performed, by intent, which the stage's answer lists so the gateway
/// can close the stage.
#[derive(Default)]
struct CommandState {
    intents: Vec<Intent>,
    expansions: HashMap<String, (String, String)>,
    performed: BTreeMap<String, Vec<String>>,
    /// B6: the stage's recorded occurrences, and those answered from them, by intent.
    recorded: Option<Recorded>,
    replayed: BTreeMap<String, Vec<String>>,
    /// Set when a blocked occurrence was reached: the stage stops, and no later call in it runs
    /// live, so a repair never acts past what it was given.
    halted: bool,
    /// Every call the records refused, as (reason, message). Any one fails the stage, however
    /// the dialect reported it.
    record_refusals: Vec<(String, String)>,
}

/// One occurrence's recorded result (B6): the args digest it ran with and Broker's `result`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedOccurrence {
    pub argd: String,
    pub result: Json,
}

/// A command stage's recorded occurrences (B6, docs/b6-command-repair-plan.md decisions 6 and
/// 7a), by occurrence id. `completed` ones answer from their record, with no bind, no token and
/// no call. `blocked` ones (recorded, but neither completed nor selected by a repair) stop the
/// stage before any call. Any other occurrence runs live in a `start`, and fails in `Replay`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Recorded {
    pub completed: BTreeMap<String, RecordedOccurrence>,
    pub blocked: HashSet<String>,
}

impl Recorded {
    /// Reads `{ completed: { <occurrence>: { argd, result } }, blocked: [<occurrence>] }`,
    /// exactly: anything malformed is refused rather than partly honored.
    pub fn from_json(json: &Json) -> Result<Self, String> {
        let bad =
            || "recorded must be { completed: { <occurrence>: { argd, result } }, blocked: [<occurrence>] }".to_owned();
        let object = json.as_object().ok_or_else(bad)?;
        if object.keys().any(|k| k != "completed" && k != "blocked") {
            return Err(bad());
        }
        let mut recorded = Recorded::default();
        if let Some(completed) = object.get("completed") {
            for (occurrence, entry) in completed.as_object().ok_or_else(bad)? {
                let entry = entry.as_object().ok_or_else(bad)?;
                let argd = entry.get("argd").and_then(Json::as_str).filter(|a| !a.is_empty()).ok_or_else(bad)?;
                let result = entry.get("result").ok_or_else(bad)?;
                if entry.len() != 2 {
                    return Err(bad());
                }
                recorded
                    .completed
                    .insert(occurrence.clone(), RecordedOccurrence { argd: argd.to_owned(), result: result.clone() });
            }
        }
        if let Some(blocked) = object.get("blocked") {
            for occurrence in blocked.as_array().ok_or_else(bad)? {
                recorded.blocked.insert(occurrence.as_str().ok_or_else(bad)?.to_owned());
            }
        }
        if recorded.blocked.iter().any(|o| recorded.completed.contains_key(o)) {
            return Err("an occurrence can't be both completed and blocked".to_owned());
        }
        Ok(recorded)
    }
}

/// The caller's VERIFIED identity and invocation, supplied by the language server from its
/// authenticated request context — never from program input.
#[derive(Clone, Default)]
pub struct Identity {
    pub uid: Option<String>,
    pub connection_id: Option<String>,
    /// Forwarded to policy only.
    pub user_token: Option<String>,
    /// The logical invocation, allocated by the authenticated entry point (the gateway) and
    /// shared by every retry of it. Policy derives operation ids from it and from `stage`, so
    /// a retry reaches the same write receipts.
    pub invocation_token: Option<String>,
    /// This compile's position in the task chain.
    pub stage: Option<String>,
    /// The plan this chain was admitted under, from the gateway. Policy verifies it; with it,
    /// the compiler executes only what the plan pins for its stage.
    pub admission_token: Option<String>,
    /// A command stage's session, from the gateway (B5 §6 step 3). Policy issued it for this
    /// command, stage and owner; with it the stage runs as a `start`.
    pub command_session: Option<String>,
    /// Whether the server lets this compile open a system session
    /// ([`ExecContext::open_system_session`]). The server decides it from the request alone,
    /// never from the body: for a dialect whose system sessions are gateway-only
    /// ([`crate::Dialect::system_sessions_gateway_only`]) only a verified gateway caller gets
    /// it. Off by default, so a session is never opened without the server's say.
    pub system_session_permitted: bool,
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("uid", &self.uid)
            .field("connection_id", &self.connection_id)
            .field("stage", &self.stage)
            .field("system_session_permitted", &self.system_session_permitted)
            .finish_non_exhaustive()
    }
}

/// How a protected write went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectStatus {
    Succeeded,
    /// Refused before acting: nothing was done.
    Failed,
    Partial,
    /// The write was sent and nothing says how it went.
    Uncertain,
}

/// What one protected write did: the broker's outcome, or what can be said without one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedEffect {
    #[serde(rename = "fn")]
    pub function: String,
    pub op: String,
    pub status: EffectStatus,
    /// The completed provider steps. Empty for an uncertain write means none is known to have
    /// completed, not that nothing happened.
    pub steps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// The broker had already performed this operation and answered from its receipt.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub replayed: bool,
}

impl ProtectedEffect {
    /// The broker's outcome for a write. A status it does not recognize is uncertain.
    fn of_outcome(call: &ProtectedCall, outcome: &Json) -> Self {
        let text = |field: &str| outcome[field].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
        Self {
            function: call.function.clone(),
            op: call.op.clone(),
            status: match outcome["status"].as_str() {
                Some("succeeded") => EffectStatus::Succeeded,
                Some("failed") => EffectStatus::Failed,
                Some("partial") => EffectStatus::Partial,
                _ => EffectStatus::Uncertain,
            },
            steps: outcome["steps"]
                .as_array()
                .map(|steps| steps.iter().filter_map(Json::as_str).map(str::to_owned).collect())
                .unwrap_or_default(),
            failed_step: text("failedStep"),
            reason: text("reason"),
            category: text("category"),
            replayed: outcome["replayed"] == true,
        }
    }

    /// A write that returned no outcome: refused before acting, or sent with its answer lost.
    fn of_error(call: &ProtectedCall, error: &ProtectedCallError) -> Self {
        let uncertain = error.effect_unknown();
        Self {
            function: call.function.clone(),
            op: call.op.clone(),
            status: if uncertain { EffectStatus::Uncertain } else { EffectStatus::Failed },
            steps: Vec::new(),
            failed_step: None,
            reason: (!uncertain).then(|| error.reason().map(str::to_owned)).flatten(),
            category: (!uncertain).then(|| error.category().map(str::to_owned)).flatten(),
            replayed: false,
        }
    }
}

/// What admission decided for this invocation. Set once, before the program runs.
pub(crate) struct Grant {
    pub allowed: HashSet<String>,
    /// The admitted functions that are writes: their outcomes are this compile's effects.
    pub writes: HashSet<String>,
    pub session_token: Option<String>,
    pub policy: Option<Arc<dyn PolicyClient>>,
}

/// Why a system session could not be opened (see [`ExecContext::open_system_session`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SystemSessionRefusal {
    /// This compiler has no policy client, or the compile is not one a system session is for.
    NotConfigured,
    /// The server did not permit this compile a system session
    /// ([`Identity::system_session_permitted`]); policy was not asked.
    NotPermitted,
    /// Policy did not issue a session for the function, with its reason when it gave one.
    Unavailable(Option<String>),
}

/// How a result may be cached, loosest to strictest, as the API's interpreter manifest names
/// them (`CACHE_CLASSES`): `immutable` forever, `shared` across viewers until it expires,
/// `private` to its viewer, `no-store` never.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CacheClass {
    Immutable,
    Shared,
    Private,
    NoStore,
}

impl CacheClass {
    /// The name the envelope's `cache` field carries.
    pub fn as_str(self) -> &'static str {
        match self {
            CacheClass::Immutable => "immutable",
            CacheClass::Shared => "shared",
            CacheClass::Private => "private",
            CacheClass::NoStore => "no-store",
        }
    }
}

/// A result's cache restriction: its class, and when it expires (epoch milliseconds), if ever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Restriction {
    pub class: CacheClass,
    pub expires_at: Option<u64>,
}

impl Restriction {
    /// Both restrictions at once: the stricter class and the earlier expiry.
    pub fn and(self, other: Restriction) -> Restriction {
        Restriction {
            class: self.class.max(other.class),
            expires_at: match (self.expires_at, other.expires_at) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            },
        }
    }
}

pub struct ExecContext {
    identity: Identity,
    compile_id: Uuid,
    occurrences: HashMap<String, u64>,
    grant: Option<Grant>,
    effects: Vec<ProtectedEffect>,
    /// The compiler's policy client, for a system session. Admission has its own copy.
    policy: Option<Arc<dyn PolicyClient>>,
    /// The outcome of this compile's one attempt at a system session.
    system_session: Option<Result<(), SystemSessionRefusal>>,
    /// What a dialect keeps for this invocation alone.
    state: HashMap<TypeId, Box<dyn Any + Send + Sync>>,
    /// Set when this compile is a command's `start` (B5), or a replay (B6).
    command: Option<CommandState>,
    /// B6: recorded occurrences waiting for the command state.
    pending_recorded: Option<Recorded>,
    /// How this compile's result may be cached, when a dialect restricted it (C3).
    restriction: Option<Restriction>,
    /// What the result is for (design §5): `present` for `/compile` and a command's `start`,
    /// the request's mode for `/interpret`.
    mode: Mode,
}

impl ExecContext {
    pub fn new(identity: Identity) -> Self {
        let present = |field: Option<String>| field.filter(|s| !s.is_empty());
        Self {
            identity: Identity {
                uid: present(identity.uid),
                connection_id: present(identity.connection_id),
                user_token: present(identity.user_token),
                invocation_token: present(identity.invocation_token),
                stage: present(identity.stage),
                admission_token: present(identity.admission_token),
                command_session: present(identity.command_session),
                system_session_permitted: identity.system_session_permitted,
            },
            compile_id: Uuid::new_v4(),
            occurrences: HashMap::new(),
            grant: None,
            effects: Vec::new(),
            policy: None,
            system_session: None,
            state: HashMap::new(),
            command: None,
            pending_recorded: None,
            restriction: None,
            mode: Mode::Present,
        }
    }

    /// Restricts how this compile's result may be cached (C3): to `class` at least, and until
    /// `expires_at` (epoch milliseconds) at the latest. Restrictions accumulate: the stricter
    /// class and the earlier expiry win. A compile no dialect restricts carries none, and its
    /// envelope is unchanged.
    pub fn restrict(&mut self, class: CacheClass, expires_at: Option<u64>) {
        let next = Restriction { class, expires_at };
        self.restriction = Some(match self.restriction {
            Some(current) => current.and(next),
            None => next,
        });
    }

    /// What this result is for: `evaluate` (data for the next stage, never signed) or `present`
    /// (what the final consumer gets). The API decides it, never the language.
    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub(crate) fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }

    /// This compile's cache restriction, if any dialect set one.
    pub fn restriction(&self) -> Option<Restriction> {
        self.restriction
    }

    pub(crate) fn set_policy(&mut self, policy: Option<Arc<dyn PolicyClient>>) {
        self.policy = policy;
    }

    /// State a dialect keeps for this invocation, created on first use. It dies with the
    /// compile, so nothing in it reaches another invocation; and a program cannot reach it.
    pub fn state<T: Default + Send + Sync + 'static>(&mut self) -> &mut T {
        self.state
            .entry(TypeId::of::<T>())
            .or_insert_with(|| Box::new(T::default()))
            .downcast_mut()
            .expect("state is keyed by its type")
    }

    /// Whether this invocation holds a policy session: admission granted one, or a system
    /// session was opened.
    pub fn has_session(&self) -> bool {
        self.grant.as_ref().is_some_and(|grant| grant.session_token.is_some())
    }

    /// Opens a system session for a compile that selected no connection, permitting `function`
    /// and nothing else, whatever else policy's answer lists. The function must be one that
    /// writes nothing: the session's calls are never recorded as effects.
    ///
    /// Asked once per compile; later calls return the first answer. It is refused for a
    /// compile with a connection (that one has its own session) and for one admission already
    /// granted something (an admitted plan), so it never replaces a grant.
    pub async fn open_system_session(&mut self, lang_id: &str, function: &str) -> Result<(), SystemSessionRefusal> {
        if let Some(outcome) = &self.system_session {
            return outcome.clone();
        }
        let outcome = self.request_system_session(lang_id, function).await;
        self.system_session = Some(outcome.clone());
        outcome
    }

    async fn request_system_session(&mut self, lang_id: &str, function: &str) -> Result<(), SystemSessionRefusal> {
        // Only `present` signs: data for the next stage (`evaluate`, C6 part 2) and a replay
        // (B6) act on nothing, and neither would a mode added later.
        if self.mode != Mode::Present {
            return Err(SystemSessionRefusal::NotPermitted);
        }
        if self.identity.connection_id.is_some() || self.grant.is_some() {
            return Err(SystemSessionRefusal::NotConfigured);
        }
        let policy = self.policy.clone().ok_or(SystemSessionRefusal::NotConfigured)?;
        if !self.identity.system_session_permitted {
            return Err(SystemSessionRefusal::NotPermitted);
        }
        let session = match policy.preview_session(lang_id).await {
            Ok(session) => session,
            Err(ProtectedCallError::NoClient) => return Err(SystemSessionRefusal::NotConfigured),
            Err(error) => return Err(SystemSessionRefusal::Unavailable(error.reason().map(str::to_owned))),
        };
        let permitted = session.allowed.iter().any(|allowed| allowed == function);
        let (Some(session_token), true) = (session.session_token, permitted) else {
            return Err(SystemSessionRefusal::Unavailable(Some("no-preview-permission".to_owned())));
        };
        self.grant = Some(Grant {
            allowed: HashSet::from([function.to_owned()]),
            writes: HashSet::new(),
            session_token: Some(session_token),
            policy: Some(policy),
        });
        Ok(())
    }

    pub fn uid(&self) -> Option<&str> {
        self.identity.uid.as_deref()
    }

    /// Whether the server permits this compile a system session (see
    /// [`Identity::system_session_permitted`]).
    pub fn system_session_permitted(&self) -> bool {
        self.identity.system_session_permitted
    }

    pub fn connection_id(&self) -> Option<&str> {
        self.identity.connection_id.as_deref()
    }

    pub fn stage(&self) -> Option<&str> {
        self.identity.stage.as_deref()
    }

    /// The user token a policy client forwards.
    pub fn user_token(&self) -> Option<&str> {
        self.identity.user_token.as_deref()
    }

    /// The invocation token a policy client forwards.
    pub fn invocation_token(&self) -> Option<&str> {
        self.identity.invocation_token.as_deref()
    }

    /// The admission token a policy client forwards.
    pub fn admission_token(&self) -> Option<&str> {
        self.identity.admission_token.as_deref()
    }

    /// The command session this compile runs under, if it is a command's `start`.
    pub fn command_session(&self) -> Option<&str> {
        self.identity.command_session.as_deref()
    }

    /// Whether this compile is a command's `start` that admission accepted.
    pub fn is_command(&self) -> bool {
        self.command.is_some()
    }

    pub(crate) fn set_command(&mut self, intents: Vec<Intent>) {
        let recorded = self.pending_recorded.take();
        self.command = Some(CommandState { intents, recorded, ..CommandState::default() });
    }

    /// The stage's recorded occurrences (B6), for a `start` that repairs it or a replay. They
    /// join the command state when it is set, so only a command stage has them.
    pub(crate) fn set_pending_recorded(&mut self, recorded: Recorded) {
        self.pending_recorded = Some(recorded);
    }

    /// Whether this is a replay (B6): a command stage rebuilt from its records, acting on nothing.
    pub fn is_replay(&self) -> bool {
        self.mode == Mode::Replay && self.command.is_some()
    }

    /// The occurrences answered from their records (B6), by intent.
    pub fn replayed_occurrences(&self) -> Option<&BTreeMap<String, Vec<String>>> {
        self.command.as_ref().map(|c| &c.replayed)
    }

    /// Recorded `completed` occurrences this stage never reached: a replay or repair that
    /// doesn't follow the original's path.
    pub(crate) fn unreached_recorded(&self) -> Vec<String> {
        let Some(command) = self.command.as_ref() else { return Vec::new() };
        let Some(recorded) = command.recorded.as_ref() else { return Vec::new() };
        let reached: HashSet<&String> = command.replayed.values().flatten().collect();
        recorded.completed.keys().filter(|o| !reached.contains(o)).cloned().collect()
    }

    /// B6: answers `call` from the stage's records, when it has one. `None` lets the call run
    /// live (a `start` with nothing recorded for it). In `Replay` every call is answered here:
    /// one without a record fails, and nothing reaches policy.
    fn answer_from_record(&mut self, call: &ProtectedCall) -> Option<Result<Json, ProtectedCallError>> {
        let answer = self.lookup_record(call);
        if let (Some(Err(error)), Some(command)) = (&answer, self.command.as_mut()) {
            command.record_refusals.push((error.reason().unwrap_or("refused").to_owned(), error.to_string()));
        }
        answer
    }

    /// The calls the records refused (B6), as (reason, message).
    pub(crate) fn record_refusals(&self) -> &[(String, String)] {
        self.command.as_ref().map_or(&[], |c| &c.record_refusals)
    }

    fn lookup_record(&mut self, call: &ProtectedCall) -> Option<Result<Json, ProtectedCallError>> {
        let replay = self.mode == Mode::Replay;
        let intent = self.intent_of(call);
        let command = self.command.as_mut()?;
        let Some(recorded) = command.recorded.as_ref() else {
            return replay.then(|| Err(ProtectedCallError::NotRecorded(call.occurrence_id.clone())));
        };
        if recorded.blocked.contains(&call.occurrence_id) {
            command.halted = true;
            return Some(Err(ProtectedCallError::NotSelected(call.occurrence_id.clone())));
        }
        let Some(entry) = recorded.completed.get(&call.occurrence_id) else {
            if command.halted {
                return Some(Err(ProtectedCallError::NotSelected(call.occurrence_id.clone())));
            }
            return replay.then(|| Err(ProtectedCallError::NotRecorded(call.occurrence_id.clone())));
        };
        // Only the model's intents are answered, as only they are performed.
        let Some((intent_id, _)) = intent else {
            return Some(Err(ProtectedCallError::NotAdmitted(call.function.clone())));
        };
        if entry.argd != args_digest(&call.payload) {
            return Some(Err(ProtectedCallError::ArgsMismatch(call.occurrence_id.clone())));
        }
        let result = entry.result.clone();
        command.replayed.entry(intent_id).or_default().push(call.occurrence_id.clone());
        Some(Ok(json!({ "status": "succeeded", "steps": [], "result": result })))
    }

    /// A runtime occurrence of `intent_id` (B5 §4): its id, for the dialect to invoke with. The
    /// expansion key is what makes this occurrence this one (`batch 3`), and comes from the pinned
    /// model and recorded observations, never from a count of attempts.
    pub fn expand(&mut self, intent_id: &str, expansion_key: &str) -> Result<String, ProtectedCallError> {
        let command = self.command.as_mut().ok_or_else(|| ProtectedCallError::NotAdmitted(intent_id.to_owned()))?;
        if !command.intents.iter().any(|i| i.id == intent_id && i.is_runtime()) {
            return Err(ProtectedCallError::NotAdmitted(intent_id.to_owned()));
        }
        let id = runtime_occurrence_id(intent_id, expansion_key);
        command.expansions.insert(id.clone(), (intent_id.to_owned(), expansion_key.to_owned()));
        Ok(id)
    }

    /// An external read a command depends on, recorded once (B5 §5). The first answer to `key` is
    /// recorded under the command; every later one (a retry, a takeover) returns it and `read`
    /// never runs. A new check is a new key (`poll 2`). Outside a command, `read` just runs.
    pub async fn observe<F, Fut>(&mut self, key: &str, read: F) -> Result<Json, ProtectedCallError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Json, ProtectedCallError>>,
    {
        // A replay reads nothing (B6): its result comes from records alone.
        if self.mode == Mode::Replay {
            return Err(ProtectedCallError::NotAdmitted(format!("observe {key}")));
        }
        let (Some(_), Some(session), Some(policy)) = (
            self.command.as_ref(),
            self.identity.command_session.clone(),
            self.grant.as_ref().and_then(|g| g.policy.clone()),
        ) else {
            return read().await;
        };
        let parse = |text: String| {
            serde_json::from_str(&text)
                .map_err(|_| ProtectedCallError::Unavailable("a recorded observation isn't JSON".to_owned()))
        };
        if let Some(text) = policy.observe(&session, key, None).await? {
            return parse(text);
        }
        let value = read().await?;
        let text = serde_json::to_string(&value)
            .map_err(|_| ProtectedCallError::Unavailable("an observation can't be recorded".to_owned()))?;
        let recorded = policy.observe(&session, key, Some(&text)).await?.unwrap_or(text);
        parse(recorded)
    }

    /// The occurrences this command stage performed, by intent: what the stage's answer lists.
    pub fn command_occurrences(&self) -> Option<&BTreeMap<String, Vec<String>>> {
        self.command.as_ref().map(|c| &c.performed)
    }

    /// The intent an occurrence belongs to, and its expansion key if it has one.
    fn intent_of(&self, call: &ProtectedCall) -> Option<(String, Option<String>)> {
        let command = self.command.as_ref()?;
        let (intent_id, key) = match command.expansions.get(&call.occurrence_id) {
            Some((intent, key)) => (intent.clone(), Some(key.clone())),
            None => (
                command
                    .intents
                    .iter()
                    .find(|i| !i.is_runtime() && i.occurrences.contains(&call.occurrence_id))?
                    .id
                    .clone(),
                None,
            ),
        };
        let intent = command.intents.iter().find(|i| i.id == intent_id)?;
        (intent.function == call.function && intent.op == call.op).then_some((intent_id, key))
    }

    /// Whether this compile runs under an admitted plan.
    pub fn is_planned(&self) -> bool {
        self.identity.admission_token.is_some()
    }

    /// Unique to this compile. For diagnostics only: the logical invocation, which retries
    /// share, comes from the invocation token.
    pub fn compile_id(&self) -> Uuid {
        self.compile_id
    }

    /// Whether admission allowed `function` for this invocation.
    pub fn is_admitted(&self, function: &str) -> bool {
        self.grant.as_ref().is_some_and(|grant| grant.allowed.contains(function))
    }

    /// Deterministic occurrence ids: the Nth protected call made from the same node in this
    /// invocation is `<key>.<N>`. A retry that follows the same path reproduces them; a loop
    /// calling one node repeatedly gets distinct ones.
    pub fn next_occurrence(&mut self, key: &str) -> String {
        let n = self.occurrences.entry(key.to_owned()).or_default();
        let id = format!("{key}.{n}");
        *n += 1;
        id
    }

    /// The only way a language performs a protected operation. Refuses anything admission did
    /// not allow, before any network call. The outcome of a write is recorded as an effect,
    /// whether it succeeds or not.
    pub async fn invoke(&mut self, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        // A recorded occurrence (B6) answers from its record, with no bind, token or call; in a
        // replay every call does, or fails. Nothing below runs for it.
        if let Some(answer) = self.answer_from_record(call) {
            return answer;
        }
        // Only `present` acts: no protected call runs in `evaluate` (C6 part 2), or in any other
        // mode, whatever was granted, so a dialect that forgets to check the mode still can't
        // sign or write.
        if self.mode != Mode::Present {
            return Err(ProtectedCallError::NotAdmitted(call.function.clone()));
        }
        let grant = self
            .grant
            .as_ref()
            .filter(|grant| grant.allowed.contains(&call.function))
            .ok_or_else(|| ProtectedCallError::NotAdmitted(call.function.clone()))?;
        let policy = grant.policy.clone().ok_or(ProtectedCallError::NoClient)?;
        let is_write = grant.writes.contains(&call.function);
        let session = grant.session_token.clone();
        // A command performs only its model's intents, and binds each occurrence under its
        // session before a token is minted for it (B5 §4).
        let bound = match (&self.command, &session) {
            (Some(_), Some(session)) => match self.intent_of(call) {
                Some((intent_id, expansion_key)) => {
                    let binding = OccurrenceBinding {
                        occurrence_id: call.occurrence_id.clone(),
                        args: serde_json::to_string(&call.payload).unwrap_or_default(),
                        argd: args_digest(&call.payload),
                        intent_id: intent_id.clone(),
                        expansion_key,
                    };
                    policy.bind_occurrence(session, &binding).await.map(|()| Some(intent_id))
                }
                None => Err(ProtectedCallError::NotAdmitted(call.function.clone())),
            },
            _ => Ok(None),
        };
        let outcome = match (bound, session) {
            (Err(error), _) => Err(error),
            (Ok(intent), Some(session)) => {
                let outcome = policy.invoke(&session, call).await;
                if let (Some(intent), Some(command)) = (intent, self.command.as_mut()) {
                    command.performed.entry(intent).or_default().push(call.occurrence_id.clone());
                }
                outcome
            }
            (Ok(_), None) => Err(ProtectedCallError::NoSession),
        };
        if is_write {
            self.effects.push(match &outcome {
                Ok(outcome) => ProtectedEffect::of_outcome(call, outcome),
                Err(error) => ProtectedEffect::of_error(call, error),
            });
        }
        outcome
    }

    /// Every protected write this compile has made, in order, including one that failed after
    /// an earlier one succeeded.
    pub fn effects(&self) -> &[ProtectedEffect] {
        &self.effects
    }

    pub(crate) fn into_effects(self) -> Vec<ProtectedEffect> {
        self.effects
    }

    pub(crate) fn set_grant(&mut self, grant: Grant) {
        debug_assert!(self.grant.is_none(), "admission runs once per invocation");
        self.grant = Some(grant);
    }
}

impl fmt::Debug for ExecContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExecContext")
            .field("identity", &self.identity)
            .field("compile_id", &self.compile_id)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_identity_fields_are_absent() {
        let exec = ExecContext::new(Identity { uid: Some(String::new()), ..Identity::default() });
        assert_eq!(exec.uid(), None);
        assert_eq!(exec.connection_id(), None);
    }

    #[test]
    fn occurrence_ids_count_per_key() {
        let mut exec = ExecContext::new(Identity::default());
        assert_eq!(exec.next_occurrence("n12"), "n12.0");
        assert_eq!(exec.next_occurrence("n12"), "n12.1");
        assert_eq!(exec.next_occurrence("n7"), "n7.0");
    }

    #[test]
    fn debug_output_carries_no_tokens() {
        let exec = ExecContext::new(Identity {
            uid: Some("u1".into()),
            user_token: Some("user-secret".into()),
            invocation_token: Some("invocation-secret".into()),
            ..Identity::default()
        });
        let debug = format!("{exec:?}");
        assert!(debug.contains("u1"));
        assert!(!debug.contains("secret"), "{debug}");
    }

    #[tokio::test]
    async fn nothing_is_invocable_before_admission() {
        let mut exec = ExecContext::new(Identity::default());
        let call = ProtectedCall {
            function: "items.save".into(),
            op: "save".into(),
            payload: Json::Null,
            occurrence_id: "n1.0".into(),
        };
        assert!(matches!(exec.invoke(&call).await, Err(ProtectedCallError::NotAdmitted(f)) if f == "items.save"));
        assert!(exec.effects().is_empty());
    }

    #[test]
    fn an_effect_reads_the_brokers_outcome() {
        let call = ProtectedCall {
            function: "save-it".into(),
            op: "toy.write".into(),
            payload: Json::Null,
            occurrence_id: "n.0".into(),
        };
        let wire = |outcome: Json| serde_json::to_value(ProtectedEffect::of_outcome(&call, &outcome)).unwrap();
        assert_eq!(
            wire(serde_json::json!({ "status": "succeeded", "steps": ["questions", "items"], "result": {} })),
            serde_json::json!({ "fn": "save-it", "op": "toy.write", "status": "succeeded", "steps": ["questions", "items"] })
        );
        assert_eq!(
            wire(serde_json::json!({
                "status": "partial", "steps": ["questions"], "failedStep": "items",
                "reason": "authorization-denied:not-granted", "category": "permission", "error": "denied",
            })),
            serde_json::json!({
                "fn": "save-it", "op": "toy.write", "status": "partial", "steps": ["questions"], "failedStep": "items",
                "reason": "authorization-denied:not-granted", "category": "permission",
            })
        );
        assert_eq!(wire(serde_json::json!({ "status": "succeeded", "replayed": true }))["replayed"], true);
        // An outcome that is not recognized was sent, and nothing says how it went.
        assert_eq!(
            wire(serde_json::json!({ "status": "mystery" })),
            serde_json::json!({ "fn": "save-it", "op": "toy.write", "status": "uncertain", "steps": [] })
        );
    }

    #[test]
    fn a_failed_call_is_a_refusal_unless_its_answer_was_lost() {
        let call = ProtectedCall {
            function: "save-it".into(),
            op: "toy.write".into(),
            payload: Json::Null,
            occurrence_id: "n.0".into(),
        };
        let refused = ProtectedCallError::Rejected {
            path: "/v1/mint".into(),
            status: 403,
            reason: Some("operation-not-allowed".into()),
            category: Some("permission".into()),
            effect_unknown: false,
        };
        let effect = ProtectedEffect::of_error(&call, &refused);
        assert_eq!((effect.status, effect.reason.as_deref()), (EffectStatus::Failed, Some("operation-not-allowed")));
        assert_eq!(effect.category.as_deref(), Some("permission"));

        let lost = ProtectedCallError::Unreachable { path: "/v1/execute".into(), effect_unknown: true };
        let effect = ProtectedEffect::of_error(&call, &lost);
        assert_eq!((effect.status, effect.reason), (EffectStatus::Uncertain, None));
    }
}
