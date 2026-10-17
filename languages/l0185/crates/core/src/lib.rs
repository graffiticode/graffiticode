// SPDX-License-Identifier: MIT

//! L0185 — fetch and shape data. A program is steps, then a source, then `{}`:
//!
//! ```text
//! sort-by ["revenue" DESC]
//! summarize {orders: COUNT revenue: [SUM "amount"]}
//! group-by ["region"]
//! fetch "https://l0185.graffiticode.org/data/sales.csv"
//! {}..
//! ```
//!
//! Every word is arity 2: its parameter, then the record to its right — the [`State`]
//! carrying the data so far. A word evaluates its right-hand side first, so the source runs
//! first and the steps run right to left. `PROG` unwraps the state: the output is the data and
//! nothing else.
//!
//! The data is held as JavaScript values ([`js::Js`]) and every step is written against
//! JavaScript's reading of them, because the output must equal the TypeScript compiler's
//! byte for byte. A state travels through the kernel (a `let`, a list, a `join`'s record) as
//! a small record naming a state kept in the compile's own store.

pub mod csv;
pub mod dates;
#[cfg(feature = "http")]
pub mod fetch;
pub mod js;
pub mod paths;
pub mod source;
pub mod steps;
pub mod vocab;

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use graffiticode_l0000::{Ast, Diagnostic, Dialect, Evaluator, Key, Lambda, Lexicon, Node, NodeId, Op, Record, Value};
use indexmap::IndexMap;

pub use crate::source::{FetchResult, Fetcher};
pub use crate::steps::State;

use crate::js::{Js, Obj, is_record, show_value};
use crate::vocab::word_of;

/// The most records a result may have.
pub const MAX_OUTPUT_ROWS: usize = 10_000;
/// The platform stores a compiled result in one Firestore field; a larger one fails there.
pub const MAX_OUTPUT_BYTES: usize = 1_000_000;
/// The most different URLs one compile may fetch.
pub const MAX_URLS: usize = 10;

const PROGRAM_EXAMPLE: &str = "where [\"age\" ABOVE 30] fetch \"https://example.org/people.json\" {}..";

/// The words L0185 adds to the base lexicon. Generated from the TypeScript package by
/// `tests/conformance/generate.mjs`.
const ADDITIONS_JSON: &str = include_str!("lexicon-additions.json");

static LEXICON: LazyLock<Lexicon> = LazyLock::new(|| {
    let additions = serde_json::from_str(ADDITIONS_JSON).expect("the embedded lexicon additions are valid");
    Lexicon::base().merge(additions, &[], Some("L0185")).expect("L0185 redefines no base word")
});

/// L0185's vocabulary: the base lexicon with its words and tags laid over it.
pub fn lexicon() -> &'static Lexicon {
    &LEXICON
}

/// L0000 list functions used as steps, and what to write instead.
const SHADOWED: [(&str, usize, &str); 5] = [
    ("TAKE", 1, "limit 10 fetch \"https://…\" {}"),
    ("DROP", 1, "skip 10 fetch \"https://…\" {}"),
    ("FILTER", 1, "where [\"age\" ABOVE 30] fetch \"https://…\" {}"),
    ("MAP", 1, "derive {total: <row: …>} fetch \"https://…\" {}"),
    ("LAST", 0, "limit 1 sort-by [\"date\" DESC] fetch \"https://…\" {}"),
];

/// The tag of a record key that marks a value standing for something the kernel cannot hold.
const STATE_KEY: &str = "\u{1}l0185-state";
const DATE_KEY: &str = "\u{1}l0185-date";

/// L0185, with the fetcher its `fetch` uses.
#[derive(Clone)]
pub struct L0185 {
    fetcher: Option<Arc<dyn Fetcher>>,
}

impl L0185 {
    /// The language server's L0185: `fetch` goes through the guarded HTTPS fetcher, and through
    /// the egress proxy when the environment names one (ISOLATE-01). A proxy that isn't a URL, or
    /// one without a readable CA, is an error, so the server refuses to start.
    #[cfg(feature = "http")]
    pub fn from_env() -> Result<Self, graffiticode_l0000::egress::EgressError> {
        let opts = fetch::GuardOptions {
            egress: graffiticode_l0000::egress::EgressEnv::from_env(),
            ..fetch::GuardOptions::default()
        };
        Ok(Self { fetcher: Some(Arc::new(fetch::GuardedFetcher::new(opts)?)) })
    }

    /// L0185 fetching through `fetcher` (tests use a fixture one).
    pub fn with_fetcher(fetcher: impl Fetcher + 'static) -> Self {
        Self { fetcher: Some(Arc::new(fetcher)) }
    }

    /// L0185 that cannot fetch: `fetch` is an error rather than an unguarded request.
    pub fn without_fetcher() -> Self {
        Self { fetcher: None }
    }
}

/// What one compile keeps: the states its words made, the URLs it fetched, and whether a
/// function given to a step is being applied (where the TypeScript runs synchronously, so a
/// word, which always answers later, never answers at all).
#[derive(Default)]
struct Compile {
    states: Vec<Arc<State>>,
    fetches: IndexMap<String, Result<FetchResult, String>>,
    sync_depth: usize,
    went_async: bool,
}

fn compile<'a>(cx: &'a mut Evaluator<'_>) -> &'a mut Compile {
    cx.exec().state::<Compile>()
}

fn store(cx: &mut Evaluator<'_>, state: State) -> Value {
    let compile = compile(cx);
    compile.states.push(Arc::new(state));
    let index = compile.states.len() - 1;
    Value::Record([(Key::str(STATE_KEY), Value::from(index as f64))].into_iter().collect())
}

fn handle(value: &Value) -> Option<usize> {
    match value {
        Value::Record(record) if record.len() == 1 => match record.get(&Key::str(STATE_KEY)) {
            Some(Value::Num(n)) => Some(n.to_f64() as usize),
            _ => None,
        },
        _ => None,
    }
}

fn state_of_value(cx: &mut Evaluator<'_>, value: &Value) -> Option<Arc<State>> {
    let index = handle(value)?;
    compile(cx).states.get(index).cloned()
}

/// A kernel value as the plain JavaScript value the TypeScript's `toPlainObject` makes of it.
fn plain(cx: &mut Evaluator<'_>, value: &Value) -> Js {
    if let Some(state) = state_of_value(cx, value) {
        return state.to_js();
    }
    match value {
        Value::Undefined => Js::Undef,
        Value::Null => Js::Null,
        Value::Bool(b) => Js::Bool(*b),
        Value::Num(n) => Js::Num(n.to_f64()),
        Value::Str(s) => Js::Str(s.clone()),
        Value::Tag(name) => Js::Obj([("tag".to_owned(), Js::from(name.as_str()))].into_iter().collect()),
        Value::List(items) => Js::Arr(items.iter().map(|item| plain(cx, item)).collect()),
        Value::Record(record) => {
            if record.len() == 1
                && let Some(Value::Num(t)) = record.get(&Key::str(DATE_KEY))
            {
                return Js::Date(t.to_f64());
            }
            let mut obj = Obj::new();
            for (key, v) in record.iter() {
                let v = plain(cx, v);
                obj.set(key.name().into_owned(), v);
            }
            Js::Obj(obj)
        }
        Value::Lambda(Lambda { params }) => {
            let params = Js::Arr(params.iter().map(|p| Js::from(p.as_str())).collect());
            let inner: Obj = [("params".to_owned(), params)].into_iter().collect();
            Js::Obj([("lambda".to_owned(), Js::Obj(inner))].into_iter().collect())
        }
    }
}

/// A plain value as the kernel sees it, for a function of the record.
fn kernel_value(js: &Js) -> Value {
    match js {
        Js::Undef => Value::Undefined,
        Js::Null => Value::Null,
        Js::Bool(b) => Value::Bool(*b),
        Js::Num(n) => Value::from(*n),
        Js::Str(s) => Value::Str(s.clone()),
        Js::Date(t) => Value::Record([(Key::str(DATE_KEY), Value::from(*t))].into_iter().collect()),
        Js::Arr(items) => Value::List(items.iter().map(kernel_value).collect()),
        Js::Obj(obj) => match (obj.len(), obj.get("tag")) {
            (1, Some(Js::Str(name))) => Value::Tag(name.clone()),
            _ => Value::Record(obj.iter().map(|(k, v)| (Key::tag(k.as_str()), kernel_value(v))).collect()),
        },
    }
}

/// The output: what the TypeScript renderer makes of the data (`deepConvertRecords`, which
/// rebuilds every object without a `tag` from its own fields, so a `Date` there is `{}`), as
/// a value whose JSON is `JSON.stringify`'s.
fn output(js: &Js) -> Value {
    match js {
        Js::Arr(items) => Value::List(items.iter().map(output).collect()),
        Js::Date(_) => Value::Record(Record::new()),
        Js::Obj(obj) if matches!(obj.get("tag"), None | Some(Js::Undef)) => {
            Value::Record(obj.iter().map(|(k, v)| (Key::str(k.as_str()), output(v))).collect())
        }
        other => json_value(other),
    }
}

/// A value whose JSON is `JSON.stringify(js)`.
fn json_value(js: &Js) -> Value {
    match js {
        Js::Undef => Value::Undefined,
        Js::Null => Value::Null,
        Js::Bool(b) => Value::Bool(*b),
        Js::Num(n) => Value::from(*n),
        Js::Str(s) => Value::Str(s.clone()),
        Js::Date(t) => dates::to_iso_string(*t).map_or(Value::Null, Value::Str),
        Js::Arr(items) => Value::List(items.iter().map(json_value).collect()),
        Js::Obj(obj) => Value::Record(obj.iter().map(|(k, v)| (Key::str(k.as_str()), json_value(v))).collect()),
    }
}

/// A node with its parentheses removed.
fn unparen(ast: &Ast, mut id: NodeId) -> NodeId {
    while let Some(Node::Form { op: Op::Paren, elts }) = ast.get(id) {
        match elts.as_slice() {
            [inner] => id = *inner,
            _ => break,
        }
    }
    id
}

fn tag_of_node(ast: &Ast, id: NodeId) -> Option<&str> {
    match ast.get(id) {
        Some(Node::Form { op, .. }) => Some(op.tag()),
        _ => None,
    }
}

fn is_own_tag(tag: &str) -> bool {
    tag == "RECORD" || vocab::meta(tag).is_some()
}

/// A field of `derive`: a function of the record, or a value.
enum Entry {
    Lambda(NodeId),
    Value(Js),
}

/// A word's parameter, as its step needs it.
enum Param {
    Lambda(NodeId),
    Entries(Vec<(String, Entry)>),
    Value(Js),
}

/// Why a word produced no state.
enum Failed {
    /// Errors are already reported (its right-hand side's, or its parameter's).
    Reported,
    /// Applying a function given to a step reached a word.
    Async,
    Message(String),
}

impl From<String> for Failed {
    fn from(message: String) -> Self {
        Failed::Message(message)
    }
}

#[async_trait]
impl Dialect for L0185 {
    fn lang_id(&self) -> &str {
        "0185"
    }

    fn overrides(&self, op: &Op) -> bool {
        matches!(op, Op::Prog | Op::Take | Op::Drop | Op::Filter | Op::Map | Op::Last)
    }

    fn check(&self, ast: &Ast, errors: &mut Vec<Diagnostic>) {
        let exprs = match ast.get(ast.root()) {
            Some(Node::Form { op: Op::Prog, elts }) => elts.first().and_then(|id| ast.get(*id)),
            _ => None,
        };
        let elts = exprs.map(Node::elts).unwrap_or_default();
        let stray =
            elts.iter().take(elts.len().saturating_sub(1)).position(|id| tag_of_node(ast, *id).is_some_and(is_own_tag));
        if let Some(at) = stray {
            let message = format!(
                "A `{{}}` ended the program early: it has {} top-level expressions where one was expected, and the words after the early `{{}}` started a new one. A program is steps, then the source, then exactly one `{{}}`: write `where [\"age\" ABOVE 30] fetch \"https://…\" {{}}`, not `where [\"age\" ABOVE 30] {{}} fetch \"https://…\" {{}}`.",
                elts.len()
            );
            errors.push(Diagnostic::at(message, ast.span(elts[at + 1])));
        }
    }

    async fn eval(&self, cx: &mut Evaluator<'_>, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<Value> {
        let tag = op.tag();
        if tag == "PROG" {
            return Some(self.prog(cx, id).await);
        }
        if let Some((_, arg, instead)) = SHADOWED.iter().find(|(name, ..)| *name == tag) {
            let ast = cx.ast();
            if elts.get(*arg).and_then(|id| tag_of_node(ast, *id)).is_some_and(is_own_tag) {
                cx.report_diagnostic(Diagnostic::new(format!(
                    "`{}` is L0000's list function, not an L0185 step. Write: {instead}.",
                    tag.to_lowercase()
                )));
                return Some(Value::Undefined);
            }
            return Some(cx.eval_kernel(id).await);
        }
        if vocab::meta(tag).is_some() {
            return Some(match self.word(cx, id, tag, elts).await {
                Ok(state) => store(cx, state),
                Err(Failed::Message(message)) => {
                    cx.report_diagnostic(Diagnostic::new(message));
                    Value::Undefined
                }
                Err(Failed::Reported | Failed::Async) => Value::Undefined,
            });
        }
        None
    }
}

impl L0185 {
    /// The program's value is the data its last expression produced — nothing is added to it.
    async fn prog(&self, cx: &mut Evaluator<'_>, id: NodeId) -> Value {
        let value = cx.eval_kernel(id).await;
        if cx.error_count() > 0 {
            return Value::Undefined;
        }
        let fail = |cx: &mut Evaluator<'_>, message: String| {
            cx.report_diagnostic(Diagnostic::new(message));
            Value::Undefined
        };
        let Some(state) = state_of_value(cx, &value) else {
            return fail(cx, format!("A program is steps, then a source, then `{{}}`: e.g. {PROGRAM_EXAMPLE}"));
        };
        let Some(data) = &state.data else {
            return fail(
                cx,
                format!(
                    "The program has no source. Put fetch, rows or from last, just before `{{}}`: e.g. {PROGRAM_EXAMPLE}"
                ),
            );
        };
        if state.group_by.is_some() {
            return fail(cx, "group-by: has no summarize to its left. Write summarize {…} group-by […] …, e.g. summarize {orders: COUNT} group-by [\"region\"] fetch \"https://…\" {}.".to_owned());
        }
        if let Js::Arr(rows) = data
            && rows.len() > MAX_OUTPUT_ROWS
        {
            return fail(
                cx,
                format!(
                    "The result has {} records, more than the {MAX_OUTPUT_ROWS} L0185 returns. Add limit, or where, to keep fewer.",
                    rows.len()
                ),
            );
        }
        if js::stringify(data).map_or(0, |text| text.len()) > MAX_OUTPUT_BYTES {
            return fail(cx, "The result is larger than 1 MB, the most an item can hold. Use pick to keep only the fields you need, or limit.".to_owned());
        }
        output(data)
    }

    /// One word: its right-hand side, then its parameter, then itself.
    async fn word(&self, cx: &mut Evaluator<'_>, id: NodeId, name: &str, elts: &[NodeId]) -> Result<State, Failed> {
        let before = cx.error_count();
        let rest = cx.eval_arg(id, elts, 1).await;
        if cx.error_count() > before || compile(cx).went_async {
            return Err(Failed::Reported);
        }
        let param = self.read_param(cx, id, name, elts).await;
        if cx.error_count() > before {
            return Err(Failed::Reported);
        }
        if compile(cx).sync_depth > 0 {
            // The TypeScript applies a word in a later turn; a function applied to a record
            // cannot wait for one.
            compile(cx).went_async = true;
            return Err(Failed::Async);
        }
        let word = word_of(name);
        let state = self.state_of(cx, &word, name, &rest)?;
        let meta = vocab::meta(name).expect("a word is in the vocabulary");
        if meta.role == "option" {
            let Param::Value(value) = param else { unreachable!("an option's parameter is a value") };
            return Ok(steps::option(name, &value, &state)?);
        }
        Ok(match (name, param) {
            ("WHERE", Param::Lambda(lambda)) => self.where_fn(cx, lambda, &state).await?,
            ("WHERE", Param::Value(cond)) => steps::where_condition(&cond, &state)?,
            ("DERIVE", Param::Entries(entries)) => self.derive(cx, entries, &state).await?,
            ("DERIVE", Param::Value(value)) => {
                let Js::Arr(items) = value else {
                    return Err(Failed::Message(format!(
                        "derive: expects {{field: <row: …>}}, e.g. derive {{total: <row: mul (get \"price\" row) (get \"qty\" row)>}}. Got {}.",
                        show_value(&value)
                    )));
                };
                self.derive_list(items, &state)?
            }
            ("FETCH", Param::Value(url)) => {
                let url = steps::fetch_check(&url, &state)?;
                let body = self.fetch(cx, &url).await?;
                steps::fetch_finish(&url, &body, &state)?
            }
            (_, Param::Value(p)) => match name {
                "ROWS" => steps::rows_source(&p, &state)?,
                "FROM" => steps::from_source(&p, &state)?,
                "PICK" => steps::pick(&p, &state)?,
                "OMIT" => steps::omit(&p, &state)?,
                "RENAME" => steps::rename(&p, &state)?,
                "FILL" => steps::fill(&p, &state)?,
                "GROUP_BY" => steps::group_by(&p, &state)?,
                "SUMMARIZE" => steps::summarize(&p, &state)?,
                "SORT_BY" => steps::sort_by(&p, &state)?,
                "LIMIT" => steps::limit(&p, &state)?,
                "SKIP" => steps::skip(&p, &state)?,
                "DISTINCT" => steps::distinct(&p, &state)?,
                "UNNEST" => steps::unnest(&p, &state)?,
                "SPREAD" => steps::spread_step(&p, &state)?,
                "JOIN" => steps::join(&p, &state)?,
                "FORMAT" => steps::format(&p, &state)?,
                _ => unreachable!("every word has a step"),
            },
            _ => unreachable!("only where and derive take functions"),
        })
    }

    /// The record to a word's right: the state so far, or the program-ending `{}`.
    fn state_of(&self, cx: &mut Evaluator<'_>, word: &str, name: &str, rest: &Value) -> Result<State, Failed> {
        if let Some(state) = state_of_value(cx, rest) {
            return Ok((*state).clone());
        }
        // Only a word makes a state: a record literal that imitates one's object form
        // (`{__l0185: true}`) is just a record here.
        let plain = plain(cx, rest);
        if is_record(&plain) && js::entries(&plain).is_ok_and(|e| e.is_empty()) {
            return Ok(State::default());
        }
        let example = vocab::meta(name).map_or("", |m| m.example.as_str());
        Err(Failed::Message(format!(
            "{word}: everything to its right must be more of the program, ending in `{{}}`, e.g. {example}. Got {}.",
            show_value(&plain)
        )))
    }

    /// The parameter of a word. Functions are kept as their node and applied per record.
    async fn read_param(&self, cx: &mut Evaluator<'_>, id: NodeId, name: &str, elts: &[NodeId]) -> Param {
        let expects = vocab::meta(name).map_or("", |m| m.expects.as_str());
        if let Some(&pid) = elts.first() {
            let ast = cx.ast();
            let pid = unparen(ast, pid);
            match (expects, ast.get(pid)) {
                ("condition", Some(Node::Form { op: Op::Lambda, .. })) => return Param::Lambda(pid),
                ("lambda-record", Some(Node::Form { op: Op::Record, elts: bindings })) => {
                    let mut entries = Vec::with_capacity(bindings.len());
                    for &binding in bindings {
                        let Some(Node::Form { elts: pair, .. }) = ast.get(binding) else { continue };
                        let (key, value) = (pair.first().copied(), pair.get(1).copied());
                        let key = match key {
                            Some(key) => cx.eval(key).await,
                            None => Value::Undefined,
                        };
                        let key = match plain(cx, &key) {
                            Js::Obj(obj) if matches!(obj.get("tag"), Some(Js::Str(_))) => {
                                obj.get("tag").map(js::js_string).unwrap_or_default()
                            }
                            other => js::js_string(&other),
                        };
                        let Some(value) = value else { continue };
                        let vid = unparen(ast, value);
                        let entry = if matches!(ast.get(vid), Some(Node::Form { op: Op::Lambda, .. })) {
                            Entry::Lambda(vid)
                        } else {
                            let v = cx.eval(value).await;
                            Entry::Value(plain(cx, &v))
                        };
                        entries.push((key, entry));
                    }
                    return Param::Entries(entries);
                }
                _ => {}
            }
        }
        let value = cx.eval_arg(id, elts, 0).await;
        Param::Value(plain(cx, &value))
    }

    /// Applies a function written in the program to a record.
    async fn call(&self, cx: &mut Evaluator<'_>, lambda: NodeId, row: &Js) -> Result<Js, Failed> {
        let before = cx.error_count();
        compile(cx).sync_depth += 1;
        let value = cx.apply(lambda, vec![kernel_value(row)]).await;
        let compile = compile(cx);
        compile.sync_depth -= 1;
        if compile.went_async {
            if compile.sync_depth == 0 {
                compile.went_async = false;
            }
            return Err(Failed::Message(
                "A function given to a step must compute its value directly; it cannot fetch.".to_owned(),
            ));
        }
        if cx.error_count() > before {
            return Err(Failed::Reported);
        }
        Ok(plain(cx, &value))
    }

    async fn where_fn(&self, cx: &mut Evaluator<'_>, lambda: NodeId, state: &State) -> Result<State, Failed> {
        let rows = steps::where_rows(state)?.to_vec();
        let mut kept = Vec::new();
        for (i, row) in rows.into_iter().enumerate() {
            match self.call(cx, lambda, &row).await? {
                Js::Bool(true) => kept.push(row),
                Js::Bool(false) => {}
                other => {
                    return Err(Failed::Message(format!(
                        "where: the function returned {} for record {}; it must return true or false, e.g. where (<row: gt (get \"age\" row) 30>).",
                        show_value(&other),
                        i + 1
                    )));
                }
            }
        }
        Ok(steps::with_data(state.clone(), Js::Arr(kept))?)
    }

    async fn derive(
        &self,
        cx: &mut Evaluator<'_>,
        entries: Vec<(String, Entry)>,
        state: &State,
    ) -> Result<State, Failed> {
        steps::need_data("derive", state)?;
        let rows = self.rows("derive", state)?;
        if entries.is_empty() {
            return Err(Failed::Message("derive: expects {field: <row: …>}, e.g. derive {total: <row: mul (get \"price\" row) (get \"qty\" row)>}.".to_owned()));
        }
        let mut out = Vec::with_capacity(rows.len());
        for (i, row) in rows.iter().enumerate() {
            let mut rec = js::spread(row);
            for (field, entry) in &entries {
                let val = match entry {
                    Entry::Lambda(lambda) => self.call(cx, *lambda, &Js::Obj(rec.clone())).await?,
                    Entry::Value(v) => v.clone(),
                };
                if matches!(val, Js::Undef) {
                    return Err(Failed::Message(format!(
                        "derive: the function for {} returned nothing for record {}. Check its field names, e.g. derive {{{field}: <row: get \"price\" row>}}.",
                        js::quote(field),
                        i + 1
                    )));
                }
                rec.set(field.clone(), val);
            }
            out.push(Js::Obj(rec));
        }
        Ok(steps::with_data(state.clone(), Js::Arr(out))?)
    }

    /// `derive` given a list: each element is destructured as `[field, value]`.
    fn derive_list(&self, items: Vec<Js>, state: &State) -> Result<State, Failed> {
        steps::need_data("derive", state)?;
        let rows = self.rows("derive", state)?;
        if items.is_empty() {
            return Err(Failed::Message("derive: expects {field: <row: …>}, e.g. derive {total: <row: mul (get \"price\" row) (get \"qty\" row)>}.".to_owned()));
        }
        // `for (const [field, v] of entries)`: a list or text destructures; anything else fails
        // with the compiled loop's TypeError.
        let pairs: Vec<Result<(Js, Js), String>> = items
            .iter()
            .map(|item| match item {
                Js::Arr(items) => {
                    Ok((items.first().cloned().unwrap_or(Js::Undef), items.get(1).cloned().unwrap_or(Js::Undef)))
                }
                Js::Str(s) => {
                    let mut chars = s.chars().map(|c| Js::Str(c.to_string()));
                    Ok((chars.next().unwrap_or(Js::Undef), chars.next().unwrap_or(Js::Undef)))
                }
                _ => Err(".for is not iterable".to_owned()),
            })
            .collect();
        let mut out = Vec::with_capacity(rows.len());
        for (i, row) in rows.iter().enumerate() {
            let mut rec = js::spread(row);
            for pair in &pairs {
                let (field, val) = pair.clone()?;
                let field = js::js_string(&field);
                if matches!(val, Js::Undef) {
                    return Err(Failed::Message(format!(
                        "derive: the function for {} returned nothing for record {}. Check its field names, e.g. derive {{{field}: <row: get \"price\" row>}}.",
                        js::quote(&field),
                        i + 1
                    )));
                }
                rec.set(field, val);
            }
            out.push(Js::Obj(rec));
        }
        Ok(steps::with_data(state.clone(), Js::Arr(out))?)
    }

    fn rows(&self, word: &str, state: &State) -> Result<Vec<Js>, Failed> {
        match &state.data {
            Some(Js::Arr(rows)) => Ok(rows.clone()),
            other => Err(Failed::Message(format!(
                "{word}: needs a list of records, but the data to its right is {}. Use at \"…\" on the fetch to reach the list.",
                show_value(other.as_ref().unwrap_or(&Js::Undef))
            ))),
        }
    }

    /// A URL, fetched at most once per compile; at most [`MAX_URLS`] different ones.
    async fn fetch(&self, cx: &mut Evaluator<'_>, url: &str) -> Result<FetchResult, Failed> {
        if let Some(done) = compile(cx).fetches.get(url) {
            return Ok(done.clone()?);
        }
        if compile(cx).fetches.len() >= MAX_URLS {
            return Err(Failed::Message(format!("fetch: a program may fetch at most {MAX_URLS} different URLs.")));
        }
        let Some(fetcher) = &self.fetcher else {
            return Err(Failed::Message("fetch: fetching is not available here.".to_owned()));
        };
        let result = fetcher.fetch(url).await;
        compile(cx).fetches.insert(url.to_owned(), result.clone());
        Ok(result?)
    }
}
