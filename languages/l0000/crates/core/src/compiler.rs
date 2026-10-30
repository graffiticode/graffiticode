// SPDX-License-Identifier: MIT

use std::sync::Arc;

use serde_json::{Value as Json, json};

use crate::ast::Ast;
use crate::check::check;
use crate::dialect::Dialect;
use crate::error::Diagnostic;
use crate::eval::{Context, Evaluator};
use crate::exec::{ExecContext, Identity, ProtectedEffect};
use crate::model::{Mode, Model, ModelKind};
use crate::preflight::{RevisionIdentity, StageManifest, digest_of, required_protected_functions};
use crate::protected::{PolicyClient, admit, admit_planned};
use crate::schema::{NoSchemas, SchemaSource};
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

    /// Whether this language's output may be cached (see [`Dialect::cacheable`]).
    pub fn cacheable(&self) -> bool {
        self.dialect.cacheable()
    }

    /// Compiles `code`, the parser's AST as JSON, against the upstream `data` it is chained
    /// onto.
    ///
    /// `data` may be a `{ data, errors }` envelope (the output of a chained task) or a bare
    /// value from a task compiled before the envelope existed; the data model is read from
    /// either. `identity` is the caller's verified identity and becomes this invocation's
    /// [`ExecContext`].
    pub async fn compile(&self, code: &Json, data: &Json, config: &Json, identity: Identity) -> Compilation {
        let mut exec = ExecContext::new(identity);
        exec.set_policy(self.policy.clone());
        let result = self.run(code, data, config, &mut exec).await;
        Compilation { result, effects: exec.into_effects() }
    }

    async fn run(
        &self,
        code: &Json,
        data: &Json,
        config: &Json,
        exec: &mut ExecContext,
    ) -> Result<Value, Vec<Diagnostic>> {
        let dialect = &*self.dialect;
        // What executes is the normalized program (preflight applies the same).
        let (program, ast) = self.program(code)?;
        // Admission comes before anything runs. A stage of an admitted plan is bound to the
        // plan whatever functions its language has.
        let refused = if exec.is_planned() {
            let stage = exec.stage().map(str::to_owned);
            let manifest = self.stage_manifest(code, &program, &ast, stage, config)?;
            admit_planned(dialect, self.policy.as_ref(), exec, &manifest).await
        } else {
            admit(&ast, dialect, self.policy.as_ref(), exec).await
        };
        if !refused.is_empty() {
            return Err(refused);
        }
        self.check(&ast)?;
        let data = upstream(data);
        let config = Value::from_json(config);
        Evaluator::new(Context {
            ast: &ast,
            dialect,
            schemas: &*self.schemas,
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
            return Ok(Model { lang, kind: ModelKind::Plan(code.clone()) });
        }
        // Input-independent: its value is the same for every input, so evaluate it once, with none.
        let mut exec = ExecContext::new(Identity::default());
        let value = self.run(code, &Json::Null, config, &mut exec).await?;
        // An undefined value has no JSON, and `/compile` answers it without `data`: as a value
        // it would come back `null`, so such a program stays a plan.
        Ok(Model {
            kind: match value.to_json() {
                Some(json) => ModelKind::Value(json),
                None => ModelKind::Plan(code.clone()),
            },
            lang,
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
            return Compilation { result: Err(vec![refused]), effects: Vec::new() };
        }
        match &model.kind {
            ModelKind::Value(value) => Compilation { result: Ok(Value::from_json(value)), effects: Vec::new() },
            ModelKind::Plan(program) => match self.dialect.interpret(model, input, mode).await {
                Some(result) => Compilation { result: result.map(|json| Value::from_json(&json)), effects: Vec::new() },
                None => self.compile(program, input, config, identity).await,
            },
        }
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
