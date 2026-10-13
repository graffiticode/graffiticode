// SPDX-License-Identifier: MIT

//! The kernel as a child language sees it: a toy dialect with one ordinary word and three
//! protected ones. The programs in `conformance/programs.json` were parsed with that dialect's
//! lexicon by `conformance/generate.mjs`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use async_trait::async_trait;
use graffiticode_l0000::{
    Compiler, Diagnostic, Dialect, EffectStatus, Evaluator, Identity, Key, Keyring, L0000, NodeId, Op, PolicyClient,
    PolicySnapshot, ProtectedCall, ProtectedCallError, ProtectedEffect, ProtectedFunction, ProtectedKind,
    RevisionIdentity, SnapshotRequest, StageManifest, Value,
};
use serde_json::{Value as Json, json};

static PROGRAMS: LazyLock<Json> =
    LazyLock::new(|| serde_json::from_str(include_str!("conformance/programs.json")).unwrap());

fn program(src: &str) -> &'static Json {
    PROGRAMS.get(src).unwrap_or_else(|| panic!("no parsed program for {src:?}"))
}

fn messages(errors: &[Diagnostic]) -> Vec<&str> {
    errors.iter().map(|e| e.message.as_str()).collect()
}

/// What the toy dialect was asked to do, for the tests to inspect.
#[derive(Default)]
struct Log {
    calls: Mutex<Vec<(String, Json)>>,
    runs: AtomicUsize,
}

impl Log {
    fn calls(&self) -> Vec<(String, Json)> {
        self.calls.lock().unwrap().clone()
    }
}

struct Toy {
    log: Arc<Log>,
    protected: Vec<(String, ProtectedFunction)>,
    implicit: Vec<ProtectedFunction>,
    /// Send protected calls through the broker rather than only recording them.
    brokered: bool,
    registry_version: Option<u32>,
    undeclarable: bool,
    failing: bool,
    /// What a stored program is lowered to before it runs; `Err` if it cannot be.
    lowered: Option<Result<&'static Json, &'static str>>,
}

impl Toy {
    fn new(log: &Arc<Log>) -> Self {
        Self {
            log: Arc::clone(log),
            protected: vec![
                ("SAVE_IT".to_owned(), ProtectedFunction::new("save-it", ProtectedKind::Write)),
                ("PEEK_IT".to_owned(), ProtectedFunction::new("peek-it", ProtectedKind::Read)),
                // Like Author API signing: authority beyond an ordinary render.
                ("EDIT_IT".to_owned(), ProtectedFunction::new("edit-it", ProtectedKind::Sign)),
            ],
            implicit: Vec::new(),
            brokered: false,
            registry_version: Some(6),
            undeclarable: false,
            failing: false,
            lowered: None,
        }
    }
}

#[async_trait]
impl Dialect for Toy {
    fn lang_id(&self) -> &str {
        "9999"
    }

    fn overrides(&self, op: &Op) -> bool {
        *op == Op::Prog
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let (function, result) = match op.tag() {
            "PROG" => {
                self.log.runs.fetch_add(1, Ordering::Relaxed);
                return Some(cx.eval_kernel(id).await);
            }
            "HELLO" => {
                let name = cx.eval_arg(id, elts, 0).await;
                return Some(Value::from(format!("hello, {}!", name.display())));
            }
            // A dialect reports a failure of its own with whatever detail it has.
            "SAVE_IT" if self.failing => {
                cx.report_diagnostic(Diagnostic {
                    code: Some("authorization-denied:not-granted".into()),
                    category: Some("permission".into()),
                    stage: Some("s0".into()),
                    function: Some("save-it".into()),
                    step: Some("items".into()),
                    ..Diagnostic::spanning("Error: Item bank save partial", 3, -1)
                });
                return Some(Value::Null);
            }
            "SAVE_IT" => ("save-it", "saved"),
            "PEEK_IT" => ("peek-it", "peeked"),
            "EDIT_IT" => ("edit-it", "edited"),
            _ => return None,
        };
        let arg = cx.eval_arg(id, elts, 0).await;
        let payload = arg.to_json().unwrap_or(Json::Null);
        self.log.calls.lock().unwrap().push((function.to_owned(), payload.clone()));
        if self.brokered {
            let occurrence_id = cx.exec().next_occurrence(&format!("n{id}"));
            let call =
                ProtectedCall { function: function.to_owned(), op: "toy.write".to_owned(), payload, occurrence_id };
            return Some(match cx.exec().invoke(&call).await {
                Ok(receipt) => Value::from_json(&receipt),
                Err(err) => {
                    cx.report(id, err.to_string());
                    Value::Undefined
                }
            });
        }
        Some(Value::Record([(Key::tag(result), arg)].into_iter().collect()))
    }

    fn protected_functions(&self) -> &[(String, ProtectedFunction)] {
        &self.protected
    }

    fn registry_version(&self) -> Option<u32> {
        self.registry_version
    }

    fn undeclarable_protected(&self) -> bool {
        self.undeclarable
    }

    fn normalize<'a>(&self, code: &'a Json) -> Result<std::borrow::Cow<'a, Json>, String> {
        match self.lowered {
            None => Ok(std::borrow::Cow::Borrowed(code)),
            Some(Ok(program)) => Ok(std::borrow::Cow::Borrowed(program)),
            Some(Err(problem)) => Err(problem.to_owned()),
        }
    }

    fn implicit_protected_functions(&self) -> &[ProtectedFunction] {
        &self.implicit
    }
}

/// A policy authority that allows a fixed list and remembers what it was asked.
#[derive(Clone, Default)]
struct Policy {
    allowed: Vec<String>,
    fail: bool,
    /// The stage binding policy signs into a planned stage's session.
    bind: Option<Json>,
    /// What the broker answers each call with, in order; a receipt once they run out.
    outcomes: Arc<Mutex<Vec<Result<Json, ProtectedCallError>>>>,
    asked: Arc<Mutex<Vec<Json>>>,
    minted: Arc<Mutex<Vec<ProtectedCall>>>,
}

impl Policy {
    fn allowing(allowed: &[&str]) -> Self {
        Self { allowed: allowed.iter().map(|f| (*f).to_owned()).collect(), ..Self::default() }
    }

    fn asked(&self) -> Vec<Json> {
        self.asked.lock().unwrap().clone()
    }
}

#[async_trait]
impl PolicyClient for Policy {
    async fn snapshot(&self, request: SnapshotRequest<'_>) -> Result<PolicySnapshot, ProtectedCallError> {
        self.asked.lock().unwrap().push(json!({
            "lang": request.lang_id,
            "fns": request.functions,
            "uid": request.exec.uid(),
            "connection": request.exec.connection_id(),
            "invocation": request.exec.invocation_token(),
            "manifest": request.manifest,
        }));
        if self.fail {
            return Err(ProtectedCallError::Unavailable("policy is down".to_owned()));
        }
        Ok(PolicySnapshot {
            allowed: self.allowed.clone(),
            session_token: Some("session-1".to_owned()),
            bind: self.bind.clone(),
        })
    }

    async fn invoke(&self, session_token: &str, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        assert_eq!(session_token, "session-1");
        self.minted.lock().unwrap().push(call.clone());
        let mut outcomes = self.outcomes.lock().unwrap();
        if outcomes.is_empty() { Ok(json!({ "receipt": call.occurrence_id })) } else { outcomes.remove(0) }
    }
}

fn user() -> Identity {
    Identity { uid: Some("u1".into()), connection_id: Some("conn-1".into()), ..Identity::default() }
}

struct Run {
    result: Result<Value, Vec<Diagnostic>>,
    effects: Vec<ProtectedEffect>,
    log: Arc<Log>,
    policy: Policy,
}

async fn run_as(src: &str, policy: Policy, identity: Identity, configure: impl FnOnce(&mut Toy)) -> Run {
    let log = Arc::new(Log::default());
    let mut toy = Toy::new(&log);
    configure(&mut toy);
    let compiler = Compiler::new(toy).with_policy(policy.clone()).with_revision(revision());
    let compiled = compiler.compile(program(src), &json!({}), &json!({ "a": 1 }), identity).await;
    Run { result: compiled.result, effects: compiled.effects, log, policy }
}

fn revision() -> RevisionIdentity {
    RevisionIdentity { revision: Some("l9999-r1".into()), image_digest: Some(format!("sha256:{}", "1".repeat(64))) }
}

async fn run(src: &str, allowed: &[&str]) -> Run {
    run_as(src, Policy::allowing(allowed), user(), |_| {}).await
}

mod dialects {
    use super::*;

    #[tokio::test]
    async fn a_dialect_defines_its_own_words() {
        let run = run(r#"hello "world".."#, &[]).await;
        assert_eq!(run.result, Ok(Value::from("hello, world!")));
        let run = super::run("hello add 1 2..", &[]).await;
        assert_eq!(run.result, Ok(Value::from("hello, 3!")));
    }

    #[tokio::test]
    async fn its_words_compose_with_the_kernels() {
        let run = run("map (<x: hello x>) [1 2]..", &[]).await;
        assert_eq!(run.result.unwrap().to_json(), Some(json!(["hello, 1!", "hello, 2!"])));
    }

    #[tokio::test]
    async fn an_overridden_operator_can_defer_to_the_kernel() {
        let run = run("add 1 2..", &[]).await;
        assert_eq!(run.result, Ok(Value::from(3.0)));
        assert_eq!(run.log.runs.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn a_word_no_dialect_defines_is_a_compile_error() {
        let result =
            Compiler::new(L0000).compile(program(r#"hello "world".."#), &json!({}), &json!({}), user()).await.result;
        assert_eq!(messages(&result.unwrap_err()), ["1004: No visitor method defined for 'HELLO'."]);
    }
}

mod the_grant_is_the_authority {
    use super::*;

    // Every placement a protected call can take in source.
    const PLACEMENTS: [&str; 7] = [
        "save-it 1..",
        "(save-it 1)..",
        "if true then save-it 1 else 2..",
        "if false then save-it 1 else 2..",
        "map (<x: save-it x>) [1 2]..",
        "reduce (<x acc: save-it x>) 0 [1 2]..",
        "let f = save-it..f 1..",
    ];

    #[tokio::test]
    async fn an_ungranted_call_is_refused_before_anything_runs() {
        for src in PLACEMENTS {
            let run = run(src, &[]).await;
            let errors = run.result.expect_err(src);
            assert_eq!(errors[0].message, "save-it is not permitted through the selected connection.", "{src}");
            assert_eq!(run.log.runs.load(Ordering::Relaxed), 0, "{src}");
            assert!(run.log.calls().is_empty(), "{src}");
        }
    }

    #[tokio::test]
    async fn a_granted_write_runs() {
        let run = run("save-it 1..", &["save-it"]).await;
        assert_eq!(run.result.unwrap().to_json(), Some(json!({ "saved": 1 })));
        assert_eq!(run.log.calls(), [("save-it".to_owned(), json!(1))]);
    }

    #[tokio::test]
    async fn a_granted_write_inside_a_lambda_runs_once_per_element() {
        let run = run("map (<x: save-it x>) [1 2]..", &["save-it"]).await;
        assert!(run.result.is_ok());
        assert_eq!(run.log.calls(), [("save-it".to_owned(), json!(1)), ("save-it".to_owned(), json!(2))]);
    }

    #[tokio::test]
    async fn a_writes_arguments_are_evaluated_like_any_calls() {
        let run = run("save-it add 1 2..", &["save-it"]).await;
        assert_eq!(run.result.unwrap().to_json(), Some(json!({ "saved": 3 })));
    }

    #[tokio::test]
    async fn one_ungranted_call_refuses_the_whole_program() {
        let run = run("[peek-it 1 save-it 2]..", &["peek-it"]).await;
        assert_eq!(messages(&run.result.unwrap_err()), ["save-it is not permitted through the selected connection."]);
        assert!(run.log.calls().is_empty());
    }

    #[tokio::test]
    async fn the_error_points_at_the_call() {
        let errors = run("[1 save-it 2]..", &[]).await.result.unwrap_err();
        assert!(errors[0].from > 0 && errors[0].to > errors[0].from, "{errors:?}");
    }

    #[tokio::test]
    async fn reads_and_signing_need_a_grant_too() {
        for (src, function) in [("peek-it 1..", "peek-it"), ("edit-it 1..", "edit-it")] {
            assert!(run(src, &[]).await.result.is_err(), "{src}");
            assert!(run(src, &[function]).await.result.is_ok(), "{src}");
        }
    }
}

mod policy_snapshot {
    use super::*;

    #[tokio::test]
    async fn is_fetched_once_with_the_functions_the_program_needs() {
        let run = run("[peek-it 1 save-it 2]..", &["peek-it", "save-it"]).await;
        assert!(run.result.is_ok());
        assert_eq!(
            run.policy.asked(),
            [json!({
                // In pool order, which is not source order.
                "lang": "9999", "fns": ["save-it", "peek-it"],
                "uid": "u1", "connection": "conn-1", "invocation": null, "manifest": null,
            })]
        );
    }

    #[tokio::test]
    async fn is_not_fetched_for_a_program_with_no_protected_calls() {
        let run = run("add 1 2..", &[]).await;
        assert_eq!(run.result, Ok(Value::from(3.0)));
        assert!(run.policy.asked().is_empty());
    }

    #[tokio::test]
    async fn fails_closed_when_policy_cannot_be_reached() {
        let policy = Policy { fail: true, ..Policy::allowing(&["save-it"]) };
        let run = run_as("save-it 1..", policy, user(), |_| {}).await;
        assert_eq!(
            messages(&run.result.unwrap_err()),
            ["Permission check is unavailable; protected functions cannot run."]
        );
        assert!(run.log.calls().is_empty());
    }

    #[tokio::test]
    async fn without_a_connection_nothing_is_allowed_and_policy_is_not_asked() {
        let identity = Identity { uid: Some("u1".into()), ..Identity::default() };
        let run = run_as("save-it 1..", Policy::allowing(&["save-it"]), identity, |_| {}).await;
        assert_eq!(messages(&run.result.unwrap_err()), ["save-it requires a connection that permits it."]);
        assert!(run.policy.asked().is_empty());
    }

    #[tokio::test]
    async fn a_published_view_asks_on_its_invocation_token_alone() {
        let identity = Identity {
            connection_id: Some("conn-1".into()),
            invocation_token: Some("inv-1".into()),
            ..Identity::default()
        };
        let run = run_as("peek-it 1..", Policy::allowing(&["peek-it"]), identity, |_| {}).await;
        assert!(run.result.is_ok());
        assert_eq!(run.policy.asked()[0]["uid"], Json::Null);
        assert_eq!(run.policy.asked()[0]["invocation"], "inv-1");
    }

    #[tokio::test]
    async fn with_neither_a_user_nor_an_invocation_policy_is_never_asked() {
        let identity = Identity { connection_id: Some("conn-1".into()), ..Identity::default() };
        let run = run_as("peek-it 1..", Policy::allowing(&["peek-it"]), identity, |_| {}).await;
        assert!(run.result.is_err());
        assert!(run.policy.asked().is_empty());
    }

    #[tokio::test]
    async fn a_compiler_with_no_policy_allows_nothing() {
        let log = Arc::new(Log::default());
        let result =
            Compiler::new(Toy::new(&log)).compile(program("save-it 1.."), &json!({}), &json!({}), user()).await.result;
        assert!(result.is_err());
        assert!(log.calls().is_empty());
    }
}

mod implicit_protected_functions {
    use super::*;

    fn signing(toy: &mut Toy) {
        toy.implicit = vec![ProtectedFunction::new("peek-it", ProtectedKind::Sign)];
    }

    #[tokio::test]
    async fn are_required_even_when_no_protected_call_appears_in_the_source() {
        let run = run_as("add 1 2..", Policy::allowing(&[]), user(), signing).await;
        assert_eq!(messages(&run.result.unwrap_err()), ["peek-it is not permitted through the selected connection."]);
        assert_eq!(run.policy.asked()[0]["fns"], json!(["peek-it"]));
    }

    #[tokio::test]
    async fn run_when_granted() {
        let run = run_as("add 1 2..", Policy::allowing(&["peek-it"]), user(), signing).await;
        assert_eq!(run.result, Ok(Value::from(3.0)));
    }

    #[tokio::test]
    async fn share_one_snapshot_with_explicit_calls() {
        let run = run_as("save-it 1..", Policy::allowing(&["peek-it", "save-it"]), user(), signing).await;
        assert!(run.result.is_ok());
        assert_eq!(run.policy.asked().len(), 1);
        assert_eq!(run.policy.asked()[0]["fns"], json!(["peek-it", "save-it"]));
    }

    #[tokio::test]
    async fn cannot_be_writes() {
        let run = run_as("add 1 2..", Policy::allowing(&["save-it"]), user(), |toy| {
            toy.implicit = vec![ProtectedFunction::new("save-it", ProtectedKind::Write)];
        })
        .await;
        assert_eq!(messages(&run.result.unwrap_err()), ["Implicit protected function save-it cannot be a write."]);
        assert!(run.policy.asked().is_empty());
    }
}

mod protected_calls {
    use super::*;

    fn brokered(toy: &mut Toy) {
        toy.brokered = true;
    }

    #[tokio::test]
    async fn an_admitted_call_reaches_the_broker_with_its_payload() {
        let run = run_as("save-it add 1 2..", Policy::allowing(&["save-it"]), user(), brokered).await;
        let minted = run.policy.minted.lock().unwrap().clone();
        assert_eq!(minted.len(), 1);
        assert_eq!((minted[0].function.as_str(), &minted[0].payload), ("save-it", &json!(3)));
        assert_eq!(run.result.unwrap().to_json(), Some(json!({ "receipt": minted[0].occurrence_id })));
    }

    #[tokio::test]
    async fn a_loop_gets_one_occurrence_id_per_call() {
        let run = run_as("map (<x: save-it x>) [1 2]..", Policy::allowing(&["save-it"]), user(), brokered).await;
        assert!(run.result.is_ok());
        let ids: Vec<String> = run.policy.minted.lock().unwrap().iter().map(|c| c.occurrence_id.clone()).collect();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0].strip_suffix(".0"), ids[1].strip_suffix(".1"));
    }

    #[tokio::test]
    async fn invoke_refuses_a_function_admission_did_not_allow() {
        // Admission passes (nothing in this dialect is declared protected), so the call is
        // attempted; the context itself refuses it before any request.
        let run = run_as("save-it 1..", Policy::allowing(&["save-it"]), user(), |toy| {
            toy.brokered = true;
            toy.protected.clear();
        })
        .await;
        assert_eq!(messages(&run.result.unwrap_err()), ["save-it was not admitted for this invocation"]);
        assert!(run.policy.minted.lock().unwrap().is_empty());
    }
}

mod invocations {
    use super::*;

    /// Yields the caller's uid, so a test can see whose context a compile ran under.
    struct WhoAmI;

    #[async_trait]
    impl Dialect for WhoAmI {
        fn lang_id(&self) -> &str {
            "9998"
        }

        async fn eval(&self, cx: &mut Evaluator<'_>, _: NodeId, op: &Op, _: &[NodeId]) -> Option<Value> {
            if op.tag() != "HELLO" {
                return None;
            }
            tokio::task::yield_now().await;
            Some(cx.exec().uid().map_or(Value::Null, Value::from))
        }
    }

    #[tokio::test]
    async fn concurrent_compiles_on_one_compiler_keep_their_own_identity() {
        let compiler = Compiler::new(WhoAmI);
        let ast = program(r#"hello "world".."#);
        let compile = |uid: &str| {
            let identity = Identity { uid: Some(uid.to_owned()), ..Identity::default() };
            async { compiler.compile(ast, &Json::Null, &Json::Null, identity).await.result }
        };
        let (alice, bob, nobody) = tokio::join!(compile("alice"), compile("bob"), async {
            compiler.compile(ast, &Json::Null, &Json::Null, Identity::default()).await.result
        });
        assert_eq!(alice, Ok(Value::from("alice")));
        assert_eq!(bob, Ok(Value::from("bob")));
        assert_eq!(nobody, Ok(Value::Null));
    }

    #[tokio::test]
    async fn a_program_reads_config_and_data_but_nothing_else_of_the_invocation() {
        let compiler = Compiler::new(L0000);
        let identity = Identity { uid: Some("u1".into()), user_token: Some("secret".into()), ..Identity::default() };
        let config = json!({ "theme": "dark" });
        let compiled = compiler.compile(program(r#"get-var "config".."#), &json!({}), &config, identity.clone()).await;
        assert_eq!(compiled.result.unwrap().to_json(), Some(config));

        let data = json!({ "data": { "x": 1 }, "errors": [] });
        let compiled = compiler.compile(program(r#"get-var "data".."#), &data, &json!({}), identity).await;
        assert_eq!(compiled.result.unwrap().to_json(), Some(json!({ "x": 1 })));
    }
}

mod checks {
    use super::*;

    #[tokio::test]
    async fn an_unresolved_value_is_reported_where_it_is_written() {
        let errors = Compiler::new(L0000)
            .compile(program(r#"get-val-public "name".."#), &json!({}), &json!({}), Identity::default())
            .await
            .result
            .unwrap_err();
        assert_eq!(errors, [Diagnostic::spanning("get-val-public requires a resolved value.", 0, 14)]);
    }

    #[tokio::test]
    async fn every_reachable_parse_error_is_reported() {
        // [ERROR("first", 1, 2), (ERROR("second", 3, 4))] — the second sits under a PAREN.
        let code = json!({
            "1": { "tag": "STR", "elts": ["first"] }, "2": { "tag": "NUM", "elts": ["1"] },
            "3": { "tag": "NUM", "elts": ["2"] }, "4": { "tag": "ERROR", "elts": [1, 2, 3] },
            "5": { "tag": "STR", "elts": ["second"] }, "6": { "tag": "NUM", "elts": ["3"] },
            "7": { "tag": "NUM", "elts": ["4"] }, "8": { "tag": "ERROR", "elts": [5, 6, 7] },
            "9": { "tag": "PAREN", "elts": [8] }, "10": { "tag": "LIST", "elts": [4, 9] },
            "11": { "tag": "EXPRS", "elts": [10] }, "12": { "tag": "PROG", "elts": [11] }, "root": 12,
        });
        let compiled = Compiler::new(L0000).compile(&code, &json!({}), &json!({}), Identity::default()).await;
        assert_eq!(
            compiled.result.unwrap_err(),
            [Diagnostic::spanning("first", 1, 2), Diagnostic::spanning("second", 3, 4)]
        );
    }

    #[tokio::test]
    async fn evaluation_reports_every_error_it_meets() {
        let errors = Compiler::new(L0000)
            .compile(program("[1 (hd [])].."), &json!({}), &json!({}), Identity::default())
            .await
            .result
            .unwrap_err();
        assert_eq!(messages(&errors), ["Error in HD operation: empty list has no head"]);
    }

    #[tokio::test]
    async fn runaway_nesting_is_an_error_not_a_crash() {
        let mut pool = serde_json::Map::new();
        pool.insert("1".into(), json!({ "tag": "NUM", "elts": ["7"] }));
        let depth = 100_000;
        for id in 2..=depth {
            pool.insert(id.to_string(), json!({ "tag": "PAREN", "elts": [id - 1] }));
        }
        pool.insert("root".into(), json!(depth));
        let compiled =
            Compiler::new(L0000).compile(&Json::Object(pool), &json!({}), &json!({}), Identity::default()).await;
        assert_eq!(messages(&compiled.result.unwrap_err()), ["Expressions are nested too deeply."]);
    }

    #[tokio::test]
    async fn a_malformed_pool_is_a_compile_error() {
        for (pool, message) in [
            (json!([]), "the AST must be an object of nodes keyed by id"),
            (json!({ "1": { "tag": "NULL", "elts": [] } }), "the AST has no valid `root`"),
            (json!({ "root": 2, "1": { "tag": "NULL", "elts": [] } }), "1001: Node ID 2 not found in pool."),
            (json!({ "root": 1, "1": { "elts": [] } }), "1002: Invalid tag in node with Node ID 1."),
            (
                json!({ "root": 1, "1": { "tag": "ADD", "elts": ["x", 2] } }),
                "node 1 (ADD) has an element that is neither a literal nor a node id",
            ),
        ] {
            let compiled = Compiler::new(L0000).compile(&pool, &json!({}), &json!({}), Identity::default()).await;
            assert_eq!(messages(&compiled.result.unwrap_err()), [message]);
        }
    }
}

mod secrets {
    use super::*;

    fn private_value(stored: &str) -> Json {
        json!({
            "1": { "tag": "STR", "elts": ["api-key"] }, "2": { "tag": "STR", "elts": [stored] },
            "3": { "tag": "GET_VAL_PRIVATE", "elts": [1, 2] },
            "4": { "tag": "EXPRS", "elts": [3] }, "5": { "tag": "PROG", "elts": [4] }, "root": 5,
        })
    }

    #[tokio::test]
    async fn a_private_value_is_decrypted_with_the_compilers_keyring() {
        let stored = include_str!("secret/v2.txt").trim();
        let compile = async |keyring: Keyring| {
            Compiler::new(L0000)
                .with_keyring(keyring)
                .compile(&private_value(stored), &json!({}), &json!({}), Identity::default())
                .await
                .result
        };
        assert_eq!(compile(Keyring::new().with_secret(2, "key-two")).await, Ok(Value::from("s3cret value")));
        // Without the key the stored text passes through unopened.
        assert_eq!(compile(Keyring::new()).await, Ok(Value::from(stored)));
    }
}

mod effects {
    use super::*;

    fn brokered(toy: &mut Toy) {
        toy.brokered = true;
    }

    async fn save(src: &str, outcomes: Vec<Result<Json, ProtectedCallError>>) -> Run {
        let policy = Policy { outcomes: Arc::new(Mutex::new(outcomes)), ..Policy::allowing(&["save-it", "edit-it"]) };
        run_as(src, policy, user(), brokered).await
    }

    fn wire(effects: &[ProtectedEffect]) -> Json {
        serde_json::to_value(effects).unwrap()
    }

    #[tokio::test]
    async fn a_writes_outcome_is_the_compiles_effect() {
        let run =
            save("save-it 1..", vec![Ok(json!({ "status": "succeeded", "steps": ["questions", "items"] }))]).await;
        assert!(run.result.is_ok());
        assert_eq!(
            wire(&run.effects),
            json!([{ "fn": "save-it", "op": "toy.write", "status": "succeeded", "steps": ["questions", "items"] }])
        );
    }

    #[tokio::test]
    async fn an_earlier_save_is_still_reported_when_a_later_one_fails() {
        let run = save(
            "[save-it 1 save-it 2]..",
            vec![
                Ok(json!({ "status": "succeeded", "steps": ["questions", "items"], "result": {} })),
                Ok(json!({
                    "status": "partial", "steps": ["questions"], "failedStep": "items",
                    "reason": "authorization-denied:not-granted", "category": "permission", "error": "denied",
                })),
            ],
        )
        .await;
        assert_eq!(run.effects.len(), 2);
        assert_eq!(run.effects[0].status, EffectStatus::Succeeded);
        assert_eq!(
            wire(&run.effects[1..]),
            json!([{
                "fn": "save-it", "op": "toy.write", "status": "partial", "steps": ["questions"], "failedStep": "items",
                "reason": "authorization-denied:not-granted", "category": "permission",
            }])
        );
    }

    #[tokio::test]
    async fn a_refused_write_did_nothing_and_says_why() {
        let refusal = ProtectedCallError::Rejected {
            path: "/v1/mint".into(),
            status: 403,
            reason: Some("operation-not-allowed".into()),
            category: Some("permission".into()),
            effect_unknown: false,
        };
        let run = save("save-it 1..", vec![Err(refusal)]).await;
        // The effects come with the error.
        assert_eq!(messages(&run.result.unwrap_err()), ["/v1/mint failed (403)"]);
        assert_eq!(
            wire(&run.effects),
            json!([{
                "fn": "save-it", "op": "toy.write", "status": "failed", "steps": [],
                "reason": "operation-not-allowed", "category": "permission",
            }])
        );
    }

    #[tokio::test]
    async fn a_lost_answer_is_uncertain_never_a_refusal() {
        let lost = ProtectedCallError::Unreachable { path: "/v1/execute".into(), effect_unknown: true };
        let run = save("save-it 1..", vec![Err(lost)]).await;
        assert_eq!(messages(&run.result.unwrap_err()), ["/v1/execute unreachable"]);
        assert_eq!(
            wire(&run.effects),
            json!([{ "fn": "save-it", "op": "toy.write", "status": "uncertain", "steps": [] }])
        );
    }

    #[tokio::test]
    async fn signs_and_reads_are_not_effects() {
        let run =
            save("edit-it 1..", vec![Ok(json!({ "status": "succeeded", "result": { "request": "signed" } }))]).await;
        assert!(run.result.is_ok());
        assert!(run.effects.is_empty());
        assert!(super::run("add 1 2..", &[]).await.effects.is_empty());
    }
}

mod structured_errors {
    use super::*;

    #[tokio::test]
    async fn keep_their_message_and_carry_code_category_stage_function_and_step() {
        let run = run_as("save-it 1..", Policy::allowing(&["save-it"]), user(), |toy| toy.failing = true).await;
        let errors = run.result.unwrap_err();
        assert_eq!(
            serde_json::to_value(&errors).unwrap(),
            json!([{
                "message": "Error: Item bank save partial", "from": 3, "to": -1,
                "code": "authorization-denied:not-granted", "category": "permission",
                "stage": "s0", "fn": "save-it", "step": "items",
            }])
        );
    }
}

mod preflight {
    use super::*;
    use graffiticode_l0000::canonical::args_digest;

    fn toy(configure: impl FnOnce(&mut Toy)) -> (Compiler, Arc<Log>, Policy) {
        let log = Arc::new(Log::default());
        let mut toy = Toy::new(&log);
        configure(&mut toy);
        let policy = Policy::allowing(&[]);
        (Compiler::new(toy).with_policy(policy.clone()).with_revision(revision()), log, policy)
    }

    #[test]
    fn names_every_protected_function_the_program_can_reach_once_each() {
        let functions = |src: &str, configure: fn(&mut Toy)| {
            toy(configure).0.preflight(program(src), "s0", &Json::Null).unwrap().required_functions
        };
        // A lambda that is never applied: its save is dead code, and still counts.
        assert_eq!(functions("[edit-it 1 <x: save-it x>]..", |_| {}), ["edit-it", "save-it"]);
        assert_eq!(functions("[edit-it 1 edit-it 2]..", |_| {}), ["edit-it"]);
        assert_eq!(
            functions("1..", |toy| toy.implicit = vec![ProtectedFunction::new("init", ProtectedKind::Sign)]),
            ["init"]
        );
    }

    #[test]
    fn reports_the_stage_manifest() {
        let stored = program("add 1 2..");
        let lowered = program("save-it 1..");
        let (compiler, ..) = toy(|toy| toy.lowered = Some(Ok(program("save-it 1.."))));
        assert_eq!(
            compiler.preflight(stored, "s1", &json!({ "a": 1 })),
            Ok(StageManifest {
                stage: Some("s1".into()),
                lang: "9999".into(),
                source_digest: args_digest(stored),
                program_digest: args_digest(lowered),
                options_digest: args_digest(&json!({ "a": 1 })),
                revision: "l9999-r1".into(),
                image_digest: format!("sha256:{}", "1".repeat(64)),
                registry_version: 6,
                required_functions: vec!["save-it".into()],
            })
        );
    }

    /// `conformance/manifests.json` holds manifests the TypeScript compiler computed. A plan
    /// pins a stage by these digests, so the two implementations must agree on every byte.
    #[test]
    fn computes_the_digests_the_typescript_compiler_computes() {
        let cases: Vec<Json> = serde_json::from_str(include_str!("conformance/manifests.json")).unwrap();
        assert!(cases.len() >= 5);
        let compiler = Compiler::new(L0000).with_revision(RevisionIdentity {
            revision: Some("l0000-r1".into()),
            image_digest: Some(format!("sha256:{}", "1".repeat(64))),
        });
        for case in cases {
            let manifest = compiler.preflight(&case["code"], "s0", &case["options"]).unwrap();
            assert_eq!(serde_json::to_value(manifest).unwrap(), case["manifest"], "{}", case["src"]);
        }
    }

    #[test]
    fn is_side_effect_free() {
        let (compiler, log, policy) = toy(|_| {});
        let manifest = compiler.preflight(program("save-it 1.."), "s0", &Json::Null).unwrap();
        assert_eq!(manifest.required_functions, ["save-it"]);
        assert_eq!(manifest.options_digest, args_digest(&json!({})));
        assert!(policy.asked().is_empty());
        assert!(log.calls().is_empty());
        assert_eq!(log.runs.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_language_with_no_protected_functions_is_registry_version_zero() {
        let manifest =
            Compiler::new(L0000).with_revision(revision()).preflight(program("1.."), "s0", &Json::Null).unwrap();
        assert_eq!((manifest.lang.as_str(), manifest.registry_version), ("0000", 0));
        assert!(manifest.required_functions.is_empty());
    }

    #[test]
    fn refuses_what_cannot_be_pinned() {
        let code_of = |compiler: Compiler| {
            compiler.preflight(program("save-it 1.."), "s0", &Json::Null).unwrap_err()[0].code.clone()
        };
        assert_eq!(code_of(toy(|toy| toy.undeclarable = true).0).as_deref(), Some("undeclarable-protected"));
        assert_eq!(code_of(toy(|toy| toy.registry_version = None).0).as_deref(), Some("preflight-unavailable"));
        let undeployed = toy(|_| {}).0.with_revision(RevisionIdentity::default());
        assert_eq!(code_of(undeployed).as_deref(), Some("preflight-unavailable"));
    }

    #[test]
    fn returns_the_errors_that_would_stop_the_compile() {
        let (compiler, ..) = toy(|toy| toy.lowered = Some(Err("cannot lower")));
        let errors = compiler.preflight(program("1.."), "s0", &Json::Null).unwrap_err();
        assert_eq!(messages(&errors), ["Error: cannot lower"]);

        let errors = toy(|_| {}).0.preflight(program(r#"get-val-public "name".."#), "s0", &Json::Null).unwrap_err();
        assert_eq!(messages(&errors), ["get-val-public requires a resolved value."]);
    }
}

mod admitted_plans {
    use super::*;

    fn planned(stage: &str) -> Identity {
        Identity {
            uid: Some("u1".into()),
            connection_id: Some("conn-1".into()),
            user_token: Some("t".into()),
            invocation_token: Some("inv".into()),
            stage: Some(stage.into()),
            admission_token: Some("adm".into()),
        }
    }

    /// The binding policy signs for a stage: its manifest without the stage name and the
    /// registry version.
    fn binding(compiler: &Compiler, src: &str, stage: &str) -> Json {
        let manifest = compiler.preflight(program(src), stage, &json!({ "a": 1 })).unwrap();
        let mut bind = serde_json::to_value(manifest).unwrap();
        let fields = bind.as_object_mut().unwrap();
        fields.remove("stage");
        fields.remove("registryVersion");
        bind
    }

    fn toy_binding(src: &str) -> Json {
        binding(&Compiler::new(Toy::new(&Arc::default())).with_revision(revision()), src, "s1")
    }

    async fn run_bound(src: &str, bind: Json) -> Run {
        let policy = Policy { bind: Some(bind), ..Policy::allowing(&["edit-it"]) };
        run_as(src, policy, planned("s1"), |_| {}).await
    }

    #[tokio::test]
    async fn a_stage_runs_only_after_policys_binding_matches_what_it_is_about_to_execute() {
        let bind = toy_binding("edit-it 1..");
        let run = run_bound("edit-it 1..", bind.clone()).await;
        assert_eq!(run.result.unwrap().to_json(), Some(json!({ "edited": 1 })));
        let asked = &run.policy.asked()[0];
        assert_eq!(asked["fns"], json!(["edit-it"]));
        assert_eq!(asked["manifest"]["stage"], "s1");
        assert_eq!(asked["manifest"]["programDigest"], bind["programDigest"]);
    }

    #[tokio::test]
    async fn a_binding_that_names_anything_else_refuses_the_stage_before_it_runs() {
        for (field, other) in [
            ("programDigest", json!("f".repeat(64))),
            ("optionsDigest", json!("f".repeat(64))),
            ("revision", json!("l9999-r2")),
            ("imageDigest", json!(format!("sha256:{}", "2".repeat(64)))),
            ("requiredFunctions", json!(["edit-it", "save-it"])),
        ] {
            let mut bind = toy_binding("edit-it 1..");
            bind[field] = other;
            let run = run_bound("edit-it 1..", bind).await;
            assert_eq!(
                messages(&run.result.unwrap_err()),
                [format!("This compiler is not the one the admitted plan pins ({field}).")]
            );
            assert_eq!(run.log.runs.load(Ordering::Relaxed), 0, "{field}");
            assert!(run.log.calls().is_empty(), "{field}");
        }
    }

    #[tokio::test]
    async fn a_stage_whose_language_has_no_protected_functions_is_bound_too() {
        let compiler = Compiler::new(L0000).with_revision(revision());
        let bind = binding(&compiler, "1..", "s0");
        let compile = async |bind: Json| {
            let policy = Policy { bind: Some(bind), ..Policy::allowing(&[]) };
            let compiled = compiler
                .clone()
                .with_policy(policy.clone())
                .compile(program("1.."), &json!({}), &json!({ "a": 1 }), planned("s0"))
                .await;
            (compiled.result, policy.asked())
        };
        let (result, asked) = compile(bind.clone()).await;
        assert_eq!(result, Ok(Value::from(1.0)));
        assert_eq!(asked.len(), 1);
        assert_eq!((&asked[0]["fns"], &asked[0]["manifest"]["lang"]), (&json!([]), &json!("0000")));

        let mut other = bind;
        other["revision"] = json!("l0000-other");
        let (result, _) = compile(other).await;
        assert_eq!(messages(&result.unwrap_err()), ["This compiler is not the one the admitted plan pins (revision)."]);
    }

    #[tokio::test]
    async fn a_planned_stage_fails_closed() {
        let code = program("edit-it 1..");
        let log = Arc::new(Log::default());
        let compile = async |compiler: Compiler| {
            compiler.compile(code, &json!({}), &json!({ "a": 1 }), planned("s1")).await.result.unwrap_err()
        };
        let toy = || Compiler::new(Toy::new(&log)).with_revision(revision());

        let errors = compile(toy()).await;
        assert_eq!(
            messages(&errors),
            ["This compiler can't run an admitted plan: no permission service is configured."]
        );

        let down = Policy { fail: true, ..Policy::default() };
        let errors = compile(toy().with_policy(down)).await;
        assert_eq!(messages(&errors), ["Permission check is unavailable; this stage cannot run (unavailable)."]);

        let undeployed = toy().with_policy(Policy::allowing(&["edit-it"])).with_revision(RevisionIdentity::default());
        assert_eq!(compile(undeployed).await[0].code.as_deref(), Some("preflight-unavailable"));

        // A session that carries no binding at all binds nothing.
        let unbound = toy().with_policy(Policy::allowing(&["edit-it"]));
        assert_eq!(
            messages(&compile(unbound).await),
            ["This compiler is not the one the admitted plan pins (binding)."]
        );
        assert_eq!(log.runs.load(Ordering::Relaxed), 0);
    }
}
