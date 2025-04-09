import assert from "assert";
import { Ast } from "./ast.js";
import { Env } from "./env.js";
import { assertErr } from "./parse.js";

// Helper to check if a value is a function
function isFunction(v) {
  return v instanceof Function;
}

export class Folder {
  static #nodePool;
  static #ctx;
  static #table;

  static {
    Folder.#table = {
      PROG: Folder.program,
      EXPRS: Folder.exprs,
      PAREN: Folder.parenExpr,
      IDENT: Folder.ident,
      BOOL: Folder.bool,
      NUM: Folder.num,
      STR: Folder.str,
      PARENS: Folder.unaryExpr,
      APPLY: Folder.apply,
      LAMBDA: Folder.lambda,
      // "MUL": mul,
      // "DIV": div,
      // "SUB": sub,
      ADD: Folder.add,
      POW: Folder.pow,
      MOD: Folder.mod,
      CONCAT: Folder.concat,
      // "OR": orelse,
      // "AND": andalso,
      // "NE": ne,
      // "EQ": eq,
      // "LT": lt,
      // "GT": gt,
      // "LE": le,
      // "GE": ge,
      NEG: Folder.neg,
      LIST: Folder.list
      // "CASE": caseExpr,
      // "OF": ofClause,
    };
  }

  static fold(cx, nid) {
    Folder.#ctx = cx;
    Folder.#nodePool = cx.state.nodePool;
    Folder.#visit(nid);
  }

  static #visit(nid) {
    const node = Folder.#nodePool[nid];
    if (!node) {
      return null;
    }

    if (node.tag === undefined) {
      return []; // clean up stubs;
    } else if (isFunction(Folder.#table[node.tag])) {
      // Have a primitive operation so apply it to construct a new node.
      const ret = Folder.#table[node.tag](node);
      return ret;
    }

    Folder.#expr(node);
  }

  // BEGIN VISITOR METHODS

  static program(node) {
    Folder.#visit(node.elts[0]);
    Ast.program(Folder.#ctx);
  }

  static #pushNodeStack() {
    Folder.#ctx.state.nodeStackStack.push(Folder.#ctx.state.nodeStack);
    Folder.#ctx.state.nodeStack = [];
  }

  static #popNodeStack() {
    const stack = Folder.#ctx.state.nodeStack;
    Folder.#ctx.state.nodeStack = Folder.#ctx.state.nodeStackStack.pop().concat(stack);
  }

  static list(node) {
    Folder.#pushNodeStack();
    for (let i = node.elts.length - 1; i >= 0; i--) {
      Folder.#visit(node.elts[i]); // Keep original order.
    }
    Ast.list(Folder.#ctx, Folder.#ctx.state.nodeStack.length, null, true);
    Folder.#popNodeStack();
  }

  static exprs(node) {
    // Fold exprs in reverse order to get precedence right.
    for (let i = node.elts.length - 1; i >= 0; i--) {
      Folder.#visit(node.elts[i]); // Keep original order.
    }
    Folder.#ctx.state.exprc = node.elts.length;
  }

  static lambda(node) {
    // Fold initializers and apply args.
    const inits = Ast.node(Folder.#ctx, node.elts[3]).elts;
    inits.forEach((init, i) => {
      if (init) {
        // If we have an init then fold it and replace in inits list.
        Folder.fold(Folder.#ctx, Ast.intern(Folder.#ctx, init));
        inits[i] = Ast.pop(Folder.#ctx);
      }
    });
    // FIXME don't patch old node. construct a new one.
    node.elts[3] = Ast.intern(Folder.#ctx, { tag: "LIST", elts: inits });
    const fnId = Ast.intern(Folder.#ctx, node);
    const argc = Folder.#ctx.state.nodeStack.length;
    Ast.apply(Folder.#ctx, fnId, argc);
  }

  static apply(node) {
    for (let i = node.elts.length - 1; i >= 0; i--) {
      Folder.#visit(node.elts[i]);
    }
    Ast.applyLate(Folder.#ctx, node.elts.length);
  }

  static #expr(node) {
    // Construct an expression node for the compiler.
    Ast.name(Folder.#ctx, node.tag, node.coord);
    for (let i = node.elts.length - 1; i >= 0; i--) {
      Folder.#visit(node.elts[i]);
    }
    Ast.expr(Folder.#ctx, node.elts.length, node.coord);
  }

  static neg(node) {
    Folder.#visit(node.elts[0]);
    Ast.neg(Folder.#ctx);
  }

  static parenExpr(node) {
    Folder.#pushNodeStack();
    Folder.#visit(node.elts[0]);
    Ast.parenExpr(Folder.#ctx);
    Folder.#popNodeStack();
  }

  static unaryExpr(node) {
    Folder.#visit(node.elts[0]);
    Ast.unaryExpr(Folder.#ctx, node.tag);
  }

  static add(node) {
    Folder.#visit(node.elts[0]);
    Folder.#visit(node.elts[1]);
    Ast.add(Folder.#ctx);
  }

  static pow(node) {
    Folder.#visit(node.elts[0]);
    Folder.#visit(node.elts[1]);
    Ast.pow(Folder.#ctx);
  }

  static concat(node) {
    Folder.#visit(node.elts[0]);
    Ast.concat(Folder.#ctx);
  }

  static mod(node) {
    Folder.#visit(node.elts[0]);
    Folder.#visit(node.elts[1]);
    Ast.mod(Folder.#ctx);
  }

  static ident(node) {
    const ctx = Folder.#ctx;
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
          assertErr(
            ctx,
            elt,
            `Too few arguments for ${word.name}. Expected ${word.length}.`,
            node.coord
          );
          elts.push(elt);
        }
        if (word.nid) {
          Ast.fold(ctx, word, elts);
        } else {
          Ast.push(ctx, {
            tag: word.name,
            elts,
            coord: node.coord,
          });
          Folder.fold(ctx, Ast.pop(ctx));
        }
      } else {
        assert(false);
      }
    } else {
      assertErr(ctx, false, "unresolved ident " + name, node.coord);
    }
  }

  static num(node) {
    Ast.number(Folder.#ctx, node.elts[0], node.coord);
  }

  static str(node) {
    Ast.string(Folder.#ctx, node.elts[0]);
  }

  static bool(node) {
    Ast.bool(Folder.#ctx, node.elts[0]);
  }
}

// Keep backward compatibility export
export const folder = {
  fold: Folder.fold
};
