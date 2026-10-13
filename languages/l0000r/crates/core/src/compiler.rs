// SPDX-License-Identifier: MIT

use std::sync::Arc;

use serde_json::Value as Json;

use crate::ast::Ast;
use crate::check::check;
use crate::dialect::Dialect;
use crate::error::Diagnostic;
use crate::eval::{Context, Evaluator};
use crate::exec::{ExecContext, Identity};
use crate::protected::{PolicyClient, admit};
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
}

impl Compiler {
    pub fn new(dialect: impl Dialect + 'static) -> Self {
        Self { dialect: Arc::new(dialect), schemas: Arc::new(NoSchemas), keyring: Keyring::new(), policy: None }
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

    /// The policy authority that admits this language's protected functions. Without one,
    /// none is ever allowed.
    pub fn with_policy(mut self, policy: impl PolicyClient + 'static) -> Self {
        self.policy = Some(Arc::new(policy));
        self
    }

    /// Compiles `ast` against the upstream `data` it is chained onto.
    ///
    /// `data` may be a `{ data, errors }` envelope (the output of a chained task) or a bare
    /// value from a task compiled before the envelope existed; the data model is read from
    /// either. `identity` is the caller's verified identity and becomes this invocation's
    /// [`ExecContext`].
    pub async fn compile(
        &self,
        ast: &Ast,
        data: &Json,
        config: &Json,
        identity: Identity,
    ) -> Result<Value, Vec<Diagnostic>> {
        let mut exec = ExecContext::new(identity);
        // Protected functions are admitted or refused before anything runs.
        let refused = admit(ast, &*self.dialect, self.policy.as_ref(), &mut exec).await;
        if !refused.is_empty() {
            return Err(refused);
        }
        let mut errors = check(ast);
        self.dialect.check(ast, &mut errors);
        if !errors.is_empty() {
            return Err(errors);
        }
        let data = upstream(data);
        let config = Value::from_json(config);
        Evaluator::new(Context {
            ast,
            dialect: &*self.dialect,
            schemas: &*self.schemas,
            keyring: &self.keyring,
            data: &data,
            config: &config,
            exec: &mut exec,
        })
        .run()
        .await
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
