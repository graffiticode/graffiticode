// SPDX-License-Identifier: MIT

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value as Json, json};

use crate::ast::Ast;
use crate::check::check;
use crate::dialect::Dialect;
use crate::error::Diagnostic;
use crate::eval::{Context, Evaluator};
use crate::exec::{ExecContext, Identity, ProtectedEffect, Recorded};
use crate::model::{Intent, Mode, Model, ModelKind};
use crate::preflight::{RevisionIdentity, StageManifest, digest_of, required_protected_functions};
use crate::protected::{PolicyClient, admit, admit_command, admit_planned};
use crate::schema::{NoSchemas, ReplaySchemas, SchemaSource};
use crate::secret::Keyring;
use crate::value::Value;

/// Compiles programs of one language. It holds no per-request state, so a language server
/// builds one and shares it across requests.
///
/// ```text
/// parser → AST → admit protected functions → check → evaluate → Value
/// ```
#[derive(Clone)]
pub struct Compiler {
    dialect: Arc<dyn Dialect>,
    schemas: Arc<dyn SchemaSource>,
    keyring: Keyring,
    policy: Option<Arc<dyn PolicyClient>>,
    revision: RevisionIdentity,
}

/// What a compile produced: its value or its errors, and what its protected writes did. The
/// effects go with every result, an error included: a write that succeeded before a later
/// failure still happened.
#[derive(Debug, PartialEq)]
pub struct Compilation {
    pub result: Result<Value, Vec<Diagnostic>>,
    pub effects: Vec<ProtectedEffect>,
    /// A command's `start` only: the occurrences it performed, by intent, which the gateway
    /// closes the stage with (B5 §4).
    pub occurrences: Option<BTreeMap<String, Vec<String>>>,
    /// How the result may be cached, when the dialect restricted it (C3). None is today's
    /// default: the language's own [`Dialect::cacheable_in`] its mode.
    pub restriction: Option<crate::exec::Restriction>,
    /// What the result is for: `present` for a compile and a command's `start`, the request's
    /// mode for an interpretation, `replay` for a materialization.
    pub mode: Mode,
    /// B6: the occurrences answered from their records, by intent, when there were any (a
    /// materialization, or a repair's `start`). Never bound, minted or performed.
    pub replayed: Option<BTreeMap<String, Vec<String>>>,
}

impl Compilation {
    fn of(result: Result<Value, Vec<Diagnostic>>, mode: Mode) -> Self {
        Self { result, effects: Vec::new(), occurrences: None, restriction: None, mode, replayed: None }
    }
}

impl Compiler {
    pub fn new(dialect: impl Dialect + 'static) -> Self {
        Self {
            dialect: Arc::new(dialect),
            schemas: Arc::new(NoSchemas),
            keyring: Keyring::new(),
            policy: None,
            revision: RevisionIdentity::default(),
        }
    }

    /// Where `use "<lang>"` finds a language's schema. Without one, every `use` fails.
    pub fn with_schemas(mut self, schemas: impl SchemaSource + 'static) -> Self {
        self.schemas = Arc::new(schemas);
        self
    }

    /// The keys `get-val-private` decrypts with.
    pub fn with_keyring(mut self, keyring: Keyring) -> Self {
        self.keyring = keyring;
        self
    }

    /// The policy authority that admits this language's protected functions and binds its
    /// stage of an admitted plan. Without one, no protected function is ever allowed and no
    /// planned stage runs.
    pub fn with_policy(mut self, policy: impl PolicyClient + 'static) -> Self {
        self.policy = Some(Arc::new(policy));
        self
    }

    /// The deployed revision this compiler runs as. Without one it cannot be pinned by a plan.
    pub fn with_revision(mut self, revision: RevisionIdentity) -> Self {
        self.revision = revision;
        self
    }

    pub fn lang_id(&self) -> &str {
        self.dialect.lang_id()
    }

    /// What the language reports about its configuration (see [`Dialect::status`]).
    pub fn dialect_status(&self) -> Option<Json> {
        self.dialect.status()
    }

    /// Whether this language's output may be cached (see [`Dialect::cacheable`]).
    pub fn cacheable(&self) -> bool {
        self.dialect.cacheable()
    }

    /// Whether a result in `mode` may be cached (see [`Dialect::cacheable_in`]).
    /// A replay's result is never cached: it is rebuilt for one command, on request.
    pub fn cacheable_in(&self, mode: Mode) -> bool {
        mode != Mode::Replay && self.dialect.cacheable_in(mode)
    }

    /// Whether this language rebuilds a command stage from its records (B6, see
    /// [`Dialect::materializes`]).
    pub fn materializes(&self) -> bool {
        self.dialect.materializes()
    }

    /// The answer `/compile` and `/interpret` give for `compiled`, in the envelope the
    /// TypeScript servers use, without the `revision` the server adds. Built here so a
    /// language's tests check exactly what its server answers.
    pub fn envelope(&self, compiled: &Compilation) -> Json {
        // Compiled output goes in `data` and compile errors in `errors`, which is always
        // present; consumers branch on whether it is empty.
        let mut envelope = match &compiled.result {
            Ok(value) => match value.to_json() {
                Some(data) => json!({ "data": data, "errors": [] }),
                None => json!({ "errors": [] }),
            },
            Err(errors) => json!({ "data": null, "errors": errors }),
        };
        // Output that carries something that expires (a signature) must not be stored or served
        // again; the API reads this, strips it, and neither caches the compile nor lets the
        // response be cached. Decided by the mode alone, whatever the result holds: the legacy
        // API treats anything but `cache: false` as permanent.
        if !self.cacheable_in(compiled.mode) {
            envelope["cache"] = json!(false);
        } else if let Some(restriction) = compiled.restriction {
            // How this result may be cached, when the dialect restricted it (C3): its class,
            // and its expiry in epoch milliseconds. Nothing is added for an unrestricted
            // result, so its envelope is unchanged.
            envelope["cache"] = json!(restriction.class.as_str());
            if let Some(expires_at) = restriction.expires_at {
                envelope["expiresAt"] = json!(expires_at);
            }
        }
        // What the compile's protected writes did. The gateway collects it per stage and keeps
        // it out of the next stage's input.
        if !compiled.effects.is_empty() {
            envelope["effects"] = json!(compiled.effects);
        }
        // A command stage's occurrences, by intent: the gateway closes the stage with exactly
        // these.
        if let Some(occurrences) = &compiled.occurrences {
            envelope["occurrences"] = json!(occurrences);
        }
        // The occurrences answered from their records (B6), which the gateway checks against
        // what it recorded.
        if let Some(replayed) = compiled.replayed.as_ref().filter(|r| !r.is_empty()) {
            envelope["replayed"] = json!(replayed);
        }
        envelope
    }

    /// Whether only a verified gateway's compile may open a system session (see
    /// [`Dialect::system_sessions_gateway_only`]).
    pub fn system_sessions_gateway_only(&self) -> bool {
        self.dialect.system_sessions_gateway_only()
    }

    /// Compiles `code`, the parser's AST as JSON, against the upstream `data` it is chained
    /// onto.
    ///
    /// `data` may be a `{ data, errors }` envelope (the output of a chained task) or a bare
    /// value from a task compiled before the envelope existed; the data model is read from
    /// either. `identity` is the caller's verified identity and becomes this invocation's
    /// [`ExecContext`].
    pub async fn compile(&self, code: &Json, data: &Json, config: &Json, identity: Identity) -> Compilation {
        self.compile_in(code, data, config, identity, Mode::Present).await
    }

    /// [`compile`](Self::compile) for a result in `mode`: a compile is `present`; an
    /// interpretation the dialect declines evaluates its plan in the request's mode.
    async fn compile_in(&self, code: &Json, data: &Json, config: &Json, identity: Identity, mode: Mode) -> Compilation {
        let mut exec = ExecContext::new(identity);
        exec.set_policy(self.policy.clone());
        exec.set_mode(mode);
        let result = self.run(code, data, config, &mut exec, None).await;
        let occurrences = exec.command_occurrences().cloned();
        let restriction = exec.restriction();
        Compilation { result, effects: exec.into_effects(), occurrences, restriction, mode, replayed: None }
    }

    async fn run(
        &self,
        code: &Json,
        data: &Json,
        config: &Json,
        exec: &mut ExecContext,
        intents: Option<Vec<Intent>>,
    ) -> Result<Value, Vec<Diagnostic>> {
        let dialect = &*self.dialect;
        // What executes is the normalized program (preflight applies the same).
        let (program, ast) = self.program(code)?;
        // Admission comes before anything runs. A stage of an admitted plan is bound to the
        // plan whatever functions its language has.
        // A command's `start` (B5): admitted by the session the gateway brought for this stage,
        // and bound to the model's intents.
        let refused = if let (Some(session), Some(intents)) = (exec.command_session().map(str::to_owned), intents) {
            let stage = exec.stage().map(str::to_owned);
            let manifest = self.stage_manifest(code, &program, &ast, stage, config)?;
            admit_command(dialect, self.policy.as_ref(), exec, &manifest, &session, intents).await
        } else if exec.is_planned() {
            let stage = exec.stage().map(str::to_owned);
            let manifest = self.stage_manifest(code, &program, &ast, stage, config)?;
            admit_planned(dialect, self.policy.as_ref(), exec, &manifest).await
        } else if exec.mode() != Mode::Present {
            // Only `present` acts: `evaluate` (C6 part 2) and a replay (B6) have nothing to
            // admit, and policy isn't asked for a snapshot. A live protected call in either is
            // refused (`ExecContext::invoke`), as is a system session.
            Vec::new()
        } else {
            admit(&ast, dialect, self.policy.as_ref(), exec).await
        };
        if !refused.is_empty() {
            return Err(refused);
        }
        self.check(&ast)?;
        let data = upstream(data);
        let config = Value::from_json(config);
        // A replay reads nothing live (B6): its schema source refuses every `use`, so the
        // compiler's own (HTTP in production) is never consulted.
        let schemas: &dyn SchemaSource = if exec.mode() == Mode::Replay { &ReplaySchemas } else { &*self.schemas };
        Evaluator::new(Context {
            ast: &ast,
            dialect,
            schemas,
            keyring: &self.keyring,
            data: &data,
            config: &config,
            exec,
        })
        .run()
        .await
    }

    /// The model `code` compiles to (B1): a value model when the language declares this program
    /// input-independent and it has no protected functions, otherwise a plan model carrying the
    /// stored program. Nothing that could act runs here: a plan isn't evaluated, and a value
    /// model's program has no protected function to call.
    pub async fn model(&self, code: &Json, config: &Json) -> Result<Model, Vec<Diagnostic>> {
        let dialect = &*self.dialect;
        let (_program, ast) = self.program(code)?;
        self.check(&ast)?;
        let lang = dialect.lang_id().to_owned();
        let protected = !required_protected_functions(&ast, dialect).is_empty()
            || !dialect.implicit_protected_functions().is_empty();
        if protected || !dialect.input_independent(&ast) {
            // A plan carries the effects a `start` of it may execute (B5).
            let intents = dialect.intents(&ast);
            return Ok(Model { lang, kind: ModelKind::Plan(code.clone()), intents });
        }
        // Input-independent: its value is the same for every input, so evaluate it once, with none.
        let mut exec = ExecContext::new(Identity::default());
        let value = self.run(code, &Json::Null, config, &mut exec, None).await?;
        // An undefined value has no JSON, and `/compile` answers it without `data`: as a value
        // it would come back `null`, so such a program stays a plan.
        Ok(Model {
            kind: match value.to_json() {
                Some(json) => ModelKind::Value(json),
                None => ModelKind::Plan(code.clone()),
            },
            lang,
            intents: Vec::new(),
        })
    }

    /// Interprets `model` against `input`, the previous stage's resolved data (B1). A value model
    /// is its value. A plan model goes to the language's [`Dialect::interpret`], and if it
    /// declines, it is compiled against the input exactly as [`compile`](Self::compile) does.
    /// A model from another language is refused: which language interprets which is the API's
    /// decision (the interpreter manifest's producer -> interpreter pairs), not this server's.
    pub async fn interpret(
        &self,
        model: &Model,
        input: &Json,
        config: &Json,
        mode: Mode,
        identity: Identity,
    ) -> Compilation {
        if model.lang != self.dialect.lang_id() {
            let refused = Diagnostic::new(format!(
                "Error: a model from L{} can't be interpreted by L{}",
                model.lang,
                self.dialect.lang_id()
            ))
            .with_code("model-language-mismatch");
            return Compilation::of(Err(vec![refused]), mode);
        }
        // A read never runs as a command, whatever it carries.
        let identity = Identity { command_session: None, ..identity };
        match &model.kind {
            ModelKind::Value(value) => Compilation::of(Ok(Value::from_json(value)), mode),
            ModelKind::Plan(program) => match self.dialect.interpret(model, input, mode).await {
                Some(result) => Compilation::of(result.map(|json| Value::from_json(&json)), mode),
                None => self.compile_in(program, input, config, identity, mode).await,
            },
        }
    }

    /// Starts `model` as a command's stage (B5 §6 step 3): runs its plan against `input`, the
    /// stage's pinned input, under the command session in `identity`, performing only the model's
    /// intents. Refused, before anything runs, for a model of another language, a model with no
    /// intents, and an identity without a command session.
    pub async fn start(&self, model: &Model, input: &Json, config: &Json, identity: Identity) -> Compilation {
        self.start_with(model, input, config, identity, None).await
    }

    /// [`start`](Self::start) for a repair (B6, docs/b6-command-repair-plan.md decision 7a): the
    /// stage's `recorded` occurrences answer from their records, with no bind, token or call;
    /// a blocked one stops the stage before any call; every other occurrence runs live, exactly
    /// as in a `start`. A recorded completed occurrence the run never reaches fails the stage:
    /// the repair didn't follow the original's path.
    pub async fn start_with(
        &self,
        model: &Model,
        input: &Json,
        config: &Json,
        identity: Identity,
        recorded: Option<Recorded>,
    ) -> Compilation {
        let refuse = |message: String, code: &str| {
            Compilation::of(Err(vec![Diagnostic::new(message).with_code(code)]), Mode::Present)
        };
        if model.lang != self.dialect.lang_id() {
            return refuse(
                format!("Error: a model from L{} can't be started by L{}", model.lang, self.dialect.lang_id()),
                "model-language-mismatch",
            );
        }
        let ModelKind::Plan(program) = &model.kind else {
            return refuse("Error: a value model has no effects to start.".to_owned(), "no-intents");
        };
        if model.intents.is_empty() {
            return refuse("Error: this model declares no effects to start.".to_owned(), "no-intents");
        }
        if identity.command_session.as_deref().is_none_or(str::is_empty) {
            return refuse("Error: a start needs its command's session.".to_owned(), "bad-session");
        }
        let mut exec = ExecContext::new(identity);
        exec.set_policy(self.policy.clone());
        let replaying = recorded.is_some();
        let result = self.run_recorded(program, input, config, &mut exec, model.intents.clone(), recorded, true).await;
        // The occurrences performed, even when the stage failed partway: what was bound is the
        // stage's to close.
        let occurrences = Some(exec.command_occurrences().cloned().unwrap_or_default());
        let replayed = replaying.then(|| exec.replayed_occurrences().cloned().unwrap_or_default());
        let restriction = exec.restriction();
        Compilation { result, effects: exec.into_effects(), occurrences, restriction, mode: Mode::Present, replayed }
    }

    /// Rebuilds a command stage's result from its records (B6, docs/b6-command-repair-plan.md
    /// decision 6): `model` (the admitted one, carrying its intents) runs on `input`, the
    /// stage's pinned input, in [`Mode::Replay`]. Occurrence ids are expanded exactly as the
    /// original's, with no session. Every protected call answers from `recorded`, or fails the
    /// stage; nothing is bound, minted, signed, observed or sent, and no policy is consulted.
    /// Refused for a language that doesn't [`materialize`](Dialect::materializes), a model of
    /// another language, and a model with no intents (a stage without effects isn't replayed:
    /// its recorded output is taken as it is).
    pub async fn materialize(&self, model: &Model, input: &Json, config: &Json, recorded: Recorded) -> Compilation {
        let refuse = |message: String, code: &str| {
            Compilation::of(Err(vec![Diagnostic::new(message).with_code(code)]), Mode::Replay)
        };
        if !self.dialect.materializes() {
            return refuse(
                format!("Error: L{} can't rebuild a command from its records.", self.dialect.lang_id()),
                "materialize-unsupported",
            );
        }
        if model.lang != self.dialect.lang_id() {
            return refuse(
                format!("Error: a model from L{} can't be materialized by L{}", model.lang, self.dialect.lang_id()),
                "model-language-mismatch",
            );
        }
        let ModelKind::Plan(program) = &model.kind else {
            return refuse("Error: a value model has no effects to replay.".to_owned(), "no-intents");
        };
        if model.intents.is_empty() {
            return refuse("Error: this model declares no effects to replay.".to_owned(), "no-intents");
        }
        // No identity: no user, connection, session or system session. Policy isn't given to
        // the context either, so nothing in it could be asked.
        let mut exec = ExecContext::new(Identity::default());
        exec.set_mode(Mode::Replay);
        let result =
            self.run_recorded(program, input, config, &mut exec, model.intents.clone(), Some(recorded), false).await;
        let replayed = Some(exec.replayed_occurrences().cloned().unwrap_or_default());
        Compilation { result, effects: Vec::new(), occurrences: None, restriction: None, mode: Mode::Replay, replayed }
    }

    /// Runs a command stage with its recorded occurrences: a `start` (`live`, admitted by its
    /// session) or a replay (no admission: nothing in it acts). Fails when a recorded completed
    /// occurrence is never reached.
    #[allow(clippy::too_many_arguments)]
    async fn run_recorded(
        &self,
        program: &Json,
        input: &Json,
        config: &Json,
        exec: &mut ExecContext,
        intents: Vec<Intent>,
        recorded: Option<Recorded>,
        live: bool,
    ) -> Result<Value, Vec<Diagnostic>> {
        let has_records = recorded.is_some();
        // The records join the command state when it is set: by admission inside `run` for a
        // live start, here for a replay.
        if let Some(recorded) = recorded {
            exec.set_pending_recorded(recorded);
        }
        if !live {
            exec.set_command(intents.clone());
        }
        let result = self.run(program, input, config, exec, live.then_some(intents)).await;
        // A call the records refused fails the stage, whether or not the dialect made it an
        // error: a replay that couldn't answer, or a repair that reached what it wasn't given.
        let refusals = exec.record_refusals();
        if !refusals.is_empty() {
            let mut errors: Vec<Diagnostic> = refusals
                .iter()
                .map(|(reason, message)| Diagnostic::new(format!("Error: {message}")).with_code(reason.clone()))
                .collect();
            if let Err(reported) = result {
                let more: Vec<Diagnostic> =
                    reported.into_iter().filter(|d| !errors.iter().any(|e| e.message == d.message)).collect();
                errors.extend(more);
            }
            return Err(errors);
        }
        if has_records && result.is_ok() {
            let unreached = exec.unreached_recorded();
            if !unreached.is_empty() {
                return Err(vec![
                    Diagnostic::new(format!(
                        "Error: recorded occurrences were never reached: {}",
                        unreached.join(", ")
                    ))
                    .with_code("recorded-not-reached"),
                ]);
            }
        }
        result
    }

    /// Preflight: this stage's manifest, or the errors that would stop it compiling.
    /// Side-effect free: no snapshot, no mint, no signing, no provider call, and nothing is
    /// evaluated. The checks run, so a program that would not compile is refused before
    /// anything is admitted.
    pub fn preflight(&self, code: &Json, stage: &str, options: &Json) -> Result<StageManifest, Vec<Diagnostic>> {
        let (program, ast) = self.program(code)?;
        let manifest = self.stage_manifest(code, &program, &ast, Some(stage.to_owned()), options)?;
        self.check(&ast)?;
        Ok(manifest)
    }

    /// The program that executes, and its AST.
    fn program(&self, code: &Json) -> Result<(Json, Ast), Vec<Diagnostic>> {
        let program = self.dialect.normalize(code).map_err(|err| vec![Diagnostic::new(format!("Error: {err}"))])?;
        let ast = Ast::from_json(&program).map_err(|err| vec![Diagnostic::new(err.to_string())])?;
        Ok((program.into_owned(), ast))
    }

    fn check(&self, ast: &Ast) -> Result<(), Vec<Diagnostic>> {
        let mut errors = check(ast);
        self.dialect.check(ast, &mut errors);
        if errors.is_empty() { Ok(()) } else { Err(errors) }
    }

    /// `code` is the program as stored, `program` after normalization.
    fn stage_manifest(
        &self,
        code: &Json,
        program: &Json,
        ast: &Ast,
        stage: Option<String>,
        options: &Json,
    ) -> Result<StageManifest, Vec<Diagnostic>> {
        let dialect = &*self.dialect;
        let refuse = |message: &str, code: &str| Err(vec![Diagnostic::new(message).with_code(code)]);
        if dialect.undeclarable_protected() {
            return refuse(
                "This language's protected behaviour can't be declared in advance, so it can't run in an admitted plan.",
                "undeclarable-protected",
            );
        }
        let has_protected =
            !dialect.protected_functions().is_empty() || !dialect.implicit_protected_functions().is_empty();
        let Some(registry_version) = dialect.registry_version().or((!has_protected).then_some(0)) else {
            return refuse(
                "This compiler declares protected functions without the registry version they were written for.",
                "preflight-unavailable",
            );
        };
        let (Some(revision), Some(image_digest)) = (&self.revision.revision, &self.revision.image_digest) else {
            return refuse(
                "This compiler revision has no deployed identity, so it can't be pinned.",
                "preflight-unavailable",
            );
        };
        Ok(StageManifest {
            stage,
            lang: dialect.lang_id().to_owned(),
            source_digest: digest_of(code),
            program_digest: digest_of(program),
            // Absent options are the empty options.
            options_digest: if options.is_null() { digest_of(&json!({})) } else { digest_of(options) },
            revision: revision.clone(),
            image_digest: image_digest.clone(),
            registry_version,
            required_functions: required_protected_functions(ast, dialect),
            replay: u32::from(dialect.materializes()),
        })
    }
}

/// Detection requires `errors` to be an array — the envelope always carries one — because
/// using `data` as the discriminator would misread a bare value that happens to have a
/// top-level `data` key.
fn upstream(data: &Json) -> Value {
    match data.as_object() {
        Some(envelope) if envelope.get("errors").is_some_and(Json::is_array) => {
            envelope.get("data").map_or(Value::Undefined, Value::from_json)
        }
        _ => Value::from_json(data),
    }
}
