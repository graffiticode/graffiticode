// SPDX-License-Identifier: MIT

//! Evaluation: a program's AST, its upstream data and its config in, a [`Value`] out.
//!
//! Errors do not stop evaluation. Each is recorded and a neutral value stands in for the failed
//! operation, so one compile reports every problem it can find; a compile with any error has no
//! result.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use serde_json::Value as Json;

use crate::ast::{Ast, Node, NodeId, Op};
use crate::dialect::Dialect;
use crate::error::Diagnostic;
use crate::exec::ExecContext;
use crate::format::format_number;
use crate::number::{BinaryOp, Decimal, Number};
use crate::schema::{LanguageSchema, SchemaSource};
use crate::secret::Keyring;
use crate::value::{Key, Lambda, Record, Value};

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How deeply expressions may nest. The parser inlines every `let` and every applied function,
/// and a template is a chain of `concat`s as long as it has interpolations, so real programs
/// nest far deeper than they read. The limit exists to stop an AST that refers to itself.
const MAX_DEPTH: usize = 10_000;
/// Evaluation recurses through the AST; when less than this much stack is left, it continues
/// on a fresh segment.
const STACK_RED_ZONE: usize = 256 * 1024;
const STACK_SEGMENT: usize = 4 * 1024 * 1024;

/// The evaluation of one node. Each node gets its own heap-allocated future, and polling it
/// grows the stack on demand, so nesting depth is bounded by [`MAX_DEPTH`] rather than by the
/// thread's stack.
pub struct Eval<'a>(BoxFuture<'a, Value>);

impl Future for Eval<'_> {
    type Output = Value;

    fn poll(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Value> {
        stacker::maybe_grow(STACK_RED_ZONE, STACK_SEGMENT, || self.0.as_mut().poll(cx))
    }
}
/// The most elements `range` will produce.
const MAX_RANGE: usize = 1_000_000;

pub struct Evaluator<'e> {
    ast: &'e Ast,
    dialect: &'e dyn Dialect,
    schemas: &'e dyn SchemaSource,
    keyring: &'e Keyring,
    data: &'e Value,
    config: &'e Value,
    exec: &'e mut ExecContext,
    /// Bindings made by function application and `case`, innermost last.
    scopes: Vec<Vec<(String, Value)>>,
    /// `set-var` / `get-var`.
    vars: HashMap<String, Value>,
    /// Arguments on their way to the function being applied. See [`Evaluator::apply`].
    args: Option<Vec<Value>>,
    errors: Vec<Diagnostic>,
    depth: usize,
}

pub(crate) struct Context<'e> {
    pub ast: &'e Ast,
    pub dialect: &'e dyn Dialect,
    pub schemas: &'e dyn SchemaSource,
    pub keyring: &'e Keyring,
    pub data: &'e Value,
    pub config: &'e Value,
    pub exec: &'e mut ExecContext,
}

impl<'e> Evaluator<'e> {
    pub(crate) fn new(cx: Context<'e>) -> Self {
        Self {
            ast: cx.ast,
            dialect: cx.dialect,
            schemas: cx.schemas,
            keyring: cx.keyring,
            data: cx.data,
            config: cx.config,
            exec: cx.exec,
            scopes: Vec::new(),
            vars: HashMap::new(),
            args: None,
            errors: Vec::new(),
            depth: 0,
        }
    }

    pub(crate) async fn run(mut self) -> Result<Value, Vec<Diagnostic>> {
        let value = self.eval(self.ast.root()).await;
        if self.errors.is_empty() { Ok(value) } else { Err(self.errors) }
    }

    pub fn ast(&self) -> &'e Ast {
        self.ast
    }

    /// The upstream value this task was chained onto (what `data` reads).
    pub fn data(&self) -> &'e Value {
        self.data
    }

    pub fn config(&self) -> &'e Value {
        self.config
    }

    /// This invocation's authorization context.
    pub fn exec(&mut self) -> &mut ExecContext {
        self.exec
    }

    /// Records a compile error at a node. Evaluation continues.
    pub fn report(&mut self, at: NodeId, message: impl Into<String>) {
        self.errors.push(Diagnostic::at(message, self.ast.span(at)));
    }

    /// Records a compile error that carries structured fields (a refusal's code and category,
    /// the function and step that failed). Evaluation continues.
    pub fn report_diagnostic(&mut self, diagnostic: Diagnostic) {
        self.errors.push(diagnostic);
    }

    /// Evaluates a node.
    pub fn eval(&mut self, id: NodeId) -> Eval<'_> {
        Eval(Box::pin(async move {
            let ast = self.ast;
            // Pending arguments belong to this node alone. Taking them here keeps them from
            // reaching any subexpression `kernel` does not deliberately forward them to.
            let args = self.args.take();
            let Some(node) = ast.get(id) else {
                self.report(id, format!("1001: Node ID {id} not found in pool."));
                return Value::Undefined;
            };
            if self.depth == MAX_DEPTH {
                self.report(id, "Expressions are nested too deeply.");
                return Value::Undefined;
            }
            self.depth += 1;
            let offered = match node {
                Node::Form { op, elts } if matches!(op, Op::Dialect(_)) || self.dialect.overrides(op) => {
                    let dialect = self.dialect;
                    dialect.eval(self, id, op, elts).await
                }
                _ => None,
            };
            let value = match offered {
                Some(value) => value,
                None => self.kernel(id, node, args).await,
            };
            self.depth -= 1;
            value
        }))
    }

    /// Evaluates a node with L0000's meaning, bypassing the dialect for this node only. A
    /// dialect that overrides a kernel operator uses it to wrap the base behavior.
    pub fn eval_kernel(&mut self, id: NodeId) -> Eval<'_> {
        Eval(Box::pin(async move {
            let ast = self.ast;
            let args = self.args.take();
            match ast.get(id) {
                Some(node) => self.kernel(id, node, args).await,
                None => {
                    self.report(id, format!("1001: Node ID {id} not found in pool."));
                    Value::Undefined
                }
            }
        }))
    }

    /// Evaluates the `index`th element of the node `at`, reporting an error if it has none.
    pub async fn eval_arg(&mut self, at: NodeId, elts: &[NodeId], index: usize) -> Value {
        match self.elt(at, elts, index) {
            Some(elt) => self.eval(elt).await,
            None => Value::Undefined,
        }
    }

    /// Applies the function written at `function` to `args`.
    ///
    /// Functions are not values that carry a body: one is applied by evaluating its node with
    /// arguments pending. A `LAMBDA` consumes them, parentheses and sequences pass them on to
    /// the expression that yields their value, and anything else ignores them.
    pub async fn apply(&mut self, function: NodeId, args: Vec<Value>) -> Value {
        self.args = Some(args);
        let value = self.eval(function).await;
        self.args = None;
        value
    }

    fn elt(&mut self, at: NodeId, elts: &[NodeId], index: usize) -> Option<NodeId> {
        let elt = elts.get(index).copied();
        if elt.is_none() {
            let tag = match self.ast.get(at) {
                Some(Node::Form { op, .. }) => op.tag(),
                _ => "node",
            };
            self.report(at, format!("{tag} is missing argument {}.", index + 1));
        }
        elt
    }

    fn lookup(&self, name: &str) -> Option<&Value> {
        self.scopes.iter().rev().flat_map(|scope| scope.iter().rev()).find(|(bound, _)| bound == name).map(|(_, v)| v)
    }

    async fn kernel(&mut self, id: NodeId, node: &'e Node, args: Option<Vec<Value>>) -> Value {
        let (op, elts) = match node {
            Node::Num(n) => return Value::Num(n.clone()),
            Node::Str(s) => return Value::Str(s.clone()),
            Node::Bool(b) => return Value::Bool(*b),
            Node::Tag(name) => return Value::Tag(name.clone()),
            Node::Null => return Value::Null,
            // A name nothing binds stands for itself.
            Node::Ident(name) => return self.lookup(name).cloned().unwrap_or_else(|| Value::Str(name.clone())),
            Node::Form { op, elts } => (op, elts.as_slice()),
        };
        match op {
            Op::Prog => self.eval_arg(id, elts, 0).await,
            Op::Exprs => self.sequence(elts, args).await,
            // Parens only group.
            Op::Paren => {
                self.args = args;
                self.eval_arg(id, elts, 0).await
            }
            Op::List => {
                let mut items = Vec::with_capacity(elts.len());
                for &elt in elts {
                    items.push(self.eval(elt).await);
                }
                Value::List(items)
            }
            Op::Record => self.record(elts).await,
            Op::Lambda => self.lambda(id, elts, args).await,
            Op::Apply => {
                let args = match self.eval_arg(id, elts, 1).await {
                    Value::List(args) => args,
                    arg => vec![arg],
                };
                match self.elt(id, elts, 0) {
                    Some(function) => self.apply(function, args).await,
                    None => Value::Undefined,
                }
            }
            Op::Map | Op::Filter => self.map_or_filter(id, op, elts).await,
            Op::Reduce => {
                let mut acc = self.eval_arg(id, elts, 1).await;
                let list = self.eval_arg(id, elts, 2).await;
                let (Value::List(items), Some(function)) = (&list, elts.first().copied()) else {
                    // The accumulator stands: `reduce` over nothing is the initial value.
                    self.report(id, list_arg_error("reduce", &list));
                    return acc;
                };
                for item in items {
                    acc = self.apply(function, vec![acc, item.clone()]).await;
                }
                acc
            }
            Op::Case => self.case(id, elts).await,
            Op::If => {
                let branch = if self.eval_arg(id, elts, 0).await.is_truthy() { 1 } else { 2 };
                self.eval_arg(id, elts, branch).await
            }

            Op::Add | Op::Sub | Op::Mul | Op::Div | Op::Mod | Op::Pow | Op::Min | Op::Max => {
                match self.operands(id, op, elts).await {
                    Some((a, b)) => Value::Num(a.evaluate(binary_op(op), &b)),
                    None => Value::Num(Number::NAN),
                }
            }
            Op::Eq | Op::Ne | Op::Lt | Op::Le | Op::Gt | Op::Ge => {
                let Some((a, b)) = self.operands(id, op, elts).await else { return Value::Bool(false) };
                let ordering = a.compare(&b);
                Value::Bool(match op {
                    Op::Eq => ordering == Some(Ordering::Equal),
                    Op::Ne => ordering != Some(Ordering::Equal),
                    Op::Lt => ordering == Some(Ordering::Less),
                    Op::Le => matches!(ordering, Some(Ordering::Less | Ordering::Equal)),
                    Op::Gt => ordering == Some(Ordering::Greater),
                    _ => matches!(ordering, Some(Ordering::Greater | Ordering::Equal)),
                })
            }
            Op::Range => self.range(id, elts).await,

            Op::Not => Value::Bool(!self.eval_arg(id, elts, 0).await.is_truthy()),
            // `and` and `or` evaluate their second operand only when the first does not decide.
            Op::And => Value::Bool(
                self.eval_arg(id, elts, 0).await.is_truthy() && self.eval_arg(id, elts, 1).await.is_truthy(),
            ),
            Op::Or => Value::Bool(
                self.eval_arg(id, elts, 0).await.is_truthy() || self.eval_arg(id, elts, 1).await.is_truthy(),
            ),
            Op::Equiv => {
                let a = self.eval_arg(id, elts, 0).await;
                let b = self.eval_arg(id, elts, 1).await;
                Value::Bool(a == b)
            }

            Op::Concat => {
                let a = self.eval_arg(id, elts, 0).await;
                let b = self.eval_arg(id, elts, 1).await;
                match (a, b) {
                    (Value::Str(a), Value::Str(b)) => Value::Str(a + &b),
                    (Value::List(mut a), Value::List(b)) => {
                        a.extend(b);
                        Value::List(a)
                    }
                    _ => {
                        self.report(
                            id,
                            "Error in CONCAT operation: both arguments must be strings or both must be lists",
                        );
                        Value::Undefined
                    }
                }
            }
            Op::StrOf => Value::Str(self.eval_arg(id, elts, 0).await.display()),
            Op::FormatNumber => {
                let pattern = self.eval_arg(id, elts, 0).await;
                let value = self.eval_arg(id, elts, 1).await;
                let formatted = match (&pattern, &value) {
                    (Value::Str(pattern), Value::Num(value)) => {
                        format_number(pattern, value).map_err(|err| err.to_string())
                    }
                    (Value::Str(_), other) => Err(format!("expected a number, got {}", other.display_source())),
                    (other, _) => Err(format!("the pattern must be a string, got {}", other.display_source())),
                };
                Value::Str(formatted.unwrap_or_else(|problem| {
                    self.report(id, format!("format-number: {problem}"));
                    String::new()
                }))
            }
            Op::Json => match self.eval_arg(id, elts, 0).await {
                Value::Str(text) => match serde_json::from_str::<Json>(&text) {
                    Ok(json) => Value::from_json(&json),
                    Err(err) => {
                        self.report(id, format!("Error in JSON operation: {err}"));
                        Value::Undefined
                    }
                },
                other => {
                    self.report(id, format!("Error in JSON operation: expected a string, got {}", other.kind()));
                    Value::Undefined
                }
            },
            Op::Length => Value::from(match self.eval_arg(id, elts, 0).await {
                Value::Record(record) => record.len(),
                Value::List(items) => items.len(),
                // Counted as every other Graffiticode component counts it: in UTF-16 units.
                Value::Str(s) => s.encode_utf16().count(),
                _ => 0,
            } as f64),

            Op::Get => {
                let key = self.eval_arg(id, elts, 0).await;
                let container = self.eval_arg(id, elts, 1).await;
                member(&container, &key).unwrap_or_else(|| {
                    self.report(id, format!("get: expected a record or list, got {}", container.kind()));
                    Value::Undefined
                })
            }
            // `VAL` is what the parser lowers a destructuring pattern to. A pattern that does
            // not fit its value binds nothing rather than failing.
            Op::Val => {
                let key = self.eval_arg(id, elts, 0).await;
                let container = self.eval_arg(id, elts, 1).await;
                member(&container, &key).unwrap_or(Value::Undefined)
            }
            Op::Nth => {
                let index = self.eval_arg(id, elts, 0).await;
                let container = self.eval_arg(id, elts, 1).await;
                if !matches!(index, Value::Num(_)) {
                    self.report(id, format!("nth: expected a number, got {}", index.kind()));
                    return Value::Undefined;
                }
                member(&container, &index).unwrap_or_else(|| {
                    self.report(id, format!("nth: expected a list or record, got {}", container.kind()));
                    Value::Undefined
                })
            }
            Op::Set => {
                let key = self.eval_arg(id, elts, 0).await;
                let value = self.eval_arg(id, elts, 1).await;
                match self.eval_arg(id, elts, 2).await {
                    Value::Record(mut record) => {
                        record.insert(Key::of(&key), value);
                        Value::Record(record)
                    }
                    other => {
                        self.report(id, format!("set: expected a record, got {}", other.kind()));
                        Value::Undefined
                    }
                }
            }

            Op::Hd | Op::Tl | Op::Last | Op::IsEmpty => {
                let Some(mut items) = self.list_arg(id, op, elts, 0).await else {
                    return match op {
                        Op::Tl => Value::List(Vec::new()),
                        Op::IsEmpty => Value::Bool(false),
                        _ => Value::Null,
                    };
                };
                match op {
                    Op::IsEmpty => Value::Bool(items.is_empty()),
                    Op::Hd | Op::Tl | Op::Last if items.is_empty() => {
                        let (what, fallback) = match op {
                            Op::Hd => ("head", Value::Null),
                            Op::Tl => ("tail", Value::List(Vec::new())),
                            _ => ("last element", Value::Null),
                        };
                        self.report(id, format!("Error in {op} operation: empty list has no {what}"));
                        fallback
                    }
                    Op::Hd => items.swap_remove(0),
                    Op::Tl => Value::List(items.split_off(1)),
                    _ => items.pop().unwrap_or(Value::Null),
                }
            }
            Op::Cons | Op::Append => {
                let item = self.eval_arg(id, elts, 0).await;
                match self.list_arg(id, op, elts, 1).await {
                    Some(mut items) => {
                        let at = if *op == Op::Cons { 0 } else { items.len() };
                        items.insert(at, item);
                        Value::List(items)
                    }
                    None => Value::List(vec![item]),
                }
            }
            Op::Drop | Op::Take => {
                let count = self.eval_arg(id, elts, 0).await;
                let Some(mut items) = self.list_arg(id, op, elts, 1).await else { return Value::List(Vec::new()) };
                // A negative count is taken from the end, as in a slice.
                let split = slice_index(&count, items.len());
                Value::List(if *op == Op::Drop {
                    items.split_off(split)
                } else {
                    items.truncate(split);
                    items
                })
            }

            Op::Data => self.data_form(id, elts).await,
            Op::Use => match self.schema_of(id, elts).await {
                Some(_) => Value::Record(Record::new()),
                None => Value::Null,
            },
            Op::Print => {
                let value = self.eval_arg(id, elts, 0).await;
                Value::Record([(Key::tag("print"), value)].into_iter().collect())
            }
            Op::Log => {
                let value = self.eval_arg(id, elts, 0).await;
                tracing::info!(target: "graffiticode::log", "LOG: {}", value.display());
                value
            }
            Op::GetVar => {
                let name = self.eval_arg(id, elts, 0).await.display();
                match (self.vars.get(&name), name.as_str()) {
                    (Some(value), _) => value.clone(),
                    (None, "data") => self.data.clone(),
                    (None, "config") => self.config.clone(),
                    (None, _) => Value::Undefined,
                }
            }
            Op::SetVar => {
                let name = self.eval_arg(id, elts, 0).await.display();
                let value = self.eval_arg(id, elts, 1).await;
                self.vars.insert(name, value.clone());
                value
            }
            // The value was resolved by name when the program was saved; a private one was
            // stored encrypted. One that cannot be opened is passed through as it is.
            Op::GetValPublic => self.eval_arg(id, elts, 1).await,
            Op::GetValPrivate => match self.eval_arg(id, elts, 1).await {
                Value::Str(stored) => Value::Str(self.keyring.decrypt(&stored).unwrap_or(stored)),
                other => other,
            },

            Op::Error | Op::Binding | Op::Of | Op::Dialect(_) => {
                self.report(id, format!("1004: No visitor method defined for '{op}'."));
                Value::Undefined
            }
        }
    }

    /// A sequence of expressions has the value of its last. A function followed by expressions
    /// is an application: the parser folds `<x y: add x y> 10` itself, but leaves a
    /// parenthesized function (`(add) 1`, `(<x y: add x y>) 10`) as a bare sequence.
    async fn sequence(&mut self, elts: &[NodeId], mut args: Option<Vec<Value>>) -> Value {
        if let [function, rest @ ..] = elts
            && !rest.is_empty()
            && self.is_function(*function)
        {
            let mut operands = Vec::with_capacity(rest.len());
            for &elt in rest {
                operands.push(self.eval(elt).await);
            }
            return self.apply(*function, operands).await;
        }
        let mut last = Value::Str(String::new());
        for (i, &elt) in elts.iter().enumerate() {
            if i + 1 == elts.len() {
                self.args = args.take();
            }
            last = self.eval(elt).await;
        }
        last
    }

    fn is_function(&self, id: NodeId) -> bool {
        matches!(self.ast.get(unparenthesized(self.ast, id)), Some(Node::Form { op: Op::Lambda, .. }))
    }

    /// With no application in progress a lambda is itself the value. Given fewer arguments
    /// than parameters (`(add) 1`) it is partially applied: a lambda over the parameters still
    /// unbound. Otherwise its body is evaluated with the parameters bound.
    async fn lambda(&mut self, id: NodeId, elts: &[NodeId], args: Option<Vec<Value>>) -> Value {
        let ast = self.ast;
        let mut params: Vec<String> = elts
            .first()
            .and_then(|&list| ast.get(list))
            .map(Node::elts)
            .unwrap_or_default()
            .iter()
            .filter_map(|&param| match ast.get(param) {
                Some(Node::Ident(name)) => Some(name.clone()),
                _ => None,
            })
            .collect();
        let Some(args) = args else { return Value::Lambda(Lambda { params }) };
        if !args.is_empty() && args.len() < params.len() {
            return Value::Lambda(Lambda { params: params.split_off(args.len()) });
        }
        self.scopes.push(params.into_iter().zip(args).collect());
        let value = self.eval_arg(id, elts, 1).await;
        self.scopes.pop();
        value
    }

    async fn record(&mut self, elts: &[NodeId]) -> Value {
        let ast = self.ast;
        let mut record = Record::new();
        for &elt in elts {
            let Some(Node::Form { op: Op::Binding, elts: pair }) = ast.get(elt) else {
                self.report(elt, "A record field must be a binding.");
                continue;
            };
            let key = self.eval_arg(elt, pair, 0).await;
            let value = self.eval_arg(elt, pair, 1).await;
            record.insert(Key::of(&key), value);
        }
        Value::Record(record)
    }

    /// `map` and `filter` pass each element as ONE argument.
    async fn map_or_filter(&mut self, id: NodeId, op: &Op, elts: &[NodeId]) -> Value {
        let word = if *op == Op::Map { "map" } else { "filter" };
        let (items, function) = match (self.eval_arg(id, elts, 1).await, elts.first()) {
            (Value::List(items), Some(&function)) => (items, function),
            (other, _) => {
                self.report(id, list_arg_error(word, &other));
                return Value::List(Vec::new());
            }
        };
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            if *op == Op::Map {
                out.push(self.apply(function, vec![item]).await);
            } else if self.apply(function, vec![item.clone()]).await.is_truthy() {
                out.push(item);
            }
        }
        Value::List(out)
    }

    /// The first clause whose pattern matches wins, and its pattern's variables are bound for
    /// its value only. With no match the value is an empty record.
    async fn case(&mut self, id: NodeId, elts: &[NodeId]) -> Value {
        let ast = self.ast;
        let subject = self.eval_arg(id, elts, 0).await;
        for &clause in elts.iter().skip(1) {
            let Some(Node::Form { op: Op::Of, elts: clause }) = ast.get(clause) else { continue };
            let &[pattern, value] = clause.as_slice() else { continue };
            let mut bindings = Vec::new();
            if bind_pattern(ast, pattern, &subject, &mut bindings) {
                self.scopes.push(bindings);
                let value = self.eval(value).await;
                self.scopes.pop();
                return value;
            }
        }
        Value::Record(Record::new())
    }

    async fn operands(&mut self, id: NodeId, op: &Op, elts: &[NodeId]) -> Option<(Decimal, Decimal)> {
        let a = self.eval_arg(id, elts, 0).await;
        let b = self.eval_arg(id, elts, 1).await;
        match (Decimal::from_value(&a), Decimal::from_value(&b)) {
            (Ok(a), Ok(b)) => Some((a, b)),
            (Err(err), _) | (_, Err(err)) => {
                self.report(id, format!("Error in {op} operation: {err}"));
                None
            }
        }
    }

    async fn list_arg(&mut self, id: NodeId, op: &Op, elts: &[NodeId], index: usize) -> Option<Vec<Value>> {
        match self.eval_arg(id, elts, index).await {
            Value::List(items) => Some(items),
            other => {
                self.report(id, format!("Error in {op} operation: expected a list, got {}", other.kind()));
                None
            }
        }
    }

    async fn range(&mut self, id: NodeId, elts: &[NodeId]) -> Value {
        let start = self.eval_arg(id, elts, 0).await;
        let end = self.eval_arg(id, elts, 1).await;
        let step = self.eval_arg(id, elts, 2).await;
        let bounds = [&start, &end, &step].map(Decimal::from_value);
        let [Ok(start), Ok(end), Ok(step)] = bounds else {
            let err = bounds.into_iter().find_map(Result::err).expect("a bound failed to parse");
            self.report(id, format!("Error in RANGE operation: {err}"));
            return Value::List(Vec::new());
        };
        let problem = if step.is_zero() {
            Some("step cannot be zero")
        } else if !(start.is_finite() && end.is_finite() && step.is_finite()) {
            Some("start, end and step must be finite")
        } else {
            None
        };
        if let Some(problem) = problem {
            self.report(id, format!("Error in RANGE operation: {problem}"));
            return Value::List(Vec::new());
        }
        let toward = if step.compare(&Decimal::from(0.0)) == Some(Ordering::Greater) {
            Ordering::Less
        } else {
            Ordering::Greater
        };
        let mut items = Vec::new();
        let mut current = start;
        while current.compare(&end) == Some(toward) {
            if items.len() == MAX_RANGE {
                self.report(id, format!("Error in RANGE operation: more than {MAX_RANGE} elements"));
                return Value::List(Vec::new());
            }
            items.push(Value::Num(current.clone().into_number()));
            current = current.apply(BinaryOp::Add, &step);
        }
        Value::List(items)
    }

    /// `data <fallback>`: the upstream value merged over the fallback, or the fallback alone
    /// when nothing is bound upstream. With `data use "<lang>"` the upstream value must first
    /// conform to that language's schema.
    async fn data_form(&mut self, id: NodeId, elts: &[NodeId]) -> Value {
        let ast = self.ast;
        let arg = elts.first().map(|&arg| unparenthesized(ast, arg));
        let (fallback, schema) = match arg.and_then(|arg| Some((arg, ast.get(arg)?))) {
            Some((used, Node::Form { op: Op::Use, elts })) => match self.schema_of(used, elts).await {
                Some(schema) => (Value::Record(Record::new()), Some(schema)),
                None => return Value::Null,
            },
            _ => (self.eval_arg(id, elts, 0).await, None),
        };
        let upstream = self.data;
        let bound = match upstream {
            Value::Undefined | Value::Null => false,
            Value::Record(record) => !record.is_empty(),
            Value::List(items) => !items.is_empty(),
            _ => true,
        };
        if !bound {
            return fallback;
        }
        if let Some(schema) = schema {
            let violations = schema.validate(&upstream.to_json().unwrap_or(Json::Null));
            if !violations.is_empty() {
                for violation in violations {
                    self.report(id, violation);
                }
                return Value::Null;
            }
        }
        let mut merged = match fallback {
            Value::Record(record) => record,
            _ => Record::new(),
        };
        match upstream {
            Value::Record(record) => merged.extend(record.iter().map(|(key, value)| (key.clone(), value.clone()))),
            Value::List(items) => {
                merged.extend(items.iter().enumerate().map(|(i, item)| (Key::tag(i.to_string()), item.clone())))
            }
            _ => {}
        }
        Value::Record(merged)
    }

    /// The schema a `USE` node names, or `None` after reporting why there is none.
    async fn schema_of(&mut self, id: NodeId, elts: &[NodeId]) -> Option<std::sync::Arc<LanguageSchema>> {
        let lang = match self.eval_arg(id, elts, 0).await {
            Value::Str(lang) => lang,
            _ => String::new(),
        };
        if !(3..=5).contains(&lang.len()) || !lang.bytes().all(|b| b.is_ascii_digit()) {
            self.report(id, format!("use: argument must be a language id, got \"{lang}\""));
            return None;
        }
        match self.schemas.schema(&lang).await {
            Ok(schema) => Some(schema),
            Err(err) => {
                self.report(id, format!("use: failed to load L{lang}/schema.json: {err}"));
                None
            }
        }
    }
}

/// The node inside any parentheses around `id`.
fn unparenthesized(ast: &Ast, mut id: NodeId) -> NodeId {
    // Bounded, so a PAREN that contains itself cannot spin.
    for _ in 0..MAX_DEPTH {
        match ast.get(id) {
            Some(Node::Form { op: Op::Paren, elts }) if !elts.is_empty() => id = elts[0],
            _ => break,
        }
    }
    id
}

fn binary_op(op: &Op) -> BinaryOp {
    match op {
        Op::Add => BinaryOp::Add,
        Op::Sub => BinaryOp::Sub,
        Op::Mul => BinaryOp::Mul,
        Op::Div => BinaryOp::Div,
        Op::Mod => BinaryOp::Mod,
        Op::Pow => BinaryOp::Pow,
        Op::Min => BinaryOp::Min,
        Op::Max => BinaryOp::Max,
        other => unreachable!("{other} is not arithmetic"),
    }
}

/// `get` on a missing key is `undefined` by design, so `map (fn) (get "items" (data {}))` with
/// nothing bound upstream is a common mistake; name it.
fn list_arg_error(word: &str, value: &Value) -> String {
    let got = match value {
        Value::Undefined => "undefined (a missing key or unbound upstream?)",
        other => other.kind(),
    };
    format!("{word}: expected a list, got {got}")
}

/// The member of a record or list a key selects: `Undefined` if it has none, `None` if the
/// container is neither.
fn member(container: &Value, key: &Value) -> Option<Value> {
    match container {
        Value::Record(record) => Some(record.get(&Key::of(key)).cloned().unwrap_or(Value::Undefined)),
        Value::List(items) => Some(match key {
            Value::Num(Number::Float(n)) if n.fract() == 0.0 && *n >= 0.0 => {
                items.get(*n as usize).cloned().unwrap_or(Value::Undefined)
            }
            _ => Value::Undefined,
        }),
        _ => None,
    }
}

/// Where a count splits a list of `len`: clamped to the list, and counted from the end when
/// negative.
fn slice_index(count: &Value, len: usize) -> usize {
    let n = match count {
        Value::Num(n) => n.to_f64(),
        Value::Str(s) => s.trim().parse().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        _ => f64::NAN,
    };
    let n = if n.is_nan() { 0.0 } else { n.trunc() };
    if n < 0.0 { (len as f64 + n).max(0.0) as usize } else { n.min(len as f64) as usize }
}

/// Matches `value` against the pattern at `pattern`, collecting the variables it binds. Lists
/// match EXACTLY their length; records are OPEN (a record pattern names the keys it needs, and
/// extra keys are ignored).
fn bind_pattern(ast: &Ast, pattern: NodeId, value: &Value, bindings: &mut Vec<(String, Value)>) -> bool {
    match (ast.get(pattern), value) {
        (Some(Node::Ident(name)), _) => {
            bindings.push((name.clone(), value.clone()));
            true
        }
        (Some(Node::Tag(name)), _) if name == "_" => true,
        (Some(Node::Tag(name)), Value::Tag(tag)) => name == tag,
        (Some(Node::Num(n)), Value::Num(m)) => n == m,
        (Some(Node::Str(s)), Value::Str(t)) => s == t,
        (Some(Node::Bool(b)), Value::Bool(c)) => b == c,
        (Some(Node::Null), Value::Null) => true,
        (Some(Node::Form { op: Op::List, elts }), Value::List(items)) => {
            elts.len() == items.len()
                && elts.iter().zip(items).all(|(&elt, item)| bind_pattern(ast, elt, item, bindings))
        }
        (Some(Node::Form { op: Op::Record, elts }), Value::Record(record)) => elts.iter().all(|&field| {
            let Some(Node::Form { op: Op::Binding, elts: pair }) = ast.get(field) else { return false };
            let &[key, pattern] = pair.as_slice() else { return false };
            let key = match ast.get(key) {
                Some(Node::Tag(name)) => Key::tag(name.as_str()),
                Some(Node::Str(name)) => Key::str(name.as_str()),
                Some(Node::Num(n)) => Key::num(n.clone()),
                _ => return false,
            };
            match record.get(&key) {
                Some(Value::Undefined) | None => false,
                Some(field) => bind_pattern(ast, pattern, field, bindings),
            }
        }),
        _ => false,
    }
}
