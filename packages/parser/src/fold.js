import assert from "assert";
import { Ast } from "./ast.js";
import { Env } from "./env.js";

export const folder = (function () {
  const table = {
    PROG: program,
    EXPRS: exprs,
    PAREN: parenExpr,
    IDENT: ident,
    BOOL: bool,
    NUM: num,
    STR: str,
    PARENS: unaryExpr,
    APPLY: apply,
    LAMBDA: lambda,
    // "MUL": mul,
    // "DIV": div,
    // "SUB": sub,
    ADD: add,
    POW: pow,
    MOD: mod,
    CONCAT: concat,
    // "OR": orelse,
    // "AND": andalso,
    // "NE": ne,
    // "EQ": eq,
    // "LT": lt,
    // "GT": gt,
    // "LE": le,
    // "GE": ge,
    NEG: neg,
    LIST: list
    // "CASE": caseExpr,
    // "OF": ofClause,
  };

  let nodePool;
  let ctx;

  function fold(cx, nid) {
    ctx = cx;
    nodePool = ctx.state.nodePool;
    visit(nid);
  }

  function visit(nid) {
    const node = nodePool[nid];
    if (!node) {
      return null;
    }
    if (node.tag === undefined) {
      return []; // clean up stubs;
    } else if (isFunction(table[node.tag])) {
      // Have a primitive operation so apply it to construct a new node.
      const ret = table[node.tag](node);
      return ret;
    }
    expr(node);
  }

  function isFunction(v) {
    return v instanceof Function;
  }

  // BEGIN VISITOR METHODS

  function program(node) {
    visit(node.elts[0]);
    Ast.program(ctx);
  }

  function pushNodeStack(ctx) {
    ctx.state.nodeStackStack.push(ctx.state.nodeStack);
    ctx.state.nodeStack = [];
  }
  function popNodeStack(ctx) {
    const stack = ctx.state.nodeStack;
    ctx.state.nodeStack = ctx.state.nodeStackStack.pop().concat(stack);
  }

  function list(node) {
    // Fold list
    // for (var i = 0; i < node.elts.length; i++) {
    //   visit(node.elts[i]);
    // }
    pushNodeStack(ctx);
    for (let i = node.elts.length - 1; i >= 0; i--) {
      visit(node.elts[i]); // Keep original order.
    }
    Ast.list(ctx, ctx.state.nodeStack.length, null, true);
    popNodeStack(ctx);
  }

  function exprs(node) {
    // Fold exprs in reverse order to get precedence right.
    for (let i = node.elts.length - 1; i >= 0; i--) {
      visit(node.elts[i]); // Keep original order.
    }
    ctx.state.exprc = node.elts.length;
  }

  function lambda(node) {
    // Fold initializers and apply args.
    const inits = Ast.node(ctx, node.elts[3]).elts;
    inits.forEach((init, i) => {
      if (init) {
        // If we have an init then fold it and replace in inits list.
        folder.fold(ctx, Ast.intern(ctx, init));
        inits[i] = Ast.pop(ctx);
      }
    });
    // FIXME don't patch old node. construct a new one.
    node.elts[3] = Ast.intern(ctx, { tag: "LIST", elts: inits });
    const fnId = Ast.intern(ctx, node);
    const argc = ctx.state.nodeStack.length;
    Ast.apply(ctx, fnId, argc);
  }

  function apply(node) {
    for (let i = node.elts.length - 1; i >= 0; i--) {
      visit(node.elts[i]);
    }
    Ast.applyLate(ctx, node.elts.length);
  }

  function expr(node) {
    // Construct an expression node for the compiler.
    Ast.name(ctx, node.tag);
    for (let i = node.elts.length - 1; i >= 0; i--) {
      visit(node.elts[i]);
    }
    Ast.expr(ctx, node.elts.length);
  }

  function neg(node) {
    visit(node.elts[0]);
    Ast.neg(ctx);
  }

  function parenExpr(node) {
    pushNodeStack(ctx);
    visit(node.elts[0]);
    Ast.parenExpr(ctx);
    popNodeStack(ctx);
  }

  function unaryExpr(node) {
    visit(node.elts[0]);
    Ast.unaryExpr(ctx, node.tag);
  }

  function add(node) {
    visit(node.elts[0]);
    visit(node.elts[1]);
    Ast.add(ctx);
  }

  function pow(node) {
    visit(node.elts[0]);
    visit(node.elts[1]);
    Ast.pow(ctx);
  }

  function concat(node) {
    visit(node.elts[0]);
    Ast.concat(ctx);
  }

  function mod(node) {
    visit(node.elts[0]);
    visit(node.elts[1]);
    Ast.mod(ctx);
  }

  function ident(node) {
    const name = node.elts[0];
    const word = Env.findWord(ctx, name);
    if (word) {
      if (word.cls === "val") {
        if (word.val) {
          Ast.string(ctx, word.val); // strip quotes;
        } else if (word.nid) {
          let wrd;
          if ((wrd = Ast.node(ctx, word.nid)).tag === "LAMBDA") {
            const argc = wrd.elts[0].elts.length;
            Ast.apply(ctx, word.nid, argc);
          } else {
            Ast.push(ctx, word.nid);
          }
        } else if (word.name) {
          Ast.push(ctx, node);
        } else {
          // push the original node to be resolved later.
          Ast.push(ctx, node);
        }
      } else if (word.cls === "function") {
        const elts = [];
        for (let i = 0; i < word.length; i++) {
          const elt = Ast.pop(ctx);
          elts.push(elt);
        }
        if (word.nid) {
          Ast.fold(ctx, word, elts);
        } else {
          Ast.push(ctx, {
            tag: word.name,
            elts
          });
          folder.fold(ctx, Ast.pop(ctx));
        }
      } else {
        assert(false);
      }
    } else {
      // assert(false, "unresolved ident "+name);
      Ast.push(ctx, node);
    }
  }

  function num(node) {
    Ast.number(ctx, node.elts[0]);
  }

  function str(node) {
    Ast.string(ctx, node.elts[0]);
  }

  function bool(node) {
    Ast.bool(ctx, node.elts[0]);
  }

  return {
    fold
  };
}());
