// SPDX-License-Identifier: MIT

//! Static checks, run before a program is evaluated.
//!
//! The parser reports a syntax error by putting an `ERROR` node in the tree. Every `ERROR`
//! reachable from the root is reported here, so a program with one is never evaluated.

use std::collections::HashSet;

use crate::ast::{Ast, Node, NodeId, Op};
use crate::error::Diagnostic;

pub fn check(ast: &Ast) -> Vec<Diagnostic> {
    let mut errors = Vec::new();
    let mut seen = HashSet::new();
    let mut pending = vec![ast.root()];
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        let Some(Node::Form { op, elts }) = ast.get(id) else { continue };
        match op {
            Op::Error => errors.push(parse_error(ast, id, elts)),
            // The console resolves the named value when the program is saved and stores it as
            // the second element; without it there is nothing to return.
            Op::GetValPrivate | Op::GetValPublic if elts.len() < 2 => {
                let word = if *op == Op::GetValPrivate { "get-val-private" } else { "get-val-public" };
                errors.push(Diagnostic::at(format!("{word} requires a resolved value."), ast.span(id)));
            }
            // Pushed in reverse so errors come out in source order.
            _ => pending.extend(elts.iter().rev()),
        }
    }
    errors
}

/// `ERROR(message, from, to)`.
fn parse_error(ast: &Ast, id: NodeId, elts: &[NodeId]) -> Diagnostic {
    let message = match elts.first().and_then(|&elt| ast.get(elt)) {
        Some(Node::Str(message)) => message.clone(),
        _ => "Syntax error.".to_owned(),
    };
    let offset = |i: usize| match elts.get(i).and_then(|&elt| ast.get(elt)) {
        Some(Node::Num(n)) if n.is_finite() => Some(*n as i64),
        _ => None,
    };
    match (offset(1), offset(2)) {
        (Some(from), Some(to)) => Diagnostic { message, from, to },
        _ => Diagnostic::at(message, ast.span(id)),
    }
}
