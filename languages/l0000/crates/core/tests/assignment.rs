// SPDX-License-Identifier: MIT

//! The kernel's part of durable assignment (docs/c4-l0182-assignment-plan.md, decision 1 and §3):
//! `/interpret` takes an assignment table, a dialect may answer `needsAssignment` instead of a
//! result, and a value that isn't known yet is `pending`, suspending whatever inspects it. The
//! protocol is exercised with `Fake`, a dialect made for these tests; no language uses it yet.

use std::sync::Arc;

use async_trait::async_trait;
use graffiticode_l0000::{
    Compilation, Compiler, Diagnostic, Dialect, Evaluator, Identity, Interpretation, L0000, LanguageSchema, Mode,
    Model, NodeId, Op, SchemaError, SchemaSource, Value, json_text,
};
use serde::Deserialize;
use serde_json::{Value as Json, json};

/// How many occurrences this run has reached, unsuspended, so far.
#[derive(Default)]
struct Ordinals(usize);

/// `OCC <name>`: an occurrence whose identity is its name's text, standing for a survey. With a
/// table it is resolved from it (its `instance` and its ordinal, `"<instance>#<ordinal>"`) or,
/// when the table doesn't hold it, asks for it and is pending. Without one (a compile) it is
/// `"compiled <name>"`, as a language's legacy path would be. `LOST` is a bug: pending without a
/// request. `STUCK` suspends on nothing pending, without a request.
struct Fake;

#[async_trait]
impl Dialect for Fake {
    fn lang_id(&self) -> &str {
        "0000"
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        match op.tag() {
            "OCC" => {
                let name = cx.eval_arg(id, elts, 0).await;
                // A dialect's own word that receives a pending value is suspended: its identity
                // isn't known, so it asks for nothing.
                if name.contains_pending() {
                    return Some(cx.suspend(&[]));
                }
                let identity = name.display();
                let ordinal = {
                    let ordinals = cx.exec().state::<Ordinals>();
                    ordinals.0 += 1;
                    ordinals.0 - 1
                };
                Some(match cx.assignments() {
                    None => Value::from(format!("compiled {identity}")),
                    Some(table) => match table.get(&identity) {
                        Some(assigned) => {
                            Value::from(format!("{}#{ordinal}", assigned["instance"].as_str().unwrap_or_default()))
                        }
                        None => cx.request_assignment(json!({ "identity": identity, "ordinal": ordinal })),
                    },
                })
            }
            "LOST" => Some(Value::Pending),
            "STUCK" => Some(cx.suspend(&[])),
            _ => None,
        }
    }
}

/// A program, built node by node the way the parser lays out its pool.
#[derive(Default)]
struct Prog {
    pool: serde_json::Map<String, Json>,
    next: u32,
}

impl Prog {
    fn node(&mut self, tag: &str, elts: Vec<Json>) -> u32 {
        self.next += 1;
        self.pool.insert(self.next.to_string(), json!({ "tag": tag, "elts": elts }));
        self.next
    }
    fn form(&mut self, tag: &str, elts: &[u32]) -> u32 {
        self.node(tag, elts.iter().map(|&elt| json!(elt)).collect())
    }
    fn num(&mut self, n: f64) -> u32 {
        self.node("NUM", vec![json!(n.to_string())])
    }
    fn str(&mut self, s: &str) -> u32 {
        self.node("STR", vec![json!(s)])
    }
    fn ident(&mut self, name: &str) -> u32 {
        self.node("IDENT", vec![json!(name)])
    }
    fn occ(&mut self, name: &str) -> u32 {
        let name = self.str(name);
        self.form("OCC", &[name])
    }
    /// `<params: body>`, parenthesized.
    fn lambda(&mut self, params: &[&str], body: u32) -> u32 {
        let params: Vec<u32> = params.iter().map(|param| self.ident(param)).collect();
        let params = self.form("LIST", &params);
        let lambda = self.form("LAMBDA", &[params, body]);
        self.form("PAREN", &[lambda])
    }
    fn set_var(&mut self, name: &str, value: u32) -> u32 {
        let name = self.str(name);
        self.form("SET_VAR", &[name, value])
    }
    fn get_var(&mut self, name: &str) -> u32 {
        let name = self.str(name);
        self.form("GET_VAR", &[name])
    }
    fn list(&mut self, items: &[u32]) -> u32 {
        self.form("LIST", items)
    }
    /// The program `expr..` (a sequence of `exprs`, its value the last).
    fn program(mut self, exprs: &[u32]) -> Json {
        let exprs = self.form("EXPRS", exprs);
        let root = self.form("PROG", &[exprs]);
        self.pool.insert("root".to_owned(), json!(root));
        Json::Object(self.pool)
    }
}

async fn model(compiler: &Compiler, code: &Json) -> Model {
    compiler.model(code, &json!({})).await.expect("the program has a model")
}

/// Interprets `code` with `table` (`None`: the request carried none) and returns the
/// compilation and the envelope the server writes, without its revision.
async fn interpret(code: &Json, table: Option<Json>) -> (Compilation, Json) {
    let compiler = Compiler::new(Fake);
    let model = model(&compiler, code).await;
    let compiled = compiler
        .interpret_assigned(&model, &json!({}), &json!({}), Mode::Evaluate, Identity::default(), table.as_ref())
        .await;
    let envelope = compiler.envelope(&compiled);
    (compiled, envelope)
}

/// The identities a `needsAssignment` answer asks for, in order; panics on any other answer.
fn requested(envelope: &Json) -> Vec<String> {
    assert_eq!(envelope["status"], json!(200), "not a needsAssignment answer: {envelope}");
    assert!(envelope.get("data").is_none() && envelope.get("errors").is_none(), "{envelope}");
    envelope["needsAssignment"]
        .as_array()
        .expect("needsAssignment is a list")
        .iter()
        .map(|request| request["identity"].as_str().unwrap().to_owned())
        .collect()
}

/// A table assigning each identity the instance `<identity>-1`.
fn table(identities: &[&str]) -> Json {
    Json::Object(
        identities
            .iter()
            .map(|identity| ((*identity).to_owned(), json!({ "instance": format!("{identity}-1"), "digest": "d" })))
            .collect(),
    )
}

// ---- Dialects that use neither feature are byte-identical ----

#[derive(Deserialize)]
struct Case {
    src: String,
    data: Json,
    ast: Json,
    schema: Option<Option<Json>>,
}

struct OneSchema(Option<Json>);

#[async_trait]
impl SchemaSource for OneSchema {
    async fn schema(&self, lang: &str) -> Result<Arc<LanguageSchema>, SchemaError> {
        match &self.0 {
            Some(schema) => LanguageSchema::new(schema).map(Arc::new),
            None => Err(SchemaError(format!("HTTP 404 from https://api.graffiticode.org/L{lang}/schema.json"))),
        }
    }
}

/// Every L0000 conformance case: interpreting with no table, a null one, an empty one or one
/// that holds entries gives the same compilation and byte for byte the same envelope as
/// [`Compiler::interpret`], which `tests/interpret.rs` holds equal to compiling. No answer is a
/// `needsAssignment`.
#[tokio::test]
async fn a_dialect_that_never_asks_interprets_byte_identically_whatever_the_table() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("conformance/cases.json")).unwrap();
    assert!(cases.len() > 350, "the fixture looks truncated: {} cases", cases.len());
    let tables = [None, Some(Json::Null), Some(json!({})), Some(table(&["a", "civic-priorities"]))];
    let mut failures = Vec::new();
    for case in &cases {
        let compiler = match &case.schema {
            Some(schema) => Compiler::new(L0000).with_schemas(OneSchema(schema.clone())),
            None => Compiler::new(L0000),
        };
        let Ok(model) = compiler.model(&case.ast, &json!({})).await else { continue };
        for mode in [Mode::Evaluate, Mode::Present] {
            let before = compiler.interpret(&model, &case.data, &json!({}), mode, Identity::default()).await;
            let written = json_text(&compiler.envelope(&before));
            for table in &tables {
                let after = compiler
                    .interpret_assigned(&model, &case.data, &json!({}), mode, Identity::default(), table.as_ref())
                    .await;
                assert_eq!(after.needs_assignment, None, "{}", case.src);
                // Compared as printed: NaN (`div 0 0`) is never equal to itself.
                if format!("{after:?}") != format!("{before:?}") || json_text(&compiler.envelope(&after)) != written {
                    failures.push(format!("{} with {table:?} in {mode:?}", case.src));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.join("\n"));
}

/// The envelope a dialect that never asks writes is exactly the one it wrote before this change.
#[tokio::test]
async fn an_envelope_without_assignments_is_the_one_written_before() {
    let mut p = Prog::default();
    let (one, two) = (p.num(1.0), p.num(2.0));
    let add = p.form("ADD", &[one, two]);
    let code = p.program(&[add]);
    let compiler = Compiler::new(L0000);
    let model = model(&compiler, &code).await;
    for table in [None, Some(json!({})), Some(table(&["x"]))] {
        let compiled = compiler
            .interpret_assigned(&model, &json!({}), &json!({}), Mode::Evaluate, Identity::default(), table.as_ref())
            .await;
        assert_eq!(json_text(&compiler.envelope(&compiled)), r#"{"data":3,"errors":[]}"#);
    }
    // And a compile is untouched.
    let compiled = compiler.compile(&code, &json!({}), &json!({}), Identity::default()).await;
    assert_eq!(compiled.needs_assignment, None);
    assert_eq!(json_text(&compiler.envelope(&compiled)), r#"{"data":3,"errors":[]}"#);
}

// ---- The exchange ----

/// Call 1 asks for every reached occurrence; call 2, with the table, has the result.
#[tokio::test]
async fn the_two_call_exchange_round_trips() {
    let mut p = Prog::default();
    let (a, b) = (p.occ("a"), p.occ("b"));
    let list = p.list(&[a, b]);
    let code = p.program(&[list]);

    let (compiled, envelope) = interpret(&code, None).await;
    assert_eq!(compiled.result, Ok(Value::Pending));
    assert_eq!(
        json_text(&envelope),
        r#"{"status":200,"needsAssignment":[{"identity":"a","ordinal":0},{"identity":"b","ordinal":1}]}"#
    );

    let (compiled, envelope) = interpret(&code, Some(table(&["a", "b"]))).await;
    assert_eq!(compiled.needs_assignment, None);
    assert_eq!(json_text(&envelope), r#"{"data":["a-1#0","b-1#1"],"errors":[]}"#);

    // A partial table asks only for the rest.
    let (_, envelope) = interpret(&code, Some(table(&["a"]))).await;
    assert_eq!(requested(&envelope), ["b"]);
}

/// A compile can't ask: the fake dialect takes its legacy path, and `/compile` is unchanged.
#[tokio::test]
async fn a_compile_has_no_table_and_never_answers_needs_assignment() {
    let mut p = Prog::default();
    let a = p.occ("a");
    let code = p.program(&[a]);
    let compiler = Compiler::new(Fake);
    let compiled = compiler.compile(&code, &json!({}), &json!({}), Identity::default()).await;
    assert_eq!(json_text(&compiler.envelope(&compiled)), r#"{"data":"compiled a","errors":[]}"#);
}

/// A language that interprets on its own receives the table through
/// [`Dialect::interpret_assigned`] and may answer [`Interpretation::NeedsAssignment`].
struct OwnInterpreter;

#[async_trait]
impl Dialect for OwnInterpreter {
    fn lang_id(&self) -> &str {
        "0000"
    }
    async fn interpret_assigned(
        &self,
        _model: &Model,
        _input: &Json,
        _mode: Mode,
        assignments: &Json,
    ) -> Option<Result<Interpretation, Vec<Diagnostic>>> {
        Some(Ok(match assignments.get("a") {
            Some(assigned) => Interpretation::Data(assigned["instance"].clone()),
            None if assignments.get("empty").is_some() => Interpretation::NeedsAssignment(Vec::new()),
            None => Interpretation::NeedsAssignment(vec![json!({ "identity": "a" })]),
        }))
    }
}

#[tokio::test]
async fn a_language_s_own_interpretation_receives_the_table_and_may_ask() {
    let mut p = Prog::default();
    let one = p.num(1.0);
    let code = p.program(&[one]);
    let compiler = Compiler::new(OwnInterpreter);
    let model = model(&compiler, &code).await;
    let run = |table: Option<Json>| {
        let (compiler, model) = (compiler.clone(), model.clone());
        async move {
            let compiled = compiler
                .interpret_assigned(&model, &json!({}), &json!({}), Mode::Evaluate, Identity::default(), table.as_ref())
                .await;
            json_text(&compiler.envelope(&compiled))
        }
    };
    assert_eq!(run(None).await, r#"{"status":200,"needsAssignment":[{"identity":"a"}]}"#);
    assert_eq!(run(Some(table(&["a"]))).await, r#"{"data":"a-1","errors":[]}"#);
    // Asking for nothing can't make progress: an internal error, never a result.
    let empty = run(Some(json!({ "empty": {} }))).await;
    assert!(empty.contains(r#""code":"assignment-unresolved""#), "{empty}");
    // Without the table (the plain entry point), it is offered the empty one.
    let compiled = compiler.interpret(&model, &json!({}), &json!({}), Mode::Evaluate, Identity::default()).await;
    assert_eq!(compiled.needs_assignment, Some(vec![json!({ "identity": "a" })]));
}

// ---- Deterministic evaluation order ----

/// `[occ "a", map (<x: occ x>) ["b" "c"], filter (<x: occ x>) ["d" "e"], occ "f"]`: the same
/// ordinals on every run, inside `map` and `filter` too, in the requests and in the result.
#[tokio::test]
async fn evaluation_order_gives_the_same_ordinals_every_run() {
    let mut p = Prog::default();
    let a = p.occ("a");
    let x = p.ident("x");
    let occ_x = p.form("OCC", &[x]);
    let mapper = p.lambda(&["x"], occ_x);
    let (b, c) = (p.str("b"), p.str("c"));
    let bc = p.list(&[b, c]);
    let map = p.form("MAP", &[mapper, bc]);
    let x = p.ident("x");
    let occ_x = p.form("OCC", &[x]);
    let predicate = p.lambda(&["x"], occ_x);
    let (d, e) = (p.str("d"), p.str("e"));
    let de = p.list(&[d, e]);
    let filter = p.form("FILTER", &[predicate, de]);
    let f = p.occ("f");
    let list = p.list(&[a, map, filter, f]);
    let code = p.program(&[list]);

    let mut first = None;
    for _ in 0..5 {
        let (_, envelope) = interpret(&code, None).await;
        // Every predicate runs, though the filter is pending once one of them is.
        assert_eq!(
            envelope["needsAssignment"],
            json!([
                { "identity": "a", "ordinal": 0 }, { "identity": "b", "ordinal": 1 },
                { "identity": "c", "ordinal": 2 }, { "identity": "d", "ordinal": 3 },
                { "identity": "e", "ordinal": 4 }, { "identity": "f", "ordinal": 5 },
            ])
        );
        let (_, resolved) = interpret(&code, Some(table(&["a", "b", "c", "d", "e", "f"]))).await;
        assert_eq!(
            resolved["data"],
            json!(["a-1#0", ["b-1#1", "c-1#2"], ["d", "e"], "f-1#5"]),
            "the filter keeps both: each predicate's value is a non-empty string"
        );
        let both = (json_text(&envelope), json_text(&resolved));
        assert_eq!(first.get_or_insert_with(|| both.clone()), &both);
    }
}

// ---- Suspension ----

/// `if occ "c" then occ "t" else occ "e"`: neither branch runs until the condition is known,
/// and then only the branch taken asks.
#[tokio::test]
async fn a_conditional_on_pending_runs_neither_branch() {
    let mut p = Prog::default();
    let (c, t, e) = (p.occ("c"), p.occ("t"), p.occ("e"));
    let cond = p.form("IF", &[c, t, e]);
    let code = p.program(&[cond]);
    let (_, envelope) = interpret(&code, None).await;
    assert_eq!(requested(&envelope), ["c"]);
    let (_, envelope) = interpret(&code, Some(table(&["c"]))).await;
    assert_eq!(envelope["needsAssignment"], json!([{ "identity": "t", "ordinal": 1 }]));
    let (_, envelope) = interpret(&code, Some(table(&["c", "t"]))).await;
    assert_eq!(envelope["data"], json!("t-1#1"));
}

/// `case occ "c" of "x": occ "t" _: occ "e" end`.
#[tokio::test]
async fn a_case_on_pending_runs_no_clause() {
    let mut p = Prog::default();
    let c = p.occ("c");
    let (x, t) = (p.str("x"), p.occ("t"));
    let first = p.form("OF", &[x, t]);
    let wild = p.node("TAG", vec![json!("_")]);
    let e = p.occ("e");
    let second = p.form("OF", &[wild, e]);
    let case = p.form("CASE", &[c, first, second]);
    let code = p.program(&[case]);
    let (_, envelope) = interpret(&code, None).await;
    assert_eq!(requested(&envelope), ["c"]);
    let (_, envelope) = interpret(&code, Some(table(&["c"]))).await;
    assert_eq!(requested(&envelope), ["e"], "c-1#0 isn't \"x\": the wildcard clause");
}

/// `map`, `filter` and `reduce` over a pending list run no body.
#[tokio::test]
async fn map_filter_and_reduce_over_pending_run_no_body() {
    for word in ["MAP", "FILTER", "REDUCE"] {
        let mut p = Prog::default();
        let body = p.occ("body");
        let function = p.lambda(&["x", "y"], body);
        let list = p.occ("list");
        let form = if word == "REDUCE" {
            let init = p.num(0.0);
            p.form(word, &[function, init, list])
        } else {
            p.form(word, &[function, list])
        };
        let code = p.program(&[form]);
        let (compiled, envelope) = interpret(&code, None).await;
        assert_eq!(requested(&envelope), ["list"], "{word}");
        assert_eq!(compiled.result, Ok(Value::Pending), "{word}");
    }
}

/// Builds an expression over the pending value it is given.
type Build = fn(&mut Prog, u32) -> u32;

/// A value computed from pending is pending, whatever computes it, and nothing reports an error
/// for it: `add`, `gt`, `concat`, `equiv`, `get`, `hd`, `not`, `length`, a dialect's own word.
#[tokio::test]
async fn a_value_computed_from_pending_is_pending() {
    let cases: Vec<(&str, Build)> = vec![
        ("ADD", |p, v| {
            let one = p.num(1.0);
            p.form("ADD", &[v, one])
        }),
        ("GT", |p, v| {
            let one = p.num(1.0);
            p.form("GT", &[v, one])
        }),
        ("CONCAT", |p, v| {
            let s = p.str("s");
            p.form("CONCAT", &[s, v])
        }),
        ("EQUIV in a list", |p, v| {
            let list = p.list(&[v]);
            let other = p.list(&[]);
            p.form("EQUIV", &[list, other])
        }),
        ("GET from a record holding it", |p, v| {
            let (k, j) = (p.str("k"), p.str("j"));
            let one = p.num(1.0);
            let kb = p.form("BINDING", &[k, one]);
            let jb = p.form("BINDING", &[j, v]);
            let record = p.form("RECORD", &[kb, jb]);
            let k = p.str("k");
            p.form("GET", &[k, record])
        }),
        ("HD", |p, v| {
            let list = p.list(&[v]);
            p.form("HD", &[list])
        }),
        ("NOT", |p, v| p.form("NOT", &[v])),
        ("LENGTH", |p, v| p.form("LENGTH", &[v])),
        ("a dialect's word", |p, v| p.form("OCC", &[v])),
    ];
    for (what, build) in cases {
        let mut p = Prog::default();
        let pending = p.occ("p");
        let computed = build(&mut p, pending);
        // `[computed, occ "after"]`: what follows is still reached.
        let after = p.occ("after");
        let list = p.list(&[computed, after]);
        let code = p.program(&[list]);
        let (compiled, envelope) = interpret(&code, None).await;
        assert_eq!(requested(&envelope), ["p", "after"], "{what}");
        let Ok(Value::Pending) = compiled.result else { panic!("{what}: {:?}", compiled.result) };
    }
}

/// `[1 occ "a" 3]`: pending inside a list survives to the end, and the run asks.
#[tokio::test]
async fn pending_inside_a_list_survives_and_asks() {
    let mut p = Prog::default();
    let (one, a, three) = (p.num(1.0), p.occ("a"), p.num(3.0));
    let list = p.list(&[one, a, three]);
    let code = p.program(&[list]);
    let (_, envelope) = interpret(&code, None).await;
    assert_eq!(requested(&envelope), ["a"]);
    let (_, envelope) = interpret(&code, Some(table(&["a"]))).await;
    assert_eq!(envelope["data"], json!([1, "a-1#0", 3]));
}

// ---- Regressions: suspension covers variables ----

/// `set-var "s" "z".. if occ "c" then set-var "s" "a" else set-var "s" "b".. occ get-var "s"`:
/// the last occurrence's identity depends on a branch not yet taken, so it is suspended. It is
/// asked for neither with the stale `"z"` nor with an undefined name.
#[tokio::test]
async fn a_suspended_conditional_that_sets_a_variable_suspends_its_readers() {
    let mut p = Prog::default();
    let z = p.str("z");
    let init = p.set_var("s", z);
    let c = p.occ("c");
    let (a, b) = (p.str("a"), p.str("b"));
    let then = p.set_var("s", a);
    let otherwise = p.set_var("s", b);
    let cond = p.form("IF", &[c, then, otherwise]);
    let s = p.get_var("s");
    let reader = p.form("OCC", &[s]);
    let code = p.program(&[init, cond, reader]);
    let (_, envelope) = interpret(&code, None).await;
    assert_eq!(requested(&envelope), ["c"]);
    // Once the branch is known, the occurrence asks with the value that branch set.
    let (_, envelope) = interpret(&code, Some(table(&["c"]))).await;
    assert_eq!(envelope["needsAssignment"], json!([{ "identity": "a", "ordinal": 1 }]));
    let (_, envelope) = interpret(&code, Some(table(&["c", "a"]))).await;
    assert_eq!(envelope["data"], json!("a-1#1"));
}

/// The same with a computed `set-var` name: any variable may have been set, so every one reads
/// as pending, `"t"` included, until it is set again.
#[tokio::test]
async fn a_suspended_set_var_with_a_computed_name_suspends_every_reader() {
    let mut p = Prog::default();
    let c = p.occ("c");
    let (s, empty) = (p.str("s"), p.str(""));
    let name = p.form("CONCAT", &[s, empty]);
    let a = p.str("a");
    let then = p.form("SET_VAR", &[name, a]);
    let zero = p.num(0.0);
    let cond = p.form("IF", &[c, then, zero]);
    let s = p.get_var("s");
    let reads_s = p.form("OCC", &[s]);
    let t = p.get_var("t");
    let reads_t = p.form("OCC", &[t]);
    // Set again after the suspension, a variable is known.
    let q = p.str("q");
    let reset = p.set_var("t", q);
    let t = p.get_var("t");
    let reads_reset = p.form("OCC", &[t]);
    let code = p.program(&[cond, reads_s, reads_t, reset, reads_reset]);
    let (_, envelope) = interpret(&code, None).await;
    assert_eq!(requested(&envelope), ["c", "q"]);
}

/// The same with a user-defined function that sets a variable: applying one could set any.
#[tokio::test]
async fn a_suspended_function_application_suspends_every_reader() {
    let mut p = Prog::default();
    let c = p.occ("c");
    let x = p.ident("x");
    let body = p.set_var("s", x);
    let function = p.lambda(&["x"], body);
    let a = p.str("a");
    let apply = p.form("APPLY", &[function, a]);
    let zero = p.num(0.0);
    let cond = p.form("IF", &[c, apply, zero]);
    let s = p.get_var("s");
    let reads_s = p.form("OCC", &[s]);
    let u = p.get_var("u");
    let reads_u = p.form("OCC", &[u]);
    let code = p.program(&[cond, reads_s, reads_u]);
    let (_, envelope) = interpret(&code, None).await;
    assert_eq!(requested(&envelope), ["c"]);
    let (_, envelope) = interpret(&code, Some(table(&["c"]))).await;
    // The function ran: `s` is "a"; `u` was never set, so its name is `null`.
    assert_eq!(requested(&envelope), ["a", "null"]);
}

/// A set-var whose name is itself pending: no variable is known afterwards.
#[tokio::test]
async fn a_set_var_with_a_pending_name_suspends_every_reader() {
    let mut p = Prog::default();
    let name = p.occ("name");
    let v = p.str("v");
    let set = p.form("SET_VAR", &[name, v]);
    let k = p.get_var("k");
    let reader = p.form("OCC", &[k]);
    let code = p.program(&[set, reader]);
    let (_, envelope) = interpret(&code, None).await;
    assert_eq!(requested(&envelope), ["name"]);
}

// ---- Regressions: success means nothing was left unresolved ----

/// `occ "a".. 1`: the sequence's value is plain, but it discarded a pending value.
#[tokio::test]
async fn a_discarded_pending_still_asks() {
    let mut p = Prog::default();
    let (a, one) = (p.occ("a"), p.num(1.0));
    let code = p.program(&[a, one]);
    let (compiled, envelope) = interpret(&code, None).await;
    assert_eq!(requested(&envelope), ["a"]);
    assert_eq!(compiled.result, Ok(Value::Pending));
    let (_, envelope) = interpret(&code, Some(table(&["a"]))).await;
    assert_eq!(json_text(&envelope), r#"{"data":1,"errors":[]}"#);
}

/// `{k: occ "a", k: 1}`: the record drops the pending value, and the run still asks. So does a
/// function given more than it uses, and a suspended branch whose value is dropped.
#[tokio::test]
async fn a_dropped_pending_still_asks() {
    let mut p = Prog::default();
    let (k1, a) = (p.str("k"), p.occ("a"));
    let first = p.form("BINDING", &[k1, a]);
    let (k2, one) = (p.str("k"), p.num(1.0));
    let second = p.form("BINDING", &[k2, one]);
    let record = p.form("RECORD", &[first, second]);
    let code = p.program(&[record]);
    let (_, envelope) = interpret(&code, None).await;
    assert_eq!(requested(&envelope), ["a"]);

    let mut p = Prog::default();
    let (c, t) = (p.occ("c"), p.occ("t"));
    let zero = p.num(0.0);
    let cond = p.form("IF", &[c, t, zero]);
    let len = p.form("LENGTH", &[cond]);
    let one = p.num(1.0);
    let code = p.program(&[len, one]);
    let (_, envelope) = interpret(&code, None).await;
    assert_eq!(requested(&envelope), ["c"]);
}

/// Pending with nothing asked can't happen silently: it is an internal error, never data,
/// whether the value was kept, discarded, or a suspension stood alone. A request in a run that
/// can't exchange (a compile) is one too.
#[tokio::test]
async fn pending_without_a_request_is_an_internal_error() {
    for (what, tag, keep) in [("kept", "LOST", true), ("discarded", "LOST", false), ("suspension", "STUCK", false)] {
        let mut p = Prog::default();
        let lost = p.form(tag, &[]);
        let one = p.num(1.0);
        let code = if keep { p.program(&[lost]) } else { p.program(&[lost, one]) };
        let (compiled, envelope) = interpret(&code, Some(json!({}))).await;
        assert_eq!(compiled.needs_assignment, None, "{what}");
        assert_eq!(envelope["data"], Json::Null, "{what}");
        assert_eq!(envelope["errors"][0]["code"], json!("assignment-unresolved"), "{what}: {envelope}");
    }

    /// Asks even in a compile.
    struct Eager;
    #[async_trait]
    impl Dialect for Eager {
        fn lang_id(&self) -> &str {
            "0000"
        }
        async fn eval(&self, cx: &mut Evaluator<'_>, _id: NodeId, op: &Op, _elts: &[NodeId]) -> Option<Value> {
            (op.tag() == "OCC").then(|| cx.request_assignment(json!({ "identity": "a" })))
        }
    }
    let mut p = Prog::default();
    let a = p.occ("a");
    let code = p.program(&[a]);
    let compiler = Compiler::new(Eager);
    let compiled = compiler.compile(&code, &json!({}), &json!({}), Identity::default()).await;
    let envelope = compiler.envelope(&compiled);
    assert_eq!(envelope["data"], Json::Null);
    assert_eq!(envelope["errors"][0]["code"], json!("assignment-unresolved"), "{envelope}");
    // An error and a request: the error wins, as it will once everything is assigned.
    let mut p = Prog::default();
    let a = p.occ("a");
    let (one, s) = (p.num(1.0), p.str("s"));
    let bad = p.form("CONCAT", &[one, s]);
    let code = p.program(&[a, bad]);
    let (compiled, envelope) = interpret(&code, None).await;
    assert_eq!(compiled.needs_assignment, None);
    assert!(compiled.result.is_err());
    assert!(envelope["errors"][0]["message"].as_str().unwrap().contains("CONCAT"), "{envelope}");
}
