// SPDX-License-Identifier: MIT

//! The brokered path, against a fake policy and broker at the client boundary: a compile that
//! selects a connection signs and saves through them and never with a credential of its own;
//! one without signs its preview through a system session and writes nothing. These follow
//! `packages/core/src/brokered.test.ts`.

use std::sync::{Arc, LazyLock, Mutex};

use async_trait::async_trait;
use graffiticode_l0000::{
    Compilation, Compiler, Identity, PolicyClient, PolicySnapshot, PreviewSession, ProtectedCall, ProtectedCallError,
    SnapshotRequest,
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

    #[tokio::test]
    async fn a_preview_is_signed_by_the_broker_under_a_system_session() {
        let fake = Fake::default();
        let out = value(compile(&fake, &items(), Identity::default()).await);
        assert!(fake.snapshots.lock().unwrap().is_empty());
        assert_eq!(*fake.previews.lock().unwrap(), ["0176"]);
        let call = fake.call(0);
        assert_eq!((call.function.as_str(), call.op.as_str()), ("init", "learnosity.sign-questions-preview"));
        assert_eq!(call.occurrence_id, "prog.0");
        let mut fields: Vec<&String> = call.payload.as_object().unwrap().keys().collect();
        fields.sort();
        assert_eq!(fields, ["id", "name", "questions", "session_id"]);
        assert_eq!(fake.sessions(), ["system-session"]);
        assert_eq!(out["request"], "signed:learnosity.sign-questions-preview");
        assert_eq!(out.get("signing"), None);
    }

    #[tokio::test]
    async fn init_signs_through_the_system_session_too() {
        let fake = Fake::default();
        let out =
            value(compile(&fake, r#"set-var "lrn-id" "t" init questions [mcq []] {}.."#, Identity::default()).await);
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
        let out = value(compile(&fake, &src, Identity::default()).await);
        assert_eq!(fake.sessions(), ["system-session"]);
        assert_eq!(out["request"], "signed:learnosity.sign-questions-preview");
        let config = json!({ "learnosity": { "key": "cfg-key", "secret": "cfg-secret-0123456789" } });
        let compiled = Compiler::new(L0176::new())
            .with_policy(fake.clone())
            .compile(program(&items()), &json!({}), &config, Identity::default())
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
            let out = value(compile(&fake, &items(), Identity::default()).await);
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
        let out = value(compile(&fake, &items(), Identity::default()).await);
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
            let out = value(compile(&fake, &save(), Identity::default()).await);
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
        assert_eq!(fields, ["id", "name", "questions", "session_id"]);
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
