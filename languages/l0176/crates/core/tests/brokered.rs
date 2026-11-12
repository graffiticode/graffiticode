// SPDX-License-Identifier: MIT

//! The brokered path, against a fake policy and broker at the client boundary: a compile that
//! selects a connection signs and saves through them and never with a credential of its own;
//! one without signs its preview through a system session and writes nothing. These follow
//! `packages/core/src/brokered.test.ts`.

use std::sync::{Arc, LazyLock, Mutex};

use async_trait::async_trait;
use graffiticode_l0000::{
    Compilation, Compiler, Identity, Mode, PolicyClient, PolicySnapshot, PreviewSession, ProtectedCall,
    ProtectedCallError, SnapshotRequest,
};
use graffiticode_l0176::L0176;
use serde_json::{Value as Json, json};

static PROGRAMS: LazyLock<Json> =
    LazyLock::new(|| serde_json::from_str(include_str!("conformance/programs.json")).unwrap());

const ITEM: &str = "item [questions [mcq []] {}]";

fn program(src: &str) -> &'static Json {
    PROGRAMS.get(src).unwrap_or_else(|| panic!("no parsed program for {src:?}"))
}

fn items() -> String {
    format!(r#"set-var "lrn-id" "t" items [{ITEM}] {{}}.."#)
}

fn save() -> String {
    format!(r#"set-var "lrn-id" "t" save-to-itembank items [{ITEM}] {{}}.."#)
}

type Reply = Arc<dyn Fn(&ProtectedCall) -> Result<Json, ProtectedCallError> + Send + Sync>;
type Allow = Arc<dyn Fn(&[String]) -> Option<Vec<String>> + Send + Sync>;
type Preview = Arc<dyn Fn() -> Result<PreviewSession, ProtectedCallError> + Send + Sync>;

/// Policy and the broker, scripted, remembering what they were asked.
#[derive(Clone)]
struct Fake {
    /// What a snapshot allows, given what was asked; `None` refuses it.
    allow: Allow,
    broker: Reply,
    preview: Preview,
    snapshots: Arc<Mutex<Vec<Json>>>,
    calls: Arc<Mutex<Vec<(String, ProtectedCall)>>>,
    previews: Arc<Mutex<Vec<String>>>,
}

impl Default for Fake {
    fn default() -> Self {
        Fake {
            allow: Arc::new(|asked| Some(asked.to_vec())),
            broker: Arc::new(|call| {
                Ok(if call.op == "learnosity.write-items" {
                    json!({ "status": "succeeded", "result": { "saved": true, "references": ["graffiticode-t-0"] } })
                } else {
                    json!({ "status": "succeeded", "result": { "request": format!("signed:{}", call.op) } })
                })
            }),
            preview: Arc::new(|| {
                Ok(PreviewSession { allowed: vec!["init".into()], session_token: Some("system-session".into()) })
            }),
            snapshots: Arc::default(),
            calls: Arc::default(),
            previews: Arc::default(),
        }
    }
}

impl Fake {
    fn ops(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(_, call)| call.op.clone()).collect()
    }

    fn sessions(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(session, _)| session.clone()).collect()
    }

    fn call(&self, n: usize) -> ProtectedCall {
        self.calls.lock().unwrap()[n].1.clone()
    }

    fn writes(outcomes: Vec<Result<Json, ProtectedCallError>>) -> Reply {
        let outcomes = Mutex::new(outcomes);
        Arc::new(move |call| {
            if call.op == "learnosity.write-items" {
                outcomes.lock().unwrap().remove(0)
            } else {
                Ok(json!({ "status": "succeeded", "result": { "request": "r" } }))
            }
        })
    }
}

#[async_trait]
impl PolicyClient for Fake {
    async fn snapshot(&self, request: SnapshotRequest<'_>) -> Result<PolicySnapshot, ProtectedCallError> {
        self.snapshots.lock().unwrap().push(json!({
            "fns": request.functions, "lang": request.lang_id, "connection": request.exec.connection_id(),
        }));
        match (self.allow)(request.functions) {
            Some(allowed) => Ok(PolicySnapshot { allowed, session_token: Some("session-1".into()), bind: None }),
            None => Err(ProtectedCallError::Unavailable("403".into())),
        }
    }

    async fn invoke(&self, session_token: &str, call: &ProtectedCall) -> Result<Json, ProtectedCallError> {
        self.calls.lock().unwrap().push((session_token.to_owned(), call.clone()));
        (self.broker)(call)
    }

    async fn preview_session(&self, lang_id: &str) -> Result<PreviewSession, ProtectedCallError> {
        self.previews.lock().unwrap().push(lang_id.to_owned());
        (self.preview)()
    }
}

fn connection() -> Identity {
    Identity {
        uid: Some("u1".into()),
        connection_id: Some("conn-1".into()),
        user_token: Some("user".into()),
        invocation_token: Some("inv".into()),
        stage: Some("s0".into()),
        admission_token: None,
        ..Identity::default()
    }
}

async fn compile_with(fake: &Fake, code: &Json, identity: Identity, data: Json) -> Compilation {
    Compiler::new(L0176::new()).with_policy(fake.clone()).compile(code, &data, &json!({}), identity).await
}

async fn compile(fake: &Fake, src: &str, identity: Identity) -> Compilation {
    compile_with(fake, program(src), identity, json!({})).await
}

fn value(compiled: Compilation) -> Json {
    match compiled.result {
        Ok(value) => value.to_json().unwrap_or(Json::Null),
        Err(errors) => panic!("errors: {errors:?}"),
    }
}

fn errors(compiled: &Compilation) -> Vec<Json> {
    match &compiled.result {
        Err(errors) => errors.iter().map(|error| serde_json::to_value(error).unwrap()).collect(),
        Ok(_) => Vec::new(),
    }
}

fn refused(reason: &str, category: Option<&str>) -> ProtectedCallError {
    ProtectedCallError::Rejected {
        path: "/v1/execute".into(),
        status: 403,
        reason: Some(reason.into()),
        category: category.map(str::to_owned),
        effect_unknown: false,
    }
}

mod without_a_connection {
    use super::*;

    /// No connection, from the api: the server verified its `X-Caller-Identity` as a gateway's
    /// (or runs with `SYSTEM_PREVIEW_DIRECT=1`), so it may sign on the system path.
    fn gateway() -> Identity {
        Identity { system_session_permitted: true, ..Identity::default() }
    }

    /// C6 part 2, decision 1: only the head's `present` signs. In `evaluate`, data for the next
    /// stage, the activity comes back unsigned (an incoming `request` dropped, no `signing`)
    /// and nothing asks policy or Broker; in `present` it is signed exactly as a compile is.
    #[tokio::test]
    async fn only_present_signs_and_evaluate_never_asks_policy() {
        let stale = json!({
            "type": "questions",
            "data": { "questions": [{ "type": "mcq", "response_id": "r1" }] },
            "request": "signed-elsewhere",
        });
        let lrn_init = r#"set-var "lrn-id" "t" init questions [mcq []] {}.."#;
        for (src, input) in
            [(items(), json!({})), (lrn_init.to_owned(), json!({})), ("init data {}..".to_owned(), stale)]
        {
            let fake = Fake::default();
            let compiler = Compiler::new(L0176::new()).with_policy(fake.clone());
            let model = compiler.model(program(&src), &json!({})).await.unwrap();
            let evaluated = value(compiler.interpret(&model, &input, &json!({}), Mode::Evaluate, gateway()).await);
            assert_eq!((evaluated.get("request"), evaluated.get("signing")), (None, None), "{src}");
            assert_eq!(evaluated["type"], "questions", "{src}");
            assert!(fake.calls.lock().unwrap().is_empty() && fake.previews.lock().unwrap().is_empty(), "{src}");
            let presented = value(compiler.interpret(&model, &input, &json!({}), Mode::Present, gateway()).await);
            let compiled = value(compile_with(&fake, program(&src), gateway(), input.clone()).await);
            assert_eq!(presented, compiled, "{src}");
            assert_eq!(*fake.previews.lock().unwrap(), ["0176", "0176"], "{src}");
            // Without the signature, the presented activity is the evaluated one.
            if let Json::Object(mut presented) = presented {
                presented.remove("request");
                assert_eq!(Json::Object(presented), evaluated, "{src}");
            }
        }
        // With a connection, too: nothing is signed or written in `evaluate`.
        let fake = Fake::default();
        let compiler = Compiler::new(L0176::new()).with_policy(fake.clone());
        let model = compiler.model(program(&items()), &json!({})).await.unwrap();
        let evaluated = value(compiler.interpret(&model, &json!({}), &json!({}), Mode::Evaluate, connection()).await);
        assert_eq!((evaluated.get("request"), evaluated.get("signing")), (None, None));
        assert!(fake.calls.lock().unwrap().is_empty() && fake.previews.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_direct_caller_s_preview_is_unsigned_gateway_only_and_policy_is_never_asked() {
        let fake = Fake::default();
        for src in [items(), r#"set-var "lrn-id" "t" init questions [mcq []] {}.."#.to_owned()] {
            let out = value(compile(&fake, &src, Identity::default()).await);
            assert_eq!(out.get("request"), None);
            assert_eq!(
                out["signing"],
                json!({
                    "unsigned": "gateway-only",
                    "message": "Preview not signed: a preview without a connection is signed only through the Graffiticode api. Select a Learnosity connection to sign it.",
                })
            );
        }
        assert!(fake.previews.lock().unwrap().is_empty(), "policy is never asked");
        assert!(fake.ops().is_empty());
    }

    #[tokio::test]
    async fn the_signing_limits_come_back_busy_under_their_own_reason() {
        const BUSY: &str = "Previews are busy right now; try again in a moment.";
        // Policy's mint bucket, for the session.
        let limited = Fake {
            preview: Arc::new(|| {
                Err(ProtectedCallError::Rejected {
                    path: "/v1/preview-session".into(),
                    status: 429,
                    reason: Some("rate-limited".into()),
                    category: None,
                    effect_unknown: false,
                })
            }),
            ..Fake::default()
        };
        let out = value(compile(&limited, &items(), gateway()).await);
        assert_eq!(out["signing"], json!({ "unsigned": "rate-limited", "message": BUSY }));
        // Broker's per-session allowance, at execute.
        let exhausted = Fake {
            broker: Arc::new(|_| {
                Ok(json!({ "status": "failed", "reason": "session-exhausted", "error": "session allowance spent" }))
            }),
            ..Fake::default()
        };
        let out = value(compile(&exhausted, &items(), gateway()).await);
        assert_eq!(out["signing"], json!({ "unsigned": "session-exhausted", "message": BUSY }));
        // A refusal that isn't a limit keeps its fallback, with the reason.
        let other = Fake { broker: Arc::new(|_| Err(refused("token-expired", None))), ..Fake::default() };
        let out = value(compile(&other, &items(), gateway()).await);
        assert_eq!(out["signing"]["unsigned"], "signing-failed");
        assert!(out["signing"]["message"].as_str().unwrap().ends_with("(token-expired)"));
    }

    #[tokio::test]
    async fn an_activity_arriving_signed_is_signed_afresh() {
        let fake = Fake::default();
        let stale = json!({
            "type": "questions",
            "data": { "questions": [{ "type": "mcq", "response_id": "r1" }] },
            "request": "signed-elsewhere",
            "signing": { "unsigned": "unavailable" },
        });
        let signed = value(compile_with(&fake, program("data {}.."), gateway(), stale.clone()).await);
        assert_eq!(signed["request"], "signed:learnosity.sign-questions-preview");
        assert_eq!(signed.get("signing"), None);
        let request = value(compile_with(&fake, program("init data {}.."), gateway(), stale).await);
        assert_eq!(request, "signed:learnosity.sign-questions-preview");
        let sent = format!("{:?}", fake.calls.lock().unwrap());
        assert!(!sent.contains("signed-elsewhere"), "{sent}");
    }

    #[tokio::test]
    async fn a_preview_is_signed_by_the_broker_under_a_system_session() {
        let fake = Fake::default();
        let out = value(compile(&fake, &items(), gateway()).await);
        assert!(fake.snapshots.lock().unwrap().is_empty());
        assert_eq!(*fake.previews.lock().unwrap(), ["0176"]);
        let call = fake.call(0);
        assert_eq!((call.function.as_str(), call.op.as_str()), ("init", "learnosity.sign-questions-preview"));
        assert_eq!(call.occurrence_id, "prog.0");
        let mut fields: Vec<&String> = call.payload.as_object().unwrap().keys().collect();
        fields.sort();
        // No `session_id`: Broker sets the signed request's own (C6 part 2, decision 3).
        assert_eq!(fields, ["id", "name", "questions"]);
        assert_eq!(fake.sessions(), ["system-session"]);
        assert_eq!(out["request"], "signed:learnosity.sign-questions-preview");
        assert_eq!(out.get("signing"), None);
    }

    #[tokio::test]
    async fn init_signs_through_the_system_session_too() {
        let fake = Fake::default();
        let out = value(compile(&fake, r#"set-var "lrn-id" "t" init questions [mcq []] {}.."#, gateway()).await);
        assert_eq!(fake.ops(), ["learnosity.sign-questions-preview"]);
        let occurrence = fake.call(0).occurrence_id;
        assert!(occurrence.starts_with("INIT:") && occurrence.ends_with(".0"), "{occurrence}");
        assert_eq!(out, "signed:learnosity.sign-questions-preview");
    }

    #[tokio::test]
    async fn program_and_config_credentials_are_ignored() {
        let fake = Fake::default();
        let src = format!(
            r#"set-var "lrn-id" "t" set-var "learnosity-key" "own-key" set-var "learnosity-secret" "own-secret-0123456789" items [{ITEM}] {{}}.."#
        );
        let out = value(compile(&fake, &src, gateway()).await);
        assert_eq!(fake.sessions(), ["system-session"]);
        assert_eq!(out["request"], "signed:learnosity.sign-questions-preview");
        let config = json!({ "learnosity": { "key": "cfg-key", "secret": "cfg-secret-0123456789" } });
        let compiled = Compiler::new(L0176::new())
            .with_policy(fake.clone())
            .compile(program(&items()), &json!({}), &config, gateway())
            .await;
        let out = value(compiled);
        let sent = format!("{:?} {out}", fake.calls.lock().unwrap());
        assert!(!sent.contains("own-") && !sent.contains("cfg-"), "{sent}");
    }

    #[tokio::test]
    async fn without_a_session_the_preview_compiles_unsigned_with_a_message() {
        let unavailable = |reason: &'static str| -> Result<PreviewSession, ProtectedCallError> {
            Err(ProtectedCallError::Rejected {
                path: "/v1/preview-session".into(),
                status: 403,
                reason: Some(reason.into()),
                category: None,
                effect_unknown: false,
            })
        };
        let cases: Vec<(Preview, &str)> = vec![
            (Arc::new(move || unavailable("no-system-connection")), "(no-system-connection)"),
            (
                Arc::new(|| {
                    Err(ProtectedCallError::Unreachable { path: "/v1/preview-session".into(), effect_unknown: false })
                }),
                "no system preview session",
            ),
            (
                Arc::new(|| Ok(PreviewSession { allowed: vec![], session_token: Some("s".into()) })),
                "(no-preview-permission)",
            ),
            (
                Arc::new(|| Ok(PreviewSession { allowed: vec!["init".into()], session_token: None })),
                "(no-preview-permission)",
            ),
        ];
        for (preview, said) in cases {
            let fake = Fake { preview, ..Fake::default() };
            let out = value(compile(&fake, &items(), gateway()).await);
            assert_eq!(out["type"], "questions");
            assert_eq!(out.get("request"), None);
            assert_eq!(out["signing"]["unsigned"], "unavailable");
            let message = out["signing"]["message"].as_str().unwrap();
            assert!(message.starts_with("Preview not signed") && message.contains(said), "{message}");
            assert!(fake.ops().is_empty());
        }
    }

    #[tokio::test]
    async fn a_failed_system_signing_is_unsigned_not_an_error() {
        let fake = Fake {
            broker: Arc::new(|_| Ok(json!({ "status": "failed", "error": "provider down" }))),
            ..Fake::default()
        };
        let out = value(compile(&fake, &items(), gateway()).await);
        assert_eq!(out.get("request"), None);
        assert_eq!(out["signing"]["unsigned"], "signing-failed");
    }

    #[tokio::test]
    async fn a_system_session_never_writes_even_one_that_claims_it_may() {
        for allowed in [vec!["init".to_owned()], vec!["init".to_owned(), "save-to-itembank".to_owned()]] {
            let fake = Fake {
                preview: Arc::new(move || {
                    Ok(PreviewSession { allowed: allowed.clone(), session_token: Some("wide".into()) })
                }),
                ..Fake::default()
            };
            let out = value(compile(&fake, &save(), gateway()).await);
            assert_eq!(out["data"]["itemBank"]["skipped"], "no-connection");
            assert_eq!(fake.ops(), ["learnosity.sign-questions-preview"]);
        }
    }

    #[tokio::test]
    async fn without_a_policy_client_the_preview_is_unsigned_and_a_connection_is_refused() {
        let unsigned =
            Compiler::new(L0176::new()).compile(program(&items()), &json!({}), &json!({}), Identity::default()).await;
        assert_eq!(value(unsigned)["signing"]["unsigned"], "not-configured");
        // TypeScript says "connections are not available on this server"; the kernel's
        // admission refuses the same compile in its own words.
        let refused =
            Compiler::new(L0176::new()).compile(program(&items()), &json!({}), &json!({}), connection()).await;
        assert_eq!(errors(&refused)[0]["message"], "init is not permitted through the selected connection.");
    }
}

/// `init` signs only a `{ type, data }` activity Broker would accept; anything else is a compile
/// error on both paths, never signed (brokered.test.ts).
#[tokio::test]
async fn init_refuses_what_isn_t_an_activity_on_both_paths() {
    const NOT_AN_ACTIVITY: &str = "Error: init signs a Learnosity activity, `{ type: \"questions\" | \"items\", data: { questions, ... } }`; it was given ";
    let legacy_question = "Error: init: questions[0] needs a type and response_id. A legacy `{ type, reference, data }` question record is not accepted; recompile the program that made it.";
    let legacy = json!({
        "type": "questions",
        "data": { "id": "act-1", "name": "legacy", "session_id": "s",
            "questions": [{ "type": "mcq", "reference": "artcompiler-mcq-x-0", "data": { "type": "mcq", "stimulus": "?" } }] },
    });
    let bare =
        json!({ "consumer_key": "K", "signature": "$02$abc", "questions": [{ "response_id": "r-0", "type": "mcq" }] });
    let cases = [
        (legacy.clone(), legacy_question.to_owned()),
        (bare, format!("{NOT_AN_ACTIVITY}a record with no type (a bare signed request is not an activity).")),
        (
            json!({ "type": "items", "data": { "questions": [{ "reference": "q" }] }, "request": { "security": {} } }),
            legacy_question.to_owned(),
        ),
        // `data {}` reads a list as a record, in TypeScript too.
        (
            json!([legacy]),
            format!("{NOT_AN_ACTIVITY}a record with no type (a bare signed request is not an activity)."),
        ),
        (json!({}), format!("{NOT_AN_ACTIVITY}a record with no type (a bare signed request is not an activity).")),
        (json!({ "type": "other", "data": {} }), format!("{NOT_AN_ACTIVITY}a \"other\" record.")),
        (json!({ "type": "items" }), format!("{NOT_AN_ACTIVITY}a \"items\" record.")),
        (
            json!({ "type": "questions", "data": { "questions": "q" } }),
            "Error: init: the activity's data.questions must be a list.".to_owned(),
        ),
        (
            json!({ "type": "questions", "data": { "questions": [{ "type": "mcq", "response_id": "r 0/../x" }] } }),
            legacy_question.to_owned(),
        ),
        (
            json!({ "type": "questions", "data": { "questions": [{ "type": "mcq", "response_id": "r-0" }, "mcq"] } }),
            legacy_question.replace("questions[0]", "questions[1]"),
        ),
    ];
    let permitted = Identity { system_session_permitted: true, ..Identity::default() };
    for (data, message) in cases {
        for identity in [permitted.clone(), connection()] {
            let fake = Fake::default();
            let compiled = compile_with(&fake, program("init data {}.."), identity, data.clone()).await;
            let errors = errors(&compiled);
            assert_eq!(errors.len(), 1, "{data}: {errors:?}");
            assert_eq!(errors[0]["message"], message, "{data}");
            assert!(fake.ops().is_empty(), "{data}: nothing is signed");
        }
    }
}

/// Registry v7 (AUTHOR-01): L0176 has no `author`. An Author activity arriving as data is
/// refused on every path, and nothing is signed.
#[tokio::test]
async fn an_author_activity_arriving_as_data_is_refused_unsigned() {
    let author = json!({ "type": "author", "data": { "mode": "item_edit", "reference": "r" } });
    for (src, identity) in [
        ("data {}..", Identity::default()),
        ("init data {}..", Identity::default()),
        ("data {}..", connection()),
        ("init data {}..", connection()),
    ] {
        let fake = Fake::default();
        let compiled = compile_with(&fake, program(src), identity, author.clone()).await;
        let errors = errors(&compiled);
        assert_eq!(errors.len(), 1, "{src}");
        let message = errors[0]["message"].as_str().unwrap();
        assert!(message.contains("doesn't open the Learnosity Author Site") && message.contains("L0177"), "{message}");
        assert!(fake.ops().is_empty());
    }
}

mod with_a_connection {
    use super::*;

    #[tokio::test]
    async fn a_render_is_signed_by_the_broker_with_only_preview_fields_sent() {
        let fake = Fake::default();
        let out = value(compile(&fake, &items(), connection()).await);
        assert_eq!(
            *fake.snapshots.lock().unwrap(),
            [json!({ "fns": ["init"], "lang": "0176", "connection": "conn-1" })]
        );
        assert!(fake.previews.lock().unwrap().is_empty(), "a connection compile never asks for a system session");
        assert_eq!(fake.sessions(), ["session-1"]);
        let mut fields: Vec<String> = fake.call(0).payload.as_object().unwrap().keys().cloned().collect();
        fields.sort();
        // No `session_id`: Broker sets the signed request's own (C6 part 2, decision 3).
        assert_eq!(fields, ["id", "name", "questions"]);
        assert_eq!(out["request"], "signed:learnosity.sign-questions-preview");
    }

    #[tokio::test]
    async fn a_save_writes_through_the_broker() {
        let fake = Fake::default();
        let out = value(compile(&fake, &save(), connection()).await);
        assert_eq!(fake.ops(), ["learnosity.write-items", "learnosity.sign-questions-preview"]);
        let write = fake.call(0);
        assert_eq!(write.function, "save-to-itembank");
        assert_eq!(write.payload["itemRecords"][0]["reference"], "graffiticode-t-0");
        assert_eq!(write.payload["itemRecords"][0]["status"], "unpublished");
        assert!(write.occurrence_id.starts_with("SAVE_TO_ITEMBANK:") && write.occurrence_id.ends_with(".0"));
        assert_eq!(out["data"]["itemBank"]["saved"], true);
    }

    /// The API's read path sends this fixed program (the unsigned activity as a JSON literal),
    /// never the source. Keep the two in step.
    #[tokio::test]
    async fn a_stored_result_is_signed_on_read_by_a_data_only_program() {
        let built = value(compile(&Fake::default(), &save(), Identity::default()).await);
        let mut activity = built.as_object().unwrap().clone();
        activity.remove("request");
        let read = json!({
            "1": { "tag": "STR", "elts": [Json::Object(activity).to_string()] },
            "2": { "tag": "JSON", "elts": [1] },
            "3": { "tag": "EXPRS", "elts": [2] },
            "4": { "tag": "PROG", "elts": [3] },
            "root": 4,
        });
        let fake = Fake::default();
        let out = value(compile_with(&fake, &read, connection(), json!({})).await);
        assert_eq!(
            *fake.snapshots.lock().unwrap(),
            [json!({ "fns": ["init"], "lang": "0176", "connection": "conn-1" })]
        );
        assert_eq!(fake.ops(), ["learnosity.sign-questions-preview"]);
        assert_eq!(out["request"], "signed:learnosity.sign-questions-preview");
        assert_eq!(out["data"]["itemBank"]["skipped"], "no-connection");
    }

    /// The save plan is the build's, never program data: an activity arriving as data, even
    /// one built by an earlier compile, is not saved.
    #[tokio::test]
    async fn a_save_needs_an_activity_this_compile_built() {
        let built = value(compile(&Fake::default(), &items(), Identity::default()).await);
        let fake = Fake::default();
        let compiled = compile_with(&fake, program("save-to-itembank data {}.."), connection(), built).await;
        let message = errors(&compiled)[0]["message"].clone();
        assert_eq!(
            message,
            "Error: save-to-itembank must wrap an activity built by `items [...] {}` or `questions [...] {}`."
        );
        assert!(fake.ops().is_empty());
    }

    /// Policy refuses an occurrence id outside `[A-Za-z0-9_:.-]{1,200}`.
    #[tokio::test]
    async fn every_occurrence_id_is_one_policy_accepts() {
        let fake = Fake::default();
        let compiled = compile(
            &fake,
            &format!(r#"set-var "lrn-id" "t" init save-to-itembank items [{ITEM}] {{}}.."#),
            connection(),
        )
        .await;
        assert!(compiled.result.is_ok());
        let calls = fake.calls.lock().unwrap();
        assert!(calls.len() > 1);
        for (_, call) in calls.iter() {
            let id = &call.occurrence_id;
            assert!(id.len() <= 200 && id.chars().all(|c| c.is_ascii_alphanumeric() || "_:.-".contains(c)), "{id}");
        }
    }

    #[tokio::test]
    async fn the_legacy_member_form_saves_the_same_way() {
        let fake = Fake::default();
        let compiled = compile(
            &fake,
            &format!(r#"set-var "lrn-id" "t" items [save-to-itembank true, {ITEM}] {{}}.."#),
            connection(),
        )
        .await;
        assert!(compiled.result.is_ok());
        assert_eq!(fake.ops()[0], "learnosity.write-items");
    }

    #[tokio::test]
    async fn what_policy_does_not_grant_is_refused_before_anything_runs() {
        let fake = Fake { allow: Arc::new(|_| Some(vec!["init".into()])), ..Fake::default() };
        let compiled = compile(&fake, &save(), connection()).await;
        assert!(errors(&compiled)[0]["message"].as_str().unwrap().contains("save-to-itembank is not permitted"));
        assert!(fake.ops().is_empty());

        let fake = Fake { allow: Arc::new(|_| Some(vec![])), ..Fake::default() };
        let compiled = compile(&fake, &items(), connection()).await;
        assert!(errors(&compiled)[0]["message"].as_str().unwrap().contains("init is not permitted"));
        assert!(fake.ops().is_empty());

        let fake = Fake { allow: Arc::new(|_| None), ..Fake::default() };
        let compiled = compile(&fake, &items(), connection()).await;
        assert!(errors(&compiled)[0]["message"].as_str().unwrap().contains("Permission check is unavailable"));
        assert!(fake.ops().is_empty());
    }
}

/// A failed protected call is a structured compile error, its message unchanged, and every
/// save's effect reaches the caller.
mod structured_failures_and_effects {
    use super::*;

    fn effects(compiled: &Compilation) -> Json {
        serde_json::to_value(&compiled.effects).unwrap()
    }

    #[tokio::test]
    async fn a_partial_save_names_its_code_category_stage_function_and_failed_step() {
        let fake = Fake {
            broker: Fake::writes(vec![Ok(json!({
                "status": "partial", "steps": ["questions"], "failedStep": "items",
                "reason": "authorization-denied:not-granted", "category": "permission", "error": "items write failed",
            }))]),
            ..Fake::default()
        };
        let compiled = compile(&fake, &save(), connection()).await;
        assert_eq!(
            errors(&compiled),
            [json!({
                "message": "Error: Item bank save partial: items write failed", "from": -1, "to": -1,
                "code": "authorization-denied:not-granted", "category": "permission", "stage": "s0",
                "fn": "save-to-itembank", "step": "items",
            })]
        );
        assert_eq!(
            effects(&compiled),
            json!([{
                "fn": "save-to-itembank", "op": "learnosity.write-items", "status": "partial", "steps": ["questions"],
                "failedStep": "items", "reason": "authorization-denied:not-granted", "category": "permission",
            }])
        );
        assert_eq!(fake.ops().iter().filter(|op| *op == "learnosity.write-items").count(), 1, "never a silent retry");
    }

    #[tokio::test]
    async fn an_earlier_save_is_still_reported_when_a_later_one_fails() {
        let fake = Fake {
            broker: Fake::writes(vec![
                Ok(json!({ "status": "succeeded", "steps": ["questions", "items"], "result": { "saved": true } })),
                Ok(json!({
                    "status": "failed", "steps": [], "failedStep": "questions",
                    "reason": "authorization-denied:not-granted", "category": "permission", "error": "denied",
                })),
            ]),
            ..Fake::default()
        };
        let src = format!(
            r#"set-var "lrn-id" "t" [save-to-itembank items [{ITEM}] {{}} save-to-itembank items [{ITEM}] {{}}].."#
        );
        let compiled = compile(&fake, &src, connection()).await;
        let messages: Vec<Json> = errors(&compiled).into_iter().map(|error| error["message"].clone()).collect();
        assert_eq!(messages, [json!("Error: Item bank save failed: denied")]);
        let statuses: Vec<(Json, Json)> =
            effects(&compiled).as_array().unwrap().iter().map(|e| (e["status"].clone(), e["steps"].clone())).collect();
        assert_eq!(statuses, [(json!("succeeded"), json!(["questions", "items"])), (json!("failed"), json!([]))]);
    }

    #[tokio::test]
    async fn an_uncertain_save_keeps_its_guidance() {
        let fake = Fake {
            broker: Fake::writes(vec![Ok(
                json!({ "status": "uncertain", "steps": [], "failedStep": "questions", "error": "no response" }),
            )]),
            ..Fake::default()
        };
        let compiled = compile(&fake, &save(), connection()).await;
        let error = &errors(&compiled)[0];
        assert_eq!(
            (&error["fn"], &error["step"], &error["stage"]),
            (&json!("save-to-itembank"), &json!("questions"), &json!("s0"))
        );
        let message = error["message"].as_str().unwrap();
        assert!(
            message.starts_with("Error: Item bank save uncertain: no response — it may or may not have been written")
        );
        assert!(message.contains("new idempotency key"));
        assert_eq!(
            effects(&compiled),
            json!([{ "fn": "save-to-itembank", "op": "learnosity.write-items", "status": "uncertain", "steps": [], "failedStep": "questions" }])
        );
    }

    #[tokio::test]
    async fn a_lost_broker_answer_is_an_uncertain_save_said_the_same_way() {
        let fake = Fake {
            broker: Fake::writes(vec![Err(ProtectedCallError::Unreachable {
                path: "/v1/execute".into(),
                effect_unknown: true,
            })]),
            ..Fake::default()
        };
        let compiled = compile(&fake, &save(), connection()).await;
        let error = &errors(&compiled)[0];
        assert_eq!((&error["fn"], &error["stage"]), (&json!("save-to-itembank"), &json!("s0")));
        assert!(error["message"].as_str().unwrap().starts_with(
            "Error: Item bank save uncertain: /v1/execute unreachable — it may or may not have been written"
        ));
        assert_eq!(
            effects(&compiled),
            json!([{ "fn": "save-to-itembank", "op": "learnosity.write-items", "status": "uncertain", "steps": [] }])
        );
    }

    #[tokio::test]
    async fn a_refusal_carries_the_reason_and_category() {
        let fake = Fake {
            broker: Fake::writes(vec![Err(refused("authorization-denied:not-granted", Some("permission")))]),
            ..Fake::default()
        };
        let compiled = compile(&fake, &save(), connection()).await;
        assert_eq!(
            errors(&compiled),
            [json!({
                "message": "Error: /v1/execute failed (403)", "from": -1, "to": -1,
                "code": "authorization-denied:not-granted", "category": "permission", "stage": "s0", "fn": "save-to-itembank",
            })]
        );
        assert_eq!(
            effects(&compiled),
            json!([{
                "fn": "save-to-itembank", "op": "learnosity.write-items", "status": "failed", "steps": [],
                "reason": "authorization-denied:not-granted", "category": "permission",
            }])
        );
    }

    #[tokio::test]
    async fn a_refused_signing_is_structured_and_is_not_an_effect() {
        let fake = Fake { broker: Arc::new(|_| Err(refused("maintenance", Some("unavailable")))), ..Fake::default() };
        let compiled = compile(&fake, &items(), connection()).await;
        let error = &errors(&compiled)[0];
        assert_eq!(
            (&error["code"], &error["category"], &error["fn"], &error["stage"]),
            (&json!("maintenance"), &json!("unavailable"), &json!("init"), &json!("s0"))
        );
        assert_eq!(effects(&compiled), json!([]));
    }

    #[tokio::test]
    async fn bodies_without_category_or_failed_step_give_the_same_messages() {
        let fake = Fake {
            broker: Fake::writes(vec![Ok(
                json!({ "status": "partial", "steps": ["questions"], "error": "items write failed" }),
            )]),
            ..Fake::default()
        };
        let compiled = compile(&fake, &save(), connection()).await;
        assert_eq!(
            errors(&compiled),
            [
                json!({ "message": "Error: Item bank save partial: items write failed", "from": -1, "to": -1, "stage": "s0", "fn": "save-to-itembank" })
            ]
        );
        assert_eq!(
            effects(&compiled),
            json!([{ "fn": "save-to-itembank", "op": "learnosity.write-items", "status": "partial", "steps": ["questions"] }])
        );
    }

    #[tokio::test]
    async fn a_compile_with_no_save_reports_no_effects() {
        let compiled = compile(&Fake::default(), &items(), connection()).await;
        assert!(compiled.result.is_ok());
        assert!(compiled.effects.is_empty());
    }
}

/// C6 part 2: `evaluate` acts on nothing. A program that saves, with a connection Policy would
/// grant, or with a system session the server permits, neither writes, signs nor asks Policy
/// for anything in `evaluate`; the save is reported skipped. The same program in `present` with
/// the connection does write, so the fake would have seen it.
#[tokio::test]
async fn evaluate_never_writes_signs_or_asks_policy() {
    let saves = [
        r#"set-var "lrn-id" "t" save-to-itembank items [item [questions [mcq []] {}]] {}.."#,
        r#"set-var "lrn-id" "t" init save-to-itembank items [item [questions [mcq []] {}]] {}.."#,
        r#"set-var "lrn-id" "t" items [save-to-itembank true, item [questions [mcq []] {}]] {}.."#,
        r#"set-var "lrn-id" "t" [save-to-itembank items [item [questions [mcq []] {}]] {} save-to-itembank items [item [questions [mcq []] {}]] {}].."#,
        r#"set-var "lrn-id" "t" map (<x: save-to-itembank items [item [questions [mcq []] {}]] {}>) [1 2 3].."#,
    ];
    let system = Identity { system_session_permitted: true, ..Identity::default() };
    for src in saves {
        for identity in [connection(), system.clone()] {
            let fake = Fake::default();
            let compiler = Compiler::new(L0176::new()).with_policy(fake.clone());
            let model = compiler.model(program(src), &json!({})).await.unwrap();
            let evaluated = compiler.interpret(&model, &json!({}), &json!({}), Mode::Evaluate, identity.clone()).await;
            let envelope = compiler.envelope(&evaluated);
            assert!(fake.ops().is_empty(), "{src}: evaluate performed {:?}", fake.ops());
            assert!(fake.snapshots.lock().unwrap().is_empty(), "{src}: evaluate asked Policy for a snapshot");
            assert!(fake.previews.lock().unwrap().is_empty(), "{src}: evaluate asked for a system session");
            assert_eq!(envelope.get("cache"), None, "{src}");
            assert!(envelope.get("effects").is_none(), "{src}: {envelope}");
            let text = envelope.to_string();
            assert!(!text.contains("\"request\"") && !text.contains("\"signing\""), "{src}: {text}");
            if src.starts_with(r#"set-var "lrn-id" "t" save-to-itembank"#) {
                assert_eq!(envelope["data"]["data"]["itemBank"]["skipped"], "evaluate", "{src}: {envelope}");
            }
        }
    }
    // The fake would have seen a write: the same save in `present`, with the connection.
    let fake = Fake::default();
    let compiler = Compiler::new(L0176::new()).with_policy(fake.clone());
    let model = compiler.model(program(saves[0]), &json!({})).await.unwrap();
    compiler.interpret(&model, &json!({}), &json!({}), Mode::Present, connection()).await;
    assert!(fake.ops().iter().any(|op| op == "learnosity.write-items"), "{:?}", fake.ops());
    assert_eq!(fake.snapshots.lock().unwrap().len(), 1);
}

/// `{type: "questions" data: {session_id: "old-session" questions: [mcq-ish]}}`, as the parser
/// writes a record literal, under `init` when `init` is given.
fn literal_with_session(init: bool) -> Json {
    let mut ast = json!({
        "1": { "tag": "TAG", "elts": ["type"] }, "2": { "tag": "STR", "elts": ["questions"] },
        "5": { "tag": "TAG", "elts": ["data"] },
        "6": { "tag": "TAG", "elts": ["questions"] }, "7": { "tag": "LIST", "elts": [] },
        "8": { "tag": "TAG", "elts": ["session_id"] }, "9": { "tag": "STR", "elts": ["old-session"] },
        "16": { "tag": "BINDING", "elts": [8, 9] },
        "17": { "tag": "BINDING", "elts": [6, 7] }, "18": { "tag": "RECORD", "elts": [16, 17] },
        "19": { "tag": "BINDING", "elts": [5, 18] }, "20": { "tag": "BINDING", "elts": [1, 2] },
        "21": { "tag": "RECORD", "elts": [20, 19] },
        "22": { "tag": "EXPRS", "elts": [21] }, "23": { "tag": "PROG", "elts": [22] }, "root": 23,
    });
    if init {
        ast["24"] = json!({ "tag": "INIT", "elts": [21] });
        ast["22"] = json!({ "tag": "EXPRS", "elts": [24] });
    }
    ast
}

/// C6 part 2, decision 3: no activity carries a `session_id`, whatever it arrived with: a legacy
/// activity as upstream data, or a record literal, bare or under `init`, in either mode. Broker
/// is never sent one either; it sets the signed request's own.
#[tokio::test]
async fn an_incoming_session_id_is_dropped_in_every_mode() {
    let legacy = json!({
        "type": "questions",
        "data": { "id": "explicit", "session_id": "old-session", "questions": [{ "type": "mcq", "response_id": "r1" }] },
        "request": "signed-elsewhere",
    });
    let system = Identity { system_session_permitted: true, ..Identity::default() };
    let programs = [
        (program("init data {}..").clone(), legacy.clone()),
        (program("data {}..").clone(), legacy),
        (literal_with_session(false), json!({})),
        (literal_with_session(true), json!({})),
    ];
    for (code, input) in programs {
        for mode in [Mode::Evaluate, Mode::Present] {
            let fake = Fake::default();
            let compiler = Compiler::new(L0176::new()).with_policy(fake.clone());
            let model = compiler.model(&code, &json!({})).await.unwrap();
            let out = value(compiler.interpret(&model, &input, &json!({}), mode, system.clone()).await);
            assert!(!out.to_string().contains("old-session"), "{mode:?} {code}: {out}");
            for (_, call) in fake.calls.lock().unwrap().iter() {
                assert!(call.payload.get("session_id").is_none(), "{mode:?}: sent {}", call.payload);
            }
            if mode == Mode::Evaluate {
                assert_eq!(out["data"].get("session_id"), None, "{code}");
                assert!(fake.calls.lock().unwrap().is_empty());
            } else {
                assert!(!fake.calls.lock().unwrap().is_empty(), "present signs: {code}");
            }
        }
        // `/compile` is `present`: the same.
        let fake = Fake::default();
        let out = value(compile_with(&fake, &code, system.clone(), input.clone()).await);
        assert!(!out.to_string().contains("old-session"), "/compile {code}: {out}");
    }
}
