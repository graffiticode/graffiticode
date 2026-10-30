// SPDX-License-Identifier: MIT

//! The AST the parser hands a language server: a flat pool of nodes keyed by id, with `root`
//! naming the entry node.
//!
//! The wire form is `{ "root": 8, "2": { "tag": "NUM", "elts": ["1"] }, ... }`. Literal nodes
//! (`NUM`, `STR`, `IDENT`, `BOOL`, `TAG`, `NULL`) carry their payload in `elts[0]`; every other
//! node's `elts` are the ids of its children. [`Ast::from_json`] resolves that distinction once,
//! so nothing downstream has to guess whether an element is a value or a reference.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value as Json;

use crate::number::Number;

/// A node id within an [`Ast`]. The parser uses `0` for "no node".
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId(pub u32);

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Source offsets of a node, when the parser recorded them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub from: u32,
    pub to: u32,
}

macro_rules! ops {
    ($($variant:ident => $tag:literal,)*) => {
        /// The operator of a non-literal node. Tags the kernel does not define belong to a
        /// dialect and are carried as [`Op::Dialect`].
        #[derive(Clone, Debug, PartialEq, Eq, Hash)]
        pub enum Op {
            $($variant,)*
            Dialect(Box<str>),
        }

        impl Op {
            pub fn from_tag(tag: &str) -> Self {
                match tag {
                    $($tag => Op::$variant,)*
                    other => Op::Dialect(other.into()),
                }
            }

            /// The node tag, which is also the `name` of the lexicon entry that produces it.
            pub fn tag(&self) -> &str {
                match self {
                    $(Op::$variant => $tag,)*
                    Op::Dialect(tag) => tag,
                }
            }
        }
    };
}

ops! {
    Prog => "PROG",
    Exprs => "EXPRS",
    Paren => "PAREN",
    Error => "ERROR",
    List => "LIST",
    Record => "RECORD",
    Binding => "BINDING",
    Lambda => "LAMBDA",
    Apply => "APPLY",
    Map => "MAP",
    Filter => "FILTER",
    Reduce => "REDUCE",
    Case => "CASE",
    Of => "OF",
    If => "IF",
    Add => "ADD",
    Sub => "SUB",
    Mul => "MUL",
    Div => "DIV",
    Mod => "MOD",
    Pow => "POW",
    Min => "MIN",
    Max => "MAX",
    Eq => "EQ",
    Ne => "NE",
    Lt => "LT",
    Le => "LE",
    Gt => "GT",
    Ge => "GE",
    Not => "NOT",
    And => "AND",
    Or => "OR",
    Equiv => "EQUIV",
    Concat => "CONCAT",
    StrOf => "STR_OF",
    FormatNumber => "FORMAT_NUMBER",
    Json => "JSON",
    Length => "LENGTH",
    Get => "GET",
    Set => "SET",
    Nth => "NTH",
    Val => "VAL",
    Hd => "HD",
    Tl => "TL",
    Last => "LAST",
    IsEmpty => "ISEMPTY",
    Cons => "CONS",
    Append => "APPEND",
    Drop => "DROP",
    Take => "TAKE",
    Range => "RANGE",
    Data => "DATA",
    Use => "USE",
    Print => "PRINT",
    Log => "LOG",
    GetVar => "GET_VAR",
    SetVar => "SET_VAR",
    GetValPrivate => "GET_VAL_PRIVATE",
    GetValPublic => "GET_VAL_PUBLIC",
}

impl fmt::Display for Op {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.tag())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Num(Number),
    Str(String),
    Ident(String),
    Bool(bool),
    Tag(String),
    Null,
    Form { op: Op, elts: Vec<NodeId> },
}

impl Node {
    /// The children of a form; literals have none.
    pub fn elts(&self) -> &[NodeId] {
        match self {
            Node::Form { elts, .. } => elts,
            _ => &[],
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AstError {
    #[error("the AST must be an object of nodes keyed by id")]
    NotAPool,
    #[error("the AST has no valid `root`")]
    MissingRoot,
    #[error("1001: Node ID {0} not found in pool.")]
    DanglingRoot(NodeId),
    #[error("\"{0}\" is not a node id")]
    BadId(String),
    #[error("1002: Invalid tag in node with Node ID {0}.")]
    BadNode(NodeId),
    #[error("node {id} ({tag}) has an element that is neither a literal nor a node id")]
    BadElt { id: NodeId, tag: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ast {
    // Ordered, so a scan of the pool (protected-function admission) is deterministic.
    nodes: BTreeMap<NodeId, Node>,
    spans: BTreeMap<NodeId, Span>,
    root: NodeId,
}

impl Ast {
    pub fn from_json(pool: &Json) -> Result<Self, AstError> {
        let pool = pool.as_object().ok_or(AstError::NotAPool)?;
        let root = pool.get("root").and_then(node_id).ok_or(AstError::MissingRoot)?;
        let mut nodes = BTreeMap::new();
        let mut spans = BTreeMap::new();
        for (key, value) in pool {
            if key == "root" {
                continue;
            }
            let id = key.parse().map(NodeId).map_err(|_| AstError::BadId(key.clone()))?;
            let tag = value.get("tag").and_then(Json::as_str).ok_or(AstError::BadNode(id))?;
            let elts = value.get("elts").and_then(Json::as_array).ok_or(AstError::BadNode(id))?;
            nodes.insert(id, node(id, tag, elts)?);
            if let Some(span) = value.get("coord").and_then(span) {
                spans.insert(id, span);
            }
        }
        if !nodes.contains_key(&root) {
            return Err(AstError::DanglingRoot(root));
        }
        Ok(Self { nodes, spans, root })
    }

    pub fn root(&self) -> NodeId {
        self.root
    }

    pub fn get(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn span(&self, id: NodeId) -> Option<Span> {
        self.spans.get(&id).copied()
    }

    /// The nodes a program can evaluate: those reachable from the root, each once, parents
    /// before children and siblings in source order.
    pub fn reachable(&self) -> Vec<(NodeId, &Node)> {
        let mut seen = std::collections::HashSet::new();
        let mut found = Vec::new();
        let mut pending = vec![self.root];
        while let Some(id) = pending.pop() {
            if !seen.insert(id) {
                continue;
            }
            if let Some(node) = self.get(id) {
                found.push((id, node));
                pending.extend(node.elts().iter().rev());
            }
        }
        found
    }

    /// Whether the program can read its input, the upstream value it is chained onto: a
    /// reachable `data` form, or a `get-var` whose name isn't a literal other than `"data"` (an
    /// unset `get-var "data"` reads the input). A dialect whose own words never read the input
    /// may declare a program that doesn't independent of it
    /// ([`Dialect::input_independent`](crate::Dialect::input_independent)). Conservative: a name
    /// computed at run time counts as reading it.
    pub fn reads_input(&self) -> bool {
        self.reachable().into_iter().any(|(_, node)| match node {
            Node::Form { op: Op::Data, .. } => true,
            Node::Form { op: Op::GetVar, elts } => {
                !matches!(elts.first().and_then(|&e| self.get(e)), Some(Node::Str(name)) if name != "data")
            }
            _ => false,
        })
    }

    /// Every node in the pool in id order, reachable from the root or not.
    pub fn nodes(&self) -> impl Iterator<Item = (NodeId, &Node)> {
        self.nodes.iter().map(|(id, node)| (*id, node))
    }
}

impl std::str::FromStr for Ast {
    type Err = AstError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let pool: Json = serde_json::from_str(s).map_err(|_| AstError::NotAPool)?;
        Self::from_json(&pool)
    }
}

fn node_id(value: &Json) -> Option<NodeId> {
    match value {
        Json::Number(n) => n.as_u64().and_then(|n| u32::try_from(n).ok()).map(NodeId),
        Json::String(s) => s.parse().ok().map(NodeId),
        _ => None,
    }
}

fn span(coord: &Json) -> Option<Span> {
    let offset = |key| coord.get(key)?.as_u64().and_then(|n| u32::try_from(n).ok());
    Some(Span { from: offset("from")?, to: offset("to")? })
}

fn text(value: Option<&Json>) -> String {
    match value {
        Some(Json::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn node(id: NodeId, tag: &str, elts: &[Json]) -> Result<Node, AstError> {
    let head = elts.first();
    Ok(match tag {
        // The parser stores a number as its lexeme.
        "NUM" => Node::Num(match head {
            Some(Json::Number(n)) => Number::Float(n.as_f64().unwrap_or(f64::NAN)),
            Some(Json::String(s)) => Number::parse(s),
            _ => Number::NAN,
        }),
        "STR" => Node::Str(text(head)),
        "IDENT" => Node::Ident(text(head)),
        "TAG" => Node::Tag(text(head)),
        "BOOL" => Node::Bool(matches!(head, Some(Json::Bool(true))) || head.and_then(Json::as_str) == Some("true")),
        "NULL" => Node::Null,
        _ => Node::Form {
            op: Op::from_tag(tag),
            elts: elts
                .iter()
                .map(|elt| node_id(elt).ok_or_else(|| AstError::BadElt { id, tag: tag.to_owned() }))
                .collect::<Result<_, _>>()?,
        },
    })
}
