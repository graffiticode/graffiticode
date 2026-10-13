// SPDX-License-Identifier: MIT

//! The kernel as a child language sees it: a toy dialect with one ordinary word and three
//! protected ones. The programs in `conformance/programs.json` were parsed with that dialect's
//! lexicon by `conformance/generate.mjs`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use async_trait::async_trait;
use graffiticode_l0000::{
    Ast, Compiler, Diagnostic, Dialect, Evaluator, Identity, Key, Keyring, L0000, NodeId, Op, PolicyClient,
    PolicySnapshot, ProtectedCall, ProtectedCallError, ProtectedFunction, ProtectedKind, SnapshotRequest, Value,
};
use serde_json::{Value as Json, json};

static PROGRAMS: LazyLock<Json> =
    LazyLock::new(|| serde_json::from_str(include_str!("conformance/programs.json")).unwrap());

fn program(src: &str) -> Ast {
    Ast::from_json(PROGRAMS.get(src).unwrap_or_else(|| panic!("no parsed program for {src:?}"))).unwrap()
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
    protected: Vec<(&'static str, ProtectedFunction)>,
    implicit: Vec<ProtectedFunction>,
    /// Send protected calls through the broker rather than only recording them.
    brokered: bool,
}

impl Toy {
    fn new(log: &Arc<Log>) -> Self {
        Self {
            log: Arc::clone(log),
            protected: vec![
                ("SAVE_IT", ProtectedFunction::new("save-it", ProtectedKind::Write)),
                ("PEEK_IT", ProtectedFunction::new("peek-it", ProtectedKind::Read)),
                // Like Author API signing: authority beyond an ordinary render.
                ("EDIT_IT", ProtectedFunction::new("edit-it", ProtectedKind::Sign)),
            ],
            implicit: Vec::new(),
            brokered: false,
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
            let call = ProtectedCall { function: function.to_owned(), op: "put".to_owned(), payload, occurrence_id };
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

    fn protected_function(&self, tag: &str) -> Option<&ProtectedFunction> {
        self.protected.iter().find(|(name, _)| *name == tag).map(|(_, function)| function)
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
        }));
        if self.fail {
            return Err(ProtectedCallError::Transport("policy is down".to_owned()));
        }
        Ok(PolicySnapshot { allowed: self.allowed.clone(), session_token: Some("session-1".to_owned()) })
    }

    async fn invoke(&self, session_token: &str, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        assert_eq!(session_token, "session-1");
        self.minted.lock().unwrap().push(call.clone());
        Ok(json!({ "receipt": call.occurrence_id }))
    }
}

fn user() -> Identity {
    Identity { uid: Some("u1".into()), connection_id: Some("conn-1".into()), ..Identity::default() }
}

struct Run {
    result: Result<Value, Vec<Diagnostic>>,
    log: Arc<Log>,
    policy: Policy,
}

async fn run_as(src: &str, policy: Policy, identity: Identity, configure: impl FnOnce(&mut Toy)) -> Run {
    let log = Arc::new(Log::default());
    let mut toy = Toy::new(&log);
    configure(&mut toy);
    let compiler = Compiler::new(toy).with_policy(policy.clone());
    let result = compiler.compile(&program(src), &json!({}), &json!({}), identity).await;
    Run { result, log, policy }
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
        assert_eq!(run.result, Ok(Value::Num(3.0)));
        assert_eq!(run.log.runs.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn a_word_no_dialect_defines_is_a_compile_error() {
        let result = Compiler::new(L0000).compile(&program(r#"hello "world".."#), &json!({}), &json!({}), user()).await;
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
                "uid": "u1", "connection": "conn-1", "invocation": null,
            })]
        );
    }

    #[tokio::test]
    async fn is_not_fetched_for_a_program_with_no_protected_calls() {
        let run = run("add 1 2..", &[]).await;
        assert_eq!(run.result, Ok(Value::Num(3.0)));
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
            Compiler::new(Toy::new(&log)).compile(&program("save-it 1.."), &json!({}), &json!({}), user()).await;
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
        assert_eq!(run.result, Ok(Value::Num(3.0)));
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
            compiler.compile(&ast, &Json::Null, &Json::Null, identity)
        };
        let (alice, bob, nobody) = tokio::join!(
            compile("alice"),
            compile("bob"),
            compiler.compile(&ast, &Json::Null, &Json::Null, Identity::default())
        );
        assert_eq!(alice, Ok(Value::from("alice")));
        assert_eq!(bob, Ok(Value::from("bob")));
        assert_eq!(nobody, Ok(Value::Null));
    }

    #[tokio::test]
    async fn a_program_reads_config_and_data_but_nothing_else_of_the_invocation() {
        let compiler = Compiler::new(L0000);
        let identity = Identity { uid: Some("u1".into()), user_token: Some("secret".into()), ..Identity::default() };
        let config = json!({ "theme": "dark" });
        let value = compiler.compile(&program(r#"get-var "config".."#), &json!({}), &config, identity.clone()).await;
        assert_eq!(value.unwrap().to_json(), Some(config));

        let data = json!({ "data": { "x": 1 }, "errors": [] });
        let value = compiler.compile(&program(r#"get-var "data".."#), &data, &json!({}), identity).await;
        assert_eq!(value.unwrap().to_json(), Some(json!({ "x": 1 })));
    }
}

mod checks {
    use super::*;

    #[tokio::test]
    async fn an_unresolved_value_is_reported_where_it_is_written() {
        let errors = Compiler::new(L0000)
            .compile(&program(r#"get-val-public "name".."#), &json!({}), &json!({}), Identity::default())
            .await
            .unwrap_err();
        assert_eq!(
            errors,
            [Diagnostic { message: "get-val-public requires a resolved value.".into(), from: 0, to: 14 }]
        );
    }

    #[tokio::test]
    async fn every_reachable_parse_error_is_reported() {
        // [ERROR("first", 1, 2), (ERROR("second", 3, 4))] — the second sits under a PAREN.
        let ast = Ast::from_json(&json!({
            "1": { "tag": "STR", "elts": ["first"] }, "2": { "tag": "NUM", "elts": ["1"] },
            "3": { "tag": "NUM", "elts": ["2"] }, "4": { "tag": "ERROR", "elts": [1, 2, 3] },
            "5": { "tag": "STR", "elts": ["second"] }, "6": { "tag": "NUM", "elts": ["3"] },
            "7": { "tag": "NUM", "elts": ["4"] }, "8": { "tag": "ERROR", "elts": [5, 6, 7] },
            "9": { "tag": "PAREN", "elts": [8] }, "10": { "tag": "LIST", "elts": [4, 9] },
            "11": { "tag": "EXPRS", "elts": [10] }, "12": { "tag": "PROG", "elts": [11] }, "root": 12,
        }))
        .unwrap();
        let errors = Compiler::new(L0000).compile(&ast, &json!({}), &json!({}), Identity::default()).await.unwrap_err();
        assert_eq!(
            errors,
            [
                Diagnostic { message: "first".into(), from: 1, to: 2 },
                Diagnostic { message: "second".into(), from: 3, to: 4 },
            ]
        );
    }

    #[tokio::test]
    async fn evaluation_reports_every_error_it_meets() {
        let errors = Compiler::new(L0000)
            .compile(&program("[1 (hd [])].."), &json!({}), &json!({}), Identity::default())
            .await
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
        let ast = Ast::from_json(&Json::Object(pool)).unwrap();
        let errors = Compiler::new(L0000).compile(&ast, &json!({}), &json!({}), Identity::default()).await.unwrap_err();
        assert_eq!(messages(&errors), ["Expressions are nested too deeply."]);
    }

    #[test]
    fn a_malformed_pool_is_rejected_before_it_is_compiled() {
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
            assert_eq!(Ast::from_json(&pool).unwrap_err().to_string(), message);
        }
    }
}

mod secrets {
    use super::*;

    fn private_value(stored: &str) -> Ast {
        Ast::from_json(&json!({
            "1": { "tag": "STR", "elts": ["api-key"] }, "2": { "tag": "STR", "elts": [stored] },
            "3": { "tag": "GET_VAL_PRIVATE", "elts": [1, 2] },
            "4": { "tag": "EXPRS", "elts": [3] }, "5": { "tag": "PROG", "elts": [4] }, "root": 5,
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn a_private_value_is_decrypted_with_the_compilers_keyring() {
        let stored = include_str!("secret/v2.txt").trim();
        let compile = async |keyring: Keyring| {
            Compiler::new(L0000)
                .with_keyring(keyring)
                .compile(&private_value(stored), &json!({}), &json!({}), Identity::default())
                .await
        };
        assert_eq!(compile(Keyring::new().with_secret(2, "key-two")).await, Ok(Value::from("s3cret value")));
        // Without the key the stored text passes through unopened.
        assert_eq!(compile(Keyring::new()).await, Ok(Value::from(stored)));
    }
}
